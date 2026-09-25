#!/usr/bin/env python3
"""Bounded HTTP-to-USI adapter for the private staging engine image."""

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
MANIFEST_PATH = Path(os.environ.get("ARTIFACT_MANIFEST_PATH", "/opt/app/artifact-manifest.json"))

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
SFEN_RE = re.compile(r"^[1-9KkLlNnSsGgBbRrPp/+ bw-]+$")
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
    except (ValueError, IndexError):
        return None
    if nodes is not None and nodes < 0:
        return None
    if engine_time is not None and engine_time < 0:
        return None
    return {
        "depth": depth,
        "rank": rank,
        "score": score,
        "exact": exact,
        "pv": pv,
        "nodes": nodes,
        "engineTime": engine_time,
    }


class MultiPvCollector:
    def __init__(self, effective_multi_pv: int, side_to_move: str):
        self.effective_multi_pv = effective_multi_pv
        self.side_to_move = side_to_move
        self.by_depth: dict[int, dict[int, dict[str, Any]]] = {}
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
        self.by_depth.setdefault(depth, {})[record["rank"]] = record
        block = self._completed_block(depth)
        if block is not None:
            self.completed[depth] = block

    def _completed_block(self, depth: int) -> list[dict[str, Any]] | None:
        ranks = self.by_depth.get(depth, {})
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
        self.send(f"setoption name Threads value {THREADS}")
        self.send(f"setoption name USI_Hash value {HASH_MB}")
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
        if self.process is None or self.process.stdin is None or self.process.poll() is not None:
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
            if self.process is None or self.process.poll() is not None:
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

    def stop_and_reap(self) -> dict[str, int] | None:
        if self.process is None:
            return None
        process = self.process
        if process.poll() is None:
            try:
                self.send("stop")
            except DriverError:
                pass
            try:
                self._wait_for_bestmove(self.settings["stopResponseGraceSeconds"])
            except (DriverError, TimeoutError):
                pass
        return {"enginePid": process.pid, "waitReturnCode": self._terminate_and_reap(process, force_terminate=True)}

    def close_after_search(self) -> dict[str, int] | None:
        if self.process is None:
            return None
        process = self.process
        if process.poll() is None:
            try:
                self.send("quit")
            except DriverError:
                pass
        return {"enginePid": process.pid, "waitReturnCode": self._terminate_and_reap(process)}

    def _wait_for_bestmove(self, timeout_seconds: float) -> None:
        deadline = time.monotonic() + timeout_seconds
        while True:
            line = self.next_line(deadline)
            if line is None or line.startswith("bestmove "):
                return

    def _terminate_and_reap(self, process: subprocess.Popen[str], force_terminate: bool = False) -> int:
        if process.poll() is None:
            if force_terminate:
                process.terminate()
            try:
                process.wait(timeout=self.settings["termGraceSeconds"])
            except subprocess.TimeoutExpired:
                if not force_terminate:
                    process.terminate()
                try:
                    process.wait(timeout=self.settings["termGraceSeconds"])
                except subprocess.TimeoutExpired:
                    process.kill()
                    try:
                        process.wait(timeout=self.settings["killGraceSeconds"])
                    except subprocess.TimeoutExpired:
                        # wait() after SIGKILL is required so the child is not left as a zombie.
                        process.wait()
        else:
            process.wait()
        # Always call wait() and retain its return code as explicit reap evidence.
        wait_return_code = process.wait()
        if self.reader is not None:
            self.reader.join(timeout=1)
        for pipe in (process.stdin, process.stdout):
            if pipe is not None:
                try:
                    pipe.close()
                except OSError:
                    pass
        return wait_return_code


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
        settings: dict[str, Any] | None = None,
    ):
        self.engine_path = engine_path
        self.weight_path = weight_path
        self.options_path = options_path
        self.manifest_path = manifest_path
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
            if self.path != "/analyze":
                self._write(404, {"schemaVersion": 1, "sfen": None, "status": "failure", "failure": {"code": "invalid", "message": "Unknown route."}})
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
            status, response = service.response(payload)
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
