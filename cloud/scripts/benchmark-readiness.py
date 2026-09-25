#!/usr/bin/env python3
"""Bounded authenticated readiness polling for a benchmark staging deploy."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.request
from typing import Any


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
    ):
        if not checks[name]:
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-instance-type", required=True, choices=("standard-2", "standard-3"))
    parser.add_argument("--expected-build-id", default=os.environ.get("ANALYSIS_BUILD_ID"), help="32-hex build ID printed by build-push-image.sh (or ANALYSIS_BUILD_ID)")
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

    deadline = time.monotonic() + args.max_wait_seconds
    attempt = 0
    while True:
        attempt += 1
        remaining = max(0.1, deadline - time.monotonic())
        request = urllib.request.Request(
            url.rstrip("/") + "/internal/health",
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
        )
        evidence["attempt"] = attempt
        evidence["elapsedSeconds"] = round(args.max_wait_seconds - max(0, deadline - time.monotonic()), 3)
        print(json.dumps(evidence, separators=(",", ":"), allow_nan=False), flush=True)
        if evidence["ready"]:
            return 0
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return 1
        time.sleep(min(args.poll_interval_seconds, remaining))


if __name__ == "__main__":
    raise SystemExit(main())
