from __future__ import annotations

import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch


BENCH_DIR = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("issue20_aggregate", BENCH_DIR / "aggregate.py")
aggregate = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = aggregate
spec.loader.exec_module(aggregate)


REFERENCE = {
    "conditionId": "reference-standard-3-t2-10000ms-mpv3",
    "instanceType": "standard-3",
    "threads": 2,
    "hashMb": 64,
    "moveTimeMs": 10000,
    "multiPV": 3,
    "role": "reference",
}
CANDIDATE = {
    "conditionId": "standard-3-t1-250ms-mpv2",
    "instanceType": "standard-3",
    "threads": 1,
    "hashMb": 64,
    "moveTimeMs": 250,
    "multiPV": 2,
    "role": "candidate",
}
IDENTITY_DIGESTS = {
    "engineSha256": "a" * 64,
    "weightSha256": "b" * 64,
    "optionsSha256": "c" * 64,
    "sourceArchiveSha256": "d" * 64,
    "sourceTreeSha256": "e" * 64,
}
BUILD_ID = "9" * 32
GIT_COMMIT = "a" * 40
CONDITIONS_SHA256 = "1" * 64


def add_provenance(rows: list[dict]) -> list[dict]:
    run_ids = sorted({row["runId"] for row in rows})
    starts = []
    for run_id in run_ids:
        mode = next(row.get("mode", "positions") for row in rows if row["runId"] == run_id)
        fingerprint = {
            "imageRef": "registry.example/meeshogi@sha256:" + "f" * 64,
            "imageDigest": "f" * 64,
            "buildId": BUILD_ID,
            "gitCommit": GIT_COMMIT,
            "mode": mode,
            "workerVersionId": "worker-fixture",
            "identityDigests": IDENTITY_DIGESTS,
            "driverVersion": "usi-driver-v1",
            "contractVersion": "analysis-json-v1",
            "conditionsSha256": "1" * 64,
            "datasetSha256": "2" * 64,
            "datasetManifestSha256": "3" * 64,
            "runManifestSha256": "4" * 64,
            "endpoint": "https://staging.example",
        }
        fingerprint["fingerprintSha256"] = aggregate._canonical_sha256(fingerprint)
        starts.append({
            "recordType": "run-start", "runId": run_id, "mode": mode, "fingerprint": fingerprint,
            "healthAtRunStart": {
                "buildId": BUILD_ID, "gitCommit": GIT_COMMIT, "identityDigests": IDENTITY_DIGESTS,
                "driverVersion": "usi-driver-v1", "contractVersion": "analysis-json-v1",
            },
        })
        for row in rows:
            if row["runId"] == run_id:
                row["runFingerprintSha256"] = fingerprint["fingerprintSha256"]
                row["imageDigest"] = fingerprint["imageDigest"]
                row["identityDigests"] = IDENTITY_DIGESTS
                row["expectedBuildId"] = BUILD_ID
                row["buildId"] = BUILD_ID
                row["responseBuildId"] = BUILD_ID if isinstance(row.get("response"), dict) else None
                if isinstance(row.get("response"), dict):
                    row["response"]["identityDigests"] = IDENTITY_DIGESTS
                    row["response"]["buildId"] = BUILD_ID
                    row["response"]["gitCommit"] = GIT_COMMIT
                    row["responseIdentityDigests"] = IDENTITY_DIGESTS
    return starts + rows


def aggregate_with_fixture_hash(records: list[dict], conditions: dict[str, dict]) -> dict:
    return aggregate.aggregate_records(records, conditions, conditions_sha256=CONDITIONS_SHA256)


def success(condition: dict, position_id: str, phase: str, move: str, score: dict, other: list[str] | None = None, rep: int = 1) -> dict:
    candidates = [{"move": move, "pv": [move], "score": score}]
    for next_move in other or []:
        candidates.append({"move": next_move, "pv": [next_move], "score": {"kind": "cp", "value": 5}})
    return {
        "recordType": "attempt",
        "runId": "synthetic",
        "mode": "positions",
        "attemptNo": rep,
        "conditionId": condition["conditionId"],
        "condition": condition,
        "positionId": position_id,
        "positionSha256": "0" * 64,
        "phase": phase,
        "requestStartWall": f"2026-09-25T00:00:0{rep}.000Z",
        "requestEndWall": f"2026-09-25T00:00:0{rep}.250Z",
        "httpElapsedMs": 250,
        "response": {
            "status": "success",
            "candidates": candidates,
            "conditions": {"actual": {"effectiveMultiPV": len(candidates)}},
            "meta": {
                "nodes": 1000,
                "completedDepth": 8,
                "engineNps": 9000,
                "derivedNps": 8000,
                "searchElapsedMs": 125,
                "processElapsedMs": 200,
                "processCpuSeconds": 0.1,
            },
        },
    }


class AggregateTests(unittest.TestCase):
    def test_linear_quantiles_and_missing_counts(self) -> None:
        self.assertEqual(aggregate.quantile([1, 2, 3, 4], 0.9), 3.7)
        stats = aggregate.value_stats([1, None, 3])
        self.assertEqual(stats["count"], 2)
        self.assertEqual(stats["missing"], 1)
        self.assertEqual(stats["median"], 2)

    def test_pair_quality_denominators_cp_mate_and_failures(self) -> None:
        rows = [
            success(REFERENCE, "p1", "opening", "7g7f", {"kind": "cp", "value": 20}, ["2g2f", "6g6f"]),
            {**success(REFERENCE, "p1", "opening", "2g2f", {"kind": "cp", "value": 100}, ["7g7f"], rep=1), "runId": "pilot", "comparisonRole": "pilot"},
            success(REFERENCE, "p1", "opening", "7g7f", {"kind": "cp", "value": 25}, ["2g2f", "6g6f"], rep=2),
            success(REFERENCE, "p1", "opening", "2g2f", {"kind": "cp", "value": 15}, ["7g7f", "6g6f"], rep=3),
            success(CANDIDATE, "p1", "opening", "2g2f", {"kind": "cp", "value": 10}, ["7g7f"]),
            success(REFERENCE, "p2", "middlegame", "8i8h", {"kind": "mate", "value": 3, "winningSide": "sente"}, ["7g7f", "2g2f"]),
            success(REFERENCE, "p2", "middlegame", "8i8h", {"kind": "mate", "value": 2, "winningSide": "gote"}, ["7g7f", "2g2f"], rep=2),
            success(REFERENCE, "p2", "middlegame", "8i8h", {"kind": "mate", "value": 4, "winningSide": "sente"}, ["7g7f", "2g2f"], rep=3),
            success(CANDIDATE, "p2", "middlegame", "8i8h", {"kind": "mate", "value": 4, "winningSide": "sente"}, ["7g7f"]),
            success(REFERENCE, "p3", "endgame", "7g7f", {"kind": "cp", "value": 4}, ["2g2f"]),
            {
                "recordType": "attempt", "runId": "synthetic", "mode": "positions", "attemptNo": 1,
                "conditionId": CANDIDATE["conditionId"], "condition": CANDIDATE, "positionId": "p3", "phase": "endgame",
                "positionSha256": "0" * 64,
                "httpElapsedMs": 500, "httpStatus": 504,
                "response": {"status": "failure", "failure": {"code": "timeout"}, "meta": {"nodes": 50}},
            },
            {
                "recordType": "attempt", "runId": "synthetic", "mode": "positions", "attemptNo": 1,
                "conditionId": CANDIDATE["conditionId"], "condition": CANDIDATE, "positionId": "p4", "phase": "endgame",
                "positionSha256": "0" * 64,
                "httpElapsedMs": 100, "httpStatus": 200,
                "response": {"status": "terminal", "terminal": "checkmate", "candidates": []},
            },
        ]
        result = aggregate_with_fixture_hash(add_provenance(rows), {REFERENCE["conditionId"]: REFERENCE, CANDIDATE["conditionId"]: CANDIDATE})
        self.assertEqual(result["schemaVersion"], 2)
        candidate_row = next(row for row in result["conditions"] if row["condition"]["conditionId"] == CANDIDATE["conditionId"])
        overall = candidate_row["overall"]
        self.assertEqual(overall["attempts"], 4)
        self.assertEqual(overall["successRate"], {"numerator": 2, "denominator": 4, "rate": 0.5})
        self.assertEqual(overall["failureRate"]["numerator"], 1)
        self.assertEqual(overall["terminalRate"]["numerator"], 1)
        self.assertEqual(overall["typedCauses"]["failure:timeout"], 1)
        quality = overall["qualityVsPrimaryReference"]
        self.assertEqual(quality["top1Agreement"], {"numerator": 1, "denominator": 2, "rate": 0.5})
        self.assertEqual(quality["referenceTop1InCandidateTop2"], {"numerator": 2, "denominator": 2, "rate": 1})
        self.assertIsNone(quality["referenceTop1InCandidateTop3"])
        self.assertEqual(quality["cpAbsDiff"]["count"], 1)
        self.assertEqual(quality["cpAbsDiff"]["median"], 10)
        self.assertEqual(quality["mateSideAgreement"], {"numerator": 1, "denominator": 1, "rate": 1})
        self.assertEqual(quality["mateDistanceExactAgreement"], {"numerator": 0, "denominator": 1, "rate": 0})
        self.assertEqual(quality["attemptsWithoutPrimaryReference"], 1)
        self.assertEqual(candidate_row["byPhase"]["opening"]["attempts"], 1)
        self.assertEqual(candidate_row["byPhase"]["endgame"]["attempts"], 2)
        rep2 = candidate_row["qualityVsReferenceRepetitions"]["2"]["quality"]
        rep3 = candidate_row["qualityVsReferenceRepetitions"]["3"]["quality"]
        self.assertEqual(rep2["pairedAttempts"], 2)
        self.assertEqual(rep3["pairedAttempts"], 2)
        self.assertEqual(rep2["top1Agreement"], {"numerator": 1, "denominator": 2, "rate": 0.5})
        self.assertEqual(rep3["top1Agreement"], {"numerator": 2, "denominator": 2, "rate": 1})
        self.assertEqual(rep3["mateDistanceExactAgreement"], {"numerator": 1, "denominator": 1, "rate": 1})
        self.assertIn("Candidate quality against reference repetitions 2 and 3", aggregate.markdown_report(result))

    def test_repetition_variability_and_markdown_preserve_missing_data(self) -> None:
        first = success(CANDIDATE, "p1", "opening", "7g7f", {"kind": "cp", "value": 20}, ["2g2f"], rep=1)
        second = success(CANDIDATE, "p1", "opening", "2g2f", {"kind": "cp", "value": 15}, ["7g7f"], rep=2)
        value = aggregate.repetition_variability([first, second])
        self.assertEqual(value["positionsWithMultipleAttempts"], 1)
        self.assertEqual(value["top1RepeatAgreement"], {"numerator": 0, "denominator": 1, "rate": 0})
        report = aggregate.markdown_report({"runIds": [], "attemptCount": 0, "referenceConditionId": None, "conditions": [], "gameWallTimes": [], "coldStart": {}, "costEstimate": {}})
        self.assertIn("Primary reference: not present", report)

    def test_duplicate_attempt_keys_are_rejected(self) -> None:
        row = success(CANDIDATE, "p1", "opening", "7g7f", {"kind": "cp", "value": 20})
        with self.assertRaisesRegex(ValueError, "duplicate attempt key"):
            aggregate._materialize_attempts([row, dict(row)])

    def test_aggregation_rejects_mixed_image_identity(self) -> None:
        rows = [
            success(CANDIDATE, "p1", "opening", "7g7f", {"kind": "cp", "value": 20}),
            {**success(CANDIDATE, "p2", "opening", "7g7f", {"kind": "cp", "value": 20}), "runId": "second-run"},
        ]
        records = add_provenance(rows)
        second_start = next(row for row in records if row.get("recordType") == "run-start" and row["runId"] == "second-run")
        second_fp = second_start["fingerprint"]
        second_fp["imageDigest"] = "9" * 64
        second_fp["imageRef"] = "registry.example/meeshogi@sha256:" + "9" * 64
        second_fp["fingerprintSha256"] = aggregate._canonical_sha256({key: value for key, value in second_fp.items() if key != "fingerprintSha256"})
        for row in records:
            if row.get("runId") == "second-run" and row.get("recordType") == "attempt":
                row["imageDigest"] = second_fp["imageDigest"]
                row["runFingerprintSha256"] = second_fp["fingerprintSha256"]
        with self.assertRaisesRegex(ValueError, "mixes image build or artifact identity"):
            aggregate_with_fixture_hash(records, {CANDIDATE["conditionId"]: CANDIDATE})

    def test_positions_runs_must_share_dataset_and_conditions_hashes(self) -> None:
        for changed_field, message in (
            ("datasetSha256", "mixes positions dataset hashes"),
            ("datasetManifestSha256", "mixes positions dataset hashes"),
            ("conditionsSha256", "mixes conditions manifest hashes"),
        ):
            with self.subTest(changed_field=changed_field):
                rows = [
                    success(CANDIDATE, "p1", "opening", "7g7f", {"kind": "cp", "value": 20}),
                    {**success(CANDIDATE, "p2", "opening", "2g2f", {"kind": "cp", "value": 10}), "runId": "second-run"},
                ]
                records = add_provenance(rows)
                second_start = next(row for row in records if row.get("recordType") == "run-start" and row["runId"] == "second-run")
                second_fingerprint = second_start["fingerprint"]
                second_fingerprint[changed_field] = "8" * 64
                second_fingerprint["fingerprintSha256"] = aggregate._canonical_sha256({
                    key: value for key, value in second_fingerprint.items() if key != "fingerprintSha256"
                })
                for row in records:
                    if row.get("runId") == "second-run" and row.get("recordType") == "attempt":
                        row["runFingerprintSha256"] = second_fingerprint["fingerprintSha256"]
                with self.assertRaisesRegex(ValueError, message):
                    aggregate_with_fixture_hash(records, {CANDIDATE["conditionId"]: CANDIDATE})

    def test_game_dataset_hashes_are_separate_from_positions_runs(self) -> None:
        rows = [
            success(CANDIDATE, "p1", "opening", "7g7f", {"kind": "cp", "value": 20}),
            {**success(CANDIDATE, "ply-1", "opening", "2g2f", {"kind": "cp", "value": 10}), "runId": "second-run", "mode": "game"},
        ]
        records = add_provenance(rows)
        second_start = next(row for row in records if row.get("recordType") == "run-start" and row["runId"] == "second-run")
        second_fingerprint = second_start["fingerprint"]
        second_fingerprint["datasetSha256"] = "8" * 64
        second_fingerprint["datasetManifestSha256"] = "7" * 64
        second_fingerprint["fingerprintSha256"] = aggregate._canonical_sha256({
            key: value for key, value in second_fingerprint.items() if key != "fingerprintSha256"
        })
        for row in records:
            if row.get("runId") == "second-run" and row.get("recordType") == "attempt":
                row["runFingerprintSha256"] = second_fingerprint["fingerprintSha256"]
        aggregate.verify_run_provenance(records)

    def test_duplicate_primary_reference_across_runs_is_rejected(self) -> None:
        first = success(REFERENCE, "p1", "opening", "7g7f", {"kind": "cp", "value": 20})
        second = {**success(REFERENCE, "p1", "opening", "2g2f", {"kind": "cp", "value": 10}), "runId": "second-run"}
        records = add_provenance([first, second])
        with self.assertRaisesRegex(ValueError, "duplicate primary reference attempt across runs"):
            aggregate_with_fixture_hash(records, {REFERENCE["conditionId"]: REFERENCE})

    def test_worker_failure_is_counted_as_typed_failure_without_driver_identity(self) -> None:
        row = {
            "recordType": "attempt", "runId": "worker-failure-run", "mode": "positions", "attemptNo": 1,
            "conditionId": CANDIDATE["conditionId"], "condition": CANDIDATE,
            "positionId": "p1", "positionSha256": "0" * 64, "phase": "opening",
            "httpStatus": 502, "transportError": None, "response": None,
            "workerFailure": {
                "schemaVersion": 1, "status": "failure",
                "failure": {
                    "code": "engine_error", "message": "Benchmark result failed contract validation.",
                    "detail": "check=identityDigests; driverStatus=success; containerHttpStatus=200",
                },
            },
            "driverIdentityConfirmed": False,
            "responseBuildId": None,
        }
        result = aggregate_with_fixture_hash(add_provenance([row]), {CANDIDATE["conditionId"]: CANDIDATE})
        overall = result["conditions"][0]["overall"]
        self.assertEqual(overall["statusCounts"], {"failure": 1})
        self.assertEqual(overall["failureRate"], {"numerator": 1, "denominator": 1, "rate": 1})
        self.assertEqual(overall["typedCauses"]["failure:engine_error"], 1)

    def test_worker_failure_cannot_bypass_driver_identity_checks(self) -> None:
        row = {
            "recordType": "attempt", "runId": "worker-failure-run", "mode": "positions", "attemptNo": 1,
            "conditionId": CANDIDATE["conditionId"], "condition": CANDIDATE,
            "positionId": "p1", "positionSha256": "0" * 64,
            "workerFailure": {
                "schemaVersion": 1, "status": "failure",
                "failure": {"code": "engine_error", "message": "Benchmark failed."},
            },
            "driverIdentityConfirmed": False,
            "response": {"status": "success", "buildId": BUILD_ID, "gitCommit": GIT_COMMIT},
        }
        with self.assertRaisesRegex(ValueError, "Worker failure incorrectly claims driver identity"):
            aggregate_with_fixture_hash(add_provenance([row]), {CANDIDATE["conditionId"]: CANDIDATE})

    def test_analysis_response_build_identity_remains_strict(self) -> None:
        row = success(CANDIDATE, "p1", "opening", "7g7f", {"kind": "cp", "value": 20})
        records = add_provenance([row])
        records[-1]["response"]["buildId"] = "8" * 32
        with self.assertRaisesRegex(ValueError, "response image build identity differs"):
            aggregate_with_fixture_hash(records, {CANDIDATE["conditionId"]: CANDIDATE})

    def test_aggregation_requires_the_run_conditions_hash(self) -> None:
        records = add_provenance([success(CANDIDATE, "p1", "opening", "7g7f", {"kind": "cp", "value": 20})])
        with self.assertRaisesRegex(ValueError, "conditions manifest hash does not match"):
            aggregate.aggregate_records(
                records, {CANDIDATE["conditionId"]: CANDIDATE}, conditions_sha256="8" * 64,
            )

    def test_cli_hashes_the_selected_conditions_file_before_aggregation(self) -> None:
        with tempfile.TemporaryDirectory(prefix="meeshogi-aggregate-conditions-test-") as directory:
            root = Path(directory)
            conditions_path = root / "conditions.json"
            conditions_path.write_text(json.dumps({"schemaVersion": 1, "conditions": [CANDIDATE]}), encoding="utf-8")
            raw_path = root / "raw.jsonl"
            records = add_provenance([success(CANDIDATE, "p1", "opening", "7g7f", {"kind": "cp", "value": 20})])
            raw_path.write_text("".join(json.dumps(row) + "\n" for row in records), encoding="utf-8")
            stderr = io.StringIO()
            with patch.object(aggregate.sys, "argv", [
                "aggregate.py", "--input", str(raw_path), "--conditions", str(conditions_path),
                "--json-out", str(root / "out.json"), "--markdown-out", str(root / "out.md"),
            ]), redirect_stderr(stderr):
                result = aggregate.main()
            self.assertEqual(result, 2)
            self.assertIn("conditions manifest hash does not match the run fingerprint", stderr.getvalue())

    def test_container_cpu_reports_engine_child_lower_and_allocated_upper(self) -> None:
        attempt = success(CANDIDATE, "p1", "opening", "7g7f", {"kind": "cp", "value": 20})
        attempt.update({
            "expectedInstanceType": "standard-2",
            "driverBootId": "b" * 32,
            "requestStartWall": "2026-09-25T00:00:00.000Z",
            "requestEndWall": "2026-09-25T00:00:01.000Z",
            "httpElapsedMs": 1000,
            "healthAtRunStart": {
                "expectedInstanceType": "standard-2",
                "driverBootId": "b" * 32,
                "requestStartWall": "2026-09-24T23:59:59.000Z",
                "requestEndWall": "2026-09-25T00:00:00.000Z",
                "elapsedMs": 1000,
            },
        })
        result = aggregate.container_cost([attempt])
        instance = result["byInstanceType"]["standard-2"]
        self.assertEqual(instance["engineChildCpuSecondsLowerBound"], 0.1)
        self.assertEqual(instance["engineChildCpuAttemptsObserved"], 1)
        self.assertEqual(instance["containerAllocatedCpuSecondsUpperBound"], 2)
        self.assertIn("No sleepAfter tail is assumed", result["activeIntervalAssumptions"])
        self.assertFalse(result["sessions"][0]["stopConfirmed"])

    def test_named_target_cost_uses_first_dispatch_through_confirmed_stop(self) -> None:
        target_id = "bench-standard-3-" + "a" * 32 + "-pilot-segment"
        records = [
            {
                "recordType": "target-health", "targetId": target_id, "segmentId": "pilot-segment",
                "expectedInstanceType": "standard-3", "requestStartWall": "2026-09-25T00:00:00.000Z",
                "requestEndWall": "2026-09-25T00:00:05.000Z", "httpElapsedMs": 5000,
                "health": {"driverBootId": "b" * 32, "status": "ready"},
            },
            {
                "recordType": "attempt", "runId": "pilot", "mode": "positions", "conditionId": "c1",
                "condition": {"instanceType": "standard-3"}, "targetId": target_id,
                "expectedInstanceType": "standard-3", "driverBootId": "b" * 32,
                "requestStartWall": "2026-09-25T00:00:06.000Z", "requestEndWall": "2026-09-25T00:00:10.000Z",
                "httpElapsedMs": 4000, "response": {"meta": {"processCpuSeconds": 1.0}},
            },
            {
                "recordType": "target-stop", "targetId": target_id, "segmentId": "pilot-segment",
                "expectedInstanceType": "standard-3", "firstDispatchWall": "2026-09-25T00:00:00.000Z",
                "requestStartWall": "2026-09-25T00:00:30.000Z", "requestEndWall": "2026-09-25T00:00:31.000Z",
                "stopConfirmed": True,
                "stopResponse": {"stateAfter": {"containerState": "stopped", "containerStateLastChangeWall": "2026-09-25T00:00:30.000Z"}},
            },
        ]
        result = aggregate.container_cost(records)
        session = result["sessions"][0]
        self.assertEqual(session["targetId"], target_id)
        self.assertEqual(session["activeSeconds"], 30)
        self.assertTrue(session["stopConfirmed"])
        self.assertEqual(result["byInstanceType"]["standard-3"]["containerAllocatedCpuSecondsUpperBound"], 60)
        self.assertEqual(result["unconfirmedTargets"], [])

    def test_unconfirmed_named_target_is_reported_without_sleep_tail(self) -> None:
        target_id = "bench-standard-2-" + "a" * 32 + "-segment"
        result = aggregate.container_cost([{
            "recordType": "attempt", "targetId": target_id, "expectedInstanceType": "standard-2",
            "requestStartWall": "2026-09-25T00:00:00.000Z", "requestEndWall": "2026-09-25T00:00:02.000Z",
            "httpElapsedMs": 2000, "mode": "positions", "conditionId": "c1",
        }])
        self.assertEqual(result["byInstanceType"], {})
        self.assertEqual(result["unconfirmedTargets"], [{
            "targetId": target_id, "firstDispatchWall": "2026-09-25T00:00:00.000Z", "stopConfirmed": False,
        }])
        self.assertIn("Unconfirmed stop events remain listed", result["activeIntervalAssumptions"])

    def test_cold_confirmation_requires_analysis_response_boot_id(self) -> None:
        row = {
            "recordType": "attempt", "runId": "cold-run", "mode": "cold", "attemptNo": 1,
            "conditionId": CANDIDATE["conditionId"], "condition": CANDIDATE,
            "positionId": "p1", "positionSha256": "0" * 64,
            "response": {"status": "success", "candidates": []}, "httpStatus": 200,
            "coldEvidence": {
                "bootIdBeforeIdle": "a" * 32,
                "bootIdAfterAttempt": "b" * 32,
                "bootIdFromAnalysisResponse": None,
                "bootChanged": False,
                "idleExceededSleepAfter": True,
                "coldConfirmed": False,
            },
        }
        result = aggregate_with_fixture_hash(add_provenance([row]), {})
        self.assertEqual(result["coldStart"]["successRate"], {"numerator": 0, "denominator": 1, "rate": 0})
        self.assertEqual(result["coldStart"]["failureRate"], {"numerator": 1, "denominator": 1, "rate": 1})
        self.assertEqual(result["coldStart"]["label"], "new-instance cold start")
        self.assertFalse(result["coldStart"]["idleSleepResumeVerified"])
        self.assertEqual(result["coldStart"]["verifiedNewInstanceTarget"], {"numerator": 0, "denominator": 1, "rate": 0})

    def test_cold_http_502_unused_name_is_not_a_verified_new_instance(self) -> None:
        row = {
            "recordType": "attempt", "runId": "cold-failed", "mode": "cold", "attemptNo": 1,
            "conditionId": CANDIDATE["conditionId"], "condition": CANDIDATE,
            "positionId": "p1", "positionSha256": "0" * 64,
            "targetId": "bench-standard-3-" + BUILD_ID + "-failed-cold-trial-1",
            "segmentId": "failed", "expectedInstanceType": "standard-3",
            "containerApp": "meeshogi-analysis-mvp-staging-benchmark-standard-3",
            "containerClass": "BenchmarkStandard3Container",
            "containerBinding": "ANALYSIS_BENCHMARK_STANDARD_3",
            "requestStartWall": "2026-09-25T00:00:00.000Z", "httpStatus": 502,
            "response": None, "responseBootId": None, "responseBuildId": None,
            "responseIdentityDigests": None, "driverIdentityConfirmed": False,
            "workerFailure": {
                "schemaVersion": 1, "status": "failure",
                "failure": {"code": "engine_error", "message": "Analysis failed."},
            },
            "unusedNameEvidence": {
                "allowlistedAtDeploy": True,
                "evidenceScope": "unused target name only; this does not prove the Container started",
                "priorRunnerUseCount": 0,
                "healthOrWarmupBeforeFirstAnalysis": False,
            },
            "coldEvidence": {
                "responseBootId": None,
                "responseRuntime": None,
                "httpAttempts": [{"httpStatus": 502}],
            },
        }
        result = aggregate_with_fixture_hash(add_provenance([row]), {})
        cold = result["coldStart"]
        self.assertEqual(cold["attempts"], 1)
        self.assertEqual(cold["failureRate"], {"numerator": 1, "denominator": 1, "rate": 1})
        self.assertEqual(cold["verifiedNewInstanceTarget"], {"numerator": 0, "denominator": 1, "rate": 0})
        self.assertEqual(cold["trials"][0]["coldEvidenceFailure"], "analysis_boot_id_missing")
        self.assertFalse(cold["trials"][0]["verifiedNewInstanceTarget"])
        self.assertEqual(cold["statusCounts"]["failure:engine_error"], 1)
        self.assertEqual(cold["statusCounts"]["coldEvidence:analysis_boot_id_missing"], 1)

    def test_cold_verified_new_instance_requires_response_runtime_and_identity(self) -> None:
        boot_id = "b" * 32
        runtime = {
            "expectedInstanceType": "standard-3",
            "driverBootId": boot_id,
            "osCpuCount": 2,
            "affinityCpuCount": 2,
            "cpuMax": None,
            "cpuQuota": 2,
            "memoryMaxBytes": 8 * (1 << 30),
            "memTotalBytes": 8 * (1 << 30),
            "rootDiskTotalBytes": 16 * (1 << 30),
        }
        target_id = "bench-standard-3-" + BUILD_ID + "-verified-cold-trial-1"
        row = {
            "recordType": "attempt", "runId": "cold-verified", "mode": "cold", "attemptNo": 1,
            "conditionId": CANDIDATE["conditionId"], "condition": CANDIDATE,
            "positionId": "p1", "positionSha256": "0" * 64,
            "targetId": target_id, "segmentId": "verified", "expectedInstanceType": "standard-3",
            "containerApp": "meeshogi-analysis-mvp-staging-benchmark-standard-3",
            "containerClass": "BenchmarkStandard3Container",
            "containerBinding": "ANALYSIS_BENCHMARK_STANDARD_3",
            "expectedBuildId": BUILD_ID, "responseBuildId": BUILD_ID,
            "requestStartWall": "2026-09-25T00:00:00.000Z", "httpStatus": 200,
            "driverIdentityConfirmed": True, "responseBootId": boot_id,
            "runtime": runtime,
            "unusedNameEvidence": {
                "allowlistedAtDeploy": True,
                "evidenceScope": "unused target name only; this does not prove the Container started",
                "priorRunnerUseCount": 0,
                "healthOrWarmupBeforeFirstAnalysis": False,
            },
            "response": {
                "status": "success", "expectedInstanceType": "standard-3", "driverBootId": boot_id,
                "runtime": runtime, "targetId": target_id, "segmentId": "verified",
                "targetInstanceType": "standard-3",
                "expectedBuildId": BUILD_ID,
                "containerApp": "meeshogi-analysis-mvp-staging-benchmark-standard-3",
                "containerClass": "BenchmarkStandard3Container",
                "containerBinding": "ANALYSIS_BENCHMARK_STANDARD_3",
            },
            "coldEvidence": {
                "responseBootId": boot_id, "responseRuntime": runtime,
                "httpAttempts": [{"httpStatus": 200}],
            },
        }
        result = aggregate_with_fixture_hash(add_provenance([row]), {})
        cold = result["coldStart"]
        self.assertEqual(cold["failureRate"], {"numerator": 0, "denominator": 1, "rate": 0})
        self.assertEqual(cold["verifiedNewInstanceTarget"], {"numerator": 1, "denominator": 1, "rate": 1})
        self.assertIsNone(cold["trials"][0]["coldEvidenceFailure"])
        self.assertTrue(cold["trials"][0]["verifiedNewInstanceTarget"])


if __name__ == "__main__":
    unittest.main()
