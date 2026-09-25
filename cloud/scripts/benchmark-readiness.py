#!/usr/bin/env python3
"""Authenticated readiness gate for an explicitly benchmark-enabled staging deploy."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from typing import Any


USER_AGENT = "meeshogi-issue20-benchmark/1.0"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-instance-type", required=True, choices=("standard-2", "standard-3"))
    parser.add_argument("--benchmark-enabled", choices=("yes", "no"), default="yes")
    parser.add_argument("--timeout", type=int, default=30)
    args = parser.parse_args()
    url = os.environ.get("ANALYSIS_STAGING_URL")
    token = os.environ.get("ANALYSIS_INTERNAL_TOKEN")
    if not url or not token:
        print("ANALYSIS_STAGING_URL and ANALYSIS_INTERNAL_TOKEN are required.", file=sys.stderr)
        return 2
    request = urllib.request.Request(
        url.rstrip("/") + "/internal/health",
        headers={"Authorization": "Bearer " + token, "User-Agent": USER_AGENT},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=args.timeout) as response:
            status = response.status
            payload: Any = json.loads(response.read(64 * 1024).decode("utf-8"))
    except urllib.error.HTTPError as error:
        print(json.dumps({"httpStatus": error.code, "ready": False}, separators=(",", ":")))
        return 1
    except Exception as error:
        print(json.dumps({"ready": False, "error": type(error).__name__}, separators=(",", ":")))
        return 1
    runtime = payload.get("runtime") if isinstance(payload, dict) else None
    runtime = runtime if isinstance(runtime, dict) else {}
    boot_id = payload.get("driverBootId") if isinstance(payload, dict) else None
    expected = args.expected_instance_type
    benchmark_enabled = args.benchmark_enabled == "yes"
    expected_cpu = 1 if expected == "standard-2" else 2
    expected_memory = (6 if expected == "standard-2" else 8) * 1024 * 1024 * 1024
    cpu_quota = runtime.get("cpuQuota")
    memory_limit = runtime.get("memoryMaxBytes")
    cpu_quota_matches = isinstance(cpu_quota, (int, float)) and abs(float(cpu_quota) - expected_cpu) <= 0.05
    memory_limit_matches = isinstance(memory_limit, int) and abs(memory_limit - expected_memory) <= expected_memory * 0.05
    resource_proof = (cpu_quota is not None or memory_limit is not None) and (
        (cpu_quota is None or cpu_quota_matches) and (memory_limit is None or memory_limit_matches)
    )
    evidence = {
        "httpStatus": status,
        "status": payload.get("status") if isinstance(payload, dict) else None,
        "driverBootId": boot_id if isinstance(boot_id, str) else None,
        "driverVersion": payload.get("driverVersion") if isinstance(payload, dict) else None,
        "contractVersion": payload.get("contractVersion") if isinstance(payload, dict) else None,
        "workerBenchmarkEnabled": payload.get("workerBenchmarkEnabled") if isinstance(payload, dict) else None,
        "workerExpectedInstanceType": payload.get("workerExpectedInstanceType") if isinstance(payload, dict) else None,
        "driverExpectedInstanceType": payload.get("expectedInstanceType") if isinstance(payload, dict) else None,
        "runtime": {key: runtime.get(key) for key in ("osCpuCount", "affinityCpuCount", "cpuMax", "cpuQuota", "memoryMaxBytes")},
        "resourceEvidence": {
            "expectedVcpu": expected_cpu,
            "expectedMemoryMaxBytes": expected_memory,
            "cpuQuotaMatchesExpected": cpu_quota_matches,
            "memoryLimitMatchesExpected": memory_limit_matches,
            "hasMatchingCgroupEvidence": resource_proof,
        },
    }
    ready = (
        status == 200
        and isinstance(payload, dict)
        and payload.get("status") == "ready"
        and isinstance(boot_id, str)
        and re.fullmatch(r"[0-9a-f]{32}", boot_id) is not None
        and payload.get("workerBenchmarkEnabled") is benchmark_enabled
        and payload.get("workerExpectedInstanceType") == expected
        and payload.get("expectedInstanceType") == expected
        and runtime.get("expectedInstanceType") == expected
        and runtime.get("driverBootId") == boot_id
        and resource_proof
    )
    evidence["ready"] = ready
    print(json.dumps(evidence, separators=(",", ":"), allow_nan=False))
    return 0 if ready else 1


if __name__ == "__main__":
    raise SystemExit(main())
