from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("benchmark-readiness.py")
spec = importlib.util.spec_from_file_location("benchmark_readiness", SCRIPT)
readiness = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = readiness
spec.loader.exec_module(readiness)


GIB = 1 << 30
BUILD_ID = "9" * 32


def healthy_payload() -> dict:
    return {
        "status": "ready",
        "buildId": BUILD_ID,
        "gitCommit": "a" * 40,
        "driverBootId": "a" * 32,
        "expectedInstanceType": "standard-2",
        "workerBenchmarkEnabled": True,
        "workerExpectedInstanceType": "standard-2",
        "driverVersion": "synthetic-test-driver",
        "contractVersion": "synthetic-test-contract",
        "runtime": {
            "driverBootId": "a" * 32,
            "expectedInstanceType": "standard-2",
            "osCpuCount": 1,
            "affinityCpuCount": 1,
            "cpuMax": None,
            "cpuQuota": None,
            "memoryMaxBytes": None,
            "memTotalBytes": 5 * GIB + GIB // 2,
            "rootDiskTotalBytes": 32 * GIB,
        },
    }


class FakeResponse:
    def __init__(self, payload: dict, status: int = 200):
        self.status = status
        self.raw = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit: int) -> bytes:
        return self.raw


class BenchmarkReadinessTests(unittest.TestCase):
    def test_cpu_and_memtotal_prove_instance_type_without_cgroup_values(self) -> None:
        result = readiness.inspect_health(200, healthy_payload(), "standard-2", BUILD_ID, True)
        self.assertTrue(result["ready"])
        self.assertEqual(result["runtime"]["memTotalBytes"], 5 * GIB + GIB // 2)
        self.assertEqual(result["runtime"]["rootDiskTotalBytes"], 32 * GIB)
        self.assertEqual(result["buildId"], BUILD_ID)
        self.assertEqual(result["gitCommit"], "a" * 40)
        self.assertIsNone(result["resourceEvidence"]["cpuQuotaMatchesExpected"])
        self.assertIsNone(result["resourceEvidence"]["memoryLimitMatchesExpected"])

    def test_wrong_cpu_memory_and_present_cgroup_evidence_are_reported(self) -> None:
        payload = healthy_payload()
        payload["runtime"]["affinityCpuCount"] = 2
        payload["runtime"]["memTotalBytes"] = 4 * GIB
        payload["runtime"]["cpuQuota"] = 2
        result = readiness.inspect_health(200, payload, "standard-2", BUILD_ID, True)
        self.assertFalse(result["ready"])
        self.assertIn("affinity_cpu_count_mismatch", result["failureReasons"])
        self.assertIn("mem_total_missing_or_out_of_range", result["failureReasons"])
        self.assertIn("cpu_quota_mismatch", result["failureReasons"])

    def test_wrong_image_build_id_is_not_ready(self) -> None:
        payload = healthy_payload()
        payload["buildId"] = "8" * 32
        result = readiness.inspect_health(200, payload, "standard-2", BUILD_ID, True)
        self.assertFalse(result["ready"])
        self.assertIn("driver_build_id_mismatch", result["failureReasons"])

    def test_main_reports_each_poll_and_recovers_from_old_container_contract(self) -> None:
        old_container = {
            "schemaVersion": 1,
            "status": "failure",
            "failure": {
                "code": "engine_error",
                "message": "Analysis container health failed contract validation.",
            },
        }
        old_error = urllib.error.HTTPError(
            "https://example.invalid/internal/health", 502, "Bad Gateway", {},
            io.BytesIO(json.dumps(old_container).encode("utf-8")),
        )
        captured_agents: list[str | None] = []

        def open_request(request, timeout):
            captured_agents.append(request.get_header("User-agent"))
            self.assertGreater(timeout, 0)
            if len(captured_agents) == 1:
                raise old_error
            return FakeResponse(healthy_payload())

        output = io.StringIO()
        argv = [
            "benchmark-readiness.py", "--expected-instance-type", "standard-2",
            "--expected-build-id", BUILD_ID,
            "--max-wait-seconds", "2", "--poll-interval-seconds", "0", "--timeout", "1",
        ]
        with (
            patch.object(sys, "argv", argv),
            patch.dict("os.environ", {
                "ANALYSIS_STAGING_URL": "https://example.invalid",
                "ANALYSIS_INTERNAL_TOKEN": "secret-token",
            }),
            patch.object(readiness.urllib.request, "urlopen", side_effect=open_request),
            contextlib.redirect_stdout(output),
        ):
            self.assertEqual(readiness.main(), 0)

        self.assertEqual(captured_agents, [readiness.USER_AGENT, readiness.USER_AGENT])
        rows = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(len(rows), 2)
        self.assertIn("health_contract_mismatch_possible_old_container", rows[0]["failureReasons"])
        self.assertTrue(rows[1]["ready"])
        self.assertEqual(rows[1]["attempt"], 2)
        self.assertNotIn("secret-token", output.getvalue())


if __name__ == "__main__":
    unittest.main()
