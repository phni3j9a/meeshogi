from __future__ import annotations

import hashlib
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from container import driver


START_SFEN = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1"


FAKE_ENGINE = r'''#!/usr/bin/env python3
import os
import sys
import time

scenario = os.environ.get("DRIVER_FAKE_SCENARIO", "iteration")
for raw in sys.stdin:
    command = raw.strip()
    if command == "usi":
        print("id name Fake USI Engine", flush=True)
        print("option name Threads type spin default 1 min 1 max 2", flush=True)
        print("option name USI_Hash type spin default 256 min 16 max 512", flush=True)
        print("option name MultiPV type spin default 1 min 1 max 8", flush=True)
        print("option name USI_Ponder type check default false", flush=True)
        print("option name USI_OwnBook type check default true", flush=True)
        print("option name BookFile type combo default book var no_book", flush=True)
        print("option name EvalDir type string default eval", flush=True)
        print("option name FV_SCALE type spin default 40 min 1 max 128", flush=True)
        print("usiok", flush=True)
    elif command == "isready":
        print("readyok", flush=True)
    elif command.startswith("go "):
        if scenario == "slow":
            time.sleep(0.7)
        if scenario == "mate":
            print("info depth 4 multipv 1 score mate 3 nodes 300 time 8 pv 7g7f 3c3d", flush=True)
            print("info depth 4 multipv 2 score cp 15 nodes 300 time 8 pv 2g2f 8c8d", flush=True)
        else:
            print("info depth 1 multipv 1 score cp 40 nodes 100 time 10 pv 7g7f 3c3d", flush=True)
            print("info depth 1 multipv 2 score cp -25 nodes 100 time 10 pv 2g2f 8c8d", flush=True)
            print("info depth 2 multipv 1 score cp 50 nodes 250 time 20 pv 7g7f 3c3d", flush=True)
            print("info depth 2 multipv 2 score cp -30 nodes 250 time 20 pv 2g2f 8c8d", flush=True)
            print("info depth 3 multipv 1 score cp 55 lowerbound nodes 400 time 30 pv 7g7f 3c3d", flush=True)
            print("info depth 3 multipv 2 score cp -35 nodes 400 time 30 pv 2g2f 8c8d", flush=True)
        print("bestmove 7g7f", flush=True)
    elif command == "quit":
        break
'''


class DriverTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="meeshogi-fake-usi-")
        root = Path(self.temp.name)
        self.engine_path = root / "fake-engine"
        self.engine_path.write_text(FAKE_ENGINE, encoding="utf-8")
        self.engine_path.chmod(0o700)
        self.weight_path = root / "fake.nn"
        self.weight_path.write_bytes(b"synthetic-weight-only-for-tests")
        self.options_path = root / "engine_options.txt"
        self.options_path.write_text("FV_SCALE 40\n", encoding="ascii")
        env = {
            "EXPECTED_ENGINE_SHA256": hashlib.sha256(self.engine_path.read_bytes()).hexdigest(),
            "EXPECTED_WEIGHT_SHA256": hashlib.sha256(self.weight_path.read_bytes()).hexdigest(),
            "DRIVER_FAKE_SCENARIO": "iteration",
        }
        self.env_patch = patch.dict(os.environ, env)
        self.env_patch.start()
        self.path_patch = patch.multiple(
            driver,
            ENGINE_PATH=self.engine_path,
            WEIGHT_PATH=self.weight_path,
            OPTIONS_PATH=self.options_path,
        )
        self.path_patch.start()
        self.controllers: list[driver.EngineController] = []

    def tearDown(self) -> None:
        for controller in self.controllers:
            controller.close()
        self.path_patch.stop()
        self.env_patch.stop()
        self.temp.cleanup()

    def make_controller(self) -> driver.EngineController:
        controller = driver.EngineController()
        self.controllers.append(controller)
        self.assertTrue(controller.health()["ready"], controller.health())
        return controller

    @staticmethod
    def request(sfen: str = START_SFEN, multipv: int = 2) -> dict:
        return {"sfen": sfen, "movetime_ms": 250, "multipv": multipv, "threads": 1, "hash_mb": 256}

    def test_uses_last_complete_iteration_and_excludes_bound_scores(self) -> None:
        controller = self.make_controller()
        status, result = controller.analyze(self.request())
        self.assertEqual(status, 200)
        self.assertEqual(result["terminal"], "ok")
        self.assertEqual(result["completedDepth"], 2)
        self.assertEqual([candidate["scoreCp"] for candidate in result["candidates"]], [50, -30])
        self.assertEqual([candidate["move"] for candidate in result["candidates"]], ["7g7f", "2g2f"])

    def test_mate_score_and_cp_are_converted_to_sente_perspective(self) -> None:
        os.environ["DRIVER_FAKE_SCENARIO"] = "mate"
        controller = self.make_controller()
        white_to_move = START_SFEN.replace(" b - 1", " w - 1")
        status, result = controller.analyze(self.request(white_to_move))
        self.assertEqual(status, 200)
        self.assertEqual(result["terminal"], "mate")
        self.assertEqual(result["candidates"][0]["scoreMate"], -3)
        self.assertEqual(result["candidates"][1]["scoreCp"], -15)

    def test_invalid_sfen_is_rejected_before_engine_request(self) -> None:
        self.assertIsNone(
            driver._validate_driver_request(
                {"sfen": "startpos", "movetime_ms": 250, "multipv": 1}
            )
        )

    def test_concurrent_analysis_returns_409(self) -> None:
        os.environ["DRIVER_FAKE_SCENARIO"] = "slow"
        controller = self.make_controller()
        first_result: list[tuple[int, dict]] = []
        first = threading.Thread(target=lambda: first_result.append(controller.analyze(self.request())))
        first.start()
        deadline = time.monotonic() + 2
        while not controller._active and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(controller._active)
        status, payload = controller.analyze(self.request())
        self.assertEqual(status, 409)
        self.assertEqual(payload["error"], "analysis_conflict")
        first.join(timeout=3)
        self.assertFalse(first.is_alive())
        self.assertEqual(first_result[0][0], 200)


if __name__ == "__main__":
    unittest.main()
