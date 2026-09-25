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

BUILD_ID = "9" * 32
GIT_COMMIT = "a" * 40


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
        "buildId": BUILD_ID,
        "gitCommit": GIT_COMMIT,
            "driverBootId": "b" * 32,
            "expectedInstanceType": "standard-2",
            "driverVersion": "usi-driver-v1",
            "contractVersion": "analysis-json-v1",
            "workerVersionId": "worker-version-id",
            "workerVersionTag": "benchmark-test",
            "identityDigests": {**{key: char * 64 for key, char in zip(runner.IDENTITY_DIGEST_KEYS, "abcde")}, "private": "do-not-copy"},
            "runtime": {
                "osCpuCount": 2, "affinityCpuCount": 1, "cpuMax": "max 100000", "cpuQuota": None,
                "memoryMaxBytes": 1234, "memTotalBytes": 5_900_000_000,
                "rootDiskTotalBytes": 25_000_000_000,
            },
        }, 200, 5)
        encoded = json.dumps(safe)
        self.assertNotIn("do-not-copy", encoded)
        self.assertNotIn("private", safe["identityDigests"])
        self.assertEqual(list(safe["identityDigests"]), list(runner.IDENTITY_DIGEST_KEYS))
        self.assertEqual(safe["workerVersionId"], "worker-version-id")
        self.assertEqual(safe["buildId"], BUILD_ID)
        self.assertEqual(safe["gitCommit"], GIT_COMMIT)
        self.assertEqual(safe["driverBootId"], "b" * 32)
        self.assertEqual(safe["runtime"]["memoryMaxBytes"], 1234)
        self.assertEqual(safe["runtime"]["memTotalBytes"], 5_900_000_000)
        self.assertEqual(safe["runtime"]["rootDiskTotalBytes"], 25_000_000_000)

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

    def test_pinned_image_and_immutable_resume_fingerprint(self) -> None:
        self.assertEqual(runner.pinned_image_digest("registry.example/image@sha256:" + "a" * 64), "a" * 64)
        with self.assertRaisesRegex(ValueError, "pinned"):
            runner.pinned_image_digest("registry.example/image:latest")
        fingerprint = {"imageDigest": "a" * 64, "fingerprintSha256": "same"}
        runner.assert_resume_fingerprint(fingerprint, fingerprint, "run-a")
        with self.assertRaisesRegex(ValueError, "fingerprint changed"):
            runner.assert_resume_fingerprint(fingerprint, {**fingerprint, "imageDigest": "b" * 64}, "run-a")

    def test_run_fingerprint_hashes_all_measurement_inputs_and_versions(self) -> None:
        with tempfile.TemporaryDirectory(prefix="meeshogi-runner-test-") as directory:
            root = Path(directory)
            conditions = root / "conditions.json"
            dataset = root / "dataset.json"
            manifest = root / "run.json"
            for path, content in ((conditions, "conditions"), (dataset, "dataset"), (manifest, "manifest")):
                path.write_text(content, encoding="utf-8")
            health = {
                "status": "ready",
                "buildId": BUILD_ID,
                "gitCommit": GIT_COMMIT,
                "driverVersion": "driver-v1",
                "contractVersion": "contract-v1",
                "workerVersionId": "version-id",
                "workerVersionTag": "tag",
                "workerVersionTimestamp": "time",
                "identityDigests": {key: char * 64 for key, char in zip(runner.IDENTITY_DIGEST_KEYS, "abcde")},
            }
            image_ref = "registry.example/meeshogi@sha256:" + "f" * 64
            first = runner.build_run_fingerprint(
                image_ref=image_ref,
                expected_build_id=BUILD_ID,
                mode="positions",
                endpoint="https://staging.example/",
                health=health,
                conditions_path=conditions,
                dataset_path=dataset,
                dataset_manifest_sha256="1" * 64,
                manifest_path=manifest,
            )
            self.assertEqual(first["endpoint"], "https://staging.example")
            self.assertEqual(first["imageDigest"], "f" * 64)
            self.assertEqual(first["buildId"], BUILD_ID)
            self.assertEqual(first["gitCommit"], GIT_COMMIT)
            self.assertEqual(first["workerVersionId"], "version-id")
            self.assertEqual(first["conditionsSha256"], runner.sha256_file(conditions))
            self.assertEqual(first["datasetSha256"], runner.sha256_file(dataset))
            self.assertEqual(first["runManifestSha256"], runner.sha256_file(manifest))
            manifest.write_text("changed manifest", encoding="utf-8")
            second = runner.build_run_fingerprint(
                image_ref=image_ref,
                expected_build_id=BUILD_ID,
                mode="positions",
                endpoint="https://staging.example/",
                health=health,
                conditions_path=conditions,
                dataset_path=dataset,
                dataset_manifest_sha256="1" * 64,
                manifest_path=manifest,
            )
            self.assertNotEqual(first["fingerprintSha256"], second["fingerprintSha256"])

    def test_run_fingerprint_rejects_health_from_a_different_build(self) -> None:
        with tempfile.TemporaryDirectory(prefix="meeshogi-runner-build-test-") as directory:
            root = Path(directory)
            conditions, dataset, manifest = (root / name for name in ("conditions.json", "dataset.json", "run.json"))
            for path in (conditions, dataset, manifest):
                path.write_text("{}", encoding="utf-8")
            health = {
                "status": "ready", "buildId": "8" * 32, "gitCommit": GIT_COMMIT,
                "driverVersion": "driver-v1", "contractVersion": "contract-v1",
                "identityDigests": {key: char * 64 for key, char in zip(runner.IDENTITY_DIGEST_KEYS, "abcde")},
            }
            with self.assertRaisesRegex(ValueError, "buildId does not match"):
                runner.build_run_fingerprint(
                    image_ref="registry.example/image@sha256:" + "f" * 64,
                    expected_build_id=BUILD_ID,
                    mode="positions",
                    endpoint="https://staging.example",
                    health=health,
                    conditions_path=conditions,
                    dataset_path=dataset,
                    dataset_manifest_sha256="1" * 64,
                    manifest_path=manifest,
                )

    def test_resume_refuses_attempts_without_run_start_fingerprint(self) -> None:
        with tempfile.TemporaryDirectory(prefix="meeshogi-runner-test-") as directory:
            path = Path(directory) / "raw.jsonl"
            path.write_text(json.dumps({"recordType": "attempt", "runId": "run-a"}) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "no immutable run-start fingerprint"):
                runner.existing_run_fingerprint(path, "run-a")

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
