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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

PORT = int(os.environ.get("DRIVER_PORT", "8080"))
ENGINE_PATH = Path(os.environ.get("ENGINE_PATH", "/opt/engine/engine"))
WEIGHT_PATH = Path(os.environ.get("WEIGHT_PATH", "/opt/engine/nn.bin"))
OPTIONS_PATH = Path(os.environ.get("ENGINE_OPTIONS_PATH", "/opt/engine/engine_options.txt"))
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


class DriverError(Exception):
    pass


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
        self._error_code = "engine_start_failed"
        self._ready = False
        self._active = False
        self._search_started = False
        self._stop_requested = False
        self._cpu_flags = _cpu_flags()
        self._default_threads = 1
        self._default_hash_mb = 256
        try:
            self._start()
        except (DriverError, OSError, subprocess.SubprocessError):
            self._ready = False
            self.close()

    def _start(self) -> None:
        expected_engine = os.environ.get("EXPECTED_ENGINE_SHA256", "")
        expected_weight = os.environ.get("EXPECTED_WEIGHT_SHA256", "")
        if not HASH_RE.fullmatch(expected_engine) or not HASH_RE.fullmatch(expected_weight):
            raise DriverError("expected_digest_missing")
        if not ENGINE_PATH.is_file() or not WEIGHT_PATH.is_file() or not OPTIONS_PATH.is_file():
            raise DriverError("private_artifact_missing")
        self._engine_sha256 = _sha256(ENGINE_PATH)
        self._weight_sha256 = _sha256(WEIGHT_PATH)
        if self._engine_sha256 != expected_engine or self._weight_sha256 != expected_weight:
            raise DriverError("private_artifact_digest_mismatch")
        fv_scale = _parse_engine_options(OPTIONS_PATH)

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
        self._reader = threading.Thread(target=self._read_stdout, daemon=True, name="usi-stdout")
        self._reader.start()
        self._send("usi")
        usi_lines = self._read_until("usiok", timeout_seconds=20)
        self._options = {match.group(1) for line in usi_lines if (match := OPTION_RE.match(line))}
        for line in usi_lines:
            if line.startswith("id name "):
                self._engine_id = line.removeprefix("id name ").strip() or "unknown"
        required = {"Threads", "USI_Hash", "MultiPV", "USI_Ponder", "EvalDir", "FV_SCALE"}
        if not required.issubset(self._options):
            raise DriverError("engine_options_unsupported")
        if "USI_OwnBook" not in self._options and "BookFile" not in self._options:
            raise DriverError("engine_book_control_unsupported")

        self._set_option("EvalDir", str(WEIGHT_PATH.parent))
        self._set_option("FV_SCALE", str(fv_scale))
        self._set_option("Threads", str(self._default_threads))
        self._set_option("USI_Hash", str(self._default_hash_mb))
        self._set_option("MultiPV", "1")
        self._set_option("USI_Ponder", "false")
        if "USI_OwnBook" in self._options:
            self._set_option("USI_OwnBook", "false")
        if "BookFile" in self._options:
            self._set_option("BookFile", "no_book")
        self._send("isready")
        self._read_until("readyok", timeout_seconds=120)
        if self._proc.poll() is not None:
            raise DriverError("engine_exited_during_start")
        self._ready = True

    def _read_stdout(self) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        try:
            for raw_line in self._proc.stdout:
                self._output.put(raw_line.rstrip("\r\n"))
        finally:
            self._output.put(None)

    def _send(self, command: str) -> None:
        proc = self._proc
        if proc is None or proc.stdin is None or proc.poll() is not None:
            raise DriverError("engine_not_running")
        with self._write_lock:
            proc.stdin.write(command + "\n")
            proc.stdin.flush()

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
        return {
            "ready": ready,
            "engineId": self._engine_id,
            "engineBinarySha256": self._engine_sha256[:12],
            "weightSha256": self._weight_sha256[:12],
            "cpuFlags": sorted(self._cpu_flags),
            "avx2": "avx2" in self._cpu_flags,
            **({} if ready else {"reason": self._error_code}),
        }

    def request_stop(self) -> bool:
        with self._state_lock:
            if not self._active:
                return False
            self._stop_requested = True
            search_started = self._search_started
        if not search_started:
            return True
        try:
            self._send("stop")
        except DriverError:
            return False
        return True

    def analyze(self, request: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        if not self._analysis_lock.acquire(blocking=False):
            return 409, {"error": "analysis_conflict"}
        with self._state_lock:
            self._active = True
            self._search_started = False
            self._stop_requested = False
        try:
            try:
                return self._analyze_locked(request)
            except DriverError:
                self._ready = False
                self._error_code = "analysis_failure"
                return 503, {"error": "container_not_ready"}
        finally:
            with self._state_lock:
                self._active = False
                self._search_started = False
                self._stop_requested = False
            self._analysis_lock.release()

    def _analyze_locked(self, request: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        if not self.health()["ready"]:
            return 503, {"error": "container_not_ready"}
        sfen = request["sfen"]
        movetime_ms = request["movetime_ms"]
        multipv = request["multipv"]
        threads = request.get("threads", self._default_threads)
        hash_mb = request.get("hash_mb", self._default_hash_mb)
        self._set_option("Threads", str(threads))
        self._set_option("USI_Hash", str(hash_mb))
        self._set_option("MultiPV", str(multipv))
        self._send("usinewgame")
        self._send("isready")
        self._read_until("readyok", timeout_seconds=30)
        self._send("position sfen " + sfen)
        with self._state_lock:
            if self._stop_requested:
                return 200, self._result(sfen, [], multipv, 0, 0, 0, "cancelled")
            self._search_started = True
            self._send(f"go movetime {movetime_ms}")

        start = time.monotonic()
        deadline = start + movetime_ms / 1000.0 + 8.0
        iterations: dict[int, dict[int, dict[str, Any]]] = {}
        max_nodes = 0
        reported_elapsed = 0
        bestmove: str | None = None
        timed_out = False
        while bestmove is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                try:
                    self._send("stop")
                except DriverError:
                    pass
                bestmove = self._wait_for_stop(2.0)
                break
            try:
                line = self._output.get(timeout=remaining)
            except queue.Empty:
                timed_out = True
                try:
                    self._send("stop")
                except DriverError:
                    pass
                bestmove = self._wait_for_stop(2.0)
                break
            if line is None:
                self._ready = False
                return 503, {"error": "container_not_ready"}
            if line.startswith("info "):
                info = _parse_info(line)
                if info is not None and info["multipv"] <= multipv:
                    iteration = iterations.setdefault(info["depth"], {})
                    iteration[info["multipv"]] = info
                    max_nodes = max(max_nodes, info.get("nodes", 0))
                    reported_elapsed = max(reported_elapsed, info.get("time", 0))
            elif line.startswith("bestmove "):
                parts = line.split()
                bestmove = parts[1] if len(parts) > 1 else ""

        elapsed_ms = max(0, int((time.monotonic() - start) * 1000))
        candidates, completed_depth = self._last_complete_iteration(iterations, multipv, sfen)
        with self._state_lock:
            cancelled = self._stop_requested and not timed_out
        if timed_out:
            if bestmove is None:
                self._terminate_engine()
            return 200, self._result(sfen, [], multipv, max_nodes, completed_depth, elapsed_ms, "timeout")
        if cancelled:
            return 200, self._result(sfen, [], multipv, max_nodes, completed_depth, elapsed_ms, "cancelled")
        if bestmove == "resign":
            return 200, self._result(sfen, [], multipv, max_nodes, 0, elapsed_ms, "resign")
        if bestmove in {"win", "none", "(none)", "0000"}:
            return 200, self._result(sfen, [], multipv, max_nodes, 0, elapsed_ms, "mate0")
        if not bestmove or not MOVE_RE.fullmatch(bestmove):
            return 200, self._result(sfen, [], multipv, max_nodes, 0, elapsed_ms, "error")
        if not candidates:
            return 200, self._result(sfen, [], multipv, max_nodes, 0, elapsed_ms, "incomplete")

        if any(candidate.get("scoreMate") == 0 for candidate in candidates):
            return 200, self._result(sfen, [], multipv, max_nodes, 0, elapsed_ms, "mate0")

        terminal = "mate" if any("scoreMate" in candidate for candidate in candidates) else "ok"
        return 200, self._result(sfen, candidates, multipv, max_nodes, completed_depth, max(elapsed_ms, reported_elapsed), terminal)

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
        if proc is None or proc.poll() is not None:
            self._ready = False
            self._error_code = "engine_stopped"
            return
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=2)
        self._ready = False
        self._error_code = "engine_stopped"

    @staticmethod
    def _last_complete_iteration(
        iterations: dict[int, dict[int, dict[str, Any]]], multipv: int, sfen: str
    ) -> tuple[list[dict[str, Any]], int]:
        sente_to_move = sfen.split()[1] == "b"
        for depth in sorted(iterations, reverse=True):
            current = iterations[depth]
            if set(current) < set(range(1, multipv + 1)):
                continue
            candidates: list[dict[str, Any]] = []
            valid = True
            for rank in range(1, multipv + 1):
                info = current[rank]
                pv = info["pv"][:64]
                if info["bound"] or not pv or not all(MOVE_RE.fullmatch(move) for move in pv):
                    valid = False
                    break
                score = info["score"] if sente_to_move else -info["score"]
                candidate: dict[str, Any] = {"move": pv[0], "pvUsi": pv}
                candidate["scoreCp" if info["score_type"] == "cp" else "scoreMate"] = score
                candidates.append(candidate)
            if valid:
                return candidates, depth
        return [], 0

    def _result(
        self,
        sfen: str,
        candidates: list[dict[str, Any]],
        multipv: int,
        nodes: int,
        depth: int,
        elapsed_ms: int,
        terminal: str,
    ) -> dict[str, Any]:
        return {
            "engineId": self._engine_id,
            "sfen": sfen,
            "candidates": candidates,
            "actualNodes": nodes,
            "completedDepth": depth,
            "elapsedMs": elapsed_ms,
            "multipv": multipv,
            "terminal": terminal,
        }

    def close(self) -> None:
        proc = self._proc
        if proc is None:
            return
        if proc.poll() is None and self._analysis_lock.locked():
            self.request_stop()
            if self._analysis_lock.acquire(timeout=5):
                self._analysis_lock.release()
            else:
                self._terminate_engine()
        if proc.poll() is None:
            try:
                self._send("quit")
                proc.wait(timeout=3)
            except (DriverError, subprocess.TimeoutExpired):
                proc.terminate()
                try:
                    proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=2)
        if self._reader is not None:
            self._reader.join(timeout=1)
        for stream in (proc.stdin, proc.stdout):
            if stream is not None:
                stream.close()
        self._ready = False


def _validate_driver_request(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict) or not {"sfen", "movetime_ms", "multipv"}.issubset(value):
        return None
    if set(value) - {"sfen", "movetime_ms", "multipv", "threads", "hash_mb"}:
        return None
    if not is_valid_sfen(value["sfen"]):
        return None
    movetime = value["movetime_ms"]
    multipv = value["multipv"]
    threads = value.get("threads", 1)
    hash_mb = value.get("hash_mb", 256)
    if type(movetime) is not int or not 50 <= movetime <= 30_000:
        return None
    if type(multipv) is not int or not 1 <= multipv <= 8:
        return None
    if type(threads) is not int or not 1 <= threads <= 2:
        return None
    if type(hash_mb) is not int or not 16 <= hash_mb <= 512:
        return None
    return {"sfen": value["sfen"], "movetime_ms": movetime, "multipv": multipv, "threads": threads, "hash_mb": hash_mb}


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
            if body != {}:
                self._send_json(400, {"error": "invalid_request"})
                return
            self._send_json(200, {"stopped": self.controller.request_stop()})
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
