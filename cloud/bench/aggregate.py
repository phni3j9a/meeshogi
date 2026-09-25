#!/usr/bin/env python3
"""Offline quality, timing, cold-start, and public-rate aggregation for raw JSONL."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable


CONTAINER_CPU_USD_PER_VCPU_SECOND = 0.000020
CONTAINER_MEMORY_USD_PER_GIB_SECOND = 0.0000025
CONTAINER_DISK_USD_PER_GB_SECOND = 0.00000007
WORKER_REQUEST_USD_PER_MILLION = 0.30
WORKER_CPU_USD_PER_MILLION_MS = 0.02
DO_REQUEST_USD_PER_MILLION = 0.15
DO_DURATION_USD_PER_MILLION_GB_SECOND = 12.50
DO_MEMORY_GIB = 128 / 1024
SLEEP_AFTER_SECONDS = 300
IDENTITY_DIGEST_KEYS = (
    "engineSha256", "weightSha256", "optionsSha256", "sourceArchiveSha256", "sourceTreeSha256",
)
CONTAINER_SIZES = {
    "standard-2": {"vCpu": 1, "memoryGiB": 6, "diskGb": 12},
    "standard-3": {"vCpu": 2, "memoryGiB": 8, "diskGb": 16},
}
RATE_URLS = {
    "containers": "https://developers.cloudflare.com/containers/platform/pricing/",
    "workers": "https://developers.cloudflare.com/workers/platform/pricing/",
    "durableObjects": "https://developers.cloudflare.com/durable-objects/platform/pricing/",
}
RATE_DATE = "2026-09-25"


def quantile(values: Iterable[float], probability: float) -> float | None:
    data = sorted(float(value) for value in values if value is not None and math.isfinite(float(value)))
    if not data:
        return None
    if len(data) == 1:
        return data[0]
    position = (len(data) - 1) * probability
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return data[lower]
    return data[lower] + (data[upper] - data[lower]) * (position - lower)


def value_stats(values: Iterable[float | int | None]) -> dict[str, Any]:
    raw = list(values)
    numbers = [float(value) for value in raw if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)]
    return {
        "count": len(numbers),
        "missing": len(raw) - len(numbers),
        "median": quantile(numbers, 0.5),
        "p90": quantile(numbers, 0.9),
        "min": min(numbers) if numbers else None,
        "max": max(numbers) if numbers else None,
    }


def ratio(numerator: int, denominator: int) -> dict[str, Any]:
    return {"numerator": numerator, "denominator": denominator, "rate": numerator / denominator if denominator else None}


def read_jsonl(paths: list[Path]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for path in paths:
        with path.open("r", encoding="utf-8") as stream:
            for line_number, line in enumerate(stream, 1):
                if not line.strip():
                    continue
                try:
                    item = json.loads(line)
                except json.JSONDecodeError as error:
                    raise ValueError(f"invalid JSON at {path}:{line_number}") from error
                if not isinstance(item, dict):
                    raise ValueError(f"raw line must be a JSON object at {path}:{line_number}")
                rows.append(item)
    return rows


def _successful(attempt: dict[str, Any]) -> bool:
    response = attempt.get("response")
    return isinstance(response, dict) and response.get("status") == "success" and isinstance(response.get("candidates"), list) and bool(response["candidates"])


def _top(attempt: dict[str, Any]) -> dict[str, Any] | None:
    response = attempt.get("response")
    candidates = response.get("candidates") if isinstance(response, dict) else None
    if not isinstance(candidates, list) or not candidates or not isinstance(candidates[0], dict):
        return None
    return candidates[0]


def _failure_cause(attempt: dict[str, Any]) -> str:
    response = attempt.get("response")
    if not isinstance(response, dict):
        transport_error = attempt.get("transportError")
        if isinstance(transport_error, str):
            return f"transport:{transport_error}"
        status = attempt.get("httpStatus")
        return f"http:{status}" if status is not None else "transport:no-response"
    status = response.get("status")
    if status == "failure":
        failure = response.get("failure")
        code = failure.get("code") if isinstance(failure, dict) else None
        return f"failure:{code}" if isinstance(code, str) else "failure:unknown"
    if status == "incomplete":
        outcome = response.get("engineOutcome")
        return f"incomplete:{outcome}" if isinstance(outcome, str) else "incomplete"
    if status == "terminal":
        terminal = response.get("terminal")
        return f"terminal:{terminal}" if isinstance(terminal, str) else "terminal:unknown"
    if status == "success":
        return "success"
    return f"response:{status}" if isinstance(status, str) else "response:unknown"


def _score(candidate: dict[str, Any] | None) -> dict[str, Any] | None:
    value = candidate.get("score") if isinstance(candidate, dict) else None
    if not isinstance(value, dict) or value.get("kind") not in {"cp", "mate"} or not isinstance(value.get("value"), int):
        return None
    return value


def pair_quality(pairs: list[tuple[dict[str, Any], dict[str, Any]]], multipv: int) -> dict[str, Any]:
    top1_num = top2_num = top3_num = 0
    top1_den = top2_den = top3_den = 0
    cp_diffs: list[float] = []
    score_kind_num = score_kind_den = 0
    mate_side_num = mate_distance_num = mate_den = 0
    for candidate_attempt, reference_attempt in pairs:
        if not (_successful(candidate_attempt) and _successful(reference_attempt)):
            continue
        candidate_top = _top(candidate_attempt)
        reference_top = _top(reference_attempt)
        if candidate_top is None or reference_top is None:
            continue
        candidate_response = candidate_attempt["response"]
        effective = None
        conditions = candidate_response.get("conditions")
        if isinstance(conditions, dict) and isinstance(conditions.get("actual"), dict):
            effective = conditions["actual"].get("effectiveMultiPV")
        candidate_moves = [row.get("move") for row in candidate_response.get("candidates", []) if isinstance(row, dict)]
        top1_den += 1
        top1_num += int(candidate_top.get("move") == reference_top.get("move"))
        if isinstance(effective, int) and effective >= 2 and len(candidate_moves) >= 2:
            top2_den += 1
            top2_num += int(reference_top.get("move") in candidate_moves[:2])
        if multipv == 3 and isinstance(effective, int) and effective >= 3 and len(candidate_moves) >= 3:
            top3_den += 1
            top3_num += int(reference_top.get("move") in candidate_moves[:3])
        candidate_score, reference_score = _score(candidate_top), _score(reference_top)
        if candidate_score is not None and reference_score is not None:
            score_kind_den += 1
            score_kind_num += int(candidate_score.get("kind") == reference_score.get("kind"))
            if candidate_score["kind"] == reference_score["kind"] == "cp":
                cp_diffs.append(abs(candidate_score["value"] - reference_score["value"]))
            elif candidate_score["kind"] == reference_score["kind"] == "mate":
                mate_den += 1
                mate_side_num += int(candidate_score.get("winningSide") == reference_score.get("winningSide"))
                mate_distance_num += int(candidate_score.get("value") == reference_score.get("value"))
    return {
        "pairedAttempts": len(pairs),
        "top1Agreement": ratio(top1_num, top1_den),
        "referenceTop1InCandidateTop2": ratio(top2_num, top2_den),
        "referenceTop1InCandidateTop3": ratio(top3_num, top3_den) if multipv == 3 else None,
        "cpAbsDiff": {
            "count": len(cp_diffs),
            "median": quantile(cp_diffs, 0.5),
            "p90": quantile(cp_diffs, 0.9),
        },
        "scoreKindAgreement": ratio(score_kind_num, score_kind_den),
        "mateSideAgreement": ratio(mate_side_num, mate_den),
        "mateDistanceExactAgreement": ratio(mate_distance_num, mate_den),
        "matePairs": mate_den,
    }


def _reference_map(
    rows: list[dict[str, Any]], reference_id: str | None, repetition: int = 1,
) -> dict[tuple[str, str], dict[str, Any]]:
    if reference_id is None:
        return {}
    return {
        (row["positionId"], row["positionSha256"]): row
        for row in rows
        if row.get("conditionId") == reference_id
        and row.get("attemptNo") == repetition
        and row.get("mode", "positions") == "positions"
        and row.get("comparisonRole", "primary") != "pilot"
        and isinstance(row.get("positionId"), str)
        and isinstance(row.get("positionSha256"), str)
    }


def _materialize_attempts(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    complete: dict[tuple[Any, ...], dict[str, Any]] = {}
    starts: dict[tuple[Any, ...], dict[str, Any]] = {}
    for row in records:
        if row.get("recordType") not in {"attempt", "attempt-start"}:
            continue
        key = (row.get("runId"), row.get("mode"), row.get("conditionId"), row.get("positionId"), row.get("attemptNo"))
        if row.get("recordType") == "attempt":
            if key in complete:
                raise ValueError(f"duplicate attempt key: {key}")
            complete[key] = row
        else:
            if key in starts:
                raise ValueError(f"duplicate attempt-start key: {key}")
            starts[key] = row
    output = list(complete.values())
    for key, start in starts.items():
        if key in complete:
            continue
        interrupted = dict(start)
        interrupted.update({
            "recordType": "attempt",
            "requestEndWall": None,
            "httpElapsedMs": None,
            "httpStatus": None,
            "transportError": "interrupted-before-response",
            "response": None,
            "coldEvidence": None,
        })
        output.append(interrupted)
    return output


def _canonical_sha256(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _valid_identity_digests(value: Any) -> bool:
    return isinstance(value, dict) and set(value) == set(IDENTITY_DIGEST_KEYS) and all(
        isinstance(value.get(key), str) and len(value[key]) == 64
        and all(char in "0123456789abcdef" for char in value[key])
        for key in IDENTITY_DIGEST_KEYS
    )


def verify_run_provenance(records: list[dict[str, Any]]) -> dict[str, Any]:
    run_starts: dict[str, dict[str, Any]] = {}
    for row in records:
        if row.get("recordType") != "run-start":
            continue
        run_id = row.get("runId")
        fingerprint = row.get("fingerprint")
        if not isinstance(run_id, str) or not isinstance(fingerprint, dict):
            raise ValueError("run-start record lacks runId or fingerprint")
        if run_id in run_starts:
            raise ValueError(f"duplicate run-start fingerprint for run {run_id}")
        supplied_hash = fingerprint.get("fingerprintSha256")
        unhashed = {key: value for key, value in fingerprint.items() if key != "fingerprintSha256"}
        if not isinstance(supplied_hash, str) or supplied_hash != _canonical_sha256(unhashed):
            raise ValueError(f"run {run_id} has an invalid fingerprintSha256")
        image_digest = fingerprint.get("imageDigest")
        image_ref = fingerprint.get("imageRef")
        if not isinstance(image_digest, str) or len(image_digest) != 64 or any(char not in "0123456789abcdef" for char in image_digest):
            raise ValueError(f"run {run_id} fingerprint lacks a pinned image digest")
        if not isinstance(image_ref, str) or not image_ref.endswith(f"@sha256:{image_digest}"):
            raise ValueError(f"run {run_id} imageRef does not match its pinned digest")
        for key in ("conditionsSha256", "datasetSha256", "datasetManifestSha256", "runManifestSha256"):
            value = fingerprint.get(key)
            if not isinstance(value, str) or len(value) != 64 or any(char not in "0123456789abcdef" for char in value):
                raise ValueError(f"run {run_id} fingerprint lacks {key}")
        if not isinstance(fingerprint.get("endpoint"), str) or not fingerprint["endpoint"].startswith(("http://", "https://")):
            raise ValueError(f"run {run_id} fingerprint lacks a valid endpoint")
        if not isinstance(fingerprint.get("driverVersion"), str) or not isinstance(fingerprint.get("contractVersion"), str):
            raise ValueError(f"run {run_id} fingerprint lacks driverVersion/contractVersion")
        if not _valid_identity_digests(fingerprint.get("identityDigests")):
            raise ValueError(f"run {run_id} fingerprint lacks valid artifact identity digests")
        run_starts[run_id] = row

    attempts = [row for row in records if row.get("recordType") in {"attempt", "attempt-start"}]
    if attempts and not run_starts:
        raise ValueError("raw attempts lack immutable run-start fingerprints")
    common_identity: tuple[Any, ...] | None = None
    for run_id, row in run_starts.items():
        fingerprint = row["fingerprint"]
        identity = (
            fingerprint["imageDigest"],
            tuple((key, fingerprint["identityDigests"][key]) for key in IDENTITY_DIGEST_KEYS),
            fingerprint.get("driverVersion"),
            fingerprint.get("contractVersion"),
        )
        if common_identity is None:
            common_identity = identity
        elif identity != common_identity:
            raise ValueError("aggregation mixes image or artifact identity digests across runs")
        start_health = row.get("healthAtRunStart")
        start_digests = start_health.get("identityDigests") if isinstance(start_health, dict) else None
        if start_digests is not None and start_digests != fingerprint["identityDigests"]:
            raise ValueError(f"run {run_id} run-start health identity digests differ from its fingerprint")

    for row in attempts:
        run_id = row.get("runId")
        if not isinstance(run_id, str) or run_id not in run_starts:
            raise ValueError(f"attempt references run {run_id!r} without a run-start fingerprint")
        fingerprint = run_starts[run_id]["fingerprint"]
        if row.get("runFingerprintSha256") != fingerprint["fingerprintSha256"]:
            raise ValueError(f"attempt in run {run_id} does not match its immutable fingerprint")
        if row.get("imageDigest") != fingerprint["imageDigest"] or row.get("identityDigests") != fingerprint["identityDigests"]:
            raise ValueError(f"attempt in run {run_id} has inconsistent image or artifact identities")
        response_digests = row.get("responseIdentityDigests")
        if response_digests is not None and response_digests != fingerprint["identityDigests"]:
            raise ValueError(f"attempt in run {run_id} response identity digests differ from its fingerprint")
        response = row.get("response")
        response_digests = response.get("identityDigests") if isinstance(response, dict) else None
        if response_digests is not None and response_digests != fingerprint["identityDigests"]:
            raise ValueError(f"attempt in run {run_id} response identity digests differ from its fingerprint")
        if isinstance(response, dict):
            for key in ("driverVersion", "contractVersion"):
                if isinstance(response.get(key), str) and response[key] != fingerprint[key]:
                    raise ValueError(f"attempt in run {run_id} response {key} differs from its fingerprint")
            response_worker_version = response.get("workerVersionId")
            if isinstance(fingerprint.get("workerVersionId"), str) and response_worker_version is not None:
                if response_worker_version != fingerprint["workerVersionId"]:
                    raise ValueError(f"attempt in run {run_id} response Worker version differs from its fingerprint")
        for field in ("healthAtRunStart", "healthSnapshot", "healthBeforeCold", "healthAfterCold"):
            health = row.get(field)
            health_digests = health.get("identityDigests") if isinstance(health, dict) else None
            if health_digests is not None and health_digests != fingerprint["identityDigests"]:
                raise ValueError(f"attempt in run {run_id} health identity digests differ from its fingerprint")
            if isinstance(health, dict):
                for key in ("driverVersion", "contractVersion"):
                    if isinstance(health.get(key), str) and health[key] != fingerprint[key]:
                        raise ValueError(f"attempt in run {run_id} health {key} differs from its fingerprint")
                health_worker_version = health.get("workerVersionId")
                if isinstance(fingerprint.get("workerVersionId"), str) and health_worker_version is not None:
                    if health_worker_version != fingerprint["workerVersionId"]:
                        raise ValueError(f"attempt in run {run_id} health Worker version differs from its fingerprint")

    return {
        "imageDigest": common_identity[0] if common_identity else None,
        "identityDigests": dict(common_identity[1]) if common_identity else None,
        "driverVersion": common_identity[2] if common_identity else None,
        "contractVersion": common_identity[3] if common_identity else None,
        "workerVersionIds": sorted({
            str(row["fingerprint"].get("workerVersionId"))
            for row in run_starts.values()
            if isinstance(row["fingerprint"].get("workerVersionId"), str)
        }),
        "runFingerprints": [
            {"runId": run_id, "fingerprintSha256": row["fingerprint"]["fingerprintSha256"]}
            for run_id, row in sorted(run_starts.items())
        ],
    }


def _metric_values(rows: list[dict[str, Any]], field: str) -> list[float | int | None]:
    result: list[float | int | None] = []
    for row in rows:
        response = row.get("response")
        meta = response.get("meta") if isinstance(response, dict) else None
        result.append(meta.get(field) if isinstance(meta, dict) else None)
    return result


def summarize_cell(
    rows: list[dict[str, Any]],
    references: dict[str, dict[str, Any]],
    condition: dict[str, Any],
) -> dict[str, Any]:
    attempts = len(rows)
    cause_counts = Counter(_failure_cause(row) for row in rows)
    status_counts = Counter()
    for row in rows:
        response = row.get("response")
        status = response.get("status") if isinstance(response, dict) else "transport"
        status_counts[status if isinstance(status, str) else "unknown"] += 1
    pairs: list[tuple[dict[str, Any], dict[str, Any]]] = []
    paired_without_reference = 0
    for row in rows:
        if condition.get("role") == "reference" and row.get("attemptNo") == 1:
            continue
        reference = references.get((row.get("positionId"), row.get("positionSha256")))
        if reference is None:
            paired_without_reference += 1
        else:
            pairs.append((row, reference))
    quality = pair_quality(pairs, int(condition.get("multiPV", 0)))
    quality["attemptsWithoutPrimaryReference"] = paired_without_reference
    metrics = {
        name: value_stats(_metric_values(rows, name))
        for name in ("completedDepth", "nodes", "engineNps", "derivedNps", "searchElapsedMs", "processElapsedMs")
    }
    metrics["engineChildCpuSecondsLowerBound"] = value_stats(_metric_values(rows, "processCpuSeconds"))
    metrics["httpElapsedMs"] = value_stats([row.get("httpElapsedMs") for row in rows])
    if condition.get("multiPV") != 3:
        quality["referenceTop1InCandidateTop3"] = None
    return {
        "attempts": attempts,
        "statusCounts": dict(sorted(status_counts.items())),
        "successRate": ratio(status_counts["success"], attempts),
        "incompleteRate": ratio(status_counts["incomplete"], attempts),
        "failureRate": ratio(status_counts["failure"] + status_counts["transport"], attempts),
        "terminalRate": ratio(status_counts["terminal"], attempts),
        "typedCauses": dict(sorted(cause_counts.items())),
        "metrics": metrics,
        "qualityVsPrimaryReference": quality,
    }


def repetition_variability(rows: list[dict[str, Any]]) -> dict[str, Any]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[str(row.get("positionId"))].append(row)
    comparisons: list[tuple[dict[str, Any], dict[str, Any]]] = []
    positions_repeated = 0
    for attempts in grouped.values():
        attempts.sort(key=lambda item: int(item.get("attemptNo", 0)))
        if len(attempts) < 2:
            continue
        positions_repeated += 1
        base = next((attempt for attempt in attempts if attempt.get("attemptNo") == 1), attempts[0])
        comparisons.extend((attempt, base) for attempt in attempts if attempt is not base)
    quality = pair_quality(comparisons, 3)
    return {
        "positionsWithMultipleAttempts": positions_repeated,
        "repeatComparisons": len(comparisons),
        "top1RepeatAgreement": quality["top1Agreement"],
        "cpAbsDiffAcrossRepeats": quality["cpAbsDiff"],
        "mateSideAgreementAcrossRepeats": quality["mateSideAgreement"],
        "mateDistanceExactAgreementAcrossRepeats": quality["mateDistanceExactAgreement"],
    }


def quality_vs_reference_repetitions(
    rows: list[dict[str, Any]],
    reference_repetitions: dict[int, dict[tuple[str, str], dict[str, Any]]],
    condition: dict[str, Any],
) -> dict[str, Any]:
    if condition.get("role") != "candidate":
        return {}
    comparisons: dict[str, Any] = {}
    for repetition, references in reference_repetitions.items():
        pairs: list[tuple[dict[str, Any], dict[str, Any]]] = []
        missing = 0
        for row in rows:
            reference = references.get((row.get("positionId"), row.get("positionSha256")))
            if reference is None:
                missing += 1
            else:
                pairs.append((row, reference))
        comparisons[str(repetition)] = {
            "referenceRepetition": repetition,
            "candidateAttempts": len(rows),
            "candidateAttemptsWithoutReference": missing,
            "quality": pair_quality(pairs, int(condition.get("multiPV", 0))),
        }
        if condition.get("multiPV") != 3:
            comparisons[str(repetition)]["quality"]["referenceTop1InCandidateTop3"] = None
    return comparisons


def _parse_utc(value: Any) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _valid_boot_id(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 32 and all(char in "0123456789abcdef" for char in value)


def _row_instance(row: dict[str, Any]) -> tuple[str | None, str | None]:
    direct_instance, direct_boot = row.get("expectedInstanceType"), row.get("driverBootId")
    if isinstance(direct_instance, str) and isinstance(direct_boot, str):
        return direct_instance, direct_boot
    response = row.get("response")
    if isinstance(response, dict):
        instance = response.get("expectedInstanceType")
        boot = response.get("driverBootId")
        if isinstance(instance, str) and isinstance(boot, str):
            return instance, boot
        runtime = response.get("runtime")
        if isinstance(runtime, dict):
            instance = runtime.get("expectedInstanceType") or instance
            boot = runtime.get("driverBootId") or boot
            if isinstance(instance, str) and isinstance(boot, str):
                return instance, boot
    health = row.get("healthSnapshot") or row.get("healthAtRunStart")
    if isinstance(health, dict):
        instance = health.get("expectedInstanceType") or health.get("workerExpectedInstanceType")
        boot = health.get("driverBootId")
        if isinstance(instance, str) and isinstance(boot, str):
            return instance, boot
    condition = row.get("condition")
    instance = condition.get("instanceType") if isinstance(condition, dict) else None
    return instance if isinstance(instance, str) else None, None


def container_cost(rows: list[dict[str, Any]]) -> dict[str, Any]:
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    analysis_rows = [row for row in rows if row.get("recordType") in {"attempt", "attempt-start"}]
    events = list(rows)
    health_events: dict[str, dict[str, Any]] = {}
    for row in rows:
        for field in ("healthAtRunStart", "healthSnapshot", "healthBeforeCold", "healthAfterCold"):
            snapshot = row.get(field)
            if not isinstance(snapshot, dict) or not isinstance(snapshot.get("requestStartWall"), str):
                continue
            stamp = snapshot["requestStartWall"]
            event = {
                "recordType": "health-event",
                "mode": row.get("mode", "positions"),
                "conditionId": row.get("conditionId"),
                "expectedInstanceType": snapshot.get("expectedInstanceType") or snapshot.get("workerExpectedInstanceType"),
                "driverBootId": snapshot.get("driverBootId"),
                "requestStartWall": snapshot.get("requestStartWall"),
                "requestEndWall": snapshot.get("requestEndWall"),
                "httpElapsedMs": snapshot.get("elapsedMs"),
                "sleepAfterSeconds": row.get("sleepAfterSeconds", SLEEP_AFTER_SECONDS),
            }
            prior = health_events.setdefault(stamp, event)
            if prior.get("conditionId") is None and isinstance(event.get("conditionId"), str):
                prior["conditionId"] = event["conditionId"]
    events.extend(health_events.values())
    for row in events:
        instance, boot = _row_instance(row)
        if instance in CONTAINER_SIZES and boot:
            grouped[(instance, boot)].append(row)
    active_by_instance: Counter[str] = Counter()
    active_by_condition: Counter[str] = Counter()
    sessions: list[dict[str, Any]] = []
    for (instance, boot), attempts in grouped.items():
        attempts.sort(key=lambda row: _parse_utc(row.get("requestStartWall")) or 0)
        segments: list[list[dict[str, Any]]] = []
        current: list[dict[str, Any]] = []
        previous_end: float | None = None
        for row in attempts:
            start = _parse_utc(row.get("requestStartWall"))
            end = _parse_utc(row.get("requestEndWall"))
            if start is None or end is None:
                continue
            sleep_after = row.get("sleepAfterSeconds")
            sleep_after = sleep_after if isinstance(sleep_after, (int, float)) else SLEEP_AFTER_SECONDS
            if current and previous_end is not None and start - previous_end > sleep_after:
                segments.append(current)
                current = []
            current.append(row)
            previous_end = end
        if current:
            segments.append(current)
        for segment in segments:
            first = _parse_utc(segment[0].get("requestStartWall"))
            last = _parse_utc(segment[-1].get("requestEndWall"))
            if first is None or last is None:
                continue
            tail = segment[-1].get("sleepAfterSeconds")
            tail = float(tail) if isinstance(tail, (int, float)) else SLEEP_AFTER_SECONDS
            request_secs = sum(max(0, int(row.get("httpElapsedMs") or 0)) / 1000 for row in segment)
            gaps = 0.0
            for left, right in zip(segment, segment[1:]):
                left_end = _parse_utc(left.get("requestEndWall"))
                right_start = _parse_utc(right.get("requestStartWall"))
                if left_end is not None and right_start is not None:
                    gaps += max(0.0, right_start - left_end)
            active_seconds = request_secs + gaps + tail
            active_by_instance[instance] += active_seconds
            weights: Counter[str] = Counter()
            for row in segment:
                condition_key = f"{row.get('mode', 'positions')}:{row.get('conditionId')}"
                weights[condition_key] += max(0.001, int(row.get("httpElapsedMs") or 0) / 1000)
            total_weight = sum(weights.values())
            for condition_id, weight in weights.items():
                active_by_condition[condition_id] += active_seconds * weight / total_weight
            sessions.append({"instanceType": instance, "bootId": boot, "requestCount": len(segment), "activeSeconds": active_seconds})
    total_cost = {"cpuUsdLowerBound": 0.0, "cpuUsdUpperBound": 0.0, "memoryUsd": 0.0, "diskUsd": 0.0}
    by_instance: dict[str, Any] = {}
    for instance, active_seconds in active_by_instance.items():
        size = CONTAINER_SIZES[instance]
        engine_child_cpu_seconds = 0.0
        engine_child_cpu_attempts = 0
        engine_child_cpu_missing = 0
        for row in analysis_rows:
            row_instance, _ = _row_instance(row)
            if row_instance != instance:
                continue
            response = row.get("response")
            meta = response.get("meta") if isinstance(response, dict) else None
            cpu = meta.get("processCpuSeconds") if isinstance(meta, dict) else None
            if isinstance(cpu, (int, float)) and not isinstance(cpu, bool):
                engine_child_cpu_seconds += max(0, float(cpu))
                engine_child_cpu_attempts += 1
            else:
                engine_child_cpu_missing += 1
        allocated_cpu_upper_bound = size["vCpu"] * active_seconds
        cpu_lower_cost = engine_child_cpu_seconds * CONTAINER_CPU_USD_PER_VCPU_SECOND
        cpu_upper_cost = allocated_cpu_upper_bound * CONTAINER_CPU_USD_PER_VCPU_SECOND
        memory_cost = size["memoryGiB"] * active_seconds * CONTAINER_MEMORY_USD_PER_GIB_SECOND
        disk_cost = size["diskGb"] * active_seconds * CONTAINER_DISK_USD_PER_GB_SECOND
        by_instance[instance] = {
            "fullActiveIntervalSecondsUpperBound": active_seconds,
            "engineChildCpuSecondsLowerBound": engine_child_cpu_seconds,
            "engineChildCpuAttemptsObserved": engine_child_cpu_attempts,
            "engineChildCpuAttemptsMissing": engine_child_cpu_missing,
            "containerAllocatedCpuSecondsUpperBound": allocated_cpu_upper_bound,
            "engineChildCpuUsdGrossLowerBound": cpu_lower_cost,
            "containerCpuUsdGrossUpperBound": cpu_upper_cost,
            "memoryUsdGross": memory_cost,
            "diskUsdGross": disk_cost,
        }
        total_cost["cpuUsdLowerBound"] += cpu_lower_cost
        total_cost["cpuUsdUpperBound"] += cpu_upper_cost
        total_cost["memoryUsd"] += memory_cost
        total_cost["diskUsd"] += disk_cost
    return {
        "byInstanceType": by_instance,
        "byConditionActiveSecondsEstimate": dict(active_by_condition),
        "sessions": sessions,
        "activeIntervalAssumptions": (
            "Per observed boot session: health/analysis HTTP request spans plus inter-request gaps and one configured "
            "sleepAfter tail. The first observed request latency includes Worker/Container/driver startup when startup "
            "occurs in that request. Cold idle waits are conservatively represented by the sleepAfter tail; no separate "
            "Container CPU telemetry is available."
        ),
        "grossUsd": total_cost,
    }


def cost_estimate(rows: list[dict[str, Any]]) -> dict[str, Any]:
    attempts = [row for row in rows if row.get("recordType") == "attempt"]
    health_calls: dict[str, dict[str, Any]] = {}
    for row in rows:
        for field in ("healthAtRunStart", "healthSnapshot", "healthBeforeCold", "healthAfterCold"):
            item = row.get(field)
            if isinstance(item, dict) and item.get("requestStartWall"):
                health_calls[str(item["requestStartWall"])] = item
    health_wall_seconds = sum(max(0, int(item.get("elapsedMs") or 0)) / 1000 for item in health_calls.values())
    worker_request_upper = len(attempts) + len(health_calls)
    worker_request_lower = sum(isinstance(row.get("response"), dict) for row in attempts) + sum(
        isinstance(item.get("status"), str) for item in health_calls.values()
    )
    do_health_lower = sum(
        isinstance(item.get("driverBootId"), str) and item.get("status") == "ready"
        for item in health_calls.values()
    )
    do_analysis_lower = sum(
        isinstance(row.get("response"), dict)
        and isinstance(row["response"].get("driverBootId"), str)
        for row in attempts
    )
    do_lower = do_health_lower + do_analysis_lower
    do_not_called = sum(
        row.get("httpStatus") in {400, 401, 404, 413, 415}
        or (isinstance(row.get("response"), dict) and isinstance(row["response"].get("failure"), dict)
            and row["response"]["failure"].get("code") in {"invalid", "unauthorized", "auth_unconfigured"})
        for row in attempts
    )
    do_upper = len(health_calls) + len(attempts) - do_not_called
    container = container_cost(rows)
    do_wall_seconds = sum(max(0, int(row.get("httpElapsedMs") or 0)) / 1000 for row in attempts) + health_wall_seconds
    condition_rows: dict[str, list[dict[str, Any]]] = defaultdict(list)
    condition_definitions: dict[str, dict[str, Any]] = {}
    for row in attempts:
        condition_id = row.get("conditionId")
        if isinstance(condition_id, str):
            condition_rows[f"{row.get('mode', 'positions')}:{condition_id}"].append(row)
            if isinstance(row.get("condition"), dict):
                condition_definitions[condition_id] = row["condition"]
    by_condition: dict[str, Any] = {}
    for measurement_cell, cell_rows in condition_rows.items():
        definition = condition_definitions.get(measurement_cell.split(":", 1)[1], {})
        instance = definition.get("instanceType")
        size = CONTAINER_SIZES.get(instance)
        if size is None:
            continue
        engine_child_cpu_seconds = 0.0
        engine_child_cpu_attempts = 0
        engine_child_cpu_missing = 0
        for row in cell_rows:
            response = row.get("response")
            meta = response.get("meta") if isinstance(response, dict) else None
            cpu = meta.get("processCpuSeconds") if isinstance(meta, dict) else None
            if isinstance(cpu, (int, float)) and not isinstance(cpu, bool):
                engine_child_cpu_seconds += max(0.0, float(cpu))
                engine_child_cpu_attempts += 1
            else:
                engine_child_cpu_missing += 1
        active_seconds = float(container["byConditionActiveSecondsEstimate"].get(measurement_cell, 0.0))
        allocated_cpu_upper_bound = size["vCpu"] * active_seconds
        container_components = {
            "fullActiveIntervalSecondsUpperBound": active_seconds,
            "engineChildCpuSecondsLowerBound": engine_child_cpu_seconds,
            "engineChildCpuAttemptsObserved": engine_child_cpu_attempts,
            "engineChildCpuAttemptsMissing": engine_child_cpu_missing,
            "containerAllocatedCpuSecondsUpperBound": allocated_cpu_upper_bound,
            "engineChildCpuUsdGrossLowerBound": engine_child_cpu_seconds * CONTAINER_CPU_USD_PER_VCPU_SECOND,
            "containerCpuUsdGrossUpperBound": allocated_cpu_upper_bound * CONTAINER_CPU_USD_PER_VCPU_SECOND,
            "memoryUsdGross": size["memoryGiB"] * active_seconds * CONTAINER_MEMORY_USD_PER_GIB_SECOND,
            "diskUsdGross": size["diskGb"] * active_seconds * CONTAINER_DISK_USD_PER_GB_SECOND,
        }
        request_count = len(cell_rows)
        cell_do_lower = sum(
            isinstance(row.get("response"), dict) and isinstance(row["response"].get("driverBootId"), str)
            for row in cell_rows
        )
        cell_do_upper = request_count - sum(
            row.get("httpStatus") in {400, 401, 404, 413, 415}
            or (isinstance(row.get("response"), dict) and isinstance(row["response"].get("failure"), dict)
                and row["response"]["failure"].get("code") in {"invalid", "unauthorized", "auth_unconfigured"})
            for row in cell_rows
        )
        do_proxy = sum(max(0.0, float(row.get("httpElapsedMs") or 0)) / 1000 for row in cell_rows) * DO_MEMORY_GIB
        by_condition[measurement_cell] = {
            "containers": container_components,
            "worker": {
                "requestAttemptsKnown": request_count,
                "billableRequestCountLowerBound": sum(isinstance(row.get("response"), dict) for row in cell_rows),
                "billableRequestCountUpperBound": request_count,
                "requestUsdGrossLowerBound": sum(isinstance(row.get("response"), dict) for row in cell_rows) * WORKER_REQUEST_USD_PER_MILLION / 1_000_000,
                "requestUsdGrossUpperBound": request_count * WORKER_REQUEST_USD_PER_MILLION / 1_000_000,
                "cpuUsdGross": None,
            },
            "durableObjects": {
                "requestCountLowerBound": cell_do_lower,
                "requestCountUpperBound": cell_do_upper,
                "requestUsdGrossLowerBound": cell_do_lower * DO_REQUEST_USD_PER_MILLION / 1_000_000,
                "requestUsdGrossUpperBound": cell_do_upper * DO_REQUEST_USD_PER_MILLION / 1_000_000,
                "durationGbSecondsUpperProxy": do_proxy,
                "durationUsdGrossUpperProxy": do_proxy * DO_DURATION_USD_PER_MILLION_GB_SECOND / 1_000_000,
            },
        }
    return {
        "basis": "gross usage at public rates before included allowances; not a Cloudflare invoice estimate",
        "rates": {
            "date": RATE_DATE,
            "urls": RATE_URLS,
            "containersCpuUsdPerVcpuSecond": CONTAINER_CPU_USD_PER_VCPU_SECOND,
            "containersMemoryUsdPerGiBSecond": CONTAINER_MEMORY_USD_PER_GIB_SECOND,
            "containersDiskUsdPerGBSecond": CONTAINER_DISK_USD_PER_GB_SECOND,
            "workersRequestUsdPerMillion": WORKER_REQUEST_USD_PER_MILLION,
            "workersCpuUsdPerMillionCpuMs": WORKER_CPU_USD_PER_MILLION_MS,
            "durableObjectRequestUsdPerMillion": DO_REQUEST_USD_PER_MILLION,
            "durableObjectDurationUsdPerMillionGBSecond": DO_DURATION_USD_PER_MILLION_GB_SECOND,
        },
        "formulas": {
            "engineChildCpuLowerBound": "sum(observed engine-child processCpuSeconds from wait4 rusage) * containersCpuUsdPerVcpuSecond; excludes Python driver and other Container CPU",
            "containerCpuUpperBound": "allocatedVcpu * full observed active-interval upper bound * containersCpuUsdPerVcpuSecond",
            "containerMemory": "provisionedGiB * full observed active-interval upper bound * containersMemoryUsdPerGiBSecond",
            "containerDisk": "provisionedGB * full observed active-interval upper bound * containersDiskUsdPerGBSecond",
            "workerRequests": "billable request count bounds * workersRequestUsdPerMillion / 1000000",
            "durableObjectRequests": "request count bounds * durableObjectRequestUsdPerMillion / 1000000",
            "durableObjectDurationProxy": "sum(HTTP elapsed seconds) * 128MiB-in-GiB * durableObjectDurationUsdPerMillionGBSecond / 1000000",
        },
        "containers": container,
        "byCondition": by_condition,
        "worker": {
            "requestAttemptsKnown": worker_request_upper,
            "billableRequestCountLowerBound": worker_request_lower,
            "billableRequestCountUpperBound": worker_request_upper,
            "requestUsdGrossLowerBound": worker_request_lower * WORKER_REQUEST_USD_PER_MILLION / 1_000_000,
            "requestUsdGrossUpperBound": worker_request_upper * WORKER_REQUEST_USD_PER_MILLION / 1_000_000,
            "cpuUsage": "unknown; Worker CPU usage is not exposed in the benchmark response",
            "cpuUsdGross": None,
        },
        "durableObjects": {
            "requestCountLowerBound": do_lower,
            "requestCountUpperBound": do_upper,
            "requestUsdGrossLowerBound": do_lower * DO_REQUEST_USD_PER_MILLION / 1_000_000,
            "requestUsdGrossUpperBound": do_upper * DO_REQUEST_USD_PER_MILLION / 1_000_000,
            "durationGbSecondsUpperProxy": do_wall_seconds * DO_MEMORY_GIB,
            "durationUsdGrossUpperProxy": do_wall_seconds * DO_MEMORY_GIB * DO_DURATION_USD_PER_MILLION_GB_SECOND / 1_000_000,
            "durationBasis": "HTTP elapsed × 128 MiB allocated DO proxy; exact active duration is unavailable",
            "sqlite": "not used by this Worker path",
        },
        "unknownOrExcluded": [
            "account plan, remaining included allowances, regional egress, Worker CPU, exact DO active duration, and invoice rounding",
            "engine-child CPU is only a lower bound; the allocated-vCPU upper bound assumes each observed Container session remains billable through one sleepAfter tail",
            "memory/disk duration and Container startup are estimated from observed HTTP request spans; platform scheduling may differ",
        ],
    }


def aggregate_records(records: list[dict[str, Any]], conditions: dict[str, dict[str, Any]]) -> dict[str, Any]:
    provenance = verify_run_provenance(records)
    attempts = _materialize_attempts(records)
    reference_ids = [condition_id for condition_id, condition in conditions.items() if condition.get("role") == "reference"]
    if len(reference_ids) > 1:
        raise ValueError("conditions manifest may contain at most one reference")
    reference_id = reference_ids[0] if reference_ids else None
    references = _reference_map(attempts, reference_id)
    reference_repetitions = {
        repetition: _reference_map(attempts, reference_id, repetition)
        for repetition in (2, 3)
    }
    rows_by_condition: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in attempts:
        if row.get("conditionId") in conditions:
            if row.get("mode", "positions") == "positions" and row.get("comparisonRole", "primary") != "pilot":
                rows_by_condition[row["conditionId"]].append(row)
    per_condition: list[dict[str, Any]] = []
    for condition_id, condition in conditions.items():
        rows = rows_by_condition.get(condition_id, [])
        phases = sorted({row.get("phase") for row in rows if row.get("phase") in {"opening", "middlegame", "endgame"}})
        by_phase = {
            phase: summarize_cell([row for row in rows if row.get("phase") == phase], references, condition)
            for phase in phases
        }
        per_condition.append({
            "condition": condition,
            "attemptCount": len(rows),
            "overall": summarize_cell(rows, references, condition),
            "byPhase": by_phase,
            "repetitionVariability": repetition_variability(rows),
            "qualityVsReferenceRepetitions": quality_vs_reference_repetitions(rows, reference_repetitions, condition),
        })
    game_summaries = [
        {key: row.get(key) for key in ("runId", "conditionId", "gameAttemptId", "positionCount", "gameWallMs", "complete", "resumed")}
        for row in records if row.get("recordType") == "game-summary"
    ]
    cold_rows = [row for row in attempts if row.get("mode") == "cold"]
    cold_confirmed = sum(
        bool(
            isinstance(row.get("coldEvidence"), dict)
            and row["coldEvidence"].get("coldConfirmed") is True
            and row["coldEvidence"].get("idleExceededSleepAfter") is True
            and isinstance(row["coldEvidence"].get("bootIdBeforeIdle"), str)
            and isinstance(row["coldEvidence"].get("bootIdFromAnalysisResponse"), str)
            and row["coldEvidence"]["bootIdBeforeIdle"] != row["coldEvidence"]["bootIdFromAnalysisResponse"]
        )
        for row in cold_rows
    )
    cold_status: Counter[str] = Counter()
    cold_causes: Counter[str] = Counter()
    for row in cold_rows:
        response = row.get("response")
        status = response.get("status") if isinstance(response, dict) else "transport"
        evidence = row.get("coldEvidence")
        response_boot_id = evidence.get("bootIdFromAnalysisResponse") if isinstance(evidence, dict) else None
        has_response_boot_id = _valid_boot_id(response_boot_id)
        if not has_response_boot_id and status not in {"failure", "transport"}:
            cold_status["failure"] += 1
            cold_causes["failure:analysis_boot_id_missing"] += 1
        else:
            cold_status[status if isinstance(status, str) else "unknown"] += 1
            cold_causes[_failure_cause(row)] += 1
    cold = {
        "attempts": len(cold_rows),
        "successRate": ratio(cold_status["success"], len(cold_rows)),
        "incompleteRate": ratio(cold_status["incomplete"], len(cold_rows)),
        "failureRate": ratio(cold_status["failure"] + cold_status["transport"], len(cold_rows)),
        "confirmedCold": ratio(cold_confirmed, len(cold_rows)),
        "bootIds": [
            {
                "conditionId": row.get("conditionId"),
                "positionId": row.get("positionId"),
                "before": row.get("coldEvidence", {}).get("bootIdBeforeIdle") if isinstance(row.get("coldEvidence"), dict) else None,
                "analysisResponseBootId": row.get("coldEvidence", {}).get("bootIdFromAnalysisResponse") if isinstance(row.get("coldEvidence"), dict) else None,
                "healthAfterBootId": row.get("coldEvidence", {}).get("bootIdAfterAttempt") if isinstance(row.get("coldEvidence"), dict) else None,
                "coldEvidenceFailure": (
                    "analysis_boot_id_missing"
                    if not _valid_boot_id(row.get("coldEvidence", {}).get("bootIdFromAnalysisResponse"))
                    else None
                ) if isinstance(row.get("coldEvidence"), dict) else "analysis_boot_id_missing",
                "httpStatus": row.get("httpStatus"),
                "status": row.get("response", {}).get("status") if isinstance(row.get("response"), dict) else "transport",
            }
            for row in cold_rows
        ],
        "statusCounts": dict(cold_causes),
    }
    game_rows = [row for row in attempts if row.get("mode") == "game"]
    game_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in game_rows:
        game_groups[str(row.get("gameAttemptId") or f"{row.get('conditionId')}#rep{row.get('attemptNo')}")].append(row)
    game_analysis = []
    for group_id, group in sorted(game_groups.items()):
        group.sort(key=lambda row: row.get("gameSequence") or 0)
        counts = Counter(_failure_cause(row) for row in group)
        expected = next((row.get("gamePositionCount") for row in group if isinstance(row.get("gamePositionCount"), int)), None)
        summary = next((row for row in game_summaries if row.get("gameAttemptId") == group_id), None)
        game_analysis.append({
            "gameAttemptId": group_id,
            "conditionId": group[0].get("conditionId"),
            "attemptedPositions": len(group),
            "expectedPositions": expected,
            "statusCauses": dict(sorted(counts.items())),
            "complete": summary.get("complete") if summary else (expected is not None and len(group) == expected),
            "gameWallMs": summary.get("gameWallMs") if summary else None,
            "perPositionHttpElapsedMs": value_stats([row.get("httpElapsedMs") for row in group]),
        })
    return {
        "schemaVersion": 2,
        "provenance": provenance,
        "runIds": sorted({row.get("runId") for row in records if isinstance(row.get("runId"), str)}),
        "attemptCount": len(attempts),
        "referenceConditionId": reference_id,
        "conditions": per_condition,
        "gameWallTimes": game_summaries,
        "gameAnalysis": game_analysis,
        "coldStart": cold,
        "costEstimate": cost_estimate(records),
    }


def markdown_report(value: dict[str, Any]) -> str:
    lines = [
        "# Issue #20 benchmark aggregate",
        "",
        f"Run IDs: {', '.join(value.get('runIds', [])) or 'none'}  ",
        f"Attempts: {value.get('attemptCount', 0)}  ",
        f"Primary reference: {value.get('referenceConditionId') or 'not present'}",
        "",
        "| Condition | Attempts | Success | Incomplete | Failure | Top-1 agreement | Ref top-1 in top-2 | Ref top-1 in top-3 | Mate side / distance | CP abs diff median / p90 | Depth median | Nodes median | Search ms median | HTTP ms median |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in value.get("conditions", []):
        overall = row["overall"]
        quality = overall["qualityVsPrimaryReference"]
        metrics = overall["metrics"]
        top1 = quality["top1Agreement"]["rate"]
        top2 = quality["referenceTop1InCandidateTop2"]["rate"]
        top3_stat = quality["referenceTop1InCandidateTop3"]
        top3 = top3_stat["rate"] if isinstance(top3_stat, dict) else None
        mate_side = quality["mateSideAgreement"]["rate"]
        mate_distance = quality["mateDistanceExactAgreement"]["rate"]
        cp = quality["cpAbsDiff"]
        condition_id = row["condition"]["conditionId"]
        def fmt(x: Any) -> str:
            return "n/a" if x is None else f"{x:.3f}" if isinstance(x, float) else str(x)
        lines.append(
            "| {id} | {n} | {s} | {i} | {f} | {top1} | {top2} | {top3} | {mate_side} / {mate_distance} | {cp50} / {cp90} | {depth} | {nodes} | {search} | {http} |".format(
                id=condition_id,
                n=overall["attempts"],
                s=fmt(overall["successRate"]["rate"]),
                i=fmt(overall["incompleteRate"]["rate"]),
                f=fmt(overall["failureRate"]["rate"]),
                top1=fmt(top1),
                top2=fmt(top2),
                top3=fmt(top3),
                mate_side=fmt(mate_side),
                mate_distance=fmt(mate_distance),
                cp50=fmt(cp["median"]),
                cp90=fmt(cp["p90"]),
                depth=fmt(metrics["completedDepth"]["median"]),
                nodes=fmt(metrics["nodes"]["median"]),
                search=fmt(metrics["searchElapsedMs"]["median"]),
                http=fmt(metrics["httpElapsedMs"]["median"]),
            )
        )
    lines.extend([
        "",
        "## Candidate quality against reference repetitions 2 and 3",
        "",
        "The same candidate attempts are paired independently with each available reference repetition. Ratios show numerator/denominator; missing reference positions are reported separately.",
        "",
        "| Candidate | Reference repetition | Candidate attempts | Paired attempts | Missing reference | Top-1 n/d | Top-2 n/d | Top-3 n/d | CP abs diff count, median / p90 | Mate side n/d | Mate distance n/d |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ])
    def ratio_label(value: dict[str, Any] | None) -> str:
        return "n/a" if not isinstance(value, dict) else f"{value['numerator']}/{value['denominator']}"

    for row in value.get("conditions", []):
        for repetition, comparison in row.get("qualityVsReferenceRepetitions", {}).items():
            quality = comparison["quality"]
            cp = quality["cpAbsDiff"]
            lines.append(
                "| {condition} | {rep} | {candidates} | {paired} | {missing} | {top1} | {top2} | {top3} | {cp_count}, {cp50} / {cp90} | {mate_side} | {mate_distance} |".format(
                    condition=row["condition"]["conditionId"],
                    rep=repetition,
                    candidates=comparison["candidateAttempts"],
                    paired=quality["pairedAttempts"],
                    missing=comparison["candidateAttemptsWithoutReference"],
                    top1=ratio_label(quality["top1Agreement"]),
                    top2=ratio_label(quality["referenceTop1InCandidateTop2"]),
                    top3=ratio_label(quality["referenceTop1InCandidateTop3"]),
                    cp_count=cp["count"],
                    cp50="n/a" if cp["median"] is None else f"{cp['median']:.3f}",
                    cp90="n/a" if cp["p90"] is None else f"{cp['p90']:.3f}",
                    mate_side=ratio_label(quality["mateSideAgreement"]),
                    mate_distance=ratio_label(quality["mateDistanceExactAgreement"]),
                )
            )
    lines.extend([
        "",
        "## By phase",
        "",
        "| Condition | Phase | Attempts | Success | Incomplete | Failure | Top-1 agreement | Ref top-1 in top-2 | CP abs diff median / p90 |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ])
    for row in value.get("conditions", []):
        for phase, summary in row.get("byPhase", {}).items():
            quality = summary["qualityVsPrimaryReference"]
            cp = quality["cpAbsDiff"]
            lines.append(
                "| {condition} | {phase} | {attempts} | {success} | {incomplete} | {failure} | {top1} | {top2} | {cp50} / {cp90} |".format(
                    condition=row["condition"]["conditionId"],
                    phase=phase,
                    attempts=summary["attempts"],
                    success="n/a" if summary["successRate"]["rate"] is None else f"{summary['successRate']['rate']:.3f}",
                    incomplete="n/a" if summary["incompleteRate"]["rate"] is None else f"{summary['incompleteRate']['rate']:.3f}",
                    failure="n/a" if summary["failureRate"]["rate"] is None else f"{summary['failureRate']['rate']:.3f}",
                    top1="n/a" if quality["top1Agreement"]["rate"] is None else f"{quality['top1Agreement']['rate']:.3f}",
                    top2="n/a" if quality["referenceTop1InCandidateTop2"]["rate"] is None else f"{quality['referenceTop1InCandidateTop2']['rate']:.3f}",
                    cp50="n/a" if cp["median"] is None else f"{cp['median']:.3f}",
                    cp90="n/a" if cp["p90"] is None else f"{cp['p90']:.3f}",
                )
            )
    lines.extend([
        "",
        "Top-k/score comparisons use successful candidate/reference pairs. Every ratio retains its numerator and denominator in the JSON output; missing results remain missing.",
        "",
        "## Game and cold-start records",
        "",
        f"Game summaries: {json.dumps(value.get('gameWallTimes', []), ensure_ascii=False)}",
        f"Cold-start evidence: {json.dumps(value.get('coldStart', {}), ensure_ascii=False)}",
        "",
        "## Cost estimate",
        "",
        "Gross public-rate usage before account included allowances; this is not an invoice or total bill estimate.",
        "",
        "```json",
        json.dumps(value.get("costEstimate", {}), ensure_ascii=False, indent=2, allow_nan=False),
        "```",
        "",
        f"Rate reference date: {RATE_DATE}. Formula and sources are in the JSON `costEstimate.rates` object.",
        "",
    ])
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, nargs="+", type=Path, help="raw JSONL file(s)")
    parser.add_argument("--conditions", type=Path, default=Path(__file__).resolve().parent / "conditions.json")
    parser.add_argument("--json-out", required=True, type=Path)
    parser.add_argument("--markdown-out", required=True, type=Path)
    args = parser.parse_args()
    try:
        conditions_manifest = json.loads(args.conditions.read_text(encoding="utf-8"))
        conditions = {row["conditionId"]: row for row in conditions_manifest["conditions"]}
        records = read_jsonl(args.input)
        output = aggregate_records(records, conditions)
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.markdown_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(json.dumps(output, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        args.markdown_out.write_text(markdown_report(output), encoding="utf-8")
    except (OSError, json.JSONDecodeError, KeyError, ValueError) as error:
        print(f"aggregate failed: {error}", file=sys.stderr)
        return 2
    print(json.dumps({"attempts": output["attemptCount"], "conditions": len(output["conditions"]), "json": str(args.json_out), "markdown": str(args.markdown_out)}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
