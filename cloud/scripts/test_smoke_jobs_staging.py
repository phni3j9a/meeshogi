from __future__ import annotations

import contextlib
import importlib.util
import io
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("smoke_jobs_staging", Path(__file__).with_name("smoke-jobs-staging.py"))
assert SPEC and SPEC.loader
SMOKE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SMOKE)


class SmokeAccessModeTests(unittest.TestCase):
    def test_state_route_stop_check_uses_internal_token_and_accepts_stopped_with_code(self) -> None:
        with patch.dict(os.environ, {"ANALYSIS_INTERNAL_TOKEN": "internal-secret"}), \
                patch.object(SMOKE, "api", return_value={
                    "httpStatus": 200,
                    "body": {"containerState": {"status": "stopped_with_code"}},
                }) as request:
            self.assertTrue(SMOKE.wait_for_container_stopped("https://worker.test", "job_" + "a" * 24))
        request.assert_called_once_with(
            "https://worker.test", "GET", f"/internal/jobs/{'job_' + 'a' * 24}/container", None, None,
            internal_token="internal-secret",
        )

    def test_stop_check_is_unverified_without_internal_token(self) -> None:
        with patch.dict(os.environ, {}, clear=True), patch.object(SMOKE, "api") as request:
            self.assertIsNone(SMOKE.wait_for_container_stopped("https://worker.test", "job_" + "b" * 24))
        request.assert_not_called()

    def test_development_precision_uses_a_fresh_owner_without_a_registration_file(self) -> None:
        owner = {"ownerId": "own_test", "credential": "test-only"}
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(SMOKE, "PRECISION_OWNER_FILE", Path(directory) / "owner.json"), \
                patch.object(SMOKE, "issue_credential", return_value=owner) as issue, \
                patch.object(SMOKE, "run_job_flow", return_value=[]) as flow, \
                patch.dict(os.environ, {"ANALYSIS_STAGING_URL": "https://worker.test"}), \
                patch.object(sys, "argv", ["smoke", "--precision"]), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(SMOKE.main(), 0)
            issue.assert_called_once_with("https://worker.test")
            flow.assert_called_once_with("https://worker.test", owner, "precision", require_precision_allowlist=False)
            self.assertFalse(SMOKE.PRECISION_OWNER_FILE.exists())

    def test_restricted_precision_retains_the_two_pass_grant_flow(self) -> None:
        owner = {"ownerId": "own_test", "credential": "test-only"}
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(SMOKE, "PRECISION_OWNER_FILE", Path(directory) / "owner.json"), \
                patch.object(SMOKE, "issue_credential", return_value=owner) as issue, \
                patch.object(SMOKE, "run_job_flow", return_value=[]) as flow, \
                patch.dict(os.environ, {"ANALYSIS_STAGING_URL": "https://worker.test"}), \
                patch.object(sys, "argv", ["smoke", "--precision", "--require-precision-allowlist"]), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(SMOKE.main(), 2)
            flow.assert_not_called()
            self.assertEqual(SMOKE.PRECISION_OWNER_FILE.stat().st_mode & 0o777, 0o600)
            self.assertIn("precision_allowed = 1", output.getvalue())
            self.assertNotIn(owner["credential"], output.getvalue())
            self.assertEqual(SMOKE.main(), 0)
            issue.assert_called_once()
            flow.assert_called_once_with("https://worker.test", owner, "precision", require_precision_allowlist=True)


if __name__ == "__main__":
    unittest.main()
