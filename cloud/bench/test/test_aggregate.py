from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from pathlib import Path


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


def add_provenance(rows: list[dict]) -> list[dict]:
    run_ids = sorted({row["runId"] for row in rows})
    starts = []
    for run_id in run_ids:
        fingerprint = {
            "imageRef": "registry.example/meeshogi@sha256:" + "f" * 64,
            "imageDigest": "f" * 64,
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
        starts.append({"recordType": "run-start", "runId": run_id, "fingerprint": fingerprint})
        for row in rows:
            if row["runId"] == run_id:
                row["runFingerprintSha256"] = fingerprint["fingerprintSha256"]
                row["imageDigest"] = fingerprint["imageDigest"]
                row["identityDigests"] = IDENTITY_DIGESTS
                if isinstance(row.get("response"), dict) and row["response"].get("status") in {"success", "incomplete", "failure"}:
                    row["response"]["identityDigests"] = IDENTITY_DIGESTS
                    row["responseIdentityDigests"] = IDENTITY_DIGESTS
    return starts + rows


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
        result = aggregate.aggregate_records(add_provenance(rows), {REFERENCE["conditionId"]: REFERENCE, CANDIDATE["conditionId"]: CANDIDATE})
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
        with self.assertRaisesRegex(ValueError, "mixes image or artifact identity"):
            aggregate.aggregate_records(records, {CANDIDATE["conditionId"]: CANDIDATE})

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
        self.assertEqual(instance["containerAllocatedCpuSecondsUpperBound"], 302)
        self.assertIn("driver startup", result["activeIntervalAssumptions"])

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
        result = aggregate.aggregate_records(add_provenance([row]), {})
        self.assertEqual(result["coldStart"]["successRate"], {"numerator": 0, "denominator": 1, "rate": 0})
        self.assertEqual(result["coldStart"]["failureRate"], {"numerator": 1, "denominator": 1, "rate": 1})
        self.assertEqual(result["coldStart"]["confirmedCold"], {"numerator": 0, "denominator": 1, "rate": 0})


if __name__ == "__main__":
    unittest.main()
