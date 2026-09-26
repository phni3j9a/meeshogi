from __future__ import annotations

import importlib.util
import contextlib
import io
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
IDENTITY_DIGESTS = {key: char * 64 for key, char in zip(runner.IDENTITY_DIGEST_KEYS, "abcde")}


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
        "containerApp": "meeshogi-analysis-mvp-staging-benchmark-standard-2",
        "containerClass": "BenchmarkStandard2Container",
        "containerBinding": "ANALYSIS_BENCHMARK_STANDARD_2",
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
        self.assertEqual(safe["containerApp"], "meeshogi-analysis-mvp-staging-benchmark-standard-2")
        self.assertEqual(safe["containerClass"], "BenchmarkStandard2Container")
        self.assertEqual(safe["containerBinding"], "ANALYSIS_BENCHMARK_STANDARD_2")
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

    def test_worker_generated_failure_is_retained_without_unconfirmed_driver_identity(self) -> None:
        response = {
            "schemaVersion": 1,
            "sfen": "request-position-must-not-be-copied",
            "status": "failure",
            "failure": {
                "code": "engine_error",
                "message": "Benchmark result failed contract validation.",
                "detail": "check=identityDigests; driverStatus=success; failureCode=invalid; containerHttpStatus=200",
            },
        }
        normalized, build_id, error, worker_failure, identity_confirmed = runner.normalize_response_identity(
            response, BUILD_ID, GIT_COMMIT, IDENTITY_DIGESTS, None,
        )
        self.assertIsNone(normalized)
        self.assertIsNone(build_id)
        self.assertIsNone(error)
        self.assertFalse(identity_confirmed)
        self.assertEqual(worker_failure["failure"]["code"], "engine_error")
        self.assertEqual(worker_failure["failure"]["detail"], response["failure"]["detail"])
        self.assertNotIn("sfen", worker_failure)

    def test_worker_failure_keeps_type_but_discards_unsafe_detail_and_driver_responses_stay_strict(self) -> None:
        worker_response = {
            "schemaVersion": 1, "status": "failure",
            "failure": {"code": "engine_error", "message": "Worker failure.", "detail": "secret exception text"},
        }
        _response, build_id, error, worker_failure, identity_confirmed = runner.normalize_response_identity(
            worker_response, BUILD_ID, GIT_COMMIT, IDENTITY_DIGESTS, None,
        )
        self.assertIsNone(build_id)
        self.assertIsNone(error)
        self.assertNotIn("detail", worker_failure["failure"])
        self.assertFalse(identity_confirmed)

        driver_response = {
            "schemaVersion": 2, "status": "failure", "identityDigests": {"engineSha256": "a" * 64},
            "failure": {"code": "engine_error", "message": "Driver failure."},
        }
        normalized, build_id, error, worker_failure, identity_confirmed = runner.normalize_response_identity(
            driver_response, BUILD_ID, GIT_COMMIT, IDENTITY_DIGESTS, None,
        )
        self.assertIsNone(normalized)
        self.assertIsNone(build_id)
        self.assertEqual(error, "build-id-missing")
        self.assertIsNone(worker_failure)
        self.assertFalse(identity_confirmed)

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

    def test_cold_manifest_has_one_finite_unused_name_per_trial(self) -> None:
        cold_manifest = runner.load_json(BENCH_DIR / "manifests" / "cold-standard-3.json")
        conditions = runner.load_conditions(runner.DEFAULT_CONDITIONS)
        targets = runner.targets_for_run(cold_manifest, conditions, BUILD_ID, "standard-3")
        preflight = [row for row in targets if row["purpose"] == "cold-preflight"]
        trials = [row for row in targets if row["purpose"] == "cold-trial"]
        self.assertEqual(len(preflight), 1)
        self.assertEqual([row["coldTrialNo"] for row in trials], [1, 2, 3])
        self.assertEqual(len({row["targetId"] for row in trials}), 3)
        self.assertTrue(all(BUILD_ID in row["targetId"] and row["segmentId"] == "cold-standard-3" for row in trials))

        with tempfile.TemporaryDirectory(prefix="meeshogi-cold-ledger-test-") as directory:
            path = Path(directory) / "raw.jsonl"
            trial = trials[0]
            self.assertFalse(runner.target_seen(path, trial["targetId"]))
            path.write_text(json.dumps({
                "recordType": "attempt", "targetId": trial["targetId"],
                "mode": "cold", "runId": cold_manifest["runId"],
            }) + "\n", encoding="utf-8")
            self.assertTrue(runner.target_seen(path, trial["targetId"]))

    def test_cold_runner_dispatches_once_to_each_fresh_target_then_stops_it(self) -> None:
        manifest = BENCH_DIR / "manifests" / "cold-standard-2.json"
        conditions = runner.load_conditions(runner.DEFAULT_CONDITIONS)
        target_rows = runner.targets_for_run(runner.load_json(manifest), conditions, BUILD_ID, "standard-2")
        preflight = next(row for row in target_rows if row["purpose"] == "cold-preflight")
        calls: list[dict] = []

        def fake_request_json(url, token, method, body=None, timeout=30):
            call = {"url": url, "method": method, "body": body, "timeout": timeout}
            calls.append(call)
            if url.endswith("/internal/benchmark/health?targetId=" + preflight["targetId"]):
                payload = {
                    "status": "ready", "buildId": BUILD_ID, "gitCommit": GIT_COMMIT,
                    "driverBootId": "b" * 32, "driverVersion": "test-driver", "contractVersion": "test-contract",
                    "expectedInstanceType": "standard-2", "workerExpectedInstanceType": "standard-2",
                    "workerBenchmarkEnabled": True, "identityDigests": IDENTITY_DIGESTS,
                    "targetId": preflight["targetId"], "segmentId": preflight["segmentId"],
                    "targetPurpose": "cold-preflight", "targetInstanceType": "standard-2",
                    "expectedBuildId": BUILD_ID, "containerState": "healthy",
                    "containerApp": preflight["containerApp"],
                    "containerClass": preflight["containerClass"],
                    "containerBinding": preflight["containerBinding"],
                    "containerStateLastChangeWall": "2026-09-25T00:00:00.000Z",
                    "runtime": {
                        "driverBootId": "b" * 32, "expectedInstanceType": "standard-2",
                        "osCpuCount": 1, "affinityCpuCount": 1, "cpuMax": None, "cpuQuota": None,
                        "memoryMaxBytes": None, "memTotalBytes": 5_900_000_000, "rootDiskTotalBytes": 12_000_000_000,
                    },
                }
                return 200, payload, 5, None
            if url.endswith("/internal/benchmark/stop"):
                return 200, {"stopped": True, "stopCheckedWithoutFetch": True}, 2, None
            if url.endswith("/internal/benchmark"):
                return 502, {"schemaVersion": 1, "status": "failure", "failure": {
                    "code": "engine_error", "message": "Analysis container is unavailable.",
                }}, 25, None
            self.fail(f"unexpected request URL {url}")

        with tempfile.TemporaryDirectory(prefix="meeshogi-cold-runner-main-test-") as directory:
            output_path = Path(directory) / "cold.jsonl"
            argv = [
                "run.py", "--manifest", str(manifest), "--expected-build-id", BUILD_ID,
                "--image-ref", "registry.example/image@sha256:" + "c" * 64,
                "--base-url", "https://example.invalid", "--output", str(output_path),
            ]
            stdout = io.StringIO()
            with (
                patch.object(sys, "argv", argv),
                patch.dict("os.environ", {"ANALYSIS_INTERNAL_TOKEN": "secret-token"}),
                patch.object(runner, "request_json", side_effect=fake_request_json),
                contextlib.redirect_stdout(stdout),
            ):
                self.assertEqual(runner.main(), 0)
            output_content = output_path.read_text(encoding="utf-8")
            records = [json.loads(line) for line in output_content.splitlines()]

        attempts = [row for row in records if row.get("recordType") == "attempt"]
        stops = [row for row in records if row.get("recordType") == "target-stop"]
        trial_attempts = [call for call in calls if call["url"].endswith("/internal/benchmark")]
        trial_stops = [row for row in stops if row.get("targetPurpose") == "cold-trial"]
        self.assertEqual(len(attempts), 3)
        self.assertEqual(len({row["targetId"] for row in attempts}), 3)
        self.assertEqual(len(trial_attempts), 3)
        self.assertEqual(len(trial_stops), 3)
        self.assertEqual([len(row["coldEvidence"]["httpAttempts"]) for row in attempts], [1, 1, 1])
        self.assertTrue(all(row["coldEvidence"]["timeToFirstSuccessMs"] is None for row in attempts))
        health_urls = [call["url"] for call in calls if "/internal/benchmark/health" in call["url"]]
        self.assertEqual(health_urls, [
            "https://example.invalid/internal/benchmark/health?targetId=" + preflight["targetId"],
        ])
        self.assertEqual({row["targetId"] for row in trial_stops}, {row["targetId"] for row in attempts})
        self.assertNotIn("secret-token", output_content)

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
                "containerApp": "meeshogi-analysis-mvp-staging-benchmark-standard-2",
                "containerClass": "BenchmarkStandard2Container",
                "containerBinding": "ANALYSIS_BENCHMARK_STANDARD_2",
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

    def test_interrupted_cold_trial_keeps_same_target_and_one_attempt(self) -> None:
        with tempfile.TemporaryDirectory(prefix="meeshogi-cold-recovery-test-") as directory:
            raw = Path(directory) / "raw.jsonl"
            pending = Path(directory) / "raw.jsonl.pending.json"
            target_id = "bench-standard-2-" + BUILD_ID + "-cold-test-cold-trial-1"
            pending.write_text(json.dumps({
                "recordType": "pending", "runId": "run-a", "mode": "cold",
                "conditionId": "condition-a", "positionId": "p1", "attemptNo": 1,
                "targetId": target_id, "segmentId": "cold-test",
                "unusedNameEvidence": {"allowlistedAtDeploy": True, "priorRunnerUseCount": 0},
                "requestStartWall": "2026-09-25T00:00:00.000Z",
            }), encoding="utf-8")
            self.assertTrue(runner.recover_pending(raw, pending))
            rows = [json.loads(line) for line in raw.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["targetId"], target_id)
            self.assertEqual(rows[0]["coldEvidence"]["httpAttempts"][0]["transportError"], "interrupted-before-response")
            self.assertEqual(len(runner.read_existing(raw, "run-a")), 1)


if __name__ == "__main__":
    unittest.main()
