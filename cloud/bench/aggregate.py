#!/usr/bin/env python3
"""Offline quality, timing, cold-start, and public-rate aggregation for raw JSONL."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import statistics
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
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
IDENTITY_DIGEST_KEYS = (
    "engineSha256", "weightSha256", "optionsSha256", "sourceArchiveSha256", "sourceTreeSha256",
)
# Health snapshots use the driver health contract recorded in the run fingerprint.
# Benchmark analysis responses have their own public contract version.
BENCHMARK_RESPONSE_CONTRACT_VERSION = "analysis-json-v2"
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
WORKER_FAILURE_CODES = frozenset({
    "auth_unconfigured", "unauthorized", "invalid", "busy", "timeout",
    "identity_mismatch", "instance_mismatch", "engine_error",
})
WORKER_FAILURE_DETAIL_RE = re.compile(
    r"^check=[A-Za-z0-9_.-]{1,64}; driverStatus=[A-Za-z0-9_.-]{1,64}; "
    r"(?:failureCode=[A-Za-z0-9_.-]{1,64}; )?containerHttpStatus=[0-9]{3}$"
)
SAFE_FAILURE_MESSAGE_RE = re.compile(r"^[^\x00-\x1f\x7f]{1,256}$")


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


def _valid_worker_failure(value: Any) -> bool:
    if not isinstance(value, dict) or set(value) != {"schemaVersion", "status", "failure"}:
        return False
    if value.get("schemaVersion") != 1 or value.get("status") != "failure":
        return False
    failure = value.get("failure")
    if not isinstance(failure, dict) or not set(failure).issubset({"code", "message", "detail"}):
        return False
    code, message = failure.get("code"), failure.get("message")
    if not isinstance(code, str) or code not in WORKER_FAILURE_CODES or not isinstance(message, str) or not SAFE_FAILURE_MESSAGE_RE.fullmatch(message):
        return False
    if "detail" not in failure:
        return True
    detail = failure["detail"]
    return isinstance(detail, str) and len(detail) <= 256 and WORKER_FAILURE_DETAIL_RE.fullmatch(detail) is not None


def _attempt_status(attempt: dict[str, Any]) -> str:
    response = attempt.get("response")
    if isinstance(response, dict) and isinstance(response.get("status"), str):
        return response["status"]
    if _valid_worker_failure(attempt.get("workerFailure")):
        return "failure"
    return "transport"


def _failure_cause(attempt: dict[str, Any]) -> str:
    response = attempt.get("response")
    if not isinstance(response, dict):
        worker_failure = attempt.get("workerFailure")
        if _valid_worker_failure(worker_failure):
            return f"failure:{worker_failure['failure']['code']}"
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


def _reject_duplicate_reference_attempts(
    rows: list[dict[str, Any]], reference_id: str | None,
) -> None:
    if reference_id is None:
        return
    seen: dict[tuple[str, str, str, int], str] = {}
    for row in rows:
        if (
            row.get("conditionId") != reference_id
            or row.get("mode", "positions") != "positions"
            or row.get("comparisonRole", "primary") == "pilot"
            or not isinstance(row.get("positionId"), str)
            or not isinstance(row.get("positionSha256"), str)
            or type(row.get("attemptNo")) is not int
        ):
            continue
        key = (reference_id, row["positionId"], row["positionSha256"], row["attemptNo"])
        run_id = row.get("runId")
        previous_run = seen.get(key)
        if previous_run is not None and previous_run != run_id:
            raise ValueError(
                "duplicate primary reference attempt across runs: "
                f"condition={reference_id}, position={row['positionId']}, attemptNo={row['attemptNo']}"
            )
        seen[key] = str(run_id)


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
    common_conditions_sha256: str | None = None
    dataset_fingerprints: dict[str, tuple[str, str]] = {}
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
        build_id = fingerprint.get("buildId")
        git_commit = fingerprint.get("gitCommit")
        mode = fingerprint.get("mode")
        if not isinstance(build_id, str) or not re.fullmatch(r"[0-9a-f]{32}", build_id):
            raise ValueError(f"run {run_id} fingerprint lacks a valid image buildId")
        if not isinstance(git_commit, str) or not re.fullmatch(r"[0-9a-f]{40}", git_commit):
            raise ValueError(f"run {run_id} fingerprint lacks a valid image gitCommit")
        if mode not in {"positions", "game", "cold"} or row.get("mode") != mode:
            raise ValueError(f"run {run_id} mode differs from its immutable fingerprint")
        if not isinstance(fingerprint.get("driverVersion"), str) or not isinstance(fingerprint.get("contractVersion"), str):
            raise ValueError(f"run {run_id} fingerprint lacks driverVersion/contractVersion")
        if not _valid_identity_digests(fingerprint.get("identityDigests")):
            raise ValueError(f"run {run_id} fingerprint lacks valid artifact identity digests")
        conditions_sha256 = fingerprint["conditionsSha256"]
        if common_conditions_sha256 is None:
            common_conditions_sha256 = conditions_sha256
        elif conditions_sha256 != common_conditions_sha256:
            raise ValueError("aggregation mixes conditions manifest hashes across runs")
        dataset_kind = "game" if mode == "game" else "positions"
        dataset_identity = (fingerprint["datasetSha256"], fingerprint["datasetManifestSha256"])
        existing_dataset_identity = dataset_fingerprints.get(dataset_kind)
        if existing_dataset_identity is None:
            dataset_fingerprints[dataset_kind] = dataset_identity
        elif dataset_identity != existing_dataset_identity:
            raise ValueError(f"aggregation mixes {dataset_kind} dataset hashes across runs")
        run_starts[run_id] = row

    attempts = [row for row in records if row.get("recordType") in {"attempt", "attempt-start"}]
    if attempts and not run_starts:
        raise ValueError("raw attempts lack immutable run-start fingerprints")
    common_identity: tuple[Any, ...] | None = None
    for run_id, row in run_starts.items():
        fingerprint = row["fingerprint"]
        identity = (
            fingerprint["imageDigest"],
            fingerprint["buildId"],
            fingerprint["gitCommit"],
            tuple((key, fingerprint["identityDigests"][key]) for key in IDENTITY_DIGEST_KEYS),
            fingerprint.get("driverVersion"),
            fingerprint.get("contractVersion"),
        )
        if common_identity is None:
            common_identity = identity
        elif identity != common_identity:
            raise ValueError("aggregation mixes image build or artifact identity digests across runs")
        start_health = row.get("healthAtRunStart")
        start_digests = start_health.get("identityDigests") if isinstance(start_health, dict) else None
        if start_digests is not None and start_digests != fingerprint["identityDigests"]:
            raise ValueError(f"run {run_id} run-start health identity digests differ from its fingerprint")
        if isinstance(start_health, dict) and (
            start_health.get("buildId") != fingerprint["buildId"]
            or start_health.get("gitCommit") != fingerprint["gitCommit"]
        ):
            raise ValueError(f"run {run_id} run-start health image build identity differs from its fingerprint")
        if isinstance(start_health, dict):
            for key in ("driverVersion", "contractVersion"):
                if isinstance(start_health.get(key), str) and start_health[key] != fingerprint[key]:
                    raise ValueError(f"run {run_id} run-start health {key} differs from its fingerprint")

    for row in attempts:
        run_id = row.get("runId")
        if not isinstance(run_id, str) or run_id not in run_starts:
            raise ValueError(f"attempt references run {run_id!r} without a run-start fingerprint")
        fingerprint = run_starts[run_id]["fingerprint"]
        if row.get("runFingerprintSha256") != fingerprint["fingerprintSha256"]:
            raise ValueError(f"attempt in run {run_id} does not match its immutable fingerprint")
        if row.get("mode") != fingerprint["mode"]:
            raise ValueError(f"attempt in run {run_id} mode differs from its immutable fingerprint")
        if row.get("imageDigest") != fingerprint["imageDigest"] or row.get("identityDigests") != fingerprint["identityDigests"]:
            raise ValueError(f"attempt in run {run_id} has inconsistent image or artifact identities")
        if row.get("expectedBuildId") != fingerprint["buildId"] or row.get("buildId") != fingerprint["buildId"]:
            raise ValueError(f"attempt in run {run_id} has inconsistent image build identity")
        worker_failure = row.get("workerFailure")
        if worker_failure is not None:
            if not _valid_worker_failure(worker_failure):
                raise ValueError(f"attempt in run {run_id} has an invalid Worker failure record")
            if (
                row.get("driverIdentityConfirmed") is not False
                or row.get("response") is not None
                or row.get("responseBuildId") is not None
            ):
                raise ValueError(f"attempt in run {run_id} Worker failure incorrectly claims driver identity")
        response_digests = row.get("responseIdentityDigests")
        if response_digests is not None and response_digests != fingerprint["identityDigests"]:
            raise ValueError(f"attempt in run {run_id} response identity digests differ from its fingerprint")
        response = row.get("response")
        response_digests = response.get("identityDigests") if isinstance(response, dict) else None
        if response_digests is not None and response_digests != fingerprint["identityDigests"]:
            raise ValueError(f"attempt in run {run_id} response identity digests differ from its fingerprint")
        if isinstance(response, dict):
            if response.get("buildId") != fingerprint["buildId"] or response.get("gitCommit") != fingerprint["gitCommit"]:
                raise ValueError(f"attempt in run {run_id} response image build identity differs from its fingerprint")
            if isinstance(response.get("driverVersion"), str) and response["driverVersion"] != fingerprint["driverVersion"]:
                raise ValueError(f"attempt in run {run_id} response driverVersion differs from its fingerprint")
            if (
                isinstance(response.get("contractVersion"), str)
                and response["contractVersion"] != BENCHMARK_RESPONSE_CONTRACT_VERSION
            ):
                raise ValueError(
                    f"attempt in run {run_id} response contractVersion differs from the benchmark response contract"
                )
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
                if health.get("buildId") != fingerprint["buildId"] or health.get("gitCommit") != fingerprint["gitCommit"]:
                    raise ValueError(f"attempt in run {run_id} health image build identity differs from its fingerprint")
                for key in ("driverVersion", "contractVersion"):
                    if isinstance(health.get(key), str) and health[key] != fingerprint[key]:
                        raise ValueError(f"attempt in run {run_id} health {key} differs from its fingerprint")
                health_worker_version = health.get("workerVersionId")
                if isinstance(fingerprint.get("workerVersionId"), str) and health_worker_version is not None:
                    if health_worker_version != fingerprint["workerVersionId"]:
                        raise ValueError(f"attempt in run {run_id} health Worker version differs from its fingerprint")

    return {
        "imageDigest": common_identity[0] if common_identity else None,
        "buildId": common_identity[1] if common_identity else None,
        "gitCommit": common_identity[2] if common_identity else None,
        "identityDigests": dict(common_identity[3]) if common_identity else None,
        "driverVersion": common_identity[4] if common_identity else None,
        "contractVersion": common_identity[5] if common_identity else None,
        "healthContractVersion": common_identity[5] if common_identity else None,
        "benchmarkResponseContractVersion": BENCHMARK_RESPONSE_CONTRACT_VERSION,
        "workerVersionIds": sorted({
            str(row["fingerprint"].get("workerVersionId"))
            for row in run_starts.values()
            if isinstance(row["fingerprint"].get("workerVersionId"), str)
        }),
        "conditionsSha256": common_conditions_sha256,
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
        status = _attempt_status(row)
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


def _valid_cold_runtime(value: Any, expected_instance_type: str, boot_id: str) -> bool:
    if not isinstance(value, dict) or expected_instance_type not in CONTAINER_SIZES:
        return False
    required_fields = {
        "expectedInstanceType", "driverBootId", "osCpuCount", "affinityCpuCount", "cpuMax",
        "cpuQuota", "memoryMaxBytes", "memTotalBytes", "rootDiskTotalBytes",
    }
    if not required_fields.issubset(value):
        return False
    if value.get("expectedInstanceType") != expected_instance_type or value.get("driverBootId") != boot_id:
        return False
    for key in ("osCpuCount", "affinityCpuCount", "memoryMaxBytes", "memTotalBytes", "rootDiskTotalBytes"):
        item = value.get(key)
        if item is not None and (type(item) is not int or item < 1 or item > 2**53 - 1):
            return False
    if value.get("cpuMax") is not None and not isinstance(value.get("cpuMax"), str):
        return False
    cpu_quota = value.get("cpuQuota")
    if cpu_quota is not None and (
        isinstance(cpu_quota, bool) or not isinstance(cpu_quota, (int, float))
        or not math.isfinite(float(cpu_quota)) or cpu_quota < 0
    ):
        return False

    expected = CONTAINER_SIZES[expected_instance_type]
    cpu_count = expected["vCpu"]
    memory_total = value.get("memTotalBytes")
    expected_memory = expected["memoryGiB"] * (1 << 30)
    if value.get("osCpuCount") != cpu_count or value.get("affinityCpuCount") != cpu_count:
        return False
    if not isinstance(memory_total, int) or not expected_memory - int(1.5 * (1 << 30)) <= memory_total <= expected_memory + (1 << 28):
        return False
    if cpu_quota is not None and abs(float(cpu_quota) - cpu_count) > 0.05:
        return False
    memory_limit = value.get("memoryMaxBytes")
    return memory_limit is None or expected_memory - int(1.5 * (1 << 30)) <= memory_limit <= expected_memory + (1 << 28)


def _cold_response_verification(row: dict[str, Any], provenance: dict[str, Any]) -> tuple[bool, str | None]:
    evidence = row.get("coldEvidence")
    response = row.get("response")
    if not isinstance(evidence, dict):
        return False, "analysis_response_missing"
    evidence_boot_id = evidence.get("responseBootId")
    if not _valid_boot_id(evidence_boot_id) or row.get("responseBootId") != evidence_boot_id:
        return False, "analysis_boot_id_missing"
    if not isinstance(response, dict):
        return False, "analysis_response_missing"

    expected_instance_type = row.get("expectedInstanceType")
    condition = row.get("condition")
    if not isinstance(expected_instance_type, str) and isinstance(condition, dict):
        expected_instance_type = condition.get("instanceType")
    if expected_instance_type not in CONTAINER_SIZES:
        return False, "expected_instance_type_missing"
    if not isinstance(condition, dict) or condition.get("instanceType") != expected_instance_type:
        return False, "condition_instance_type_mismatch"
    boot_id = response.get("driverBootId")
    if not _valid_boot_id(boot_id) or boot_id != evidence_boot_id:
        return False, "analysis_boot_id_missing"

    runtime = response.get("runtime")
    if (
        not _valid_cold_runtime(runtime, expected_instance_type, boot_id)
        or evidence.get("responseRuntime") != runtime
        or row.get("runtime") != runtime
    ):
        return False, "analysis_runtime_invalid"
    if response.get("expectedInstanceType") != expected_instance_type:
        return False, "analysis_instance_type_mismatch"

    target_id = row.get("targetId")
    segment_id = row.get("segmentId")
    expected_build_id = provenance.get("buildId")
    attempt_no = row.get("attemptNo")
    if (
        not isinstance(target_id, str) or response.get("targetId") != target_id
        or not isinstance(segment_id, str) or response.get("segmentId") != segment_id
        or type(attempt_no) is not int or attempt_no < 1
        or target_id != f"bench-{expected_instance_type}-{expected_build_id}-{segment_id}-cold-trial-{attempt_no}"
        or response.get("targetInstanceType") != expected_instance_type
        or response.get("expectedBuildId") != expected_build_id
        or response.get("containerApp") != row.get("containerApp")
        or response.get("containerClass") != row.get("containerClass")
        or response.get("containerBinding") != row.get("containerBinding")
    ):
        return False, "analysis_target_identity_mismatch"
    expected_container = {
        "standard-2": (
            "meeshogi-analysis-mvp-staging-benchmark-standard-2",
            "BenchmarkStandard2Container",
            "ANALYSIS_BENCHMARK_STANDARD_2",
        ),
        "standard-3": (
            "meeshogi-analysis-mvp-staging-benchmark-standard-3",
            "BenchmarkStandard3Container",
            "ANALYSIS_BENCHMARK_STANDARD_3",
        ),
    }[expected_instance_type]
    if (row.get("containerApp"), row.get("containerClass"), row.get("containerBinding")) != expected_container:
        return False, "analysis_target_identity_mismatch"

    expected_git_commit = provenance.get("gitCommit")
    expected_digests = provenance.get("identityDigests")
    response_digests = response.get("identityDigests")
    if (
        row.get("driverIdentityConfirmed") is not True
        or not isinstance(expected_build_id, str)
        or row.get("expectedBuildId") != expected_build_id
        or row.get("responseBuildId") != expected_build_id
        or response.get("buildId") != expected_build_id
        or not isinstance(expected_git_commit, str)
        or response.get("gitCommit") != expected_git_commit
        or not _valid_identity_digests(expected_digests)
        or row.get("identityDigests") != expected_digests
        or row.get("responseIdentityDigests") != expected_digests
        or response_digests != expected_digests
    ):
        return False, "analysis_identity_unconfirmed"
    return True, None


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
    analysis_rows = [row for row in rows if row.get("recordType") in {"attempt", "attempt-start"}]
    active_by_instance: Counter[str] = Counter()
    active_by_condition: Counter[str] = Counter()
    sessions: list[dict[str, Any]] = []
    unconfirmed_targets: list[dict[str, Any]] = []
    unpriced_targets: list[dict[str, Any]] = []
    target_events: dict[str, list[tuple[float, str, dict[str, Any]]]] = defaultdict(list)
    target_types: dict[str, str | None] = {}

    def add_target_event(target_id: Any, stamp_value: Any, kind: str, row: dict[str, Any], instance: Any = None) -> None:
        stamp = _parse_utc(stamp_value)
        if not isinstance(target_id, str) or stamp is None:
            return
        target_events[target_id].append((stamp, kind, row))
        if target_id not in target_types or target_types[target_id] is None:
            target_types[target_id] = instance if isinstance(instance, str) else None

    for row in rows:
        record_type = row.get("recordType")
        target_id = row.get("targetId")
        instance = row.get("expectedInstanceType") or row.get("targetInstanceType")
        if record_type == "target-health":
            add_target_event(target_id, row.get("requestStartWall"), "start", row, instance)
        elif record_type == "target-stop":
            if isinstance(row.get("firstDispatchWall"), str):
                add_target_event(target_id, row.get("firstDispatchWall"), "start", row, instance)
            add_target_event(target_id, row.get("requestEndWall"), "stop", row, instance)
        elif record_type in {"attempt", "attempt-start"} and isinstance(target_id, str):
            add_target_event(target_id, row.get("requestStartWall"), "start", row, instance)

        if record_type in {"run-start", "run-resume-check"}:
            snapshot = row.get("healthAtRunStart")
            if isinstance(snapshot, dict):
                add_target_event(
                    snapshot.get("targetId"), snapshot.get("requestStartWall"), "start", snapshot,
                    snapshot.get("expectedInstanceType") or snapshot.get("workerExpectedInstanceType"),
                )
        for field in ("healthAtRunStart", "healthSnapshot"):
            snapshot = row.get(field)
            if isinstance(snapshot, dict) and isinstance(snapshot.get("targetId"), str):
                add_target_event(
                    snapshot.get("targetId"), snapshot.get("requestStartWall"), "start", snapshot,
                    snapshot.get("targetInstanceType") or snapshot.get("expectedInstanceType"),
                )

    def allocate_interval(instance: str, target_id: str, start: float, end: float, attempts: list[dict[str, Any]], label: str, stop_row: dict[str, Any] | None) -> None:
        active_seconds = max(0.0, end - start)
        active_by_instance[instance] += active_seconds
        weights: Counter[str] = Counter()
        for row in attempts:
            condition_key = f"{row.get('mode', 'positions')}:{row.get('conditionId')}"
            weights[condition_key] += max(0.001, int(row.get("httpElapsedMs") or 0) / 1000)
        total_weight = sum(weights.values())
        if total_weight:
            for condition_id, weight in weights.items():
                active_by_condition[condition_id] += active_seconds * weight / total_weight
        sessions.append({
            "instanceType": instance,
            "targetId": target_id,
            "requestCount": len(attempts),
            "startWall": datetime.fromtimestamp(start, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "stopWall": datetime.fromtimestamp(end, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "activeSeconds": active_seconds,
            "stopConfirmed": True,
            "intervalBasis": label,
            "bootIds": sorted({row.get("driverBootId") for row in attempts if isinstance(row.get("driverBootId"), str)}),
            "stopState": ((stop_row or {}).get("stopResponse") or {}).get("containerState"),
        })

    for target_id, events in target_events.items():
        events.sort(key=lambda event: (event[0], 0 if event[1] == "start" else 1))
        current_start: float | None = None
        current_attempts: list[dict[str, Any]] = []
        stopped_rows: list[dict[str, Any]] = []
        for stamp, kind, row in events:
            if kind == "start":
                if current_start is None:
                    current_start = stamp
                    current_attempts = []
                if row.get("recordType") in {"attempt", "attempt-start"}:
                    current_attempts.append(row)
                continue
            confirmed = row.get("stopConfirmed") is True
            response = row.get("stopResponse") if isinstance(row.get("stopResponse"), dict) else {}
            state_after = response.get("stateAfter") if isinstance(response.get("stateAfter"), dict) else {}
            terminal_wall = _parse_utc(state_after.get("containerStateLastChangeWall"))
            stop_at = terminal_wall if terminal_wall is not None else stamp
            if confirmed and current_start is not None:
                instance = target_types.get(target_id)
                if instance in CONTAINER_SIZES:
                    allocate_interval(instance, target_id, current_start, stop_at, current_attempts, "first target dispatch to confirmed stopped state", row)
                else:
                    unpriced_targets.append({
                        "targetId": target_id,
                        "activeSecondsObserved": max(0.0, stop_at - current_start),
                        "reason": "instance type is unavailable for this target",
                        "stopConfirmed": True,
                    })
                current_start = None
                current_attempts = []
                stopped_rows.append(row)
            elif confirmed and current_start is None:
                state_before = response.get("stateBefore") if isinstance(response.get("stateBefore"), dict) else {}
                prior_state_change = _parse_utc(state_before.get("containerStateLastChangeWall"))
                observed_since_transition = (
                    max(0.0, stop_at - prior_state_change)
                    if prior_state_change is not None and state_before.get("containerState") in {"running", "healthy", "stopping"}
                    else 0.0 if state_before.get("containerState") in {"stopped", "stopped_with_code"}
                    else None
                )
                unpriced_targets.append({
                    "targetId": target_id,
                    "activeSecondsSinceLastStateTransition": observed_since_transition,
                    "reason": "target was already active before the raw ledger observed its start",
                    "stopConfirmed": True,
                })
            else:
                unconfirmed_targets.append({"targetId": target_id, "firstDispatchWall": row.get("firstDispatchWall"), "stopConfirmed": False})
        if current_start is not None:
            unconfirmed_targets.append({
                "targetId": target_id,
                "firstDispatchWall": datetime.fromtimestamp(current_start, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "stopConfirmed": bool(stopped_rows),
            })

    # Older raw files lack named targets and stop events. Keep their observed window
    # as a lower bound; never add an assumed sleepAfter tail.
    legacy_groups: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    legacy_health: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        if isinstance(row.get("targetId"), str):
            continue
        instance, boot = _row_instance(row)
        if instance not in CONTAINER_SIZES or not boot:
            continue
        if row.get("recordType") in {"attempt", "attempt-start"}:
            legacy_groups[(instance, boot)].append(row)
        for field in ("healthAtRunStart", "healthSnapshot"):
            snapshot = row.get(field)
            if not isinstance(snapshot, dict) or snapshot.get("targetId"):
                continue
            snapshot_instance = snapshot.get("expectedInstanceType") or snapshot.get("workerExpectedInstanceType")
            if snapshot_instance == instance and snapshot.get("driverBootId") == boot:
                legacy_health[(instance, boot, str(snapshot.get("requestStartWall")))] = snapshot
    for (instance, boot), attempts in legacy_groups.items():
        stamps = [
            stamp for row in attempts
            for stamp in (_parse_utc(row.get("requestStartWall")), _parse_utc(row.get("requestEndWall")))
            if stamp is not None
        ]
        stamps.extend(
            stamp for (health_instance, health_boot, _key), snapshot in legacy_health.items()
            if health_instance == instance and health_boot == boot
            for stamp in (_parse_utc(snapshot.get("requestStartWall")), _parse_utc(snapshot.get("requestEndWall")))
            if stamp is not None
        )
        if not stamps:
            continue
        start, end = min(stamps), max(stamps)
        active_seconds = max(0.0, end - start)
        active_by_instance[instance] += active_seconds
        weights: Counter[str] = Counter()
        for row in attempts:
            condition_key = f"{row.get('mode', 'positions')}:{row.get('conditionId')}"
            weights[condition_key] += max(0.001, int(row.get("httpElapsedMs") or 0) / 1000)
        weight_total = sum(weights.values())
        if weight_total:
            for condition_id, weight in weights.items():
                active_by_condition[condition_id] += active_seconds * weight / weight_total
        sessions.append({
            "instanceType": instance, "bootId": boot, "targetId": None,
            "requestCount": len(attempts), "activeSeconds": active_seconds,
            "stopConfirmed": False, "intervalBasis": "legacy observed request window lower bound",
        })
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
        "unconfirmedTargets": unconfirmed_targets,
        "unpricedTargets": unpriced_targets,
        "activeIntervalAssumptions": (
            "Named benchmark targets use first recorded target dispatch through Container getState confirmation of "
            "stopped; serial segment and coexistence/idle time until stop are included. No sleepAfter tail is assumed. "
            "Legacy unnamed rows contribute only their observed request window as a lower bound. The pre-existing "
            "singleton is stopped for capacity control but cannot be priced unless its actual instance type and start "
            "time were recorded. Unconfirmed stop events remain listed and are not treated as bounded intervals."
        ),
        "grossUsd": total_cost,
    }


def cost_estimate(rows: list[dict[str, Any]]) -> dict[str, Any]:
    attempts = [row for row in rows if row.get("recordType") == "attempt"]
    health_calls: dict[str, dict[str, Any]] = {}
    for row in rows:
        if row.get("recordType") == "target-health" and isinstance(row.get("requestStartWall"), str):
            health_calls[row["requestStartWall"]] = {
                "status": "ready" if row.get("httpStatus") == 200 else None,
                "elapsedMs": row.get("httpElapsedMs"),
                "driverBootId": (
                    row.get("health", {}).get("driverBootId")
                    if isinstance(row.get("health"), dict) else None
                ),
            }
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
            "engine-child CPU is only a lower bound; named Container upper bounds use each recorded dispatch-to-confirmed-stop interval",
            "unconfirmed named targets are not assigned a bounded duration, and legacy unnamed rows include only their observed request window",
            "Container platform billing timestamps may differ from Worker dispatch and stopped-state evidence",
        ],
    }


def aggregate_records(
    records: list[dict[str, Any]],
    conditions: dict[str, dict[str, Any]],
    *,
    conditions_sha256: str,
) -> dict[str, Any]:
    if not isinstance(conditions_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", conditions_sha256):
        raise ValueError("conditions_sha256 must be a 64-character lowercase SHA-256")
    provenance = verify_run_provenance(records)
    fingerprint_conditions_sha256 = provenance.get("conditionsSha256")
    if fingerprint_conditions_sha256 is not None and conditions_sha256 != fingerprint_conditions_sha256:
        raise ValueError("conditions manifest hash does not match the run fingerprint")
    attempts = _materialize_attempts(records)
    reference_ids = [condition_id for condition_id, condition in conditions.items() if condition.get("role") == "reference"]
    if len(reference_ids) > 1:
        raise ValueError("conditions manifest may contain at most one reference")
    reference_id = reference_ids[0] if reference_ids else None
    _reject_duplicate_reference_attempts(attempts, reference_id)
    primary_reference_attempt_count = sum(
        row.get("conditionId") == reference_id
        and row.get("attemptNo") == 1
        and row.get("mode", "positions") == "positions"
        and row.get("comparisonRole", "primary") != "pilot"
        for row in attempts
    ) if reference_id is not None else 0
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
    cold_verifications = [_cold_response_verification(row, provenance) for row in cold_rows]
    unused_names_verified = [
        isinstance(row.get("targetId"), str)
        and isinstance(row.get("segmentId"), str)
        and isinstance(row.get("unusedNameEvidence"), dict)
        and row["unusedNameEvidence"].get("allowlistedAtDeploy") is True
        and row["unusedNameEvidence"].get("priorRunnerUseCount") == 0
        and row["unusedNameEvidence"].get("healthOrWarmupBeforeFirstAnalysis") is False
        and isinstance(row.get("requestStartWall"), str)
        for row in cold_rows
    ]
    verified_new_instance = sum(
        unused and verified
        for unused, (verified, _) in zip(unused_names_verified, cold_verifications)
    )
    cold_status: Counter[str] = Counter()
    cold_causes: Counter[str] = Counter()
    cold_evidence_failures: list[str | None] = []
    for index, row in enumerate(cold_rows):
        response_verified, response_failure = cold_verifications[index]
        evidence_failure = response_failure or (None if unused_names_verified[index] else "unused_target_name_unverified")
        cold_evidence_failures.append(evidence_failure)
        status = _attempt_status(row)
        if evidence_failure is not None and status not in {"failure", "transport"}:
            cold_status["failure"] += 1
            cold_causes[f"failure:cold_evidence_{evidence_failure}"] += 1
        else:
            cold_status[status if isinstance(status, str) else "unknown"] += 1
            cold_causes[_failure_cause(row)] += 1
        if evidence_failure is not None and status in {"failure", "transport"}:
            cold_causes[f"coldEvidence:{evidence_failure}"] += 1
    cold = {
        "label": "new-instance cold start",
        "idleSleepResumeVerified": False,
        "attempts": len(cold_rows),
        "successRate": ratio(cold_status["success"], len(cold_rows)),
        "incompleteRate": ratio(cold_status["incomplete"], len(cold_rows)),
        "failureRate": ratio(cold_status["failure"] + cold_status["transport"], len(cold_rows)),
        "verifiedNewInstanceTarget": ratio(verified_new_instance, len(cold_rows)),
        "verifiedNewInstanceTargetBasis": "allowlisted unused target name plus a valid analysis response boot ID, expected runtime, target app/class/binding, build ID, git commit, and artifact identity digests",
        "unusedNameEvidenceScope": "An unused allowlisted name proves only that the runner had not used that target name; it does not prove the Container started.",
        "firstHttpWallMs": value_stats([
            row.get("coldEvidence", {}).get("firstHttpWallMs")
            for row in cold_rows if isinstance(row.get("coldEvidence"), dict)
        ]),
        "timeToFirstSuccessMs": value_stats([
            row.get("coldEvidence", {}).get("timeToFirstSuccessMs")
            for row in cold_rows if isinstance(row.get("coldEvidence"), dict)
        ]),
        "trials": [
            {
                "conditionId": row.get("conditionId"),
                "positionId": row.get("positionId"),
                "coldTrialId": row.get("coldTrialId"),
                "targetId": row.get("targetId"),
                "segmentId": row.get("segmentId"),
                "firstDispatchWall": row.get("coldEvidence", {}).get("firstDispatchWall") if isinstance(row.get("coldEvidence"), dict) else row.get("requestStartWall"),
                "firstHttpWallMs": row.get("coldEvidence", {}).get("firstHttpWallMs") if isinstance(row.get("coldEvidence"), dict) else None,
                "timeToFirstSuccessMs": row.get("coldEvidence", {}).get("timeToFirstSuccessMs") if isinstance(row.get("coldEvidence"), dict) else None,
                "analysisResponseBootId": row.get("coldEvidence", {}).get("responseBootId") if isinstance(row.get("coldEvidence"), dict) else None,
                "analysisResponseRuntime": row.get("coldEvidence", {}).get("responseRuntime") if isinstance(row.get("coldEvidence"), dict) else None,
                "httpAttempts": row.get("coldEvidence", {}).get("httpAttempts") if isinstance(row.get("coldEvidence"), dict) else None,
                "coldEvidenceFailure": cold_evidence_failures[index],
                "verifiedNewInstanceTarget": bool(unused_names_verified[index] and cold_verifications[index][0]),
                "containerApp": row.get("containerApp"),
                "containerClass": row.get("containerClass"),
                "containerBinding": row.get("containerBinding"),
                "unusedNameEvidence": row.get("unusedNameEvidence"),
                "httpStatus": row.get("httpStatus"),
                "failureCause": _failure_cause(row),
                "status": _attempt_status(row),
            }
            for index, row in enumerate(cold_rows)
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
        "primaryReferenceAttemptCount": primary_reference_attempt_count,
        "conditions": per_condition,
        "gameWallTimes": game_summaries,
        "gameAnalysis": game_analysis,
        "coldStart": cold,
        "costEstimate": cost_estimate(records),
    }


def markdown_report(value: dict[str, Any]) -> str:
    def fmt(number: Any) -> str:
        if number is None:
            return "n/a"
        if isinstance(number, bool):
            return str(number)
        if isinstance(number, int):
            return f"{number:,}"
        if isinstance(number, float):
            return f"{number:,.3f}".rstrip("0").rstrip(".")
        return str(number)

    def ratio_label(stat: dict[str, Any] | None) -> str:
        if not isinstance(stat, dict):
            return "n/a"
        rate = stat.get("rate")
        percent = "n/a" if rate is None else f"{rate:.1%}"
        return f"{stat.get('numerator', 0)}/{stat.get('denominator', 0)} ({percent})"

    def metric_label(stat: dict[str, Any], denominator: int) -> str:
        return f"{fmt(stat.get('median'))} (n={stat.get('count', 0)}/{denominator})"

    provenance = value.get("provenance")
    if not isinstance(provenance, dict):
        provenance = {}
    reference_id = value.get("referenceConditionId")
    reference_attempts = value.get("primaryReferenceAttemptCount")
    if reference_id is None:
        reference_summary = "Primary reference: not present; quality comparisons are n/a."
    elif reference_attempts == 0:
        reference_summary = (
            f"Primary reference: {reference_id}; primary attemptNo=1 rows: 0. "
            "Quality comparisons are n/a because reference rows are missing."
        )
    elif isinstance(reference_attempts, int):
        reference_summary = f"Primary reference: {reference_id}; primary attemptNo=1 rows: {reference_attempts}."
    else:
        reference_summary = f"Primary reference: {reference_id}; primary row count is unavailable."

    lines = [
        "# Issue #20 benchmark aggregate",
        "",
        f"Run IDs: {', '.join(value.get('runIds', [])) or 'none'}  ",
        f"Attempts: {value.get('attemptCount', 0)}  ",
        "Contract versions: health `{}`; benchmark response `{}`  ".format(
            provenance.get("healthContractVersion", provenance.get("contractVersion") or "n/a"),
            provenance.get("benchmarkResponseContractVersion", "n/a"),
        ),
        reference_summary,
        "",
        "Status cells show numerator/attempt denominator and percentage; failures include transport failures.",
        "",
        "## Overall outcomes",
        "",
        "| Condition | Attempts | Success n/d | Incomplete n/d | Failure n/d | Paired to reference | Missing reference | Top-1 agreement n/d |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in value.get("conditions", []):
        overall = row["overall"]
        quality = overall["qualityVsPrimaryReference"]
        condition_id = row["condition"]["conditionId"]
        lines.append(
            "| {id} | {n} | {success} | {incomplete} | {failure} | {paired} | {missing} | {top1} |".format(
                id=condition_id,
                n=overall["attempts"],
                success=ratio_label(overall["successRate"]),
                incomplete=ratio_label(overall["incompleteRate"]),
                failure=ratio_label(overall["failureRate"]),
                paired=quality["pairedAttempts"],
                missing=quality["attemptsWithoutPrimaryReference"],
                top1=ratio_label(quality["top1Agreement"]),
            )
        )
    lines.extend([
        "",
        "## Overall search and request metrics",
        "",
        "Median is followed by valid sample count / attempt count. NPS is reported from the engine response and from nodes divided by reported search time.",
        "",
        "| Condition | Depth | Nodes | Engine NPS | Derived NPS | Search ms | Process ms | HTTP ms |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ])
    for row in value.get("conditions", []):
        overall = row["overall"]
        metrics = overall["metrics"]
        attempts = overall["attempts"]
        lines.append(
            "| {condition} | {depth} | {nodes} | {engine_nps} | {derived_nps} | {search} | {process} | {http} |".format(
                condition=row["condition"]["conditionId"],
                depth=metric_label(metrics["completedDepth"], attempts),
                nodes=metric_label(metrics["nodes"], attempts),
                engine_nps=metric_label(metrics["engineNps"], attempts),
                derived_nps=metric_label(metrics["derivedNps"], attempts),
                search=metric_label(metrics["searchElapsedMs"], attempts),
                process=metric_label(metrics["processElapsedMs"], attempts),
                http=metric_label(metrics["httpElapsedMs"], attempts),
            )
        )
    lines.extend([
        "",
        "## Quality against the primary reference",
        "",
        "Quality ratios use successful paired analyses. When no primary reference rows exist, paired counts and ratios remain zero / n/a.",
        "",
        "| Candidate | Paired | Missing reference | Top-1 n/d | Top-2 n/d | Top-3 n/d | CP abs diff count, median / p90 | Mate side n/d | Mate distance n/d |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ])
    for row in value.get("conditions", []):
        quality = row["overall"]["qualityVsPrimaryReference"]
        cp = quality["cpAbsDiff"]
        lines.append(
            "| {condition} | {paired} | {missing} | {top1} | {top2} | {top3} | {cp_count}, {cp50} / {cp90} | {mate_side} | {mate_distance} |".format(
                condition=row["condition"]["conditionId"],
                paired=quality["pairedAttempts"],
                missing=quality["attemptsWithoutPrimaryReference"],
                top1=ratio_label(quality["top1Agreement"]),
                top2=ratio_label(quality["referenceTop1InCandidateTop2"]),
                top3=ratio_label(quality["referenceTop1InCandidateTop3"]),
                cp_count=cp["count"],
                cp50=fmt(cp["median"]),
                cp90=fmt(cp["p90"]),
                mate_side=ratio_label(quality["mateSideAgreement"]),
                mate_distance=ratio_label(quality["mateDistanceExactAgreement"]),
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
        "### Outcomes and reference coverage",
        "",
        "| Condition | Phase | Attempts | Success n/d | Incomplete n/d | Failure n/d | Paired | Missing reference | Top-1 n/d |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ])
    for row in value.get("conditions", []):
        for phase, summary in row.get("byPhase", {}).items():
            quality = summary["qualityVsPrimaryReference"]
            lines.append(
                "| {condition} | {phase} | {attempts} | {success} | {incomplete} | {failure} | {paired} | {missing} | {top1} |".format(
                    condition=row["condition"]["conditionId"],
                    phase=phase,
                    attempts=summary["attempts"],
                    success=ratio_label(summary["successRate"]),
                    incomplete=ratio_label(summary["incompleteRate"]),
                    failure=ratio_label(summary["failureRate"]),
                    paired=quality["pairedAttempts"],
                    missing=quality["attemptsWithoutPrimaryReference"],
                    top1=ratio_label(quality["top1Agreement"]),
                )
            )
    lines.extend([
        "",
        "### Search and request metrics",
        "",
        "Median is followed by valid sample count / phase attempt count.",
        "",
        "| Condition | Phase | Depth | Nodes | Engine NPS | Derived NPS | Search ms | Process ms | HTTP ms |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ])
    for row in value.get("conditions", []):
        for phase, summary in row.get("byPhase", {}).items():
            metrics = summary["metrics"]
            attempts = summary["attempts"]
            lines.append(
                "| {condition} | {phase} | {depth} | {nodes} | {engine_nps} | {derived_nps} | {search} | {process} | {http} |".format(
                    condition=row["condition"]["conditionId"],
                    phase=phase,
                    depth=metric_label(metrics["completedDepth"], attempts),
                    nodes=metric_label(metrics["nodes"], attempts),
                    engine_nps=metric_label(metrics["engineNps"], attempts),
                    derived_nps=metric_label(metrics["derivedNps"], attempts),
                    search=metric_label(metrics["searchElapsedMs"], attempts),
                    process=metric_label(metrics["processElapsedMs"], attempts),
                    http=metric_label(metrics["httpElapsedMs"], attempts),
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
        conditions_bytes = args.conditions.read_bytes()
        conditions_sha256 = hashlib.sha256(conditions_bytes).hexdigest()
        conditions_manifest = json.loads(conditions_bytes.decode("utf-8"))
        conditions = {row["conditionId"]: row for row in conditions_manifest["conditions"]}
        records = read_jsonl(args.input)
        output = aggregate_records(records, conditions, conditions_sha256=conditions_sha256)
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
