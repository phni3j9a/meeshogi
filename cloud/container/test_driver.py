from __future__ import annotations

import hashlib
import json
import os
import signal
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

import driver as driver_module
from driver import (
    AnalysisService,
    IdentityMismatch,
    MultiPvCollector,
    benchmark_runtime_mismatch,
    driver_get_response,
    is_valid_sfen,
    mem_total_bytes,
    parse_mem_total_bytes,
    parse_info_line,
    root_disk_total_bytes,
    verify_identity,
)


STARTPOS = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1"
OPTIONS = b"FV_SCALE 40\n"
GIB = 1 << 30


def benchmark_runtime(expected_instance_type: str | None) -> dict:
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

FAKE_ENGINE = r'''#!/usr/bin/env python3
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

def emit_info():
    print("info depth 2 multipv 1 score cp 42 nodes 1000 time 12 pv 7g7f 3c3d", flush=True)
    print("info depth 2 multipv 2 score cp -15 nodes 1000 time 12 pv 2g2f 8c8d", flush=True)
    print("info depth 2 multipv 3 score cp 7 nodes 1000 time 12 pv 6g6f 4c4d", flush=True)

for command in iter(commands.get, None):
    if command == "usi":
        print("id name Fake USI Engine", flush=True)
        for name in ["Threads", "USI_Hash", "MultiPV", "EvalDir", "FV_SCALE", "USI_Ponder", "USI_OwnBook", "BookFile", "GenerateAllLegalMoves"]:
            print(f"option name {name} type string default test", flush=True)
        print("usiok", flush=True)
    elif command == "isready":
        print("readyok", flush=True)
    elif command.startswith("go "):
        if scenario == "verification-stop-once" and boot == 1:
            time.sleep(0.35)
            emit_info()
            print("bestmove 7g7f", flush=True)
            continue
        if scenario in {"unexpected-exit-code", "unexpected-signal"}:
            print("info depth 3 multipv 1 score cp 42 nodes 4242 time 77 pv 7g7f 3c3d", flush=True)
            if scenario == "unexpected-exit-code":
                os._exit(23)
            os.kill(os.getpid(), signal.SIGTERM)
        if scenario == "hang-once" and boot == 1:
            print("info depth 1 multipv 1 score cp 9999 nodes 10 time 1 pv 9a9b", flush=True)
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            while True:
                time.sleep(1)
        if scenario == "resign":
            print("bestmove resign", flush=True)
            continue
        if scenario == "bad-bestmove":
            emit_info()
            print("bestmove bogus", flush=True)
            continue
        if scenario == "shortfall":
            print("info depth 2 multipv 1 score cp 42 nodes 1000 time 12 pv 7g7f 3c3d", flush=True)
        elif scenario == "bound":
            print("info depth 2 multipv 1 score cp 42 lowerbound nodes 1000 time 12 pv 7g7f 3c3d", flush=True)
            print("info depth 2 multipv 2 score cp -15 nodes 1000 time 12 pv 2g2f 8c8d", flush=True)
        else:
            emit_info()
        print("bestmove 7g7f", flush=True)
    elif command == "quit":
        break
'''


class DriverTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="meeshogi-fake-usi-")
        self.root = Path(self.temp.name)
        self.engine_path = self.root / "fake-engine"
        self.engine_path.write_text(FAKE_ENGINE, encoding="utf-8")
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
        self.counter_path = self.root / "counter.txt"
        self.commands_path = self.root / "commands.txt"
        self.pids_path = self.root / "pids.txt"

    def tearDown(self) -> None:
        for name in (
            "DRIVER_FAKE_SCENARIO",
            "DRIVER_FAKE_COUNTER",
            "DRIVER_FAKE_COMMANDS",
            "DRIVER_FAKE_PIDS",
            "ANALYSIS_VERIFY_STOP_ENGINE_ONCE",
            "ANALYSIS_BENCHMARK_ENABLED",
            "ANALYSIS_EXPECTED_INSTANCE_TYPE",
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
        verification_stop_once: bool = False,
        benchmark: bool = False,
        expected_instance_type: str = "standard-2",
    ) -> AnalysisService:
        os.environ["DRIVER_FAKE_SCENARIO"] = scenario
        os.environ["DRIVER_FAKE_COUNTER"] = str(self.counter_path)
        os.environ["DRIVER_FAKE_COMMANDS"] = str(self.commands_path)
        os.environ["DRIVER_FAKE_PIDS"] = str(self.pids_path)
        if verification_stop_once:
            os.environ["ANALYSIS_VERIFY_STOP_ENGINE_ONCE"] = "1"
        else:
            os.environ.pop("ANALYSIS_VERIFY_STOP_ENGINE_ONCE", None)
        if benchmark:
            os.environ["ANALYSIS_BENCHMARK_ENABLED"] = "1"
            os.environ["ANALYSIS_EXPECTED_INSTANCE_TYPE"] = expected_instance_type
        else:
            os.environ.pop("ANALYSIS_BENCHMARK_ENABLED", None)
            os.environ.pop("ANALYSIS_EXPECTED_INSTANCE_TYPE", None)
        settings = {
            "moveTimeMs": 50,
            "searchGraceMs": 100,
            "stopResponseGraceSeconds": 0.05,
            "termGraceSeconds": 0.05,
            "killGraceSeconds": 0.3,
            "handshakeTimeoutSeconds": 2,
            "readyTimeoutSeconds": 2,
        }
        settings.update(extra_settings or {})
        return AnalysisService(engine_path=self.engine_path, expected_manifest=self.manifest, settings=settings)

    def request(
        self,
        service: AnalysisService,
        legal_move_count: int = 30,
        sfen: str = STARTPOS,
    ) -> tuple[int, dict]:
        return service.response({"sfen": sfen, "legalMoveCount": legal_move_count})

    def benchmark_request(self, service: AnalysisService, condition_id: str, **extra) -> tuple[int, dict]:
        return service.benchmark_response({"sfen": STARTPOS, "legalMoveCount": 30, "conditionId": condition_id, **extra})

    def test_cp_and_mate_scores_are_normalized_to_sente(self) -> None:
        black_cp = parse_info_line("info depth 2 score cp 42 nodes 100 pv 7g7f", "b")
        white_cp = parse_info_line("info depth 2 score cp 42 nodes 100 pv 3c3d", "w")
        black_mate = parse_info_line("info depth 2 score mate 5 nodes 100 pv 7g7f", "b")
        white_mate = parse_info_line("info depth 2 score mate 5 nodes 100 pv 3c3d", "w")
        negative_zero = parse_info_line("info depth 2 score mate -0 nodes 100 pv 3c3d", "w")
        self.assertEqual(black_cp["score"], {"kind": "cp", "value": 42})
        self.assertEqual(white_cp["score"], {"kind": "cp", "value": -42})
        self.assertEqual(black_mate["score"], {"kind": "mate", "value": 5, "winningSide": "sente"})
        self.assertEqual(white_mate["score"], {"kind": "mate", "value": -5, "winningSide": "gote"})
        self.assertEqual(negative_zero["score"], {"kind": "mate", "value": 0, "winningSide": "unknown"})

    def test_bound_scores_are_never_marked_exact(self) -> None:
        record = parse_info_line("info depth 3 score cp 90 lowerbound nodes 300 pv 7g7f", "b")
        self.assertIsNotNone(record)
        self.assertFalse(record["exact"])
        self.assertIsNone(parse_info_line("info depth 3 nodes 300 pv 7g7f", "b")["score"])

    def test_multi_pv_requires_a_complete_same_depth_exact_block(self) -> None:
        collector = MultiPvCollector(2, "b")
        collector.observe("info depth 4 multipv 1 score cp 40 nodes 400 pv 7g7f")
        self.assertIsNone(collector.best_block)
        collector.observe("info depth 4 multipv 2 score cp -20 nodes 400 pv 2g2f")
        self.assertEqual(collector.best_block[0], 4)
        collector.observe("info depth 5 multipv 1 score cp 50 nodes 500 pv 6g6f")
        collector.observe("info depth 5 multipv 2 score cp -20 lowerbound nodes 500 pv 2g2f")
        self.assertEqual(collector.best_block[0], 4)

    def test_same_depth_partial_block_keeps_previous_complete_snapshot_until_replaced(self) -> None:
        collector = MultiPvCollector(2, "b")
        collector.observe("info depth 4 multipv 1 score cp 40 nodes 400 pv 7g7f")
        collector.observe("info depth 4 multipv 2 score cp 20 nodes 400 pv 2g2f")
        original = collector.best_block
        self.assertEqual(original[0], 4)

        collector.observe("info depth 4 multipv 1 score cp 50 nodes 500 pv 6g6f")
        collector.observe("info depth 4 multipv 2 score cp 30 upperbound nodes 500 pv 2g2f")
        self.assertEqual(collector.best_block, original)

        collector.observe("info depth 4 multipv 1 score cp 60 nodes 600 pv 5g5f")
        collector.observe("info depth 4 multipv 2 score cp 30 nodes 600 pv 2g2f")
        self.assertEqual(collector.best_block[0], 4)
        self.assertEqual([entry["score"]["value"] for entry in collector.best_block[1]], [60, 30])
        self.assertEqual([entry["pv"][0] for entry in collector.best_block[1]], ["5g5f", "2g2f"])

    def test_duplicate_root_moves_do_not_complete_multi_pv(self) -> None:
        collector = MultiPvCollector(2, "b")
        collector.observe("info depth 3 multipv 1 score cp 40 nodes 400 pv 7g7f")
        collector.observe("info depth 3 multipv 2 score cp 20 nodes 400 pv 7g7f")
        self.assertIsNone(collector.best_block)

    def test_sfens_reject_newlines_and_non_sfen_characters(self) -> None:
        self.assertTrue(is_valid_sfen(STARTPOS))
        self.assertTrue(is_valid_sfen(STARTPOS.replace(" b ", " w ")))
        self.assertFalse(is_valid_sfen(STARTPOS + "\nquit"))
        self.assertFalse(is_valid_sfen(STARTPOS + "\u0001"))
        self.assertFalse(is_valid_sfen(STARTPOS + " ;system"))

    def test_sfen_move_numbers_containing_zero_are_valid_but_zero_fields_are_not(self) -> None:
        for move_number in ("10", "20", "100"):
            with self.subTest(move_number=move_number):
                self.assertTrue(is_valid_sfen(STARTPOS.rsplit(" ", 1)[0] + " " + move_number))
        self.assertTrue(is_valid_sfen(STARTPOS.replace(" b - 1", " b 10P 10")))
        self.assertFalse(is_valid_sfen(STARTPOS.replace("lnsgkgsnl", "0nsgkgsnl")))
        self.assertFalse(is_valid_sfen(STARTPOS.replace(" b - 1", " b 0P 10")))
        self.assertFalse(is_valid_sfen(STARTPOS.replace(" b - 1", " b - 0")))

    def test_manifest_digest_mismatch_fails_closed(self) -> None:
        bad_manifest = dict(self.manifest)
        bad_manifest["weightSha256"] = "0" * 64
        self.manifest_path.write_text(json.dumps(bad_manifest), encoding="utf-8")
        with self.assertRaises(IdentityMismatch):
            verify_identity(self.engine_path, self.weight_path, self.options_path, self.manifest_path)

    def test_legal_move_count_caps_multi_pv(self) -> None:
        code, result = self.request(self.service(), legal_move_count=2)
        self.assertEqual(code, 200)
        self.assertEqual(result["conditions"]["requested"]["multiPV"], 3)
        self.assertEqual(result["conditions"]["actual"]["multiPV"], 2)
        self.assertEqual(len(result["candidates"]), 2)

    def test_multi_pv_shortfall_is_incomplete_and_not_fabricated(self) -> None:
        code, result = self.request(self.service("shortfall"), legal_move_count=3)
        self.assertEqual(code, 200)
        self.assertEqual(result["status"], "incomplete")
        self.assertEqual(result["candidates"], [])
        self.assertIsNone(result["meta"]["completedDepth"])

    def test_bestmove_resign_has_no_fabricated_candidate(self) -> None:
        code, result = self.request(self.service("resign"))
        self.assertEqual(code, 200)
        self.assertEqual(result["status"], "incomplete")
        self.assertEqual(result["engineOutcome"], "resign")
        self.assertEqual(result["candidates"], [])

    def test_malformed_bestmove_fails_even_after_a_complete_multi_pv_block(self) -> None:
        code, result = self.request(self.service("bad-bestmove"))
        self.assertEqual(code, 502)
        self.assertEqual(result["status"], "failure")
        self.assertEqual(result["failure"]["code"], "engine_error")

    def test_unexpected_engine_exit_reports_safe_wait4_and_output_diagnostics(self) -> None:
        cases = (
            ("unexpected-exit-code", 23, None, 23),
            ("unexpected-signal", None, "SIGTERM", -signal.SIGTERM),
        )
        for scenario, exit_code, terminating_signal, wait_return_code in cases:
            with self.subTest(scenario=scenario):
                prior_pids = self.pids_path.read_text(encoding="ascii").splitlines() if self.pids_path.exists() else []
                with patch.object(driver_module, "runtime_facts", side_effect=benchmark_runtime):
                    service = self.service(scenario, benchmark=True)
                    code, result = self.benchmark_request(service, "standard-2-t1-100ms-mpv2")
                self.assertEqual(code, 502)
                self.assertEqual(result["status"], "failure")
                self.assertEqual(result["failure"]["code"], "engine_error")
                self.assertEqual(result["failure"]["message"], "Engine ended during search.")
                diagnostics = result["failure"]["diagnostics"]
                self.assertEqual(diagnostics["exitCode"], exit_code)
                self.assertEqual(diagnostics["terminatingSignal"], terminating_signal)
                self.assertEqual(diagnostics["waitReturnCode"], wait_return_code)
                self.assertTrue(diagnostics["stdoutEof"])
                self.assertEqual(
                    diagnostics["lastInfo"],
                    {"depth": 3, "nodes": 4242, "timeMs": 77, "adopted": False},
                )
                self.assertEqual(diagnostics["lastNonInfoLineKind"], "readyok")
                self.assertNotIn("info depth", json.dumps(result))
                observed_pids = self.pids_path.read_text(encoding="ascii").splitlines()
                self.assertEqual(len(observed_pids), len(prior_pids) + 1, "unexpected engine exit must not retry")

    def test_timeout_stops_kills_reaps_busy_request_and_next_is_fresh(self) -> None:
        service = self.service("hang-once")
        first_result: list[tuple[int, dict]] = []
        first = threading.Thread(target=lambda: first_result.append(self.request(service)))
        first.start()
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if self.commands_path.exists() and "go movetime 50" in self.commands_path.read_text(encoding="utf-8"):
                break
            time.sleep(0.01)
        else:
            self.fail("fake engine did not start the hanging search")

        busy_code, busy_result = self.request(service)
        self.assertEqual(busy_code, 409)
        self.assertEqual(busy_result["failure"]["code"], "busy")
        first.join(timeout=4)
        self.assertFalse(first.is_alive())
        self.assertEqual(first_result[0][0], 504)
        self.assertEqual(first_result[0][1]["failure"]["code"], "timeout")
        commands = self.commands_path.read_text(encoding="utf-8").splitlines()
        self.assertIn("stop", commands)

        old_pid = int(self.pids_path.read_text(encoding="ascii").splitlines()[0])
        with self.assertRaises(ProcessLookupError):
            os.kill(old_pid, 0)

        next_code, next_result = self.request(service)
        self.assertEqual(next_code, 200)
        self.assertEqual(next_result["status"], "success")
        self.assertEqual(next_result["candidates"][0]["score"], {"kind": "cp", "value": 42})
        pids = self.pids_path.read_text(encoding="ascii").splitlines()
        self.assertEqual(len(pids), 2)
        self.assertNotEqual(pids[0], pids[1])

    def test_configured_one_shot_stop_reaps_first_engine_and_second_sfen_succeeds_fresh(self) -> None:
        service = self.service(
            "verification-stop-once",
            {"moveTimeMs": 500, "searchGraceMs": 1000},
            verification_stop_once=True,
        )
        timeout_code, timeout_result = self.request(service)

        self.assertEqual(timeout_code, 504)
        self.assertEqual(timeout_result["failure"]["code"], "timeout")
        timeout_evidence = timeout_result["verification"]
        self.assertTrue(timeout_evidence["stopInjected"])
        self.assertTrue(timeout_evidence["engineReaped"])
        self.assertTrue(timeout_evidence["waitReturned"])
        self.assertEqual(timeout_evidence["waitReturnCode"], -signal.SIGKILL)
        self.assertEqual(timeout_evidence["engineEpoch"], 1)
        old_pid = timeout_evidence["enginePid"]
        with self.assertRaises(ProcessLookupError):
            os.kill(old_pid, 0)

        success_code, success_result = self.request(
            service,
            legal_move_count=30,
            sfen="1nrg3n1/l2s2k2/p1p1gp1pl/1p1pp2s1/6P1p/b1P5P/PP1PPP1P1/L1KSRSG2/1NG4NL b BP 1",
        )
        self.assertEqual(success_code, 200)
        self.assertEqual(success_result["status"], "success")
        success_evidence = success_result["verification"]
        self.assertFalse(success_evidence["stopInjected"])
        self.assertTrue(success_evidence["engineReaped"])
        self.assertTrue(success_evidence["waitReturned"])
        self.assertEqual(success_evidence["waitReturnCode"], 0)
        self.assertEqual(success_evidence["driverBootId"], timeout_evidence["driverBootId"])
        self.assertGreater(success_evidence["engineEpoch"], timeout_evidence["engineEpoch"])
        self.assertNotEqual(success_evidence["enginePid"], old_pid)

    def test_driver_health_does_not_start_engine_or_consume_one_shot(self) -> None:
        service = self.service("verification-stop-once", verification_stop_once=True)
        status, health = driver_get_response(service, "/health")
        self.assertEqual(status, 200)
        self.assertEqual(health["schemaVersion"], 1)
        self.assertEqual(health["status"], "ready")
        self.assertRegex(health["driverBootId"], r"^[0-9a-f]{32}$")
        self.assertIsNone(health["expectedInstanceType"])
        self.assertEqual(health["runtime"]["driverBootId"], health["driverBootId"])
        self.assertIn("osCpuCount", health["runtime"])
        self.assertIn("affinityCpuCount", health["runtime"])
        self.assertIn("cpuMax", health["runtime"])
        self.assertIn("cpuQuota", health["runtime"])
        self.assertIn("memoryMaxBytes", health["runtime"])
        self.assertIn("memTotalBytes", health["runtime"])
        self.assertIn("rootDiskTotalBytes", health["runtime"])
        self.assertTrue(health["verifyStopEngineOnceEnabled"])
        self.assertFalse(health["verifyStopEngineOnceConsumed"])
        self.assertEqual(health["driverVersion"], "test-driver")
        self.assertEqual(health["contractVersion"], "test-contract")
        self.assertEqual(health["identityDigests"]["engineSha256"], self.manifest["engineSha256"])
        self.assertFalse(self.counter_path.exists(), "health must not spawn the engine")

        status, result = self.request(service)
        self.assertEqual(status, 504)
        self.assertEqual(result["failure"]["code"], "timeout")
        self.assertTrue(service.health()["verifyStopEngineOnceConsumed"])

    def test_one_shot_stop_is_not_injected_without_verification_flag(self) -> None:
        service = self.service("verification-stop-once", {"moveTimeMs": 500, "searchGraceMs": 1000})
        status, result = self.request(service)

        self.assertEqual(status, 200)
        self.assertEqual(result["status"], "success")
        self.assertNotIn("verification", result)
        commands = self.commands_path.read_text(encoding="utf-8").splitlines()
        self.assertIn("quit", commands)
        self.assertNotIn("stop", commands)

    def test_benchmark_route_is_disabled_by_default_and_never_accepts_free_search_values(self) -> None:
        disabled = self.service()
        status, result = self.benchmark_request(disabled, "standard-2-t1-100ms-mpv2")
        self.assertEqual(status, 404)
        self.assertEqual(result["failure"]["code"], "invalid")

        enabled = self.service(benchmark=True)
        status, result = self.benchmark_request(
            enabled,
            "standard-2-t1-100ms-mpv2",
            moveTimeMs=10000,
        )
        self.assertEqual(status, 400)
        self.assertEqual(result["failure"]["code"], "invalid")

    def test_benchmark_condition_must_match_deployed_instance_type(self) -> None:
        service = self.service(benchmark=True, expected_instance_type="standard-2")
        status, result = self.benchmark_request(service, "reference-standard-3-t2-10000ms-mpv3")
        self.assertEqual(status, 409)
        self.assertEqual(result["failure"]["code"], "instance_mismatch")
        self.assertEqual(result["runtimeMismatch"], "condition_instance_type_mismatch")
        self.assertIn("memTotalBytes", result["runtime"])
        self.assertIn("rootDiskTotalBytes", result["runtime"])
        self.assertFalse(self.counter_path.exists())

    def test_benchmark_reports_same_line_search_and_process_observations(self) -> None:
        with patch.object(driver_module, "runtime_facts", side_effect=benchmark_runtime):
            service = self.service(benchmark=True, expected_instance_type="standard-2")
            status, result = self.benchmark_request(service, "standard-2-t1-100ms-mpv2")

        self.assertEqual(status, 200)
        self.assertEqual(result["schemaVersion"], 2)
        self.assertEqual(result["contractVersion"], "analysis-json-v2")
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["conditions"]["requested"]["moveTimeMs"], 100)
        self.assertEqual(result["conditions"]["actual"]["effectiveMultiPV"], 2)
        self.assertEqual(result["meta"]["nodes"], 1000)
        self.assertEqual(result["meta"]["searchElapsedMs"], 12)
        self.assertAlmostEqual(result["meta"]["derivedNps"], 1000 * 1000 / 12)
        self.assertGreater(result["meta"]["processElapsedMs"], 0)
        self.assertIsNotNone(result["meta"]["processCpuSeconds"])
        self.assertEqual(result["driverBootId"], service.health()["driverBootId"])
        self.assertEqual(result["runtime"]["memTotalBytes"], 6 * GIB - GIB // 2)
        self.assertEqual(result["runtime"]["rootDiskTotalBytes"], 32 * GIB)
        self.assertEqual(result["expectedInstanceType"], "standard-2")
        self.assertNotIn("identity", result)
        commands = self.commands_path.read_text(encoding="utf-8").splitlines()
        self.assertIn("setoption name Threads value 1", commands)
        self.assertIn("setoption name USI_Hash value 64", commands)
        self.assertIn("go movetime 100", commands)

    def test_ten_second_reference_condition_is_accepted(self) -> None:
        with patch.object(driver_module, "runtime_facts", side_effect=benchmark_runtime):
            service = self.service(benchmark=True, expected_instance_type="standard-3")
            status, result = self.benchmark_request(service, "reference-standard-3-t2-10000ms-mpv3")

        self.assertEqual(status, 200)
        self.assertEqual(result["conditions"]["actual"]["threads"], 2)
        self.assertEqual(result["conditions"]["actual"]["moveTimeMs"], 10000)
        self.assertEqual(result["conditions"]["actual"]["effectiveMultiPV"], 3)
        self.assertIn("go movetime 10000", self.commands_path.read_text(encoding="utf-8").splitlines())
        self.assertIn("setoption name Threads value 2", self.commands_path.read_text(encoding="utf-8").splitlines())

    def test_runtime_instance_proof_uses_cpu_and_memtotal_without_requiring_cgroup(self) -> None:
        runtime = benchmark_runtime("standard-2")
        self.assertIsNone(benchmark_runtime_mismatch(runtime, "standard-2"))
        runtime["affinityCpuCount"] = 2
        self.assertEqual(benchmark_runtime_mismatch(runtime, "standard-2"), "cpu_count_mismatch")
        runtime["affinityCpuCount"] = 1
        runtime["memTotalBytes"] = 4 * GIB
        self.assertEqual(benchmark_runtime_mismatch(runtime, "standard-2"), "mem_total_mismatch")

    def test_benchmark_rejects_wrong_runtime_before_spawning_engine_and_keeps_raw_facts(self) -> None:
        runtime = benchmark_runtime("standard-2")
        runtime["osCpuCount"] = 2
        runtime["affinityCpuCount"] = 2
        with patch.object(driver_module, "runtime_facts", return_value=runtime):
            service = self.service(benchmark=True, expected_instance_type="standard-2")
            status, result = self.benchmark_request(service, "standard-2-t1-100ms-mpv2")
        self.assertEqual(status, 409)
        self.assertEqual(result["failure"]["code"], "instance_mismatch")
        self.assertEqual(result["runtimeMismatch"], "cpu_count_mismatch")
        self.assertEqual(result["runtime"]["osCpuCount"], 2)
        self.assertFalse(self.counter_path.exists())

    def test_memtotal_and_root_disk_runtime_readers_return_bytes(self) -> None:
        self.assertEqual(parse_mem_total_bytes("MemTotal:       1234 kB\n"), 1234 * 1024)
        self.assertIsNone(parse_mem_total_bytes("MemFree: 100 kB\n"))
        with patch.object(driver_module, "_read_text", return_value="MemTotal: 1234 kB"):
            self.assertEqual(mem_total_bytes(), 1234 * 1024)
        with patch.object(driver_module.os, "statvfs", return_value=SimpleNamespace(f_blocks=9, f_frsize=4096)):
            self.assertEqual(root_disk_total_bytes(), 9 * 4096)


if __name__ == "__main__":
    unittest.main()
