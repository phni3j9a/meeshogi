#!/usr/bin/env python3
"""Bounded HTTP-to-USI adapter for the private staging engine image."""

from __future__ import annotations

import hashlib
import json
import os
import queue
import re
import resource
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
MANIFEST_PATH = Path(os.environ.get("ARTIFACT_MANIFEST_PATH", "/opt/app/artifact-manifest.json"))
CONDITIONS_MANIFEST_PATH = Path(os.environ.get(
    "CONDITIONS_MANIFEST_PATH",
    str(Path(__file__).resolve().parents[1] / "bench" / "conditions.json"),
))

MAX_BODY_BYTES = 1024
MAX_SFEN_BYTES = 256
MAX_MOVES = 256
MAX_MULTIPV = 3
THREADS = 1
HASH_MB = 64
MOVE_TIME_MS = 1500
SEARCH_GRACE_MS = 5000
STOP_RESPONSE_GRACE_SECONDS = 0.75
TERM_GRACE_SECONDS = 1.0
KILL_GRACE_SECONDS = 1.0
HANDSHAKE_TIMEOUT_SECONDS = 20.0
READY_TIMEOUT_SECONDS = 45.0
MOVE_RE = re.compile(r"^(?:[1-9][a-i][1-9][a-i]\+?|[PLNSGBR]\*[1-9][a-i])$")
SFEN_RE = re.compile(r"^[0-9KkLlNnSsGgBbRrPp/+ bw-]+$")
HASH_RE = re.compile(r"^[0-9a-f]{64}$")
DRIVER_BOOT_ID = uuid.uuid4().hex


class DriverError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class IdentityMismatch(DriverError):
    def __init__(self, message: str = "Artifact identity does not match the image manifest."):
        super().__init__("identity_mismatch", message)


class SearchTimeout(DriverError):
    def __init__(self):
        super().__init__("timeout", "The engine exceeded the fixed search deadline.")


def is_valid_sfen(value: Any) -> bool:
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > MAX_SFEN_BYTES:
        return False
    if value.strip() != value or any(ord(char) < 0x20 or ord(char) == 0x7F for char in value):
        return False
    if not SFEN_RE.fullmatch(value):
        return False
    fields = value.split(" ")
    if len(fields) != 4 or any(not field for field in fields):
        return False
    board, turn, hands, move_number = fields
    if turn not in {"b", "w"} or not re.fullmatch(r"[1-9][0-9]*", move_number):
        return False
    if hands != "-" and not re.fullmatch(r"(?:[1-9][0-9]*)?[PLNSGBRplnsgbr](?:(?:[1-9][0-9]*)?[PLNSGBRplnsgbr])*", hands):
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


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _read_expected_manifest(path: Path) -> dict[str, Any]:
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise IdentityMismatch("Artifact manifest is missing or invalid.") from error
    expected_fields = {
        "engineName", "engineUsiNameContains", "engineSha256", "modelId", "weightSha256",
        "optionsSha256", "optionsText", "sourceArchive", "sourceArchiveSha256", "sourceTreeSha256",
        "buildInfo", "driverVersion", "contractVersion",
    }
    if manifest.get("schemaVersion") != 1 or not expected_fields.issubset(manifest):
        raise IdentityMismatch("Artifact manifest has an unsupported schema.")
    for key in ("engineSha256", "weightSha256", "optionsSha256", "sourceArchiveSha256", "sourceTreeSha256"):
        if not isinstance(manifest[key], str) or not HASH_RE.fullmatch(manifest[key]):
            raise IdentityMismatch("Artifact manifest contains an invalid digest.")
    return manifest


def verify_identity(
    engine_path: Path = ENGINE_PATH,
    weight_path: Path = WEIGHT_PATH,
    options_path: Path = OPTIONS_PATH,
    manifest_path: Path = MANIFEST_PATH,
) -> dict[str, Any]:
    manifest = _read_expected_manifest(manifest_path)
    try:
        actual = {
            "engineSha256": sha256_file(engine_path),
            "weightSha256": sha256_file(weight_path),
            "optionsSha256": sha256_file(options_path),
        }
        options_text = options_path.read_text(encoding="ascii")
    except OSError as error:
        raise IdentityMismatch("An expected engine artifact is missing.") from error
    expected = {key: manifest[key] for key in actual}
    if actual != expected or options_text != manifest["optionsText"]:
        raise IdentityMismatch()
    return manifest


def artifact_identity(manifest: dict[str, Any]) -> dict[str, str]:
    return {
        "engineName": manifest["engineName"],
        "engineSha256": manifest["engineSha256"],
        "modelId": manifest["modelId"],
        "weightSha256": manifest["weightSha256"],
        "optionsSha256": manifest["optionsSha256"],
        "sourceArchiveSha256": manifest["sourceArchiveSha256"],
        "sourceTreeSha256": manifest["sourceTreeSha256"],
        "sourceArchive": manifest["sourceArchive"],
        "buildInfo": manifest["buildInfo"],
        "driverVersion": manifest["driverVersion"],
        "contractVersion": manifest["contractVersion"],
    }


def load_benchmark_conditions(path: Path) -> dict[str, dict[str, Any]]:
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(manifest, dict):
            raise ValueError("manifest root is not an object")
        rows = manifest["conditions"]
    except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
        raise DriverError("engine_error", "Benchmark conditions manifest is unavailable.") from error
    if manifest.get("schemaVersion") != 1 or not isinstance(rows, list):
        raise DriverError("engine_error", "Benchmark conditions manifest is invalid.")
    conditions: dict[str, dict[str, Any]] = {}
    allowed_times = {100, 250, 500, 1000, 2000, 5000, 10000}
    for row in rows:
        if not isinstance(row, dict):
            raise DriverError("engine_error", "Benchmark conditions manifest is invalid.")
        condition_id = row.get("conditionId")
        instance_type = row.get("instanceType")
        if (
            not isinstance(condition_id, str) or not re.fullmatch(r"[a-z0-9-]{1,80}", condition_id)
            or condition_id in conditions
            or instance_type not in {"standard-2", "standard-3"}
            or type(row.get("threads")) is not int or row.get("threads") not in {1, 2}
            or type(row.get("hashMb")) is not int or row.get("hashMb") != 64
            or type(row.get("moveTimeMs")) is not int or row.get("moveTimeMs") not in allowed_times
            or type(row.get("multiPV")) is not int or row.get("multiPV") not in {2, 3}
            or row.get("role") not in {"candidate", "reference"}
        ):
            raise DriverError("engine_error", "Benchmark conditions manifest is invalid.")
        conditions[condition_id] = dict(row)
    if not conditions:
        raise DriverError("engine_error", "Benchmark conditions manifest is empty.")
    return conditions


def _read_text(path: Path) -> str | None:
    try:
        return path.read_text(encoding="ascii").strip()
    except (OSError, UnicodeDecodeError):
        return None


def runtime_facts(expected_instance_type: str | None) -> dict[str, Any]:
    cpu_max = _read_text(Path("/sys/fs/cgroup/cpu.max"))
    cpu_quota: float | None = None
    if cpu_max:
        parts = cpu_max.split()
        if len(parts) == 2 and parts[0] != "max":
            try:
                quota, period = int(parts[0]), int(parts[1])
                if quota > 0 and period > 0:
                    cpu_quota = quota / period
            except ValueError:
                pass
    else:
        quota_raw = _read_text(Path("/sys/fs/cgroup/cpu/cpu.cfs_quota_us"))
        period_raw = _read_text(Path("/sys/fs/cgroup/cpu/cpu.cfs_period_us"))
        if quota_raw and period_raw:
            try:
                quota, period = int(quota_raw), int(period_raw)
                if quota > 0 and period > 0:
                    cpu_quota = quota / period
                    cpu_max = f"{quota} {period}"
            except ValueError:
                pass
    memory_raw = _read_text(Path("/sys/fs/cgroup/memory.max"))
    if memory_raw is None:
        memory_raw = _read_text(Path("/sys/fs/cgroup/memory/memory.limit_in_bytes"))
    try:
        memory_bytes = int(memory_raw) if memory_raw and memory_raw.isdigit() else None
        if memory_bytes is not None and memory_bytes >= (1 << 60):
            memory_bytes = None
    except ValueError:
        memory_bytes = None
    try:
        affinity_cpu_count: int | None = len(os.sched_getaffinity(0))
    except (AttributeError, OSError):
        affinity_cpu_count = None
    return {
        "driverBootId": DRIVER_BOOT_ID,
        "expectedInstanceType": expected_instance_type,
        "osCpuCount": os.cpu_count(),
        "affinityCpuCount": affinity_cpu_count,
        "cpuMax": cpu_max,
        "cpuQuota": cpu_quota,
        "memoryMaxBytes": memory_bytes,
    }


def parse_info_line(line: str, side_to_move: str) -> dict[str, Any] | None:
    tokens = line.strip().split()
    if not tokens or tokens[0] != "info":
        return None
    try:
        depth = int(tokens[tokens.index("depth") + 1])
        rank = int(tokens[tokens.index("multipv") + 1]) if "multipv" in tokens else 1
    except (ValueError, IndexError):
        return None
    if depth < 1 or rank < 1 or rank > MAX_MULTIPV:
        return None

    score: dict[str, Any] | None = None
    exact = True
    if "lowerbound" in tokens or "upperbound" in tokens:
        exact = False
    if "score" in tokens:
        index = tokens.index("score")
        if index + 2 >= len(tokens):
            return None
        kind, raw_value = tokens[index + 1], tokens[index + 2]
        if kind == "cp":
            try:
                value = int(raw_value)
            except ValueError:
                return None
            if side_to_move == "w":
                value = -value
            if abs(value) > 1_000_000:
                return None
            score = {"kind": "cp", "value": value}
        elif kind == "mate":
            try:
                value = int(raw_value)
            except ValueError:
                return None
            if side_to_move == "w":
                value = -value
            winning_side = "sente" if value > 0 else "gote" if value < 0 else "unknown"
            score = {"kind": "mate", "value": value, "winningSide": winning_side}
        else:
            return None
    if score is None:
        exact = False

    try:
        pv_index = tokens.index("pv")
    except ValueError:
        return None
    pv = tokens[pv_index + 1 :]
    if not pv or len(pv) > MAX_MOVES or any(not MOVE_RE.fullmatch(move) for move in pv):
        return None
    try:
        nodes = int(tokens[tokens.index("nodes") + 1]) if "nodes" in tokens else None
        engine_time = int(tokens[tokens.index("time") + 1]) if "time" in tokens else None
        engine_nps = int(tokens[tokens.index("nps") + 1]) if "nps" in tokens else None
    except (ValueError, IndexError):
        return None
    if nodes is not None and nodes < 0:
        return None
    if engine_time is not None and engine_time < 0:
        return None
    if engine_nps is not None and engine_nps < 0:
        return None
    return {
        "depth": depth,
        "rank": rank,
        "score": score,
        "exact": exact,
        "pv": pv,
        "nodes": nodes,
        "engineTime": engine_time,
        "engineNps": engine_nps,
    }


class MultiPvCollector:
    def __init__(self, effective_multi_pv: int, side_to_move: str):
        self.effective_multi_pv = effective_multi_pv
        self.side_to_move = side_to_move
        self.pending_by_depth: dict[int, dict[int, dict[str, Any]]] = {}
        self.completed: dict[int, list[dict[str, Any]]] = {}
        self.nodes: int | None = None
        self.engine_time: int | None = None

    def observe(self, line: str) -> None:
        record = parse_info_line(line, self.side_to_move)
        if not record:
            return
        if record["nodes"] is not None:
            self.nodes = max(self.nodes or 0, record["nodes"])
        if record["engineTime"] is not None:
            self.engine_time = max(self.engine_time or 0, record["engineTime"])
        depth = record["depth"]
        if record["rank"] == 1 or depth not in self.pending_by_depth:
            self.pending_by_depth[depth] = {}
        self.pending_by_depth[depth][record["rank"]] = record
        block = self._completed_block(depth)
        if block is not None:
            self.completed[depth] = block

    def _completed_block(self, depth: int) -> list[dict[str, Any]] | None:
        ranks = self.pending_by_depth.get(depth, {})
        if any(rank not in ranks or not ranks[rank]["exact"] or not ranks[rank]["score"] for rank in range(1, self.effective_multi_pv + 1)):
            return None
        block = [ranks[rank] for rank in range(1, self.effective_multi_pv + 1)]
        if len({entry["pv"][0] for entry in block}) != self.effective_multi_pv:
            return None
        return [dict(entry) for entry in block]

    @property
    def best_block(self) -> tuple[int, list[dict[str, Any]]] | None:
        if not self.completed:
            return None
        depth = max(self.completed)
        return depth, self.completed[depth]


class EngineSession:
    def __init__(self, engine_path: Path, manifest: dict[str, Any], settings: dict[str, Any]):
        self.engine_path = engine_path
        self.manifest = manifest
        self.settings = settings
        self.process: subprocess.Popen[str] | None = None
        self.process_started_monotonic: float | None = None
        self.lines: queue.Queue[str | None] = queue.Queue()
        self.reader: threading.Thread | None = None
        self.engine_name = ""
        self.verification_stop_injected = False

    def start(self) -> None:
        try:
            self.process = subprocess.Popen(
                [str(self.engine_path)],
                cwd=str(self.engine_path.parent),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="ascii",
                errors="replace",
                bufsize=1,
            )
            self.process_started_monotonic = time.monotonic()
        except OSError as error:
            raise DriverError("engine_error", "Engine process could not be started.") from error
        assert self.process.stdout is not None
        self.reader = threading.Thread(target=self._read_stdout, daemon=True)
        self.reader.start()
        self.send("usi")
        deadline = time.monotonic() + self.settings["handshakeTimeoutSeconds"]
        while True:
            line = self.next_line(deadline)
            if line is None:
                raise DriverError("engine_error", "Engine ended during the USI handshake.")
            if line.startswith("id name "):
                self.engine_name = line[len("id name ") :]
            if line == "usiok":
                break
        if self.manifest["engineUsiNameContains"] not in self.engine_name:
            raise IdentityMismatch("The engine USI identity does not match the image manifest.")
        options = self._options_seen
        required = {
            "Threads", "USI_Hash", "MultiPV", "EvalDir", "FV_SCALE", "USI_Ponder",
            "USI_OwnBook", "BookFile", "GenerateAllLegalMoves",
        }
        if not required.issubset(options):
            missing = sorted(required - options)
            raise DriverError("engine_error", "Engine is missing a required fixed option: " + ",".join(missing))
        self.send(f"setoption name Threads value {self.settings.get('threads', THREADS)}")
        self.send(f"setoption name USI_Hash value {self.settings.get('hashMb', HASH_MB)}")
        self.send(f"setoption name MultiPV value {self.settings['effectiveMultiPV']}")
        self.send("setoption name EvalDir value /opt/engine")
        self.send("setoption name FV_SCALE value 40")
        self.send("setoption name USI_Ponder value false")
        self.send("setoption name USI_OwnBook value false")
        self.send("setoption name BookFile value no_book")
        self.send("setoption name GenerateAllLegalMoves value true")
        self.send("isready")
        self._wait_for("readyok", self.settings["readyTimeoutSeconds"])

    @property
    def _options_seen(self) -> set[str]:
        return self.__dict__.setdefault("options_seen", set())

    def send(self, command: str) -> None:
        if self.process is None or self.process.stdin is None or self.process.returncode is not None:
            raise DriverError("engine_error", "Engine process is not running.")
        try:
            self.process.stdin.write(command + "\n")
            self.process.stdin.flush()
        except (BrokenPipeError, OSError) as error:
            raise DriverError("engine_error", "Engine input pipe closed unexpectedly.") from error

    def next_line(self, deadline: float) -> str | None:
        if self.process is None:
            return None
        for remaining in [max(0.0, deadline - time.monotonic())]:
            try:
                line = self.lines.get(timeout=remaining)
            except queue.Empty as error:
                raise TimeoutError from error
            return line
        return None

    def _read_stdout(self) -> None:
        assert self.process is not None and self.process.stdout is not None
        try:
            for line in self.process.stdout:
                clean = line.rstrip("\r\n")
                if clean.startswith("option name "):
                    option = clean[len("option name ") :].split(" type ", 1)[0]
                    self._options_seen.add(option)
                self.lines.put(clean)
        finally:
            self.lines.put(None)

    def _wait_for(self, token: str, timeout_seconds: float) -> None:
        deadline = time.monotonic() + timeout_seconds
        while True:
            line = self.next_line(deadline)
            if line is None:
                raise DriverError("engine_error", f"Engine ended before {token}.")
            if line == token:
                return

    def search(self, sfen: str, collector: MultiPvCollector, stop_after_go: bool = False) -> str:
        self.send("usinewgame")
        self.send(f"position sfen {sfen}")
        move_time_ms = self.settings.get("moveTimeMs", MOVE_TIME_MS)
        self.send(f"go movetime {move_time_ms}")
        if stop_after_go:
            if self.process is None or self.process.returncode is not None:
                raise DriverError("engine_error", "Verification engine process stopped before SIGSTOP.")
            try:
                self.process.send_signal(signal.SIGSTOP)
            except OSError as error:
                raise DriverError("engine_error", "Verification engine process could not be stopped.") from error
            self.verification_stop_injected = True
        deadline = time.monotonic() + (move_time_ms + self.settings["searchGraceMs"]) / 1000
        while True:
            try:
                line = self.next_line(deadline)
            except TimeoutError as error:
                raise SearchTimeout() from error
            if line is None:
                raise DriverError("engine_error", "Engine ended during search.")
            if line.startswith("info "):
                collector.observe(line)
            if line.startswith("bestmove "):
                parts = line.split()
                if len(parts) < 2:
                    raise DriverError("engine_error", "Engine returned a malformed bestmove.")
                move = parts[1]
                if move not in {"resign", "win", "none", "(none)", "0000"} and not MOVE_RE.fullmatch(move):
                    raise DriverError("engine_error", "Engine returned a malformed bestmove.")
                return move

    def stop_and_reap(self) -> dict[str, Any] | None:
        if self.process is None:
            return None
        process = self.process
        if process.returncode is None:
            try:
                self.send("stop")
            except DriverError:
                pass
            try:
                self._wait_for_bestmove(self.settings["stopResponseGraceSeconds"])
            except (DriverError, TimeoutError):
                pass
        return self._terminate_and_reap(process, force_terminate=True)

    def close_after_search(self) -> dict[str, Any] | None:
        if self.process is None:
            return None
        process = self.process
        if process.returncode is None:
            try:
                self.send("quit")
            except DriverError:
                pass
        return self._terminate_and_reap(process)

    def _wait_for_bestmove(self, timeout_seconds: float) -> None:
        deadline = time.monotonic() + timeout_seconds
        while True:
            line = self.next_line(deadline)
            if line is None or line.startswith("bestmove "):
                return

    def _wait4(self, process: subprocess.Popen[str], timeout_seconds: float | None) -> tuple[int, float | None]:
        if process.returncode is not None:
            return process.returncode, None
        if not hasattr(os, "wait4"):
            before = resource.getrusage(resource.RUSAGE_CHILDREN)
            return_code = process.wait(timeout=timeout_seconds)
            after = resource.getrusage(resource.RUSAGE_CHILDREN)
            cpu_seconds = max(0.0, (after.ru_utime - before.ru_utime) + (after.ru_stime - before.ru_stime))
            return return_code, cpu_seconds
        deadline = None if timeout_seconds is None else time.monotonic() + timeout_seconds
        while True:
            try:
                waited_pid, status, usage = os.wait4(process.pid, os.WNOHANG)
            except ChildProcessError:
                # A prior low-level wait is unavailable; Popen remains the final reap fallback.
                return process.wait(timeout=timeout_seconds), None
            if waited_pid == process.pid:
                return_code = os.waitstatus_to_exitcode(status)
                process.returncode = return_code
                cpu_seconds = max(0.0, usage.ru_utime + usage.ru_stime)
                return return_code, cpu_seconds
            if deadline is not None and time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired(process.args, timeout_seconds)
            time.sleep(0.02)

    def _terminate_and_reap(self, process: subprocess.Popen[str], force_terminate: bool = False) -> dict[str, Any]:
        if process.returncode is None:
            if force_terminate:
                try:
                    os.kill(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            try:
                wait_return_code, cpu_seconds = self._wait4(process, self.settings["termGraceSeconds"])
            except subprocess.TimeoutExpired:
                if not force_terminate:
                    try:
                        os.kill(process.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                try:
                    wait_return_code, cpu_seconds = self._wait4(process, self.settings["termGraceSeconds"])
                except subprocess.TimeoutExpired:
                    try:
                        os.kill(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    wait_return_code, cpu_seconds = self._wait4(process, None)
        else:
            wait_return_code, cpu_seconds = process.returncode, None
        # Keep the established Popen wait path as explicit reap evidence. After wait4 has
        # reaped the child, returncode is already set and Popen.wait() returns it directly.
        process.returncode = wait_return_code
        wait_return_code = process.wait()
        process_elapsed_ms = None
        if self.process_started_monotonic is not None:
            process_elapsed_ms = max(1, round((time.monotonic() - self.process_started_monotonic) * 1000))
        if self.reader is not None:
            self.reader.join(timeout=1)
        for pipe in (process.stdin, process.stdout):
            if pipe is not None:
                try:
                    pipe.close()
                except OSError:
                    pass
        return {
            "enginePid": process.pid,
            "waitReturnCode": wait_return_code,
            "processCpuSeconds": cpu_seconds,
            "processElapsedMs": process_elapsed_ms,
        }


def fixed_conditions(effective_multi_pv: int) -> dict[str, int]:
    return {
        "threads": THREADS,
        "hashMb": HASH_MB,
        "moveTimeMs": MOVE_TIME_MS,
        "multiPV": effective_multi_pv,
    }


def _base_result(sfen: str, identity: dict[str, str], effective_multi_pv: int) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "sfen": sfen,
        "perspective": "sente",
        "identity": identity,
        "conditions": {
            "requested": {"threads": THREADS, "hashMb": HASH_MB, "moveTimeMs": MOVE_TIME_MS, "multiPV": MAX_MULTIPV},
            "actual": fixed_conditions(effective_multi_pv),
        },
    }


class AnalysisService:
    def __init__(
        self,
        engine_path: Path = ENGINE_PATH,
        expected_manifest: dict[str, Any] | None = None,
        weight_path: Path = WEIGHT_PATH,
        options_path: Path = OPTIONS_PATH,
        manifest_path: Path = MANIFEST_PATH,
        conditions_manifest_path: Path = CONDITIONS_MANIFEST_PATH,
        settings: dict[str, Any] | None = None,
    ):
        self.engine_path = engine_path
        self.weight_path = weight_path
        self.options_path = options_path
        self.manifest_path = manifest_path
        self.conditions_manifest_path = conditions_manifest_path
        self.manifest = expected_manifest if expected_manifest is not None else verify_identity(
            engine_path, weight_path, options_path, manifest_path
        )
        self.identity = artifact_identity(self.manifest)
        self.settings = {
            "searchGraceMs": SEARCH_GRACE_MS,
            "moveTimeMs": MOVE_TIME_MS,
            "stopResponseGraceSeconds": STOP_RESPONSE_GRACE_SECONDS,
            "termGraceSeconds": TERM_GRACE_SECONDS,
            "killGraceSeconds": KILL_GRACE_SECONDS,
            "handshakeTimeoutSeconds": HANDSHAKE_TIMEOUT_SECONDS,
            "readyTimeoutSeconds": READY_TIMEOUT_SECONDS,
        }
        if settings:
            self.settings.update(settings)
        self.busy = threading.Lock()
        self.verify_stop_engine_once_enabled = os.environ.get("ANALYSIS_VERIFY_STOP_ENGINE_ONCE") == "1"
        self.verify_stop_engine_once_pending = self.verify_stop_engine_once_enabled
        self.benchmark_enabled = os.environ.get("ANALYSIS_BENCHMARK_ENABLED") == "1"
        expected_instance_type = os.environ.get("ANALYSIS_EXPECTED_INSTANCE_TYPE")
        self.expected_instance_type = expected_instance_type if expected_instance_type in {"standard-2", "standard-3"} else None
        self.benchmark_conditions = load_benchmark_conditions(conditions_manifest_path)
        self.engine_epoch = 0

    def health(self) -> dict[str, Any]:
        digest_keys = (
            "engineSha256",
            "weightSha256",
            "optionsSha256",
            "sourceArchiveSha256",
            "sourceTreeSha256",
        )
        return {
            "schemaVersion": 1,
            "status": "ready",
            "driverBootId": DRIVER_BOOT_ID,
            "expectedInstanceType": self.expected_instance_type,
            "runtime": runtime_facts(self.expected_instance_type),
            "verifyStopEngineOnceEnabled": self.verify_stop_engine_once_enabled,
            "verifyStopEngineOnceConsumed": (
                self.verify_stop_engine_once_enabled and not self.verify_stop_engine_once_pending
            ),
            "driverVersion": self.identity["driverVersion"],
            "contractVersion": self.identity["contractVersion"],
            "identityDigests": {key: self.identity[key] for key in digest_keys},
        }

    def response(self, payload: Any) -> tuple[int, dict[str, Any]]:
        if not isinstance(payload, dict) or set(payload) != {"sfen", "legalMoveCount"}:
            return 400, {"schemaVersion": 1, "sfen": None, "perspective": "sente", "status": "failure", "failure": {"code": "invalid", "message": "Expected an SFEN and verified legal move count."}, "identity": self.identity}
        sfen = payload["sfen"]
        legal_move_count = payload["legalMoveCount"]
        if not is_valid_sfen(sfen) or not isinstance(legal_move_count, int) or isinstance(legal_move_count, bool) or not 1 <= legal_move_count <= 600:
            return 400, {"schemaVersion": 1, "sfen": sfen if isinstance(sfen, str) else None, "perspective": "sente", "status": "failure", "failure": {"code": "invalid", "message": "Invalid analysis input."}, "identity": self.identity}
        if not self.busy.acquire(blocking=False):
            result = _base_result(sfen, self.identity, min(MAX_MULTIPV, legal_move_count))
            result.update({"status": "failure", "failure": {"code": "busy", "message": "An analysis is already running."}})
            return 409, result
        try:
            stop_engine = self.verify_stop_engine_once_pending
            self.verify_stop_engine_once_pending = False
            return self._analyze_one(
                sfen,
                legal_move_count,
                verification_enabled=self.verify_stop_engine_once_enabled,
                stop_engine=stop_engine,
            )
        finally:
            self.busy.release()

    def benchmark_response(self, payload: Any) -> tuple[int, dict[str, Any]]:
        if not self.benchmark_enabled:
            return 404, {"schemaVersion": 2, "contractVersion": "analysis-json-v2", "status": "failure", "failure": {"code": "invalid", "message": "Not found."}}
        if not isinstance(payload, dict) or set(payload) != {"sfen", "legalMoveCount", "conditionId"}:
            return 400, {"schemaVersion": 2, "contractVersion": "analysis-json-v2", "status": "failure", "failure": {"code": "invalid", "message": "Expected an SFEN, verified legal move count, and manifest condition ID."}}
        sfen = payload["sfen"]
        legal_move_count = payload["legalMoveCount"]
        condition_id = payload["conditionId"]
        if (
            not is_valid_sfen(sfen) or not isinstance(legal_move_count, int) or isinstance(legal_move_count, bool)
            or not 1 <= legal_move_count <= 600 or not isinstance(condition_id, str)
        ):
            return 400, {"schemaVersion": 2, "contractVersion": "analysis-json-v2", "sfen": sfen if isinstance(sfen, str) else None, "status": "failure", "failure": {"code": "invalid", "message": "Invalid benchmark input."}}
        condition = self.benchmark_conditions.get(condition_id)
        if condition is None:
            return 400, {"schemaVersion": 2, "contractVersion": "analysis-json-v2", "sfen": sfen, "status": "failure", "failure": {"code": "invalid", "message": "Unknown benchmark condition."}}
        if self.expected_instance_type is None or condition["instanceType"] != self.expected_instance_type:
            return 409, {"schemaVersion": 2, "contractVersion": "analysis-json-v2", "sfen": sfen, "status": "failure", "failure": {"code": "invalid", "message": "Benchmark condition does not match the deployed instance type."}}
        if not self.busy.acquire(blocking=False):
            return 409, self._benchmark_base(sfen, condition, min(condition["multiPV"], legal_move_count), self.engine_epoch) | {
                "status": "failure", "failure": {"code": "busy", "message": "An analysis is already running."},
            }
        try:
            return self._analyze_benchmark(sfen, legal_move_count, condition)
        finally:
            self.busy.release()

    def _benchmark_base(
        self,
        sfen: str,
        condition: dict[str, Any],
        effective_multi_pv: int,
        engine_epoch: int,
    ) -> dict[str, Any]:
        actual = {
            "instanceType": condition["instanceType"],
            "threads": condition["threads"],
            "hashMb": condition["hashMb"],
            "moveTimeMs": condition["moveTimeMs"],
            "multiPV": condition["multiPV"],
            "effectiveMultiPV": effective_multi_pv,
        }
        return {
            "schemaVersion": 2,
            "contractVersion": "analysis-json-v2",
            "sfen": sfen,
            "perspective": "sente",
            "conditionId": condition["conditionId"],
            "expectedInstanceType": self.expected_instance_type,
            "driverBootId": DRIVER_BOOT_ID,
            "engineEpoch": engine_epoch,
            "driverVersion": self.identity["driverVersion"],
            "runtime": runtime_facts(self.expected_instance_type),
            "conditions": {
                "requested": {key: condition[key] for key in ("conditionId", "instanceType", "threads", "hashMb", "moveTimeMs", "multiPV")},
                "actual": actual,
            },
            "candidates": [],
            "meta": {
                "nodes": None,
                "completedDepth": None,
                "searchElapsedMs": None,
                "engineNps": None,
                "derivedNps": None,
                "processElapsedMs": None,
                "processCpuSeconds": None,
            },
        }

    def _analyze_benchmark(
        self,
        sfen: str,
        legal_move_count: int,
        condition: dict[str, Any],
    ) -> tuple[int, dict[str, Any]]:
        self.engine_epoch += 1
        engine_epoch = self.engine_epoch
        effective = min(condition["multiPV"], legal_move_count)
        result = self._benchmark_base(sfen, condition, effective, engine_epoch)
        collector = MultiPvCollector(effective, side_to_move=sfen.split(" ")[1])
        session = EngineSession(
            self.engine_path,
            self.manifest,
            {
                **self.settings,
                "threads": condition["threads"],
                "hashMb": condition["hashMb"],
                "moveTimeMs": condition["moveTimeMs"],
                "effectiveMultiPV": effective,
            },
        )
        timed_out = False
        engine_outcome: str | None = None
        error: DriverError | None = None
        reap_evidence: dict[str, Any] | None = None
        try:
            session.start()
            engine_outcome = session.search(sfen, collector)
        except SearchTimeout:
            timed_out = True
        except DriverError as caught:
            error = caught
        except TimeoutError:
            error = DriverError("engine_error", "Engine handshake timed out.")
        finally:
            reap_evidence = session.stop_and_reap() if timed_out else session.close_after_search()

        if reap_evidence:
            result["meta"]["processElapsedMs"] = reap_evidence["processElapsedMs"]
            result["meta"]["processCpuSeconds"] = reap_evidence["processCpuSeconds"]
        block = collector.best_block
        if error is not None:
            result.update({"status": "failure", "failure": {"code": error.code, "message": error.message}})
            return (502 if error.code != "timeout" else 504), result
        if timed_out:
            if block:
                depth, records = block
                top = records[0]
                result["meta"].update({
                    "nodes": top["nodes"], "completedDepth": depth, "searchElapsedMs": top["engineTime"],
                    "engineNps": top["engineNps"],
                    "derivedNps": (top["nodes"] * 1000 / top["engineTime"]) if top["nodes"] is not None and top["engineTime"] else None,
                })
            result.update({"status": "failure", "failure": {"code": "timeout", "message": "The engine exceeded the condition deadline."}})
            return 504, result
        if engine_outcome in {"resign", "none", "(none)", "0000", "win"}:
            result["status"] = "incomplete" if engine_outcome == "resign" else "failure"
            if result["status"] == "failure":
                result["failure"] = {"code": "engine_error", "message": "Engine returned an unsupported bestmove."}
                return 502, result
            return 200, result
        if block is None:
            result["status"] = "incomplete"
            return 200, result
        depth, records = block
        top = records[0]
        result["candidates"] = [
            {"move": record["pv"][0], "pv": record["pv"], "score": record["score"]}
            for record in records
        ]
        result["meta"].update({
            "nodes": top["nodes"],
            "completedDepth": depth,
            "searchElapsedMs": top["engineTime"],
            "engineNps": top["engineNps"],
            "derivedNps": (top["nodes"] * 1000 / top["engineTime"]) if top["nodes"] is not None and top["engineTime"] else None,
        })
        if result["meta"]["nodes"] is None or result["meta"]["searchElapsedMs"] is None:
            result.update({"status": "failure", "failure": {"code": "engine_error", "message": "Completed search omitted its same-line nodes or USI time."}})
            return 502, result
        result["status"] = "success"
        return 200, result

    def _analyze_one(
        self,
        sfen: str,
        legal_move_count: int,
        verification_enabled: bool = False,
        stop_engine: bool = False,
    ) -> tuple[int, dict[str, Any]]:
        self.engine_epoch += 1
        engine_epoch = self.engine_epoch
        effective = min(MAX_MULTIPV, legal_move_count)
        result = _base_result(sfen, self.identity, effective)
        collector = MultiPvCollector(effective, side_to_move=sfen.split(" ")[1])
        started = time.monotonic()
        session = EngineSession(
            self.engine_path,
            self.manifest,
            {**self.settings, "effectiveMultiPV": effective},
        )
        timed_out = False
        engine_outcome: str | None = None
        reap_evidence: dict[str, int] | None = None
        try:
            session.start()
            engine_outcome = session.search(sfen, collector, stop_after_go=stop_engine)
        except SearchTimeout:
            timed_out = True
        except IdentityMismatch as error:
            result.update({"status": "failure", "failure": {"code": "identity_mismatch", "message": error.message}})
            return 502, result
        except (DriverError, TimeoutError) as error:
            result.update({"status": "failure", "failure": {"code": "engine_error", "message": error.message if isinstance(error, DriverError) else "Engine handshake timed out."}})
            return 502, result
        finally:
            if timed_out:
                reap_evidence = session.stop_and_reap()
            else:
                reap_evidence = session.close_after_search()

        if verification_enabled and reap_evidence is not None:
            result["verification"] = {
                "driverBootId": DRIVER_BOOT_ID,
                "engineEpoch": engine_epoch,
                "enginePid": reap_evidence["enginePid"],
                "engineReaped": True,
                "waitReturned": True,
                "waitReturnCode": reap_evidence["waitReturnCode"],
                "stopInjected": session.verification_stop_injected,
            }

        elapsed_ms = max(1, round((time.monotonic() - started) * 1000))
        block = collector.best_block
        if timed_out:
            result.update({
                "status": "failure",
                "failure": {"code": "timeout", "message": "The engine exceeded the fixed search deadline."},
                "meta": {
                    "nodes": collector.nodes if collector.nodes and collector.nodes > 0 else None,
                    "completedDepth": block[0] if block else None,
                    "elapsedMs": elapsed_ms,
                },
            })
            return 504, result

        if engine_outcome == "resign":
            result.update({
                "status": "incomplete",
                "terminal": None,
                "engineOutcome": "resign",
                "candidates": [],
                "meta": {
                    "nodes": collector.nodes if collector.nodes and collector.nodes > 0 else None,
                    "completedDepth": None,
                    "elapsedMs": elapsed_ms,
                },
            })
            return 200, result
        if engine_outcome in {"none", "(none)", "0000", "win"}:
            result.update({"status": "failure", "failure": {"code": "engine_error", "message": "Engine returned an unsupported bestmove."}})
            return 502, result

        if block is None:
            result.update({
                "status": "incomplete",
                "terminal": None,
                "candidates": [],
                "meta": {
                    "nodes": collector.nodes if collector.nodes and collector.nodes > 0 else None,
                    "completedDepth": None,
                    "elapsedMs": elapsed_ms,
                },
            })
            return 200, result
        depth, records = block
        candidates = [{"move": record["pv"][0], "pv": record["pv"], "score": record["score"]} for record in records]
        result.update({
            "status": "success",
            "terminal": None,
            "candidates": candidates,
            "meta": {
                "nodes": collector.nodes if collector.nodes and collector.nodes > 0 else None,
                "completedDepth": depth,
                "elapsedMs": elapsed_ms,
            },
        })
        if result["meta"]["nodes"] is None:
            result.update({"status": "failure", "failure": {"code": "engine_error", "message": "Completed search omitted node counts."}})
            return 502, result
        return 200, result


def driver_get_response(service: AnalysisService, path: str) -> tuple[int, dict[str, Any]]:
    if path == "/health":
        return 200, service.health()
    if path == "/ping":
        return 200, {"status": "ready"}
    return 404, {"status": "failure", "failure": {"code": "invalid"}}


def create_handler(service: AnalysisService) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self) -> None:
            status, response = driver_get_response(service, self.path)
            self._write(status, response)

        def do_POST(self) -> None:
            if self.path not in {"/analyze", "/benchmark"}:
                self._write(404, {"schemaVersion": 1, "sfen": None, "status": "failure", "failure": {"code": "invalid", "message": "Unknown route."}})
                return
            if self.path == "/benchmark" and not service.benchmark_enabled:
                self._write(404, {"schemaVersion": 2, "contractVersion": "analysis-json-v2", "status": "failure", "failure": {"code": "invalid", "message": "Not found."}})
                return
            content_type = self.headers.get("content-type", "").split(";", 1)[0].lower()
            if content_type != "application/json":
                self._write(415, {"schemaVersion": 1, "sfen": None, "status": "failure", "failure": {"code": "invalid", "message": "Expected application/json."}})
                return
            try:
                length = int(self.headers.get("content-length", "-1"))
            except ValueError:
                length = -1
            if length < 0 or length > MAX_BODY_BYTES:
                self._write(413, {"schemaVersion": 1, "sfen": None, "status": "failure", "failure": {"code": "invalid", "message": "Request body exceeds the limit."}})
                return
            try:
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._write(400, {"schemaVersion": 1, "sfen": None, "status": "failure", "failure": {"code": "invalid", "message": "Request body is not valid JSON."}})
                return
            status, response = service.benchmark_response(payload) if self.path == "/benchmark" else service.response(payload)
            self._write(status, response)

        def _write(self, status: int, value: dict[str, Any]) -> None:
            encoded = json.dumps(value, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(encoded)

        def log_message(self, _format: str, *_args: Any) -> None:
            return

    return Handler


def main() -> None:
    # Identity verification runs before the HTTP listener opens. A mismatched image fails closed.
    service = AnalysisService()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), create_handler(service))
    server.daemon_threads = True
    server.serve_forever(poll_interval=0.25)


if __name__ == "__main__":
    main()
