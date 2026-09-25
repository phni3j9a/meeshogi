from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


BENCH_DIR = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("issue20_runner", BENCH_DIR / "run.py")
runner = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = runner
spec.loader.exec_module(runner)


class Response:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit: int):
        return b'{"status":"success"}'


class RunnerTests(unittest.TestCase):
    def test_dataset_sfen_hash_is_checked_and_phase_is_required(self) -> None:
        with tempfile.TemporaryDirectory(prefix="meeshogi-runner-test-") as directory:
            path = Path(directory) / "positions.json"
            sfen = "public synthetic position"
            digest = runner.sha256_text(sfen)
            path.write_text(json.dumps({
                "schemaVersion": 1,
                "source": {},
                "manifestSha256": "a" * 64,
                "positions": [{"id": "p1", "phase": "opening", "sfen": sfen, "sfenKey": "public synthetic position", "sha256": digest}],
            }), encoding="utf-8")
            _dataset, rows = runner.load_positions(path)
            self.assertEqual(rows[0]["id"], "p1")
            value = json.loads(path.read_text(encoding="utf-8"))
            value["positions"][0]["sha256"] = "0" * 64
            path.write_text(json.dumps(value), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                runner.load_positions(path)

    def test_game_dataset_allows_position_before_first_move_at_ply_zero(self) -> None:
        with tempfile.TemporaryDirectory(prefix="meeshogi-runner-test-") as directory:
            path = Path(directory) / "game.json"
            sfens = ["synthetic position before move one", "synthetic position before move two"]
            path.write_text(json.dumps({
                "schemaVersion": 1,
                "source": {},
                "id": "synthetic-game",
                "plies": len(sfens),
                "manifestSha256": "a" * 64,
                "positions": [
                    {"ply": ply, "sfen": sfen, "sha256": runner.sha256_text(sfen)}
                    for ply, sfen in enumerate(sfens)
                ],
            }), encoding="utf-8")
            _game, rows = runner.load_game(path)
            self.assertEqual([row["ply"] for row in rows], [0, 1])

            value = json.loads(path.read_text(encoding="utf-8"))
            value["positions"][1]["ply"] = 0
            path.write_text(json.dumps(value), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "increasing ply"):
                runner.load_game(path)

    def test_health_snapshot_whitelists_fields_and_hides_artifact_metadata(self) -> None:
        safe = runner.safe_health({
            "status": "ready",
            "driverBootId": "b" * 32,
            "expectedInstanceType": "standard-2",
            "identityDigests": {"private": "do-not-copy"},
            "runtime": {"osCpuCount": 2, "affinityCpuCount": 1, "cpuMax": "max 100000", "cpuQuota": None, "memoryMaxBytes": 1234},
        }, 200, 5)
        encoded = json.dumps(safe)
        self.assertNotIn("identityDigests", encoded)
        self.assertNotIn("do-not-copy", encoded)
        self.assertEqual(safe["driverBootId"], "b" * 32)
        self.assertEqual(safe["runtime"]["memoryMaxBytes"], 1234)

    def test_http_user_agent_is_explicit_and_transport_error_does_not_echo_details(self) -> None:
        captured = {}

        def open_request(request, timeout):
            captured["agent"] = request.get_header("User-agent")
            captured["authorization"] = request.get_header("Authorization")
            captured["timeout"] = timeout
            return Response()

        with patch.object(runner.urllib.request, "urlopen", side_effect=open_request):
            status, payload, elapsed, error = runner.request_json(
                "https://example.invalid/internal/benchmark", "secret-token", "POST", {"conditionId": "x"}, 12
            )
        self.assertEqual(status, 200)
        self.assertEqual(payload, {"status": "success"})
        self.assertEqual(error, None)
        self.assertGreaterEqual(elapsed, 0)
        self.assertEqual(captured["agent"], runner.USER_AGENT)
        self.assertEqual(captured["authorization"], "Bearer secret-token")
        self.assertEqual(captured["timeout"], 12)

        with patch.object(runner.urllib.request, "urlopen", side_effect=RuntimeError("secret-token detail")):
            status, payload, _elapsed, error = runner.request_json("https://example.invalid", "secret-token", "GET")
        self.assertIsNone(status)
        self.assertIsNone(payload)
        self.assertEqual(error, "RuntimeError")

    def test_existing_rows_make_attempts_resumable(self) -> None:
        with tempfile.TemporaryDirectory(prefix="meeshogi-runner-test-") as directory:
            path = Path(directory) / "raw.jsonl"
            path.write_text(json.dumps({
                "recordType": "attempt", "runId": "run-a", "mode": "positions",
                "conditionId": "condition-a", "positionId": "p1", "attemptNo": 2,
            }) + "\n", encoding="utf-8")
            self.assertEqual(
                runner.read_existing(path, "run-a"),
                {("positions", "condition-a", "p1", 2)},
            )
            self.assertEqual(runner.read_existing(path, "run-b"), set())

    def test_interrupted_request_is_finalized_as_a_failure_without_retry(self) -> None:
        with tempfile.TemporaryDirectory(prefix="meeshogi-runner-test-") as directory:
            raw = Path(directory) / "raw.jsonl"
            pending = Path(directory) / "raw.jsonl.pending.json"
            pending.write_text(json.dumps({
                "recordType": "pending", "runId": "run-a", "mode": "positions",
                "conditionId": "condition-a", "positionId": "p1", "attemptNo": 1,
                "requestStartWall": "2026-09-25T00:00:00.000Z",
            }), encoding="utf-8")
            self.assertTrue(runner.recover_pending(raw, pending))
            rows = [json.loads(line) for line in raw.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["recordType"], "attempt")
            self.assertEqual(rows[0]["transportError"], "interrupted-before-response")
            self.assertIn(("positions", "condition-a", "p1", 1), runner.read_existing(raw, "run-a"))
            self.assertFalse(pending.exists())


if __name__ == "__main__":
    unittest.main()
