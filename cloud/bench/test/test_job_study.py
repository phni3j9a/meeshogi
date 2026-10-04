from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("job_study", Path(__file__).parents[1] / "job_study.py")
assert SPEC and SPEC.loader
STUDY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(STUDY)


class JobStudyTests(unittest.TestCase):
    def test_parallel_mixed_run_uses_distinct_owners_and_records_cold_job_timings(self) -> None:
        lock = threading.Lock()
        issued = 0
        credentials: set[str] = set()
        job_credentials: dict[str, str] = {}
        internal_tokens: list[str | None] = []

        def fake_api(base, method, path, credential, body, *, internal_token=None):
            nonlocal issued
            if path == "/v1/credentials":
                with lock:
                    issued += 1
                    current = f"credential-{issued}"
                    credentials.add(current)
                return 201, {"credential": current}
            if path == "/v1/jobs":
                job_id = f"job-{credential}"
                job_credentials[job_id] = credential
                return 201, {"jobId": job_id}
            if path.startswith("/v1/jobs/") and path.endswith("/results?afterPly=-1&limit=200"):
                return 200, {"results": [], "hasMore": False}
            if path.startswith("/v1/jobs/"):
                return 200, {"status": "completed", "analyzedPlies": 1, "failure": None}
            if path.startswith("/internal/jobs/"):
                internal_tokens.append(internal_token)
                return 200, {"containerState": {"status": "stopped"}}
            raise AssertionError(f"unexpected API request: {method} {path}")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            positions_path = root / "positions.json"
            positions_path.write_text(json.dumps({"positions": [
                {"id": "p1", "sfen": "sfen-1", "phase": "opening", "sha256": "1" * 64},
                {"id": "p2", "sfen": "sfen-2", "phase": "middlegame", "sha256": "2" * 64},
            ]}), encoding="utf-8")
            output = root / "study.jsonl"
            args = type("Args", (), {
                "base_url": "https://worker.test", "profile": "mixed", "label": "issue48",
                "mode": "positions", "game_repetitions": 0, "expect_movetime": None,
                "output": str(output), "parallel_jobs": 2,
            })()
            with patch.object(STUDY, "POSITIONS_PATH", positions_path), \
                    patch.dict("os.environ", {"ANALYSIS_INTERNAL_TOKEN": "internal"}), \
                    patch.object(STUDY, "api", side_effect=fake_api):
                self.assertEqual(STUDY.command_run(args), 0)

            rows = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
        self.assertEqual([row["profile"] for row in rows], ["free", "precision"])
        self.assertEqual(len(credentials), 2)
        self.assertEqual(set(job_credentials.values()), credentials)
        self.assertTrue(all(row["postToFirstResultMs"] is not None for row in rows))
        self.assertTrue(all(row["postToCompleteMs"] is not None for row in rows))
        self.assertTrue(all(row["containerStopConfirmed"] for row in rows))
        self.assertTrue(all(row["containerStopConfirmedAt"] for row in rows))
        self.assertEqual(internal_tokens, ["internal", "internal"])


if __name__ == "__main__":
    unittest.main()
