from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path

from driver import (
    AnalysisService,
    IdentityMismatch,
    MultiPvCollector,
    is_valid_sfen,
    parse_info_line,
    verify_identity,
)


STARTPOS = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1"
OPTIONS = b"FV_SCALE 40\n"

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
        for name in ("DRIVER_FAKE_SCENARIO", "DRIVER_FAKE_COUNTER", "DRIVER_FAKE_COMMANDS", "DRIVER_FAKE_PIDS"):
            os.environ.pop(name, None)
        self.temp.cleanup()

    @staticmethod
    def digest(path: Path) -> str:
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def service(self, scenario: str = "normal", extra_settings: dict | None = None) -> AnalysisService:
        os.environ["DRIVER_FAKE_SCENARIO"] = scenario
        os.environ["DRIVER_FAKE_COUNTER"] = str(self.counter_path)
        os.environ["DRIVER_FAKE_COMMANDS"] = str(self.commands_path)
        os.environ["DRIVER_FAKE_PIDS"] = str(self.pids_path)
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

    def request(self, service: AnalysisService, legal_move_count: int = 30) -> tuple[int, dict]:
        return service.response({"sfen": STARTPOS, "legalMoveCount": legal_move_count})

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


if __name__ == "__main__":
    unittest.main()
