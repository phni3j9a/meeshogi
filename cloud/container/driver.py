#!/usr/bin/env python3
"""Small, fail-closed HTTP/USI bridge for the staging analysis container."""

from __future__ import annotations

import hashlib
import json
import os
import queue
import re
import signal
import subprocess
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

PORT = int(os.environ.get("DRIVER_PORT", "8080"))
ENGINE_PATH = Path(os.environ.get("ENGINE_PATH", "/opt/engine/engine"))
WEIGHT_PATH = Path(os.environ.get("WEIGHT_PATH", "/opt/engine/nn.bin"))
OPTIONS_PATH = Path(os.environ.get("ENGINE_OPTIONS_PATH", "/opt/engine/engine_options.txt"))
HELPER_PATH = Path(os.environ.get("HELPER_PATH", "/opt/app/helper-sekirei"))
MOVE_RE = re.compile(r"^(?:[1-9][a-i][1-9][a-i]\+?|[PLNSGBR]\*[1-9][a-i])$")
HASH_RE = re.compile(r"^[0-9a-f]{64}$")
OPTION_RE = re.compile(r"^option name (.+?) type ")
OPTION_VALUE_RE = re.compile(r"^FV_SCALE\s+40$")
RELEVANT_CPU_FLAGS = {
    "avx2",
    "avx512f",
    "avx512bw",
    "avx512dq",
    "avx512vl",
    "bmi1",
    "bmi2",
    "popcnt",
    "sse4_1",
    "sse4_2",
}
ENGINE_CP_LIMIT = 35_281
ENGINE_MATE_LIMIT = 100_000
SEARCH_GRACE_MS = 5_000
STOP_RESPONSE_GRACE_SECONDS = 1.0
PROCESS_TERM_GRACE_SECONDS = 2.0
PROCESS_KILL_GRACE_SECONDS = 2.0
MAX_RESTART_ATTEMPTS = 3
MAX_READINESS_ATTEMPTS = 3
HELPER_TIMEOUT_SECONDS = 3.0
MAX_PROOF_BUDGET = 10_000
USI_HANDSHAKE_TIMEOUT_SECONDS = 20.0
ENGINE_READY_TIMEOUT_SECONDS = 120.0
POSITION_READY_TIMEOUT_SECONDS = 30.0


class DriverError(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class ProtocolError(DriverError):
    """An engine or helper response failed its declared protocol contract."""


class EngineUnavailable(DriverError):
    """The process or readiness handshake failed and recovery did not succeed."""


def is_valid_sfen(value: Any) -> bool:
    if not isinstance(value, str) or len(value) > 256 or value.strip() != value:
        return False
    fields = value.split()
    if len(fields) != 4:
        return False
    board, turn, hands, move_number = fields
    if turn not in {"b", "w"} or not re.fullmatch(r"[1-9][0-9]*", move_number):
        return False
    if hands != "-":
        if not re.fullmatch(r"(?:[1-9][0-9]*)?[PLNSGBRplnsgbr](?:(?:[1-9][0-9]*)?[PLNSGBRplnsgbr])*", hands):
            return False

    ranks = board.split("/")
    if len(ranks) != 9:
        return False
    for rank in ranks:
        files = 0
        index = 0
        while index < len(rank):
            char = rank[index]
            if char in "123456789":
                if index > 0 and rank[index - 1] in "123456789":
                    return False
                files += int(char)
            elif char == "+":
                index += 1
                if index >= len(rank) or rank[index] not in "PLNSBRplnsbr":
                    return False
                files += 1
            elif char in "PLNSGBRKplnsgbrk":
                files += 1
            else:
                return False
            index += 1
        if files != 9:
            return False
    return True


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _cpu_flags() -> set[str]:
    flags: set[str] = set()
    try:
        for line in Path("/proc/cpuinfo").read_text(encoding="ascii", errors="ignore").splitlines():
            if line.lower().startswith(("flags", "features")) and ":" in line:
                flags.update(line.split(":", 1)[1].strip().lower().split())
    except OSError:
        pass
    return flags & RELEVANT_CPU_FLAGS


def _process_stats(
    pid: int,
    proc_root: Path = Path("/proc"),
    cgroup_memory_path: Path = Path("/sys/fs/cgroup/memory.current"),
) -> dict[str, int]:
    """Return best-effort process and cgroup metrics; telemetry never blocks work."""
    stats: dict[str, int] = {}
    process_dir = proc_root / str(pid)
    status_path = process_dir / "status"
    try:
        for line in status_path.read_text(encoding="ascii", errors="ignore").splitlines():
            fields = line.split()
            if len(fields) != 3 or fields[2] != "kB":
                continue
            name = fields[0].removesuffix(":")
            key = {
                "VmHWM": "enginePeakRssKiB",
                "VmRSS": "engineRssKiB",
            }.get(name)
            if key is None:
                continue
            value = int(fields[1])
            if value >= 0:
                stats[key] = value
    except (OSError, UnicodeError, ValueError):
        pass

    try:
        stat_text = (process_dir / "stat").read_text(encoding="ascii", errors="ignore")
        close_paren = stat_text.rfind(")")
        if close_paren >= 0:
            fields = stat_text[close_paren + 1 :].split()
            user_ticks = int(fields[11])
            system_ticks = int(fields[12])
            ticks_per_second = int(os.sysconf("SC_CLK_TCK"))
            if user_ticks >= 0 and system_ticks >= 0 and ticks_per_second > 0:
                stats["engineCpuMs"] = (user_ticks + system_ticks) * 1000 // ticks_per_second
    except (OSError, UnicodeError, ValueError, IndexError, TypeError):
        pass

    try:
        memory_bytes = int(cgroup_memory_path.read_text(encoding="ascii").strip())
        if memory_bytes >= 0:
            stats["containerMemUsageBytes"] = memory_bytes
    except (OSError, UnicodeError, ValueError):
        pass
    return stats


def _safe_process_stats(pid: int) -> dict[str, int]:
    try:
        return _process_stats(pid)
    except Exception:
        # Metrics are optional telemetry and must never make health or analysis fail.
        return {}


def _parse_engine_options(path: Path) -> int:
    """Read the one reviewed runtime option; never interpret this file as shell input."""
    try:
        lines = [line.strip() for line in path.read_text(encoding="ascii").splitlines() if line.strip()]
    except (OSError, UnicodeError) as error:
        raise DriverError("engine_options_unavailable") from error
    if len(lines) != 1 or OPTION_VALUE_RE.fullmatch(lines[0]) is None:
        raise DriverError("engine_options_not_allowlisted")
    return 40


def _parse_info(line: str) -> dict[str, Any] | None:
    tokens = line.split()
    if not tokens or tokens[0] != "info":
        return None
    info: dict[str, Any] = {"bound": False}
    index = 1
    while index < len(tokens):
        token = tokens[index]
        if token in {"depth", "seldepth", "multipv", "nodes", "time"} and index + 1 < len(tokens):
            try:
                info[token] = int(tokens[index + 1])
            except ValueError:
                return None
            index += 2
        elif token == "score" and index + 2 < len(tokens):
            score_type = tokens[index + 1]
            if score_type not in {"cp", "mate"}:
                return None
            try:
                score = int(tokens[index + 2])
            except ValueError:
                return None
            info["score_type"] = score_type
            info["score"] = score
            info["score_raw"] = tokens[index + 2]
            index += 3
            if index < len(tokens) and tokens[index] in {"lowerbound", "upperbound"}:
                info["bound"] = True
                index += 1
        elif token == "pv":
            info["pv"] = tokens[index + 1 :]
            break
        else:
            index += 1
    if not all(name in info for name in ("depth", "multipv", "score_type", "score", "pv")):
        return None
    if info["depth"] < 0 or info["multipv"] < 1 or not info["pv"]:
        return None
    return info


def _run_helper(*arguments: str) -> dict[str, Any]:
    try:
        result = subprocess.run(
            [str(HELPER_PATH), *arguments],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=HELPER_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise ProtocolError("helper_unavailable") from error
    if result.returncode != 0:
        raise ProtocolError("helper_failed")
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise ProtocolError("helper_invalid_json") from error
    if not isinstance(value, dict):
        raise ProtocolError("helper_invalid_response")
    return value


def _legal_position(sfen: str) -> dict[str, Any]:
    value = _run_helper("legal", "--sfen", sfen)
    count = value.get("legalMoveCount")
    moves = value.get("legalMoves")
    in_check = value.get("inCheck")
    declaration_win = value.get("declarationWin")
    if (
        type(count) is not int
        or count < 0
        or count > 512
        or not isinstance(moves, list)
        or len(moves) != count
        or not all(isinstance(move, str) and MOVE_RE.fullmatch(move) for move in moves)
        or len(set(moves)) != len(moves)
        or type(in_check) is not bool
        or type(declaration_win) is not bool
    ):
        raise ProtocolError("helper_invalid_legal_moves")
    return {"legalMoveCount": count, "legalMoves": set(moves), "inCheck": in_check, "declarationWin": declaration_win}


def _validate_pv(sfen: str, pv: list[str]) -> None:
    value = _run_helper("pv-legal", "--sfen", sfen, "--moves", " ".join(pv))
    if value.get("legal") is not True:
        raise ProtocolError("illegal_pv")


class EngineController:
    def __init__(self) -> None:
        self._output: queue.Queue[str | None] = queue.Queue()
        self._write_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._analysis_lock = threading.Lock()
        self._proc: subprocess.Popen[str] | None = None
        self._reader: threading.Thread | None = None
        self._options: set[str] = set()
        self._engine_id = "unknown"
        self._engine_sha256 = ""
        self._weight_sha256 = ""
        self._engine_options_sha256 = ""
        self._helper_sha256 = ""
        self._driver_sha256 = ""
        self._epoch = ""
        self._restart_count = 0
        self._last_restart_reason: str | None = None
        self._readiness_failures = 0
        self._error_code = "engine_start_failed"
        self._ready = False
        self._active = False
        self._active_fence = ""
        self._search_started = False
        self._stop_requested = False
        self._stop_requested_at = 0.0
        self._sigstop_fault_injected = False
        self._cpu_flags = _cpu_flags()
        self._default_threads = 1
        self._default_hash_mb = 256
        for _ in range(MAX_READINESS_ATTEMPTS):
            try:
                self._start_once()
                self._readiness_failures = 0
                return
            except (DriverError, OSError, subprocess.SubprocessError) as error:
                self._readiness_failures += 1
                self._error_code = error.reason if isinstance(error, DriverError) else "engine_start_failed"
                self._terminate_engine()

    def _start_once(self) -> None:
        expected_engine = os.environ.get("EXPECTED_ENGINE_SHA256", "")
        expected_weight = os.environ.get("EXPECTED_WEIGHT_SHA256", "")
        if not HASH_RE.fullmatch(expected_engine) or not HASH_RE.fullmatch(expected_weight):
            raise DriverError("expected_digest_missing")
        if not ENGINE_PATH.is_file() or not WEIGHT_PATH.is_file() or not OPTIONS_PATH.is_file() or not HELPER_PATH.is_file():
            raise DriverError("private_artifact_missing")
        self._engine_sha256 = _sha256(ENGINE_PATH)
        self._weight_sha256 = _sha256(WEIGHT_PATH)
        if self._engine_sha256 != expected_engine or self._weight_sha256 != expected_weight:
            raise DriverError("private_artifact_digest_mismatch")
        options_sha256 = _sha256(OPTIONS_PATH)
        if self._engine_options_sha256 and options_sha256 != self._engine_options_sha256:
            raise DriverError("engine_options_digest_mismatch")
        self._engine_options_sha256 = options_sha256
        self._helper_sha256 = _sha256(HELPER_PATH)
        self._driver_sha256 = _sha256(Path(__file__))
        fv_scale = _parse_engine_options(OPTIONS_PATH)

        self._output = queue.Queue()
        self._epoch = str(uuid.uuid4())
        self._proc = subprocess.Popen(
            [str(ENGINE_PATH)],
            cwd=str(ENGINE_PATH.parent),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        output = self._output
        proc = self._proc
        self._reader = threading.Thread(
            target=self._read_stdout,
            args=(proc, output),
            daemon=True,
            name=f"usi-stdout-{proc.pid}",
        )
        self._reader.start()
        self._send("usi")
        usi_lines = self._read_until("usiok", timeout_seconds=USI_HANDSHAKE_TIMEOUT_SECONDS)
        self._options = {match.group(1) for line in usi_lines if (match := OPTION_RE.match(line))}
        for line in usi_lines:
            if line.startswith("id name "):
                self._engine_id = line.removeprefix("id name ").strip() or "unknown"
        required = {"Threads", "USI_Hash", "MultiPV", "USI_Ponder", "EvalDir", "FV_SCALE", "GenerateAllLegalMoves"}
        if not required.issubset(self._options):
            raise DriverError("engine_options_unsupported")
        if "USI_OwnBook" not in self._options and "BookFile" not in self._options:
            raise DriverError("engine_book_control_unsupported")

        self._set_option("EvalDir", str(WEIGHT_PATH.parent))
        self._set_option("FV_SCALE", str(fv_scale))
        self._set_option("Threads", str(self._default_threads))
        self._set_option("USI_Hash", str(self._default_hash_mb))
        self._set_option("MultiPV", "1")
        self._set_option("GenerateAllLegalMoves", "true")
        self._set_option("USI_Ponder", "false")
        if "USI_OwnBook" in self._options:
            self._set_option("USI_OwnBook", "false")
        if "BookFile" in self._options:
            self._set_option("BookFile", "no_book")
        self._send("isready")
        self._read_until("readyok", timeout_seconds=ENGINE_READY_TIMEOUT_SECONDS)
        if self._proc.poll() is not None:
            raise DriverError("engine_exited_during_start")
        self._ready = True
        self._error_code = ""

    @staticmethod
    def _read_stdout(proc: subprocess.Popen[str], output: queue.Queue[str | None]) -> None:
        assert proc.stdout is not None
        try:
            for raw_line in proc.stdout:
                output.put(raw_line.rstrip("\r\n"))
        finally:
            output.put(None)

    def _send(self, command: str) -> None:
        proc = self._proc
        if proc is None or proc.stdin is None or proc.poll() is not None:
            raise DriverError("engine_not_running")
        try:
            with self._write_lock:
                proc.stdin.write(command + "\n")
                proc.stdin.flush()
        except (BrokenPipeError, OSError) as error:
            raise DriverError("engine_write_failed") from error

    def _set_option(self, name: str, value: str) -> None:
        if name not in self._options:
            raise DriverError("engine_option_not_allowlisted")
        self._send(f"setoption name {name} value {value}")

    def _read_until(self, marker: str, timeout_seconds: float) -> list[str]:
        deadline = time.monotonic() + timeout_seconds
        lines: list[str] = []
        while time.monotonic() < deadline:
            try:
                line = self._output.get(timeout=max(0.01, deadline - time.monotonic()))
            except queue.Empty as error:
                raise DriverError("engine_handshake_timeout") from error
            if line is None:
                raise DriverError("engine_stdout_closed")
            lines.append(line)
            if line == marker:
                return lines
        raise DriverError("engine_handshake_timeout")

    def health(self) -> dict[str, Any]:
        alive = self._proc is not None and self._proc.poll() is None
        ready = self._ready and alive
        stats = _safe_process_stats(self._proc.pid) if self._proc is not None else {}
        return {
            "ready": ready,
            "engineId": self._engine_id,
            "engineBinarySha256": self._engine_sha256[:12],
            "weightSha256": self._weight_sha256[:12],
            "engineOptionsSha256": self._engine_options_sha256[:12],
            "artifactProvenance": {
                "engineBinarySha256": self._engine_sha256,
                "weightSha256": self._weight_sha256,
                "engineOptionsSha256": self._engine_options_sha256,
                "helperBinarySha256": self._helper_sha256,
                "driverSha256": self._driver_sha256,
            },
            "activeFence": self._active_fence if self._active else None,
            "searchStarted": self._search_started,
            "engineEpoch": self._epoch,
            "processId": self._proc.pid if self._proc is not None else None,
            "restartCount": self._restart_count,
            "lastRestartReason": self._last_restart_reason,
            "readinessFailures": self._readiness_failures,
            "generateAllLegalMoves": True,
            "cpuFlags": sorted(self._cpu_flags),
            "avx2": "avx2" in self._cpu_flags,
            "stats": stats,
            **({} if ready else {"reason": self._error_code}),
        }

    def request_stop(self, fence: str) -> bool:
        with self._state_lock:
            if not self._active or not fence or fence != self._active_fence:
                return False
            self._stop_requested = True
            self._stop_requested_at = time.monotonic()
            search_started = self._search_started
        if not search_started:
            return True
        try:
            self._send("stop")
        except DriverError:
            return False
        return True

    def prove(self, request: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        try:
            value = _run_helper(
                "mate-proof", "--sfen", request["sfen"],
                "--plies", str(request["plies"]), "--budget", str(request["budget"]),
            )
        except ProtocolError as error:
            return 502, {"error": "proof_failed", "reason": error.reason}
        proof_result = value.get("result")
        proof_plies = value.get("plies")
        proof_line = value.get("line")
        valid_proven = (
            proof_result == "proven"
            and type(proof_plies) is int
            and proof_plies in {1, 3}
            and proof_plies <= request["plies"]
            and isinstance(proof_line, list)
            and len(proof_line) == proof_plies
            and all(isinstance(move, str) and MOVE_RE.fullmatch(move) for move in proof_line)
        )
        valid_unproven = isinstance(proof_result, str) and proof_result in {"not-mate", "budget-exceeded", "in-check-invalid"} and proof_plies is None and proof_line is None
        if (
            set(value) != {"result", "plies", "line", "nodesUsed", "budget", "budgetVersion"}
            or not (valid_proven or valid_unproven)
            or type(value.get("nodesUsed")) is not int
            or not 0 <= value["nodesUsed"] <= request["budget"]
            or value.get("budget") != request["budget"]
            or value.get("budgetVersion") != "sekirei-proof-ops-v2"
        ):
            return 502, {"error": "proof_failed", "reason": "helper_invalid_proof"}
        return 200, value

    def analyze(self, request: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        if not self._analysis_lock.acquire(blocking=False):
            return 409, {"error": "analysis_conflict"}
        with self._state_lock:
            self._active = True
            self._active_fence = request.get("fence", "internal")
            self._search_started = False
            self._stop_requested = False
        try:
            try:
                return self._analyze_locked(request)
            except ProtocolError as error:
                return 502, {"error": "analysis_failed", "reason": error.reason}
            except DriverError as error:
                self._error_code = error.reason
                self._ready = False
                restarted = self._restart_engine(error.reason)
                if restarted:
                    return 503, {"error": "container_not_ready", "reason": error.reason}
                return 503, {"error": "container_not_ready", "reason": "engine_restart_failed"}
        finally:
            with self._state_lock:
                self._active = False
                self._active_fence = ""
                self._search_started = False
                self._stop_requested = False
                self._stop_requested_at = 0.0
            self._analysis_lock.release()

    def _analyze_locked(self, request: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        if not self.health()["ready"]:
            return 503, {"error": "container_not_ready", "reason": self._error_code or "engine_not_ready"}
        sfen = request["sfen"]
        movetime_ms = request["movetime_ms"]
        requested_multipv = request["multipv"]
        threads = request.get("threads", self._default_threads)
        hash_mb = request.get("hash_mb", self._default_hash_mb)
        root = _legal_position(sfen)
        root_legal_move_count = root["legalMoveCount"]
        effective_multipv = min(requested_multipv, root_legal_move_count)
        proc = self._proc
        if proc is None:
            raise EngineUnavailable("engine_not_running")
        search_epoch = self._epoch
        search_process_id = proc.pid
        if effective_multipv == 0:
            detail = "checkmate" if root["inCheck"] else "no_legal_moves"
            return 200, self._result(
                sfen, [], requested_multipv, effective_multipv, root_legal_move_count,
                0, 0, 0, "no_legal_moves", search_epoch, search_process_id, detail,
            )
        self._set_option("Threads", str(threads))
        self._set_option("USI_Hash", str(hash_mb))
        self._set_option("MultiPV", str(effective_multipv))
        self._set_option("GenerateAllLegalMoves", "true")
        self._send("usinewgame")
        self._send("isready")
        self._read_until("readyok", timeout_seconds=POSITION_READY_TIMEOUT_SECONDS)
        self._send("position sfen " + sfen)
        with self._state_lock:
            if self._stop_requested:
                return 200, self._result(
                    sfen, [], requested_multipv, effective_multipv, root_legal_move_count,
                    0, 0, 0, "cancelled", search_epoch, search_process_id,
                )
            self._search_started = True
            self._send(f"go movetime {movetime_ms}")
            test_fence = os.environ.get("MEESHOGI_TEST_SIGSTOP_FENCE", "")
            if (
                os.environ.get("MEESHOGI_TEST_SIGSTOP_ENGINE") == "1"
                and test_fence
                and request.get("fence") == test_fence
                and not self._sigstop_fault_injected
            ):
                self._sigstop_fault_injected = True
                try:
                    proc.send_signal(signal.SIGSTOP)
                except ProcessLookupError:
                    pass

        start = time.monotonic()
        deadline = start + (movetime_ms + SEARCH_GRACE_MS) / 1000.0
        blocks: list[list[dict[str, Any]]] = []
        current_block: list[dict[str, Any]] = []
        max_nodes = 0
        reported_elapsed = 0
        bestmove: str | None = None
        while bestmove is None:
            now = time.monotonic()
            with self._state_lock:
                stop_requested = self._stop_requested
                stop_at = self._stop_requested_at
            stop_deadline = stop_at + STOP_RESPONSE_GRACE_SECONDS if stop_requested else deadline
            current_deadline = min(deadline, stop_deadline)
            remaining = current_deadline - now
            if remaining <= 0:
                if stop_requested and stop_deadline < deadline:
                    self._terminate_engine()
                    self._restart_engine("cancel_stop_timeout")
                    return 200, self._result(
                        sfen, [], requested_multipv, effective_multipv, root_legal_move_count,
                        max_nodes, 0, int((time.monotonic() - start) * 1000), "cancelled",
                        search_epoch, search_process_id,
                    )
                return self._timeout_result(
                    sfen, requested_multipv, effective_multipv, root_legal_move_count,
                    search_epoch, search_process_id, max_nodes, start,
                )
            try:
                line = self._output.get(timeout=remaining)
            except queue.Empty:
                continue
            if line is None:
                self._ready = False
                self._restart_engine("engine_exit")
                elapsed_ms = int((time.monotonic() - start) * 1000)
                return 200, self._result(
                    sfen, [], requested_multipv, effective_multipv, root_legal_move_count,
                    max_nodes, 0, elapsed_ms, "position_failed:engine_exit",
                    search_epoch, search_process_id,
                )
            if line.startswith("info "):
                info = _parse_info(line)
                if info is not None and info["multipv"] <= effective_multipv:
                    if info["score_type"] == "cp" and abs(info["score"]) > ENGINE_CP_LIMIT:
                        raise ProtocolError("score_cp_out_of_engine_range")
                    if info["score_type"] == "mate" and abs(info["score"]) > ENGINE_MATE_LIMIT:
                        raise ProtocolError("score_mate_out_of_range")
                    if current_block and (
                        info["multipv"] <= current_block[-1]["multipv"]
                        or info["depth"] != current_block[0]["depth"]
                    ):
                        blocks.append(current_block)
                        current_block = []
                    current_block.append(info)
                    max_nodes = max(max_nodes, info.get("nodes", 0))
                    reported_elapsed = max(reported_elapsed, info.get("time", 0))
            elif line.startswith("bestmove "):
                parts = line.split()
                bestmove = parts[1] if len(parts) > 1 else ""

        if current_block:
            blocks.append(current_block)
        elapsed_ms = max(0, int((time.monotonic() - start) * 1000))
        candidates, completed_depth = self._select_candidates(
            blocks,
            effective_multipv,
            sfen,
            root["legalMoves"],
        )
        with self._state_lock:
            cancelled = self._stop_requested
        if cancelled:
            return 200, self._result(
                sfen, [], requested_multipv, effective_multipv, root_legal_move_count,
                max_nodes, 0, elapsed_ms, "cancelled", search_epoch, search_process_id,
            )
        if bestmove == "resign":
            return 200, self._result(
                sfen, [], requested_multipv, effective_multipv, root_legal_move_count,
                max_nodes, 0, elapsed_ms, "resign", search_epoch, search_process_id,
            )
        if bestmove == "win":
            if not root["declarationWin"]:
                raise ProtocolError("unverified_declaration_win")
            return 200, self._result(
                sfen, [], requested_multipv, effective_multipv, root_legal_move_count,
                max_nodes, 0, elapsed_ms, "win", search_epoch, search_process_id, "declaration_win",
            )
        if bestmove in {"none", "(none)", "0000"}:
            raise ProtocolError("bestmove_none_with_legal_moves")
        if not bestmove or not MOVE_RE.fullmatch(bestmove):
            raise ProtocolError("invalid_bestmove")
        if bestmove not in root["legalMoves"]:
            raise ProtocolError("illegal_bestmove")
        if not candidates:
            return 200, self._result(
                sfen, [], requested_multipv, effective_multipv, root_legal_move_count,
                max_nodes, 0, max(elapsed_ms, reported_elapsed), "incomplete",
                search_epoch, search_process_id, engine_bestmove=bestmove,
            )

        terminal = "mate" if any("mateSign" in candidate for candidate in candidates) else "ok"
        return 200, self._result(
            sfen, candidates, requested_multipv, effective_multipv, root_legal_move_count,
            max_nodes, completed_depth, max(elapsed_ms, reported_elapsed), terminal,
            search_epoch, search_process_id, engine_bestmove=bestmove,
        )

    def _timeout_result(
        self,
        sfen: str,
        requested_multipv: int,
        effective_multipv: int,
        root_legal_move_count: int,
        search_epoch: str,
        search_process_id: int,
        nodes: int,
        start: float,
    ) -> tuple[int, dict[str, Any]]:
        try:
            self._send("stop")
        except DriverError:
            pass
        self._wait_for_stop(STOP_RESPONSE_GRACE_SECONDS)
        self._terminate_engine()
        self._restart_engine("engine_timeout")
        elapsed_ms = max(0, int((time.monotonic() - start) * 1000))
        return 200, self._result(
            sfen, [], requested_multipv, effective_multipv, root_legal_move_count,
            nodes, 0, elapsed_ms, "position_failed:engine_timeout",
            search_epoch, search_process_id,
        )

    def _wait_for_stop(self, timeout_seconds: float) -> str | None:
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            try:
                line = self._output.get(timeout=max(0.01, deadline - time.monotonic()))
            except queue.Empty:
                return None
            if line is None:
                return None
            if line.startswith("bestmove "):
                parts = line.split()
                return parts[1] if len(parts) > 1 else ""
        return None

    def _terminate_engine(self) -> None:
        proc = self._proc
        if proc is not None:
            if proc.poll() is None:
                try:
                    proc.send_signal(signal.SIGTERM)
                    proc.wait(timeout=PROCESS_TERM_GRACE_SECONDS)
                except subprocess.TimeoutExpired:
                    proc.send_signal(signal.SIGKILL)
                    proc.wait(timeout=PROCESS_KILL_GRACE_SECONDS)
                except ProcessLookupError:
                    proc.wait()
            else:
                proc.wait()
            if self._reader is not None:
                self._reader.join(timeout=1)
            for stream in (proc.stdin, proc.stdout):
                if stream is not None:
                    try:
                        stream.close()
                    except OSError:
                        pass
        self._proc = None
        self._reader = None
        self._ready = False

    def _restart_engine(self, reason: str) -> bool:
        self._ready = False
        self._last_restart_reason = reason
        if self._proc is not None:
            self._terminate_engine()
        while self._restart_count < MAX_RESTART_ATTEMPTS:
            self._restart_count += 1
            try:
                self._start_once()
                return True
            except (DriverError, OSError, subprocess.SubprocessError) as error:
                self._readiness_failures += 1
                self._error_code = error.reason if isinstance(error, DriverError) else "engine_restart_failed"
                self._terminate_engine()
        self._error_code = "engine_restart_failed"
        return False

    @staticmethod
    def _select_candidates(
        blocks: list[list[dict[str, Any]]],
        multipv: int,
        sfen: str,
        legal_moves: set[str],
    ) -> tuple[list[dict[str, Any]], int]:
        """Pick the last emission block whose MultiPV set is wholly complete.

        The engine may re-emit (depth, rank) lines, including a final flush at
        movetime expiry that can even lower the reported depth. Re-emission is
        a normal update, so only a contiguous block that itself contains ranks
        1..multipv at one depth, all with exact scores, qualifies. Later
        partial or bound blocks never displace an earlier complete block.
        """
        sente_to_move = sfen.split()[1] == "b"
        for block in reversed(blocks):
            if len(block) != multipv or [info["multipv"] for info in block] != list(range(1, multipv + 1)):
                continue
            if any(info["bound"] for info in block):
                continue
            depth = block[0]["depth"]
            candidates: list[dict[str, Any]] = []
            valid = True
            moves: set[str] = set()
            for info in block:
                pv = info["pv"][:64]
                if (
                    not pv
                    or not all(MOVE_RE.fullmatch(move) for move in pv)
                    or pv[0] not in legal_moves
                    or pv[0] in moves
                ):
                    valid = False
                    break
                moves.add(pv[0])
                _validate_pv(sfen, pv)
                candidate: dict[str, Any] = {"move": pv[0], "pvUsi": pv, "depth": depth}
                if info["score_type"] == "cp":
                    score = info["score"] if sente_to_move else -info["score"]
                    candidate["scoreCp"] = score
                else:
                    raw_score = info["score_raw"]
                    sign = 0 if raw_score in {"0"} else (-1 if raw_score.startswith("-") else 1)
                    if not sente_to_move:
                        sign = -sign
                    candidate["mateSign"] = "sente" if sign > 0 else "gote" if sign < 0 else "unknown"
                    if info["score"] != 0:
                        candidate["scoreMate"] = info["score"] if sente_to_move else -info["score"]
                candidates.append(candidate)
            if valid:
                return candidates, depth
        return [], 0

    def _result(
        self,
        sfen: str,
        candidates: list[dict[str, Any]],
        requested_multipv: int,
        effective_multipv: int,
        root_legal_move_count: int,
        nodes: int,
        depth: int,
        elapsed_ms: int,
        terminal: str,
        epoch: str,
        process_id: int,
        terminal_detail: str | None = None,
        engine_bestmove: str | None = None,
    ) -> dict[str, Any]:
        process = self._proc
        result = {
            "contractVersion": 3,
            "engineId": self._engine_id,
            "sfen": sfen,
            "candidates": candidates,
            "actualNodes": nodes,
            "completedDepth": depth,
            "elapsedMs": elapsed_ms,
            "multipv": effective_multipv,
            "requestedMultiPv": requested_multipv,
            "effectiveMultiPv": effective_multipv,
            "rootLegalMoveCount": root_legal_move_count,
            "terminal": terminal,
            "engineEpoch": epoch,
            "restartCount": self._restart_count,
            "processId": process_id,
            "stats": _safe_process_stats(process_id),
        }
        if terminal_detail is not None:
            result["terminalDetail"] = terminal_detail
        if engine_bestmove is not None:
            result["engineBestmove"] = engine_bestmove
        return result

    def close(self) -> None:
        proc = self._proc
        if proc is None:
            return
        if proc.poll() is None and self._analysis_lock.locked():
            self.request_stop(self._active_fence)
            if self._analysis_lock.acquire(timeout=5):
                self._analysis_lock.release()
            else:
                self._terminate_engine()
        proc = self._proc
        if proc is not None and proc.poll() is None:
            try:
                self._send("quit")
                proc.wait(timeout=3)
            except (DriverError, subprocess.TimeoutExpired):
                self._terminate_engine()
        if self._proc is not None:
            self._terminate_engine()


def _validate_driver_request(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict) or not {"sfen", "movetime_ms", "multipv", "fence"}.issubset(value):
        return None
    if set(value) - {"sfen", "movetime_ms", "multipv", "threads", "hash_mb", "fence"}:
        return None
    if not is_valid_sfen(value["sfen"]):
        return None
    movetime = value["movetime_ms"]
    multipv = value["multipv"]
    threads = value.get("threads", 1)
    hash_mb = value.get("hash_mb", 256)
    fence = value["fence"]
    if not isinstance(fence, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,256}", fence):
        return None
    if type(movetime) is not int or not 50 <= movetime <= 30_000:
        return None
    if type(multipv) is not int or not 1 <= multipv <= 8:
        return None
    if type(threads) is not int or not 1 <= threads <= 2:
        return None
    if type(hash_mb) is not int or not 16 <= hash_mb <= 512:
        return None
    return {"sfen": value["sfen"], "movetime_ms": movetime, "multipv": multipv, "threads": threads, "hash_mb": hash_mb, "fence": fence}


def _validate_proof_request(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict) or set(value) != {"sfen", "plies", "budget"}:
        return None
    if not is_valid_sfen(value["sfen"]):
        return None
    if type(value["plies"]) is not int or value["plies"] not in {1, 3}:
        return None
    if type(value["budget"]) is not int or not 1 <= value["budget"] <= MAX_PROOF_BUDGET:
        return None
    return {"sfen": value["sfen"], "plies": value["plies"], "budget": value["budget"]}


class DriverHandler(BaseHTTPRequestHandler):
    controller: EngineController
    server_version = "meeshogi-analysis-staging"
    sys_version = ""

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path != "/health":
            self._send_json(404, {"error": "not_found"})
            return
        health = self.controller.health()
        self._send_json(200 if health["ready"] else 503, health)

    def do_POST(self) -> None:
        if self.path == "/prove":
            length = self._content_length()
            if length is None or length > 4096:
                self._send_json(400, {"error": "invalid_request"})
                return
            try:
                value = json.loads(self.rfile.read(length))
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._send_json(400, {"error": "invalid_request"})
                return
            request = _validate_proof_request(value)
            if request is None:
                self._send_json(400, {"error": "invalid_request"})
                return
            status, payload = self.controller.prove(request)
            self._send_json(status, payload)
            return
        if self.path == "/stop":
            length = self._content_length()
            if length is None or length > 1024:
                self._send_json(400, {"error": "invalid_request"})
                return
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._send_json(400, {"error": "invalid_request"})
                return
            if not isinstance(body, dict) or set(body) != {"fence"} or not isinstance(body["fence"], str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,256}", body["fence"]):
                self._send_json(400, {"error": "invalid_request"})
                return
            self._send_json(200, {"stopped": self.controller.request_stop(body["fence"])})
            return
        if self.path != "/analyze":
            self._send_json(404, {"error": "not_found"})
            return
        length = self._content_length()
        if length is None or length > 4096:
            self._send_json(400, {"error": "invalid_request"})
            return
        try:
            value = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_json(400, {"error": "invalid_request"})
            return
        request = _validate_driver_request(value)
        if request is None:
            self._send_json(400, {"error": "invalid_request"})
            return
        try:
            status, payload = self.controller.analyze(request)
        except Exception:
            self._send_json(500, {"error": "analysis_failed"})
            return
        self._send_json(status, payload)

    def _content_length(self) -> int | None:
        value = self.headers.get("content-length")
        if value is None or not value.isdecimal():
            return None
        return int(value)

    def log_message(self, _format: str, *_args: Any) -> None:
        # Request bodies and headers are never logged; keep access logs off too.
        return


def serve() -> None:
    controller = EngineController()
    handler = type("BoundDriverHandler", (DriverHandler,), {"controller": controller})
    server = ThreadingHTTPServer(("0.0.0.0", PORT), handler)
    server.daemon_threads = True

    def shutdown(_signum: int, _frame: Any) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()
        controller.close()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        controller.close()
        server.server_close()


if __name__ == "__main__":
    serve()
