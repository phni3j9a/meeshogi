from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from container import driver


START_SFEN = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1"
SINGLE_SFEN = "2p5k/4Rg2p/1P2L1Gp1/p1P+B+Bp3/n2p2pnP/l1G2P3/P+pKP1+p2+l/LS1S2SP+n/1NR1S1+pg1 b P 1"
NO_MOVES_SFEN = "4k4/9/9/9/9/9/9/9/4K4 b - 1"


FAKE_ENGINE = r'''#!/usr/bin/env python3
import os
import signal
import sys
import time

scenario = os.environ.get("DRIVER_FAKE_SCENARIO", "iteration")
state_path = os.environ["DRIVER_FAKE_STATE_PATH"]
try:
    boot_number = int(open(state_path, encoding="ascii").read()) + 1
except FileNotFoundError:
    boot_number = 1
open(state_path, "w", encoding="ascii").write(str(boot_number))
current_sfen = ""
if scenario in {"hang-once", "hang-then-start-fail"}:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)

def log(command):
    path = os.environ.get("DRIVER_FAKE_COMMAND_LOG")
    if path:
        with open(path, "a", encoding="utf-8") as output:
            output.write(command + "\n")

def emit_default():
    print("info depth 1 multipv 1 score cp 40 nodes 100 time 10 pv 7g7f 3c3d", flush=True)
    print("info depth 1 multipv 2 score cp -25 nodes 100 time 10 pv 2g2f 8c8d", flush=True)
    print("info depth 2 multipv 1 score cp 50 nodes 250 time 20 pv 7g7f 3c3d", flush=True)
    print("info depth 2 multipv 2 score cp -30 nodes 250 time 20 pv 2g2f 8c8d", flush=True)
    print("info depth 3 multipv 1 score cp 55 lowerbound nodes 400 time 30 pv 7g7f 3c3d", flush=True)
    print("info depth 3 multipv 2 score cp -35 nodes 400 time 30 pv 2g2f 8c8d", flush=True)

for raw in sys.stdin:
    command = raw.strip()
    log(command)
    if command == "usi":
        print("id name Fake USI Engine", flush=True)
        print("option name Threads type spin default 1 min 1 max 2", flush=True)
        print("option name USI_Hash type spin default 256 min 16 max 512", flush=True)
        print("option name MultiPV type spin default 1 min 1 max 8", flush=True)
        print("option name GenerateAllLegalMoves type check default false", flush=True)
        print("option name USI_Ponder type check default false", flush=True)
        print("option name USI_OwnBook type check default true", flush=True)
        print("option name BookFile type combo default book var no_book", flush=True)
        print("option name EvalDir type string default eval", flush=True)
        print("option name FV_SCALE type spin default 40 min 1 max 128", flush=True)
        if not (scenario == "hang-then-start-fail" and boot_number > 1):
            print("usiok", flush=True)
    elif command == "isready":
        print("readyok", flush=True)
    elif command.startswith("position sfen "):
        current_sfen = command.removeprefix("position sfen ")
    elif command.startswith("go "):
        if scenario in {"hang-once", "hang-then-start-fail"} and boot_number == 1:
            print("info depth 1 multipv 1 score cp 40 nodes 100 time 10 pv 7g7f 3c3d", flush=True)
            while True:
                time.sleep(1)
        if scenario == "exit-once" and boot_number == 1:
            os._exit(7)
        if scenario == "slow":
            time.sleep(0.7)
        if scenario == "single":
            print("info depth 1 multipv 1 score cp 4787 nodes 100 time 10 pv 8h8g", flush=True)
            print("bestmove 8h8g", flush=True)
            continue
        if scenario == "partial":
            print("info depth 2 multipv 1 score cp 50 nodes 200 time 20 pv 7g7f 3c3d", flush=True)
        elif scenario == "duplicate-rank":
            print("info depth 2 multipv 1 score cp 50 nodes 200 time 20 pv 7g7f 3c3d", flush=True)
            print("info depth 2 multipv 1 score cp 51 nodes 220 time 21 pv 7g7f 3c3d", flush=True)
            print("info depth 2 multipv 2 score cp -30 nodes 250 time 20 pv 2g2f 8c8d", flush=True)
        elif scenario == "duplicate-move":
            print("info depth 2 multipv 1 score cp 50 nodes 200 time 20 pv 7g7f 3c3d", flush=True)
            print("info depth 2 multipv 2 score cp -30 nodes 250 time 20 pv 7g7f 8c8d", flush=True)
        elif scenario == "depth-mismatch":
            print("info depth 1 multipv 1 score cp 50 nodes 200 time 20 pv 7g7f 3c3d", flush=True)
            print("info depth 2 multipv 2 score cp -30 nodes 250 time 20 pv 2g2f 8c8d", flush=True)
        elif scenario == "bound-only":
            print("info depth 2 multipv 1 score cp 50 lowerbound nodes 200 time 20 pv 7g7f 3c3d", flush=True)
            print("info depth 2 multipv 2 score cp -30 nodes 250 time 20 pv 2g2f 8c8d", flush=True)
        elif scenario == "bestmove-only":
            pass
        elif scenario == "flush-reemit":
            print("info depth 2 multipv 1 score cp 50 nodes 200 time 20 pv 7g7f 3c3d", flush=True)
            print("info depth 2 multipv 2 score cp -30 nodes 250 time 20 pv 2g2f 8c8d", flush=True)
            print("info depth 2 multipv 1 score cp 51 nodes 260 time 21 pv 7g7f 3c3d", flush=True)
            print("info depth 2 multipv 2 score cp -31 nodes 270 time 21 pv 2g2f 8c8d", flush=True)
        elif scenario == "flush-downgrade":
            print("info depth 3 multipv 1 score cp 55 nodes 400 time 30 pv 7g7f 3c3d", flush=True)
            print("info depth 3 multipv 2 score cp -35 nodes 400 time 30 pv 2g2f 8c8d", flush=True)
            print("info depth 2 multipv 1 score cp 50 nodes 410 time 31 pv 7g7f 3c3d", flush=True)
            print("info depth 2 multipv 2 score cp -30 nodes 410 time 31 pv 2g2f 8c8d", flush=True)
        elif scenario in {"bestmove-mismatch", "bestmove-illegal"}:
            print("info depth 2 multipv 1 score cp 50 nodes 200 time 20 pv 7g7f 3c3d", flush=True)
            print("info depth 2 multipv 2 score cp -30 nodes 250 time 20 pv 2g2f 8c8d", flush=True)
        elif scenario == "mate":
            print("info depth 4 multipv 1 score mate 3 nodes 300 time 8 pv 7g7f 3c3d", flush=True)
            print("info depth 4 multipv 2 score cp 15 nodes 300 time 8 pv 2g2f 8c8d", flush=True)
        elif scenario == "mate-zero":
            print("info depth 4 multipv 1 score mate -0 nodes 300 time 8 pv 7g7f 3c3d", flush=True)
            print("info depth 4 multipv 2 score cp 15 nodes 300 time 8 pv 2g2f 8c8d", flush=True)
        elif scenario == "cp-value":
            value = os.environ.get("DRIVER_FAKE_CP_VALUE", "32000")
            print(f"info depth 4 multipv 1 score cp {value} nodes 300 time 8 pv 7g7f 3c3d", flush=True)
            print("info depth 4 multipv 2 score cp 15 nodes 300 time 8 pv 2g2f 8c8d", flush=True)
        elif scenario == "resign":
            print("bestmove resign", flush=True)
            continue
        elif scenario == "win":
            print("bestmove win", flush=True)
            continue
        elif scenario == "none":
            print("bestmove none", flush=True)
            continue
        elif scenario == "0000":
            print("bestmove 0000", flush=True)
            continue
        else:
            emit_default()
        bestmove = "8h8g" if current_sfen == os.environ.get("DRIVER_FAKE_SINGLE_SFEN") else "7g7f"
        if scenario == "win":
            bestmove = "win"
        elif scenario == "none":
            bestmove = "none"
        elif scenario == "0000":
            bestmove = "0000"
        elif scenario == "bestmove-mismatch":
            bestmove = "2g2f"
        elif scenario == "bestmove-illegal":
            bestmove = "1a1a"
        print("bestmove " + bestmove, flush=True)
    elif command == "quit":
        break
'''


FAKE_HELPER = r'''#!/usr/bin/env python3
import json
import os
import re
import sys

args = sys.argv[1:]
command = args[0]
def option(name):
    try:
        return args[args.index(name) + 1]
    except (ValueError, IndexError):
        return None

sfen = option("--sfen")
if command == "legal":
    count = int(os.environ.get("DRIVER_FAKE_ROOT_LEGAL_COUNT", "-1"))
    if count < 0:
        count = 1 if sfen == os.environ.get("DRIVER_FAKE_SINGLE_SFEN") else 0 if sfen == os.environ.get("DRIVER_FAKE_ZERO_SFEN") else 30
    if count == 0:
        moves = []
    elif count == 1:
        moves = ["8h8g"]
    else:
        moves = ["7g7f", "2g2f", "3g3f"]
        for source_file in range(1, 10):
            for source_rank in "abcdefghi":
                for dest_file in range(1, 10):
                    for dest_rank in "abcdefghi":
                        move = f"{source_file}{source_rank}{dest_file}{dest_rank}"
                        if source_rank != dest_rank and move not in moves:
                            moves.append(move)
    moves = moves[:count]
    print(json.dumps({
        "legalMoveCount": count,
        "legalMoves": moves,
        "inCheck": count == 0 and os.environ.get("DRIVER_FAKE_IN_CHECK") == "true",
        "declarationWin": os.environ.get("DRIVER_FAKE_DECLARATION_WIN") == "true",
    }))
elif command == "pv-legal":
    moves = option("--moves") or ""
    valid = all(re.fullmatch(r"(?:[1-9][a-i][1-9][a-i]\+?|[PLNSGBR]\*[1-9][a-i])", move) for move in moves.split())
    if os.environ.get("DRIVER_FAKE_PV_LEGAL") == "false":
        valid = False
    print(json.dumps({"legal": bool(valid)}))
else:
    raise SystemExit(2)
'''


class DriverTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="meeshogi-fake-usi-")
        root = Path(self.temp.name)
        self.engine_path = root / "fake-engine"
        self.engine_path.write_text(FAKE_ENGINE, encoding="utf-8")
        self.engine_path.chmod(0o700)
        self.helper_path = root / "fake-helper"
        self.helper_path.write_text(FAKE_HELPER, encoding="utf-8")
        self.helper_path.chmod(0o700)
        self.weight_path = root / "fake.nn"
        self.weight_path.write_bytes(b"synthetic-weight-only-for-tests")
        self.options_path = root / "engine_options.txt"
        self.options_path.write_text("FV_SCALE 40\n", encoding="ascii")
        self.state_path = root / "boot-count"
        self.command_log = root / "commands.log"
        env = {
            "EXPECTED_ENGINE_SHA256": hashlib.sha256(self.engine_path.read_bytes()).hexdigest(),
            "EXPECTED_WEIGHT_SHA256": hashlib.sha256(self.weight_path.read_bytes()).hexdigest(),
            "DRIVER_FAKE_SCENARIO": "iteration",
            "DRIVER_FAKE_STATE_PATH": str(self.state_path),
            "DRIVER_FAKE_COMMAND_LOG": str(self.command_log),
            "DRIVER_FAKE_SINGLE_SFEN": SINGLE_SFEN,
            "DRIVER_FAKE_ZERO_SFEN": NO_MOVES_SFEN,
        }
        self.env_patch = patch.dict(os.environ, env)
        self.env_patch.start()
        self.path_patch = patch.multiple(
            driver,
            ENGINE_PATH=self.engine_path,
            WEIGHT_PATH=self.weight_path,
            OPTIONS_PATH=self.options_path,
            HELPER_PATH=self.helper_path,
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

    def scenario(self, name: str, **extra: str):
        return patch.dict(os.environ, {"DRIVER_FAKE_SCENARIO": name, **extra})

    def test_uses_last_complete_iteration_and_excludes_bound_scores(self) -> None:
        controller = self.make_controller()
        status, result = controller.analyze(self.request())
        self.assertEqual(status, 200)
        self.assertEqual(result["terminal"], "ok")
        self.assertEqual(result["completedDepth"], 2)
        self.assertEqual([candidate["scoreCp"] for candidate in result["candidates"]], [50, -30])
        self.assertEqual([candidate["move"] for candidate in result["candidates"]], ["7g7f", "2g2f"])
        self.assertEqual(result["contractVersion"], 3)
        self.assertEqual(result["requestedMultiPv"], 2)
        self.assertEqual(result["effectiveMultiPv"], 2)
        self.assertEqual(result["rootLegalMoveCount"], 30)
        self.assertEqual(result["engineBestmove"], "7g7f")
        self.assertTrue(result["engineEpoch"])
        self.assertEqual(result["engineEpoch"], controller.health()["engineEpoch"])

    def test_partial_duplicate_move_depth_mismatch_and_bound_only_are_incomplete(self) -> None:
        for scenario in ["partial", "duplicate-move", "depth-mismatch", "bound-only", "bestmove-only"]:
            with self.subTest(scenario=scenario), self.scenario(scenario):
                controller = self.make_controller()
                status, result = controller.analyze(self.request())
                self.assertEqual(status, 200)
                self.assertEqual(result["terminal"], "incomplete")
                self.assertEqual(result["candidates"], [])
                self.assertEqual(result["completedDepth"], 0)
                self.assertEqual(result["engineBestmove"], "7g7f")

    def test_reemitted_and_downgraded_flush_blocks_keep_the_last_complete_set(self) -> None:
        with self.scenario("duplicate-rank"):
            controller = self.make_controller()
            status, result = controller.analyze(self.request())
        self.assertEqual((status, result["terminal"]), (200, "ok"))
        self.assertEqual([candidate["scoreCp"] for candidate in result["candidates"]], [51, -30])

        with self.scenario("flush-reemit"):
            controller = self.make_controller()
            status, result = controller.analyze(self.request())
        self.assertEqual((status, result["terminal"]), (200, "ok"))
        self.assertEqual([candidate["scoreCp"] for candidate in result["candidates"]], [51, -31])
        self.assertEqual(result["completedDepth"], 2)

        with self.scenario("flush-downgrade"):
            controller = self.make_controller()
            status, result = controller.analyze(self.request())
        self.assertEqual((status, result["terminal"]), (200, "ok"))
        self.assertEqual(result["completedDepth"], 2)
        self.assertEqual([candidate["scoreCp"] for candidate in result["candidates"]], [50, -30])

    def test_legal_bestmove_disagreement_is_kept_not_rejected(self) -> None:
        with self.scenario("bestmove-mismatch"):
            controller = self.make_controller()
            status, result = controller.analyze(self.request())
        self.assertEqual((status, result["terminal"]), (200, "ok"))
        self.assertEqual(result["candidates"][0]["move"], "7g7f")
        self.assertEqual(result["engineBestmove"], "2g2f")

        with self.scenario("bestmove-illegal"):
            controller = self.make_controller()
            status, body = controller.analyze(self.request())
        self.assertEqual(status, 502)
        self.assertEqual(body["reason"], "illegal_bestmove")

    def test_multipv_scores_keep_sente_perspective_for_both_turns(self) -> None:
        with self.scenario("mate"):
            controller = self.make_controller()
            status, result = controller.analyze(self.request())
        self.assertEqual(status, 200)
        self.assertEqual(result["terminal"], "mate")
        self.assertEqual(result["candidates"][0]["scoreMate"], 3)
        self.assertEqual(result["candidates"][0]["mateSign"], "sente")
        self.assertEqual(result["candidates"][1]["scoreCp"], 15)

        white_to_move = START_SFEN.replace(" b - 1", " w - 1")
        with self.scenario("mate"):
            controller = self.make_controller()
            status, result = controller.analyze(self.request(white_to_move))
        self.assertEqual(status, 200)
        self.assertEqual(result["candidates"][0]["scoreMate"], -3)
        self.assertEqual(result["candidates"][0]["mateSign"], "gote")
        self.assertEqual(result["candidates"][1]["scoreCp"], -15)

    def test_mate_negative_zero_keeps_its_sign(self) -> None:
        with self.scenario("mate-zero"):
            controller = self.make_controller()
            status, result = controller.analyze(self.request())
        self.assertEqual(status, 200)
        self.assertEqual(result["terminal"], "mate")
        self.assertNotIn("scoreMate", result["candidates"][0])
        self.assertEqual(result["candidates"][0]["mateSign"], "gote")

    def test_cp_adapter_boundaries_and_protocol_rejection(self) -> None:
        for value in [32000, -32000, 35281, -35281]:
            with self.subTest(value=value), self.scenario("cp-value", DRIVER_FAKE_CP_VALUE=str(value)):
                controller = self.make_controller()
                status, result = controller.analyze(self.request())
                self.assertEqual(status, 200)
                self.assertEqual(result["candidates"][0]["scoreCp"], value)

        for value in [35282, -35282, 9007199254740993]:
            with self.subTest(value=value), self.scenario("cp-value", DRIVER_FAKE_CP_VALUE=str(value)):
                controller = self.make_controller()
                status, body = controller.analyze(self.request())
                self.assertEqual(status, 502)
                self.assertEqual(body, {"error": "analysis_failed", "reason": "score_cp_out_of_engine_range"})
                self.assertTrue(controller.health()["ready"])

    def test_requested_effective_and_root_counts_drive_engine_options(self) -> None:
        with self.scenario("single"):
            controller = self.make_controller()
            status, result = controller.analyze(self.request(SINGLE_SFEN, multipv=3))
        self.assertEqual(status, 200)
        self.assertEqual(result["requestedMultiPv"], 3)
        self.assertEqual(result["effectiveMultiPv"], 1)
        self.assertEqual(result["rootLegalMoveCount"], 1)
        self.assertEqual(result["multipv"], 1)
        self.assertEqual(result["candidates"][0]["move"], "8h8g")
        commands = self.command_log.read_text(encoding="utf-8")
        self.assertIn("setoption name MultiPV value 1", commands)
        self.assertGreaterEqual(commands.count("setoption name GenerateAllLegalMoves value true"), 2)

        with self.scenario("iteration", DRIVER_FAKE_ROOT_LEGAL_COUNT="3"):
            controller = self.make_controller()
            status, result = controller.analyze(self.request(multipv=2))
        self.assertEqual(status, 200)
        self.assertEqual((result["requestedMultiPv"], result["effectiveMultiPv"], result["rootLegalMoveCount"]), (2, 2, 3))

        with self.scenario("iteration", DRIVER_FAKE_ROOT_LEGAL_COUNT="2"):
            controller = self.make_controller()
            status, result = controller.analyze(self.request(multipv=3))
        self.assertEqual(status, 200)
        self.assertEqual((result["requestedMultiPv"], result["effectiveMultiPv"], result["rootLegalMoveCount"]), (3, 2, 2))

    def test_zero_legal_moves_are_checked_and_not_synthesized_as_mate_zero(self) -> None:
        with self.scenario("iteration", DRIVER_FAKE_IN_CHECK="true"):
            controller = self.make_controller()
            status, result = controller.analyze(self.request(NO_MOVES_SFEN, multipv=3))
        self.assertEqual(status, 200)
        self.assertEqual(result["terminal"], "no_legal_moves")
        self.assertEqual(result["terminalDetail"], "checkmate")
        self.assertEqual(result["effectiveMultiPv"], 0)
        self.assertEqual(result["candidates"], [])
        self.assertNotIn("scoreMate", result)
        self.assertNotIn("go movetime", self.command_log.read_text(encoding="utf-8"))

    def test_resign_win_none_and_unverified_pv_are_distinct(self) -> None:
        with self.scenario("resign"):
            controller = self.make_controller()
            status, result = controller.analyze(self.request())
        self.assertEqual((status, result["terminal"], result["candidates"]), (200, "resign", []))

        with self.scenario("win", DRIVER_FAKE_DECLARATION_WIN="true"):
            controller = self.make_controller()
            status, result = controller.analyze(self.request())
        self.assertEqual((status, result["terminal"], result["terminalDetail"]), (200, "win", "declaration_win"))

        with self.scenario("win"):
            controller = self.make_controller()
            status, body = controller.analyze(self.request())
        self.assertEqual(status, 502)
        self.assertEqual(body["reason"], "unverified_declaration_win")

        with self.scenario("none"):
            controller = self.make_controller()
            status, body = controller.analyze(self.request())
        self.assertEqual(status, 502)
        self.assertEqual(body["reason"], "bestmove_none_with_legal_moves")

        with self.scenario("0000"):
            controller = self.make_controller()
            status, body = controller.analyze(self.request())
        self.assertEqual(status, 502)
        self.assertEqual(body["reason"], "bestmove_none_with_legal_moves")

        with self.scenario("iteration", DRIVER_FAKE_PV_LEGAL="false"):
            controller = self.make_controller()
            status, body = controller.analyze(self.request())
        self.assertEqual(status, 502)
        self.assertEqual(body["reason"], "illegal_pv")

    def test_timeout_stops_kills_restarts_with_new_epoch_and_next_request_succeeds(self) -> None:
        with self.scenario("hang-once"), patch.object(driver, "SEARCH_GRACE_MS", 100), patch.object(
            driver, "STOP_RESPONSE_GRACE_SECONDS", 0.05
        ), patch.object(driver, "PROCESS_TERM_GRACE_SECONDS", 0.05), patch.object(
            driver, "PROCESS_KILL_GRACE_SECONDS", 0.1
        ):
            controller = self.make_controller()
            first_epoch = controller.health()["engineEpoch"]
            first_pid = controller.health()["processId"]
            status, result = controller.analyze(self.request())
            health = controller.health()
            next_status, next_result = controller.analyze(self.request())
        self.assertEqual(status, 200)
        self.assertEqual(result["terminal"], "position_failed:engine_timeout")
        self.assertEqual(result["engineEpoch"], first_epoch)
        self.assertEqual(result["restartCount"], 1)
        self.assertNotEqual(health["engineEpoch"], first_epoch)
        self.assertNotEqual(health["processId"], first_pid)
        self.assertEqual(health["lastRestartReason"], "engine_timeout")
        self.assertEqual(next_status, 200)
        self.assertEqual(next_result["terminal"], "ok")
        self.assertEqual(next_result["engineEpoch"], health["engineEpoch"])

    def test_engine_death_restarts_and_next_request_succeeds(self) -> None:
        with self.scenario("exit-once"):
            controller = self.make_controller()
            first_epoch = controller.health()["engineEpoch"]
            status, failed = controller.analyze(self.request())
            health = controller.health()
            next_status, next_result = controller.analyze(self.request())
        self.assertEqual(status, 200)
        self.assertEqual(failed["terminal"], "position_failed:engine_exit")
        self.assertEqual(failed["engineEpoch"], first_epoch)
        self.assertNotEqual(health["engineEpoch"], first_epoch)
        self.assertEqual(health["lastRestartReason"], "engine_exit")
        self.assertEqual((next_status, next_result["terminal"]), (200, "ok"))

    def test_cancelled_search_stays_cancelled_without_restarting(self) -> None:
        with self.scenario("slow"):
            controller = self.make_controller()
            results: list[tuple[int, dict]] = []
            thread = threading.Thread(target=lambda: results.append(controller.analyze(self.request())))
            thread.start()
            deadline = time.monotonic() + 2
            while not controller._search_started and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(controller.request_stop())
            thread.join(timeout=3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(results[0][0], 200)
        self.assertEqual(results[0][1]["terminal"], "cancelled")
        self.assertEqual(results[0][1]["restartCount"], 0)

    def test_restart_cap_surfaces_readiness_failure_instead_of_reusing_dead_engine(self) -> None:
        with self.scenario("hang-then-start-fail"), patch.object(driver, "SEARCH_GRACE_MS", 50), patch.object(
            driver, "STOP_RESPONSE_GRACE_SECONDS", 0.01
        ), patch.object(driver, "PROCESS_TERM_GRACE_SECONDS", 0.05), patch.object(
            driver, "PROCESS_KILL_GRACE_SECONDS", 0.1
        ), patch.object(driver, "USI_HANDSHAKE_TIMEOUT_SECONDS", 0.05), patch.object(
            driver, "MAX_RESTART_ATTEMPTS", 2
        ):
            controller = self.make_controller()
            status, failed = controller.analyze(self.request())
            health = controller.health()
            next_status, next_body = controller.analyze(self.request())
        self.assertEqual(status, 200)
        self.assertEqual(failed["terminal"], "position_failed:engine_timeout")
        self.assertEqual(health["restartCount"], 2)
        self.assertFalse(health["ready"])
        self.assertEqual(next_status, 503)
        self.assertEqual(next_body["error"], "container_not_ready")

    def test_analysis_and_health_include_synthetic_best_effort_stats(self) -> None:
        synthetic = {
            "enginePeakRssKiB": 12345,
            "engineRssKiB": 8192,
            "engineCpuMs": 276,
            "containerMemUsageBytes": 50331648,
        }
        with patch.object(driver, "_process_stats", return_value=synthetic):
            controller = self.make_controller()
            health = controller.health()
            status, result = controller.analyze(self.request())

        self.assertEqual(health["cpuFlags"], sorted(controller._cpu_flags))
        self.assertEqual(health["stats"], synthetic)
        self.assertIn("engineEpoch", health)
        self.assertIn("restartCount", health)
        self.assertEqual(status, 200)
        self.assertEqual(result["stats"], synthetic)

    def test_process_stats_parse_synthetic_proc_and_cgroup_files(self) -> None:
        with tempfile.TemporaryDirectory(prefix="meeshogi-synthetic-proc-") as temporary:
            root = Path(temporary)
            proc_root = root / "proc"
            process_dir = proc_root / "1234"
            process_dir.mkdir(parents=True)
            (process_dir / "status").write_text(
                "Name:\tfake-engine\nVmHWM:\t8192 kB\nVmRSS:\t4096 kB\n",
                encoding="ascii",
            )
            stat_fields = ["S", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "120", "30"]
            (process_dir / "stat").write_text(f"1234 (synthetic engine) {' '.join(stat_fields)}\n", encoding="ascii")
            memory_path = root / "memory.current"
            memory_path.write_text("50331648\n", encoding="ascii")

            with patch.object(driver.os, "sysconf", return_value=100):
                stats = driver._process_stats(1234, proc_root, memory_path)

        self.assertEqual(
            stats,
            {
                "enginePeakRssKiB": 8192,
                "engineRssKiB": 4096,
                "engineCpuMs": 1500,
                "containerMemUsageBytes": 50331648,
            },
        )

    def test_stats_provider_failure_does_not_fail_health_or_analysis(self) -> None:
        with patch.object(driver, "_process_stats", side_effect=RuntimeError("synthetic stats failure")):
            controller = self.make_controller()
            health = controller.health()
            status, result = controller.analyze(self.request())

        self.assertEqual(health["stats"], {})
        self.assertEqual(status, 200)
        self.assertEqual(result["terminal"], "ok")
        self.assertEqual(result["stats"], {})

    def test_invalid_sfen_is_rejected_before_engine_request(self) -> None:
        self.assertIsNone(driver._validate_driver_request({"sfen": "startpos", "movetime_ms": 250, "multipv": 1}))

    def test_concurrent_analysis_returns_409(self) -> None:
        with self.scenario("slow"):
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
