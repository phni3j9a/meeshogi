from __future__ import annotations

import hashlib
import http.client
import json
import os
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import driver as driver_module
from driver import (
    AnalysisService,
    JOB_PROFILES_PATH,
    MAX_SESSION_BODY_BYTES,
    MAX_SESSION_POSITIONS,
    SESSION_CONTRACT,
    create_handler,
    load_job_profiles,
)


STARTPOS = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1"
OPTIONS = b"FV_SCALE 40\n"
GIB = 1 << 30

JOB_PROFILES = {
    "schema": "meeshogi-job-config-v1",
    "profiles": {
        "free": {"instanceType": "standard-2", "threads": 1, "hashMb": 64, "moveTimeMs": 50, "multiPV": 3},
        "precision": {"instanceType": "standard-3", "threads": 2, "hashMb": 64, "moveTimeMs": 5000, "multiPV": 3},
    },
    "limits": {"timeZone": "Asia/Tokyo", "freeDailyJobs": 5},
    "consumer": {"budgetMs": 720000},
}


def session_runtime(expected_instance_type: str | None) -> dict:
    expected_cpu = 1 if expected_instance_type == "standard-2" else 2
    expected_memory = (6 if expected_instance_type == "standard-2" else 8) * GIB
    return {
        "driverBootId": driver_module.DRIVER_BOOT_ID,
        "expectedInstanceType": expected_instance_type,
        "osCpuCount": expected_cpu,
        "affinityCpuCount": expected_cpu,
        "cpuMax": None,
        "cpuQuota": None,
        "memoryMaxBytes": None,
        "memTotalBytes": expected_memory - (GIB // 2),
        "rootDiskTotalBytes": 32 * GIB,
    }


SESSION_FAKE_ENGINE = r'''#!/usr/bin/env python3
import os
import queue
import signal
import sys
import threading
import time

scenario = os.environ.get("DRIVER_FAKE_SCENARIO", "normal")
counter_path = os.environ["DRIVER_FAKE_COUNTER"]
command_path = os.environ["DRIVER_FAKE_COMMANDS"]
try:
    boot = int(open(counter_path, encoding="ascii").read()) + 1
except FileNotFoundError:
    boot = 1
open(counter_path, "w", encoding="ascii").write(str(boot))
with open(os.environ["DRIVER_FAKE_PIDS"], "a", encoding="ascii") as output:
    output.write(str(os.getpid()) + "\n")

commands = queue.Queue()
def read_stdin():
    for raw in sys.stdin:
        command = raw.strip()
        with open(command_path, "a", encoding="utf-8") as output:
            output.write(command + "\n")
        commands.put(command)
threading.Thread(target=read_stdin, daemon=True).start()

def emit_info(score_offset=0):
    print(f"info depth 2 multipv 1 score cp {41 + score_offset} nodes 1001 time 12 pv 7g7f 3c3d", flush=True)
    print("info depth 2 multipv 2 score cp -15 nodes 1001 time 12 pv 2g2f 8c8d", flush=True)
    print("info depth 2 multipv 3 score cp 7 nodes 1001 time 12 pv 6g6f 4c4d", flush=True)

go_count = 0
for command in iter(commands.get, None):
    if command == "usi":
        if scenario == "handshake-exit" and boot == 1:
            os._exit(1)
        print("id name Fake USI Engine", flush=True)
        for name in ["Threads", "USI_Hash", "MultiPV", "EvalDir", "FV_SCALE", "USI_Ponder", "USI_OwnBook", "BookFile", "GenerateAllLegalMoves"]:
            print(f"option name {name} type string default test", flush=True)
        print("usiok", flush=True)
    elif command == "isready":
        print("readyok", flush=True)
    elif command.startswith("go "):
        go_count += 1
        if scenario == "crash-on-second-go" and go_count == 2:
            print("info depth 3 multipv 1 score cp 42 nodes 4242 time 77 pv 7g7f 3c3d", flush=True)
            os._exit(23)
        if scenario == "hang-on-second-go" and go_count == 2:
            while True:
                time.sleep(1)
        if scenario == "resign-second-go" and go_count == 2:
            print("bestmove resign", flush=True)
            continue
        emit_info(go_count)
        print("bestmove 7g7f", flush=True)
        if scenario == "straggler":
            # Stale output from the finished search must not leak into the next
            # position's collector when the same process is reused.
            print("info depth 30 multipv 1 score cp 9999 nodes 999999 time 999 pv 9a9b 1a1b", flush=True)
            print("info depth 30 multipv 2 score cp 9998 nodes 999999 time 999 pv 8a8b 2a2b", flush=True)
            print("info depth 30 multipv 3 score cp 9997 nodes 999999 time 999 pv 7a7b 3a3b", flush=True)
    elif command == "quit":
        break
'''


class SessionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="meeshogi-session-")
        self.root = Path(self.temp.name)
        self.engine_path = self.root / "fake-engine"
        self.engine_path.write_text(SESSION_FAKE_ENGINE, encoding="utf-8")
        self.engine_path.chmod(0o750)
        self.weight_path = self.root / "fake.nn"
        self.weight_path.write_bytes(b"synthetic weight for offline tests")
        self.options_path = self.root / "engine_options.txt"
        self.options_path.write_bytes(OPTIONS)
        self.manifest_path = self.root / "artifact-manifest.json"
        self.manifest = {
            "schemaVersion": 1,
            "engineName": "Fake USI Engine",
            "engineUsiNameContains": "Fake USI Engine",
            "engineSha256": self.digest(self.engine_path),
            "modelId": "synthetic-test-model",
            "weightSha256": self.digest(self.weight_path),
            "optionsSha256": self.digest(self.options_path),
            "optionsText": "FV_SCALE 40\n",
            "sourceArchive": "synthetic-fixture-only",
            "sourceArchiveSha256": "a" * 64,
            "sourceTreeSha256": "b" * 64,
            "buildInfo": "offline synthetic fake USI process",
            "driverVersion": "test-driver",
            "contractVersion": "test-contract",
        }
        self.manifest_path.write_text(json.dumps(self.manifest), encoding="utf-8")
        self.profiles_path = self.root / "job-profiles.json"
        self.profiles_path.write_text(json.dumps(JOB_PROFILES), encoding="utf-8")
        self.counter_path = self.root / "counter.txt"
        self.commands_path = self.root / "commands.txt"
        self.pids_path = self.root / "pids.txt"

    def tearDown(self) -> None:
        for name in (
            "DRIVER_FAKE_SCENARIO",
            "DRIVER_FAKE_COUNTER",
            "DRIVER_FAKE_COMMANDS",
            "DRIVER_FAKE_PIDS",
            "ANALYSIS_EXPECTED_INSTANCE_TYPE",
            "ANALYSIS_BENCHMARK_ENABLED",
            "ANALYSIS_VERIFY_STOP_ENGINE_ONCE",
        ):
            os.environ.pop(name, None)
        self.temp.cleanup()

    @staticmethod
    def digest(path: Path) -> str:
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def service(
        self,
        scenario: str = "normal",
        extra_settings: dict | None = None,
        expected_instance_type: str = "standard-2",
        monotonic=None,
    ) -> AnalysisService:
        os.environ["DRIVER_FAKE_SCENARIO"] = scenario
        os.environ["DRIVER_FAKE_COUNTER"] = str(self.counter_path)
        os.environ["DRIVER_FAKE_COMMANDS"] = str(self.commands_path)
        os.environ["DRIVER_FAKE_PIDS"] = str(self.pids_path)
        os.environ["ANALYSIS_EXPECTED_INSTANCE_TYPE"] = expected_instance_type
        settings = {
            "moveTimeMs": 50,
            "searchGraceMs": 100,
            "stopResponseGraceSeconds": 0.05,
            "termGraceSeconds": 0.05,
            "killGraceSeconds": 0.3,
            "handshakeTimeoutSeconds": 2,
            "readyTimeoutSeconds": 2,
            "sessionDrainMs": 50,
        }
        settings.update(extra_settings or {})
        patcher = patch.object(driver_module, "runtime_facts", side_effect=session_runtime)
        patcher.start()
        self.addCleanup(patcher.stop)
        return AnalysisService(
            engine_path=self.engine_path,
            expected_manifest=self.manifest,
            settings=settings,
            job_profiles_path=self.profiles_path,
            monotonic=monotonic,
        )

    def payload(
        self,
        positions: list[dict] | None = None,
        profile_id: str = "free",
        deadline_ms: int = 600_000,
        **overrides,
    ) -> dict:
        profile = JOB_PROFILES["profiles"][profile_id]
        request = {
            "contract": SESSION_CONTRACT,
            "profileId": profile_id,
            "conditions": {key: profile[key] for key in ("threads", "hashMb", "moveTimeMs", "multiPV")},
            "positions": positions if positions is not None else [{"ply": index, "sfen": STARTPOS} for index in range(3)],
            "deadlineMs": deadline_ms,
        }
        request.update(overrides)
        return request

    def run_session(self, service: AnalysisService, payload: dict, emit=None) -> tuple[int, list]:
        status, outcome = service.session_response(payload)
        if status != 200:
            return status, [outcome]
        lines = []
        try:
            for line in outcome:
                lines.append(line)
                if emit is not None:
                    emit(line)
        finally:
            outcome.close()
        return 200, lines

    def engine_pids(self) -> list[int]:
        if not self.pids_path.exists():
            return []
        return [int(raw) for raw in self.pids_path.read_text(encoding="ascii").splitlines()]

    def engine_boots(self) -> int:
        return int(self.counter_path.read_text(encoding="ascii").strip())

    def commands(self) -> list[str]:
        if not self.commands_path.exists():
            return []
        return self.commands_path.read_text(encoding="ascii").splitlines()

    def assert_dead(self, pid: int) -> None:
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def analyze_after_reap(self, service: AnalysisService, timeout: float = 3.0) -> tuple[int, dict]:
        deadline = time.monotonic() + timeout
        while True:
            code, result = service.response({"sfen": STARTPOS, "legalMoveCount": 30})
            if code != 409 or time.monotonic() >= deadline:
                return code, result
            time.sleep(0.02)

    def test_repo_job_profiles_file_loads_with_approved_values(self) -> None:
        profiles = load_job_profiles(JOB_PROFILES_PATH)
        self.assertEqual(
            profiles["free"],
            {"instanceType": "standard-2", "threads": 1, "hashMb": 64, "moveTimeMs": 1000, "multiPV": 2},
        )
        self.assertEqual(
            profiles["precision"],
            {"instanceType": "standard-3", "threads": 2, "hashMb": 64, "moveTimeMs": 5000, "multiPV": 3},
        )

    def test_session_reuses_one_engine_process_for_all_positions(self) -> None:
        service = self.service()
        status, lines = self.run_session(service, self.payload())
        self.assertEqual(status, 200)
        self.assertEqual([line["type"] for line in lines], ["session", "result", "result", "result", "end"])

        session_line = lines[0]
        self.assertEqual(session_line["contract"], "analysis-session-v1")
        self.assertEqual(session_line["profileId"], "free")
        self.assertEqual(session_line["conditions"], {"threads": 1, "hashMb": 64, "moveTimeMs": 50, "multiPV": 3})
        self.assertEqual(session_line["identity"], service.identity)
        self.assertEqual(session_line["driverBootId"], driver_module.DRIVER_BOOT_ID)
        self.assertEqual(session_line["engineLaunch"], 1)

        for index, line in enumerate(lines[1:4]):
            self.assertEqual(set(line), {"type", "ply", "engineLaunch", "result"})
            self.assertEqual(line["ply"], index)
            self.assertEqual(line["engineLaunch"], 1)
            result = line["result"]
            self.assertEqual(result["status"], "success")
            self.assertEqual(result["schemaVersion"], 1)
            self.assertEqual(result["perspective"], "sente")
            self.assertEqual(result["identity"], service.identity)
            self.assertEqual(result["conditions"]["requested"], {"threads": 1, "hashMb": 64, "moveTimeMs": 50, "multiPV": 3})
            self.assertEqual(result["conditions"]["actual"], {"threads": 1, "hashMb": 64, "moveTimeMs": 50, "multiPV": 3})
            self.assertEqual(len(result["candidates"]), 3)
            self.assertEqual(result["candidates"][0]["score"], {"kind": "cp", "value": 41 + index + 1})
            self.assertEqual(result["meta"]["nodes"], 1001)

        self.assertEqual(
            lines[4],
            {"type": "end", "analyzed": 3, "reason": "complete", "engineLaunches": 1},
        )

        self.assertEqual(self.engine_boots(), 1)
        self.assertEqual(len(self.engine_pids()), 1)
        self.assertEqual(
            self.commands(),
            [
                "usi",
                "setoption name Threads value 1",
                "setoption name USI_Hash value 64",
                "setoption name MultiPV value 3",
                "setoption name EvalDir value /opt/engine",
                "setoption name FV_SCALE value 40",
                "setoption name USI_Ponder value false",
                "setoption name USI_OwnBook value false",
                "setoption name BookFile value no_book",
                "setoption name GenerateAllLegalMoves value true",
                "isready",
                "usinewgame",
                "position sfen " + STARTPOS,
                "go movetime 50",
                "usinewgame",
                "position sfen " + STARTPOS,
                "go movetime 50",
                "usinewgame",
                "position sfen " + STARTPOS,
                "go movetime 50",
                "quit",
            ],
        )
        self.assert_dead(self.engine_pids()[0])

    def test_session_effective_multi_pv_uses_legal_move_count(self) -> None:
        service = self.service()
        positions = [
            {"ply": 0, "sfen": STARTPOS, "legalMoveCount": 2},
            {"ply": 1, "sfen": STARTPOS, "legalMoveCount": 30},
            {"ply": 2, "sfen": STARTPOS},
        ]
        status, lines = self.run_session(service, self.payload(positions=positions))
        self.assertEqual(status, 200)
        results = [line["result"] for line in lines if line["type"] == "result"]
        self.assertEqual([result["conditions"]["actual"]["multiPV"] for result in results], [2, 3, 3])
        self.assertEqual([len(result["candidates"]) for result in results], [2, 3, 3])

    def test_session_collectors_do_not_inherit_stale_engine_output(self) -> None:
        service = self.service("straggler")
        status, lines = self.run_session(service, self.payload())
        self.assertEqual(status, 200)
        results = [line["result"] for line in lines if line["type"] == "result"]
        for index, result in enumerate(results):
            self.assertEqual(result["status"], "success")
            self.assertEqual(result["meta"]["completedDepth"], 2)
            self.assertEqual(result["meta"]["nodes"], 1001)
            self.assertEqual(result["candidates"][0]["score"], {"kind": "cp", "value": 41 + index + 1})
        self.assertEqual(lines[-1], {"type": "end", "analyzed": 3, "reason": "complete", "engineLaunches": 1})

    def test_session_deadline_stops_before_another_search(self) -> None:
        now = [0.0]
        service = self.service(monotonic=lambda: now[0])

        def emit(_line: dict) -> None:
            # One emitted line costs 600 ms of wall budget; a position needs
            # moveTimeMs 50 + margin 600 = 650 remaining to start.
            now[0] += 0.6

        status, lines = self.run_session(service, self.payload(deadline_ms=1850), emit=emit)
        self.assertEqual(status, 200)
        self.assertEqual(lines[-1], {"type": "end", "analyzed": 2, "reason": "deadline", "engineLaunches": 1})
        self.assertEqual([line["ply"] for line in lines if line["type"] == "result"], [0, 1])
        self.assertEqual([command for command in self.commands() if command.startswith("go ")], ["go movetime 50", "go movetime 50"])
        self.assert_dead(self.engine_pids()[0])

    def test_session_deadline_before_first_position_searches_nothing(self) -> None:
        service = self.service()
        status, lines = self.run_session(service, self.payload(deadline_ms=1))
        self.assertEqual(status, 200)
        self.assertEqual([line["type"] for line in lines], ["session", "end"])
        self.assertEqual(lines[-1]["reason"], "deadline")
        self.assertEqual(lines[-1]["analyzed"], 0)
        self.assertNotIn("go movetime", "\n".join(self.commands()))
        self.assert_dead(self.engine_pids()[0])

    def test_session_engine_crash_is_reaped_and_next_request_uses_fresh_process(self) -> None:
        service = self.service("crash-on-second-go")
        status, lines = self.run_session(service, self.payload())
        self.assertEqual(status, 200)
        self.assertEqual([line["type"] for line in lines], ["session", "result", "result", "end"])
        first, crashed = lines[1]["result"], lines[2]["result"]
        self.assertEqual(first["status"], "success")
        self.assertEqual(lines[2]["ply"], 1)
        self.assertEqual(crashed["status"], "failure")
        self.assertEqual(crashed["failure"]["code"], "engine_error")
        self.assertEqual(lines[-1]["reason"], "error")
        self.assertEqual(lines[-1]["analyzed"], 2)
        self.assertEqual(lines[-1]["engineLaunches"], 1)
        self.assertEqual(lines[-1]["code"], "engine_error")
        crashed_pid = self.engine_pids()[0]
        self.assert_dead(crashed_pid)

        code, result = self.analyze_after_reap(service)
        self.assertEqual(code, 200)
        self.assertEqual(result["status"], "success")
        self.assertEqual(self.engine_boots(), 2)
        self.assertEqual(len(self.engine_pids()), 2)
        self.assertNotEqual(self.engine_pids()[1], crashed_pid)

    def test_session_engine_timeout_is_reaped_and_next_request_succeeds(self) -> None:
        service = self.service("hang-on-second-go")
        status, lines = self.run_session(service, self.payload())
        self.assertEqual(status, 200)
        self.assertEqual(lines[2]["result"]["failure"]["code"], "timeout")
        self.assertEqual(lines[-1]["reason"], "error")
        self.assertEqual(lines[-1]["code"], "timeout")
        self.assert_dead(self.engine_pids()[0])

        code, result = self.analyze_after_reap(service)
        self.assertEqual(code, 200)
        self.assertEqual(result["status"], "success")
        self.assertEqual(self.engine_boots(), 2)

    def test_session_resign_position_reports_incomplete_and_continues(self) -> None:
        service = self.service("resign-second-go")
        status, lines = self.run_session(service, self.payload())
        self.assertEqual(status, 200)
        results = [line["result"] for line in lines if line["type"] == "result"]
        self.assertEqual([result["status"] for result in results], ["success", "incomplete", "success"])
        self.assertEqual(results[1]["engineOutcome"], "resign")
        self.assertEqual(results[1]["candidates"], [])
        self.assertEqual(lines[-1], {"type": "end", "analyzed": 3, "reason": "complete", "engineLaunches": 1})
        self.assertEqual(self.engine_boots(), 1)

    def test_session_stream_close_reaps_engine_and_releases_busy_guard(self) -> None:
        service = self.service()
        status, stream = service.session_response(self.payload())
        self.assertEqual(status, 200)
        iterator = iter(stream)
        self.assertEqual(next(iterator)["type"], "session")
        self.assertEqual(next(iterator)["type"], "result")

        code, result = service.response({"sfen": STARTPOS, "legalMoveCount": 30})
        self.assertEqual(code, 409)
        self.assertEqual(result["failure"]["code"], "busy")

        stream.close()
        engine_pid = self.engine_pids()[0]
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            try:
                os.kill(engine_pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.01)
        else:
            self.fail("closing the stream did not reap the engine")
        self.assertIn("stop", self.commands())

        code, result = self.analyze_after_reap(service)
        self.assertEqual(code, 200)
        self.assertEqual(result["status"], "success")
        self.assertEqual(self.engine_boots(), 2)

    def test_session_rejects_malformed_requests(self) -> None:
        service = self.service()
        valid = self.payload()
        cases = [
            "not a dict",
            {**valid, "contract": "other"},
            {key: value for key, value in valid.items() if key != "positions"},
            {**valid, "extra": 1},
            {**valid, "profileId": "other"},
            {**valid, "profileId": 7},
            {**valid, "conditions": {**valid["conditions"], "threads": 2}},
            {**valid, "conditions": {**valid["conditions"], "extra": 1}},
            {**valid, "conditions": {**valid["conditions"], "moveTimeMs": 50.5}},
            {**valid, "positions": "x"},
            {**valid, "positions": []},
            {**valid, "positions": [{"ply": 0}]},
            {**valid, "positions": [{"ply": 0, "sfen": STARTPOS, "junk": 1}]},
            {**valid, "positions": [{"ply": 0, "sfen": "bogus"}]},
            {**valid, "positions": [{"ply": 1, "sfen": STARTPOS}, {"ply": 0, "sfen": STARTPOS}]},
            {**valid, "positions": [{"ply": 0, "sfen": STARTPOS}, {"ply": 0, "sfen": STARTPOS}]},
            {**valid, "positions": [{"ply": True, "sfen": STARTPOS}]},
            {**valid, "positions": [{"ply": 0, "sfen": STARTPOS, "legalMoveCount": 0}]},
            {**valid, "positions": [{"ply": 0, "sfen": STARTPOS, "legalMoveCount": True}]},
            {**valid, "deadlineMs": 0},
            {**valid, "deadlineMs": True},
            {**valid, "deadlineMs": "5000"},
            {**valid, "positions": [{"ply": index, "sfen": STARTPOS} for index in range(MAX_SESSION_POSITIONS + 1)]},
        ]
        for payload in cases:
            with self.subTest(payload=json.dumps(payload, default=str)[:120]):
                status, lines = self.run_session(service, payload)
                self.assertEqual(status, 400)
                self.assertEqual(lines[0]["status"], "failure")
                self.assertEqual(lines[0]["failure"]["code"], "invalid")
        self.assertFalse(self.counter_path.exists())

    def test_session_rejects_profile_instance_and_runtime_mismatch(self) -> None:
        service = self.service(expected_instance_type="standard-2")
        status, lines = self.run_session(service, self.payload(profile_id="precision"))
        self.assertEqual(status, 409)
        self.assertEqual(lines[0]["failure"]["code"], "instance_mismatch")
        self.assertEqual(lines[0]["runtimeMismatch"], "profile_instance_type_mismatch")

        wrong_runtime = session_runtime("standard-2")
        wrong_runtime["osCpuCount"] = 2
        wrong_runtime["affinityCpuCount"] = 2
        with patch.object(driver_module, "runtime_facts", return_value=wrong_runtime):
            status, lines = self.run_session(service, self.payload())
        self.assertEqual(status, 409)
        self.assertEqual(lines[0]["failure"]["code"], "instance_mismatch")
        self.assertEqual(lines[0]["runtimeMismatch"], "cpu_count_mismatch")
        self.assertFalse(self.counter_path.exists())

    def test_session_on_standard_3_accepts_precision_profile(self) -> None:
        service = self.service(expected_instance_type="standard-3")
        request = self.payload(profile_id="precision", positions=[{"ply": 0, "sfen": STARTPOS}])
        status, lines = self.run_session(service, request)
        self.assertEqual(status, 200)
        self.assertEqual(lines[0]["profileId"], "precision")
        self.assertEqual(lines[-1]["reason"], "complete")
        self.assertIn("setoption name Threads value 2", self.commands())
        self.assertIn("go movetime 5000", self.commands())

    def test_session_unavailable_profiles_config_fails_closed(self) -> None:
        self.profiles_path.unlink()
        service = self.service()
        status, lines = self.run_session(service, self.payload())
        self.assertEqual(status, 502)
        self.assertEqual(lines[0]["failure"]["code"], "engine_error")
        code, result = service.response({"sfen": STARTPOS, "legalMoveCount": 30})
        self.assertEqual(code, 200)

    def test_session_handshake_failure_reports_error_and_reaps(self) -> None:
        service = self.service("handshake-exit")
        status, lines = self.run_session(service, self.payload())
        self.assertEqual(status, 200)
        self.assertEqual([line["type"] for line in lines], ["session", "end"])
        self.assertEqual(lines[-1]["reason"], "error")
        self.assertEqual(lines[-1]["analyzed"], 0)
        self.assertEqual(lines[-1]["engineLaunches"], 1)
        self.assertEqual(lines[-1]["code"], "engine_error")
        self.assert_dead(self.engine_pids()[0])
        code, result = self.analyze_after_reap(service)
        self.assertEqual(code, 200)
        self.assertEqual(self.engine_boots(), 2)

    def http_server(self, service: AnalysisService) -> ThreadingHTTPServer:
        server = ThreadingHTTPServer(("127.0.0.1", 0), create_handler(service))
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def post(self, server: ThreadingHTTPServer, body: bytes | str) -> http.client.HTTPResponse:
        connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=10)
        connection.request("POST", "/session", body=body, headers={"content-type": "application/json"})
        return connection.getresponse()

    def test_http_session_streams_chunked_ndjson(self) -> None:
        service = self.service()
        server = self.http_server(service)

        response = self.post(server, json.dumps(self.payload()))
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader("Content-Type"), "application/x-ndjson")
        self.assertEqual(response.getheader("Transfer-Encoding"), "chunked")
        lines = [json.loads(raw) for raw in response.read().decode("utf-8").splitlines()]
        self.assertEqual([line["type"] for line in lines], ["session", "result", "result", "result", "end"])
        self.assertEqual(lines[-1]["reason"], "complete")
        self.assert_dead(self.engine_pids()[0])

    def test_http_session_rejects_oversized_body_before_engine(self) -> None:
        service = self.service()
        server = self.http_server(service)

        response = self.post(server, b" " + b"x" * MAX_SESSION_BODY_BYTES)
        self.assertEqual(response.status, 413)
        response.read()
        self.assertFalse(self.counter_path.exists())

        response = self.post(server, json.dumps({**self.payload(), "junk": "x" * MAX_SESSION_BODY_BYTES}))
        self.assertEqual(response.status, 413)
        response.read()
        self.assertFalse(self.counter_path.exists())

    def test_http_client_disconnect_reaps_engine_and_driver_idles(self) -> None:
        service = self.service("hang-on-second-go")
        server = self.http_server(service)

        connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=10)
        connection.request("POST", "/session", body=json.dumps(self.payload()), headers={"content-type": "application/json"})
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        data = b""
        deadline = time.monotonic() + 5
        while data.count(b"\n") < 2 and time.monotonic() < deadline:
            chunk = response.read1(65536)
            if not chunk:
                break
            data += chunk
        self.assertGreaterEqual(data.count(b"\n"), 2)
        received = [json.loads(raw) for raw in data.decode("utf-8").splitlines()]
        self.assertEqual(received[0]["type"], "session")
        self.assertEqual(received[1]["type"], "result")
        engine_pid = self.engine_pids()[0]
        connection.close()

        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                os.kill(engine_pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.05)
        else:
            self.fail("client disconnect did not reap the engine")

        code, result = self.analyze_after_reap(service)
        self.assertEqual(code, 200)
        self.assertEqual(result["status"], "success")
        self.assertEqual(self.engine_boots(), 2)


if __name__ == "__main__":
    unittest.main()
