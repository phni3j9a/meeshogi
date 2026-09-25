#!/usr/bin/env python3
"""Bounded authenticated readiness polling for a benchmark staging deploy."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import math
import os
import re
import sys
from pathlib import Path
import time
import urllib.error
import urllib.request
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bench"))
from targeting import SINGLETON_TARGET_ID, targets_for_run  # noqa: E402


USER_AGENT = "meeshogi-issue20-benchmark/1.0"
GIB = 1 << 30
BUILD_ID_RE = re.compile(r"^[0-9a-f]{32}$")
RUNTIME_FIELDS = (
    "osCpuCount", "affinityCpuCount", "cpuMax", "cpuQuota", "memoryMaxBytes",
    "memTotalBytes", "rootDiskTotalBytes",
)


def inspect_health(
    status: int | None,
    payload: Any,
    expected_instance_type: str,
    expected_build_id: str,
    benchmark_enabled: bool,
    transport_error: str | None = None,
    expected_target: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return whitelisted facts, readiness checks, and an actionable reason list."""
    expected_cpu = 1 if expected_instance_type == "standard-2" else 2
    expected_memory = (6 if expected_instance_type == "standard-2" else 8) * GIB
    minimum_memory = expected_memory - (3 * GIB // 2)
    maximum_memory = expected_memory + (GIB // 4)
    body = payload if isinstance(payload, dict) else {}
    runtime = body.get("runtime") if isinstance(body.get("runtime"), dict) else {}
    boot_id = body.get("driverBootId")
    cpu_quota = runtime.get("cpuQuota")
    memory_limit = runtime.get("memoryMaxBytes")
    mem_total = runtime.get("memTotalBytes")

    cpu_quota_matches: bool | None = None
    if cpu_quota is not None:
        cpu_quota_matches = (
            isinstance(cpu_quota, (int, float)) and not isinstance(cpu_quota, bool)
            and math.isfinite(float(cpu_quota)) and abs(float(cpu_quota) - expected_cpu) <= 0.05
        )
    memory_limit_matches: bool | None = None
    if memory_limit is not None:
        memory_limit_matches = (
            type(memory_limit) is int and minimum_memory <= memory_limit <= maximum_memory
        )

    checks = {
        "httpOk": status == 200,
        "driverReady": body.get("status") == "ready",
        "buildIdMatches": isinstance(body.get("buildId"), str) and body.get("buildId") == expected_build_id,
        "driverBootIdValid": isinstance(boot_id, str) and re.fullmatch(r"[0-9a-f]{32}", boot_id) is not None,
        "runtimeBootIdMatches": runtime.get("driverBootId") == boot_id,
        "workerBenchmarkFlagMatches": body.get("workerBenchmarkEnabled") is benchmark_enabled,
        "workerInstanceTypeMatches": body.get("workerExpectedInstanceType") == expected_instance_type,
        "driverInstanceTypeMatches": body.get("expectedInstanceType") == expected_instance_type,
        "runtimeInstanceTypeMatches": runtime.get("expectedInstanceType") == expected_instance_type,
        "osCpuCountMatches": type(runtime.get("osCpuCount")) is int and runtime.get("osCpuCount") == expected_cpu,
        "affinityCpuCountMatches": type(runtime.get("affinityCpuCount")) is int and runtime.get("affinityCpuCount") == expected_cpu,
        "memTotalMatches": type(mem_total) is int and minimum_memory <= mem_total <= maximum_memory,
        "cpuQuotaConsistent": cpu_quota_matches is not False,
        "memoryLimitConsistent": memory_limit_matches is not False,
    }
    if expected_target is not None:
        checks.update({
            "targetIdMatches": body.get("targetId") == expected_target["targetId"],
            "segmentIdMatches": body.get("segmentId") == expected_target["segmentId"],
            "targetTypeMatches": body.get("targetInstanceType") == expected_instance_type,
            "targetBuildIdMatches": body.get("expectedBuildId") == expected_build_id,
        })
    reasons: list[str] = []
    if transport_error:
        reasons.append(f"health_request_failed:{transport_error}")
    if status is not None and status != 200:
        failure = body.get("failure") if isinstance(body.get("failure"), dict) else {}
        message = failure.get("message")
        if message == "Analysis container health failed contract validation.":
            reasons.append("health_contract_mismatch_possible_old_container")
        else:
            reasons.append(f"health_http_{status}")
    if not checks["driverReady"] and status == 200:
        reasons.append("driver_not_ready")
    for name, reason in (
        ("driverBootIdValid", "driver_boot_id_missing_or_invalid"),
        ("buildIdMatches", "driver_build_id_mismatch"),
        ("runtimeBootIdMatches", "runtime_boot_id_mismatch"),
        ("workerBenchmarkFlagMatches", "worker_benchmark_flag_mismatch"),
        ("workerInstanceTypeMatches", "worker_instance_type_mismatch"),
        ("driverInstanceTypeMatches", "driver_instance_type_mismatch"),
        ("runtimeInstanceTypeMatches", "runtime_instance_type_mismatch"),
        ("osCpuCountMatches", "os_cpu_count_mismatch"),
        ("affinityCpuCountMatches", "affinity_cpu_count_mismatch"),
        ("memTotalMatches", "mem_total_missing_or_out_of_range"),
        ("cpuQuotaConsistent", "cpu_quota_mismatch"),
        ("memoryLimitConsistent", "memory_limit_mismatch"),
        ("targetIdMatches", "target_id_mismatch"),
        ("segmentIdMatches", "target_segment_mismatch"),
        ("targetTypeMatches", "target_instance_type_mismatch"),
        ("targetBuildIdMatches", "target_build_id_mismatch"),
    ):
        if name in checks and not checks[name]:
            reasons.append(reason)
    ready = all(checks.values())
    if ready:
        reasons = []
    return {
        "httpStatus": status,
        "status": body.get("status") if isinstance(body.get("status"), str) else None,
        "buildId": body.get("buildId") if isinstance(body.get("buildId"), str) and BUILD_ID_RE.fullmatch(body["buildId"]) else None,
        "gitCommit": body.get("gitCommit") if isinstance(body.get("gitCommit"), str) and re.fullmatch(r"[0-9a-f]{40}", body["gitCommit"]) else None,
        "workerFailureCode": (
            body.get("failure", {}).get("code")
            if isinstance(body.get("failure"), dict)
            and body.get("failure", {}).get("code") in {"engine_error", "invalid", "busy", "timeout"}
            else None
        ),
        "driverBootId": boot_id if isinstance(boot_id, str) else None,
        "driverVersion": body.get("driverVersion") if isinstance(body.get("driverVersion"), str) else None,
        "contractVersion": body.get("contractVersion") if isinstance(body.get("contractVersion"), str) else None,
        "workerBenchmarkEnabled": body.get("workerBenchmarkEnabled") if isinstance(body.get("workerBenchmarkEnabled"), bool) else None,
        "workerExpectedInstanceType": body.get("workerExpectedInstanceType") if isinstance(body.get("workerExpectedInstanceType"), str) else None,
        "driverExpectedInstanceType": body.get("expectedInstanceType") if isinstance(body.get("expectedInstanceType"), str) else None,
        "runtime": {key: runtime.get(key) for key in RUNTIME_FIELDS},
        "targetId": body.get("targetId") if isinstance(body.get("targetId"), str) else None,
        "segmentId": body.get("segmentId") if isinstance(body.get("segmentId"), str) else None,
        "targetInstanceType": body.get("targetInstanceType") if isinstance(body.get("targetInstanceType"), str) else None,
        "expectedBuildId": body.get("expectedBuildId") if isinstance(body.get("expectedBuildId"), str) else None,
        "containerState": body.get("containerState") if isinstance(body.get("containerState"), str) else None,
        "containerStateLastChangeWall": body.get("containerStateLastChangeWall") if isinstance(body.get("containerStateLastChangeWall"), str) else None,
        "resourceEvidence": {
            "expectedVcpu": expected_cpu,
            "expectedMemTotalRangeBytes": [minimum_memory, maximum_memory],
            "cpuQuotaMatchesExpected": cpu_quota_matches,
            "memoryLimitMatchesExpected": memory_limit_matches,
        },
        "checks": checks,
        "failureReasons": reasons,
        "ready": ready,
    }


def _decode_health(status: int, raw: bytes) -> tuple[int, Any, str | None]:
    try:
        return status, json.loads(raw.decode("utf-8")), None
    except (UnicodeDecodeError, json.JSONDecodeError):
        return status, None, "InvalidHealthJson"


def _wall_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _post_json(base_url: str, token: str, path: str, body: dict[str, Any], timeout: float) -> tuple[int | None, dict[str, Any] | None, str | None]:
    request = urllib.request.Request(
        base_url.rstrip("/") + path,
        data=json.dumps(body, separators=(",", ":")).encode("utf-8"),
        headers={"Authorization": "Bearer " + token, "User-Agent": USER_AGENT, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status, payload, error = _decode_health(response.status, response.read(64 * 1024))
    except urllib.error.HTTPError as error:
        status, payload, decode_error = _decode_health(error.code, error.read(64 * 1024))
        return status, payload if isinstance(payload, dict) else None, decode_error
    except Exception as error:
        return None, None, type(error).__name__
    return status, payload if isinstance(payload, dict) else None, error


def _append_event(path: Path | None, row: dict[str, Any]) -> None:
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(row, separators=(",", ":"), allow_nan=False) + "\n")
        stream.flush()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-instance-type", required=True, choices=("standard-2", "standard-3"))
    parser.add_argument("--expected-build-id", default=os.environ.get("ANALYSIS_BUILD_ID"), help="32-hex build ID printed by build-push-image.sh (or ANALYSIS_BUILD_ID)")
    parser.add_argument("--manifest", type=Path, help="same run manifest passed to deploy-staging.sh and run.py")
    parser.add_argument("--evidence-file", type=Path, help="append benchmark target lifecycle evidence as JSONL")
    parser.add_argument("--benchmark-enabled", choices=("yes", "no"), default="yes")
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("--max-wait-seconds", type=float, default=120)
    parser.add_argument("--poll-interval-seconds", type=float, default=5)
    args = parser.parse_args()
    if not args.expected_build_id:
        parser.error("--expected-build-id or ANALYSIS_BUILD_ID is required")
    if not BUILD_ID_RE.fullmatch(args.expected_build_id):
        parser.error("--expected-build-id must be 32 lowercase hex characters")
    if args.timeout <= 0 or args.max_wait_seconds <= 0 or args.poll_interval_seconds < 0:
        parser.error("timeout and max wait must be positive; poll interval must be non-negative")
    url = os.environ.get("ANALYSIS_STAGING_URL")
    token = os.environ.get("ANALYSIS_INTERNAL_TOKEN")
    if not url or not token:
        print("ANALYSIS_STAGING_URL and ANALYSIS_INTERNAL_TOKEN are required.", file=sys.stderr)
        return 2

    expected_target: dict[str, Any] | None = None
    evidence_file = args.evidence_file
    if args.benchmark_enabled == "yes":
        if args.manifest is None:
            parser.error("--manifest is required for benchmark readiness")
        if evidence_file is None:
            parser.error("--evidence-file is required for benchmark readiness evidence")
        try:
            run_manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
            conditions_path = Path(__file__).resolve().parents[1] / "bench" / "conditions.json"
            conditions = json.loads(conditions_path.read_text(encoding="utf-8"))
            condition_map = {row["conditionId"]: row for row in conditions["conditions"]}
            expected_target = targets_for_run(run_manifest, condition_map, args.expected_build_id, args.expected_instance_type)[0]
        except (OSError, json.JSONDecodeError, ValueError, KeyError) as error:
            print(f"invalid benchmark run manifest: {error}", file=sys.stderr)
            return 2

        # Release the pre-existing singleton capacity slot without fetching it.
        stop_start = _wall_now()
        stop_status, stop_payload, stop_error = _post_json(
            url, token, "/internal/benchmark/stop", {"targetId": SINGLETON_TARGET_ID}, args.timeout,
        )
        stop_end = _wall_now()
        stop_row = {
            "recordType": "target-stop", "targetId": SINGLETON_TARGET_ID,
            "segmentId": "preexisting-singleton", "targetPurpose": "capacity-control",
            "requestStartWall": stop_start, "requestEndWall": stop_end,
            "httpStatus": stop_status, "transportError": stop_error,
            "stopConfirmed": isinstance(stop_payload, dict) and stop_payload.get("stopped") is True,
            "stopResponse": stop_payload,
            "preexistingStartTimeUnknown": True,
        }
        _append_event(evidence_file, stop_row)
        if stop_row["stopConfirmed"] is not True:
            print(json.dumps({"ready": False, "failureReasons": ["singleton_stop_unconfirmed"], "targetId": SINGLETON_TARGET_ID}, separators=(",", ":")), flush=True)
            return 2

    deadline = time.monotonic() + args.max_wait_seconds
    attempt = 0
    first_dispatch_wall: str | None = None
    while True:
        attempt += 1
        remaining = max(0.1, deadline - time.monotonic())
        request_start_wall = _wall_now()
        if first_dispatch_wall is None:
            first_dispatch_wall = request_start_wall
        health_path = "/internal/health"
        if expected_target is not None:
            health_path = "/internal/benchmark/health?targetId=" + expected_target["targetId"]
        request = urllib.request.Request(
            url.rstrip("/") + health_path,
            headers={"Authorization": "Bearer " + token, "User-Agent": USER_AGENT},
            method="GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=min(args.timeout, remaining)) as response:
                status, payload, transport_error = _decode_health(response.status, response.read(64 * 1024))
        except urllib.error.HTTPError as error:
            status, payload, transport_error = _decode_health(error.code, error.read(64 * 1024))
        except Exception as error:
            status, payload, transport_error = None, None, type(error).__name__
        evidence = inspect_health(
            status,
            payload,
            args.expected_instance_type,
            args.expected_build_id,
            args.benchmark_enabled == "yes",
            transport_error,
            expected_target,
        )
        request_end_wall = _wall_now()
        evidence["requestStartWall"] = request_start_wall
        evidence["requestEndWall"] = request_end_wall
        evidence["attempt"] = attempt
        evidence["elapsedSeconds"] = round(args.max_wait_seconds - max(0, deadline - time.monotonic()), 3)
        print(json.dumps(evidence, separators=(",", ":"), allow_nan=False), flush=True)
        if expected_target is not None:
            _append_event(evidence_file, {
                "recordType": "target-health", "targetId": expected_target["targetId"],
                "segmentId": expected_target["segmentId"], "targetPurpose": expected_target["purpose"],
                "expectedInstanceType": args.expected_instance_type, "expectedBuildId": args.expected_build_id,
                "requestStartWall": request_start_wall, "requestEndWall": request_end_wall,
                "httpStatus": status, "health": evidence,
            })
        if evidence["ready"]:
            return 0
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            if expected_target is not None:
                stop_start = _wall_now()
                stop_status, stop_payload, stop_error = _post_json(
                    url, token, "/internal/benchmark/stop", {"targetId": expected_target["targetId"]}, args.timeout,
                )
                stop_confirmed = isinstance(stop_payload, dict) and stop_payload.get("stopped") is True
                _append_event(evidence_file, {
                    "recordType": "target-stop", "targetId": expected_target["targetId"],
                    "segmentId": expected_target["segmentId"], "expectedInstanceType": args.expected_instance_type,
                    "expectedBuildId": args.expected_build_id, "firstDispatchWall": first_dispatch_wall,
                    "requestStartWall": stop_start, "requestEndWall": _wall_now(), "httpStatus": stop_status,
                    "transportError": stop_error,
                    "stopConfirmed": stop_confirmed,
                    "stopResponse": stop_payload,
                })
                if not stop_confirmed:
                    print(json.dumps({"ready": False, "failureReasons": ["target_stop_unconfirmed"], "targetId": expected_target["targetId"]}, separators=(",", ":")), flush=True)
                    return 2
            return 1
        time.sleep(min(args.poll_interval_seconds, remaining))


if __name__ == "__main__":
    raise SystemExit(main())
