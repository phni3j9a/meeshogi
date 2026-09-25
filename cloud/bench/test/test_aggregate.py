from __future__ import annotations

import importlib.util
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
            success(CANDIDATE, "p1", "opening", "2g2f", {"kind": "cp", "value": 10}, ["7g7f"]),
            success(REFERENCE, "p2", "middlegame", "8i8h", {"kind": "mate", "value": 3, "winningSide": "sente"}, ["7g7f", "2g2f"]),
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
        result = aggregate.aggregate_records(rows, {REFERENCE["conditionId"]: REFERENCE, CANDIDATE["conditionId"]: CANDIDATE})
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

    def test_repetition_variability_and_markdown_preserve_missing_data(self) -> None:
        first = success(CANDIDATE, "p1", "opening", "7g7f", {"kind": "cp", "value": 20}, ["2g2f"], rep=1)
        second = success(CANDIDATE, "p1", "opening", "2g2f", {"kind": "cp", "value": 15}, ["7g7f"], rep=2)
        value = aggregate.repetition_variability([first, second])
        self.assertEqual(value["positionsWithMultipleAttempts"], 1)
        self.assertEqual(value["top1RepeatAgreement"], {"numerator": 0, "denominator": 1, "rate": 0})
        report = aggregate.markdown_report({"runIds": [], "attemptCount": 0, "referenceConditionId": None, "conditions": [], "gameWallTimes": [], "coldStart": {}, "costEstimate": {}})
        self.assertIn("Primary reference: not present", report)


if __name__ == "__main__":
    unittest.main()
