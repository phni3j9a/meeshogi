"""Finite, reproducible Container target names for Issue 20 measurement segments."""

from __future__ import annotations

import re
from typing import Any


BUILD_ID_RE = re.compile(r"^[0-9a-f]{32}$")
SEGMENT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
INSTANCE_TYPES = frozenset({"standard-2", "standard-3"})
SINGLETON_TARGET_ID = "analysis-mvp-singleton"
CONTAINER_TARGETS = {
    "standard-2": {
        "containerApp": "meeshogi-analysis-mvp-staging-benchmark-standard-2",
        "containerClass": "BenchmarkStandard2Container",
        "containerBinding": "ANALYSIS_BENCHMARK_STANDARD_2",
    },
    "standard-3": {
        "containerApp": "meeshogi-analysis-mvp-staging-benchmark-standard-3",
        "containerClass": "BenchmarkStandard3Container",
        "containerBinding": "ANALYSIS_BENCHMARK_STANDARD_3",
    },
}
NORMAL_CONTAINER_TARGET = {
    "containerApp": "meeshogi-analysis-mvp-staging-analysis",
    "containerClass": "AnalysisContainer",
    "containerBinding": "ANALYSIS_CONTAINER",
}


def container_target_fields(instance_type: str | None) -> dict[str, str]:
    if instance_type is None:
        return dict(NORMAL_CONTAINER_TARGET)
    if instance_type not in CONTAINER_TARGETS:
        raise ValueError("instance type must be standard-2 or standard-3")
    return dict(CONTAINER_TARGETS[instance_type])


def target_id(
    instance_type: str,
    build_id: str,
    segment_id: str,
    cold_trial_no: int | None = None,
) -> str:
    if instance_type not in INSTANCE_TYPES:
        raise ValueError("instance type must be standard-2 or standard-3")
    if not BUILD_ID_RE.fullmatch(build_id):
        raise ValueError("build ID must be 32 lowercase hex characters")
    if not SEGMENT_ID_RE.fullmatch(segment_id):
        raise ValueError("segmentId must be a lowercase slug of at most 40 characters")
    if cold_trial_no is not None and (
        type(cold_trial_no) is not int or cold_trial_no < 1 or cold_trial_no > 2**53 - 1
    ):
        raise ValueError("cold trial number must be a positive integer")
    suffix = f"-cold-trial-{cold_trial_no}" if cold_trial_no is not None else ""
    return f"bench-{instance_type}-{build_id}-{segment_id}{suffix}"


def _positive_repetitions(run: dict[str, Any], condition_id: str) -> tuple[int, int]:
    repetitions = run.get("repetitions", 1)
    attempt_start = run.get("attemptNoStart", 1)
    if isinstance(repetitions, dict):
        repetitions = repetitions.get(condition_id, 1)
    if isinstance(attempt_start, dict):
        attempt_start = attempt_start.get(condition_id, 1)
    if type(repetitions) is not int or repetitions < 1:
        raise ValueError("each repetition count must be a positive integer")
    if type(attempt_start) is not int or attempt_start < 1:
        raise ValueError("each attemptNoStart must be a positive integer")
    return repetitions, attempt_start


def targets_for_run(
    run: dict[str, Any],
    conditions: dict[str, dict[str, Any]],
    build_id: str,
    expected_instance_type: str | None = None,
) -> list[dict[str, Any]]:
    """Return the exact bounded target names that a run manifest may address."""
    if not BUILD_ID_RE.fullmatch(build_id):
        raise ValueError("build ID must be 32 lowercase hex characters")
    if expected_instance_type is not None and expected_instance_type not in INSTANCE_TYPES:
        raise ValueError("instance type must be standard-2 or standard-3")
    segment_id = run.get("segmentId")
    if not isinstance(segment_id, str) or not SEGMENT_ID_RE.fullmatch(segment_id):
        raise ValueError("run manifest requires a valid segmentId")
    condition_ids = run.get("conditionIds")
    if not isinstance(condition_ids, list) or not condition_ids:
        raise ValueError("run manifest requires conditionIds")
    selected: list[dict[str, Any]] = []
    for condition_id in condition_ids:
        if not isinstance(condition_id, str) or condition_id not in conditions:
            raise ValueError("run manifest selects an unknown condition")
        condition = conditions[condition_id]
        if condition.get("instanceType") not in INSTANCE_TYPES:
            raise ValueError("run condition has an unsupported instance type")
        selected.append(condition)
    selected_types = {condition["instanceType"] for condition in selected}
    if len(selected_types) != 1:
        raise ValueError("all run conditions must match one fixed instance type")
    instance_type = next(iter(selected_types))
    if expected_instance_type is not None and instance_type != expected_instance_type:
        raise ValueError("all run conditions must match the requested instance type")

    mode = run.get("mode")
    rows: list[dict[str, Any]] = []
    if mode == "cold":
        if len(selected) != 1:
            raise ValueError("cold run manifest must select exactly one condition")
        # The preflight target is used for fingerprint identity only. It is destroyed
        # before the first request to any cold-trial target.
        preflight_segment = f"{segment_id}-preflight"
        if not SEGMENT_ID_RE.fullmatch(preflight_segment):
            raise ValueError("cold segmentId must leave room for the preflight suffix")
        rows.append({
            "targetId": target_id(instance_type, build_id, preflight_segment),
            "segmentId": segment_id,
            "instanceType": instance_type,
            "buildId": build_id,
            "purpose": "cold-preflight",
            **container_target_fields(instance_type),
        })
        condition_id = condition_ids[0]
        repetitions, attempt_start = _positive_repetitions(run, condition_id)
        if repetitions > 20:
            raise ValueError("cold run target allowlist is limited to 20 trials per segment")
        if attempt_start + repetitions - 1 > 2**53 - 1:
            raise ValueError("cold trial numbers must be JavaScript safe integers")
        for trial_no in range(attempt_start, attempt_start + repetitions):
            rows.append({
                "targetId": target_id(instance_type, build_id, segment_id, trial_no),
                "segmentId": segment_id,
                "instanceType": instance_type,
                "buildId": build_id,
                "purpose": "cold-trial",
                "coldTrialNo": trial_no,
                **container_target_fields(instance_type),
            })
    elif mode in {"positions", "game"}:
        rows.append({
            "targetId": target_id(instance_type, build_id, segment_id),
            "segmentId": segment_id,
            "instanceType": instance_type,
            "buildId": build_id,
            "purpose": "measurement",
            **container_target_fields(instance_type),
        })
    else:
        raise ValueError("run mode must be positions, game, or cold")
    return rows
