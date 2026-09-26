from __future__ import annotations

import importlib.util
import json
import lzma
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


BENCH_DIR = Path(__file__).resolve().parents[1]
RESULTS_DIR = BENCH_DIR / "results" / "issue-20"
FORBIDDEN_SUBSTRINGS = ("workers.dev", "registry.cloudflare.com", "bearer ", "authorization")

spec = importlib.util.spec_from_file_location("issue20_sanitize_raw", BENCH_DIR / "sanitize_raw.py")
sanitize_raw = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = sanitize_raw
spec.loader.exec_module(sanitize_raw)


class SanitizeRawTest(unittest.TestCase):
    def test_replaces_endpoint_and_image_ref_and_rehashes_references(self) -> None:
        digest = "a" * 64
        fingerprint = {
            "imageRef": f"registry.cloudflare.com/account/app@sha256:{digest}",
            "imageDigest": digest,
            "endpoint": "https://example.workers.dev",
        }
        fingerprint["fingerprintSha256"] = sanitize_raw.canonical_sha256(fingerprint)
        old_hash = fingerprint["fingerprintSha256"]
        untouched = '{"recordType": "target-health", "targetId": "t"}'
        lines = [
            json.dumps({"recordType": "run-start", "runId": "r", "fingerprint": fingerprint}),
            json.dumps({"recordType": "attempt", "runId": "r", "runFingerprintSha256": old_hash}),
            untouched,
        ]

        start, attempt, other = sanitize_raw.sanitize_lines(lines)

        new_fingerprint = json.loads(start)["fingerprint"]
        self.assertEqual(new_fingerprint["endpoint"], sanitize_raw.PLACEHOLDER_ENDPOINT)
        self.assertTrue(new_fingerprint["imageRef"].endswith(f"@sha256:{digest}"))
        unhashed = {key: value for key, value in new_fingerprint.items() if key != "fingerprintSha256"}
        self.assertEqual(new_fingerprint["fingerprintSha256"], sanitize_raw.canonical_sha256(unhashed))
        self.assertEqual(json.loads(attempt)["runFingerprintSha256"], new_fingerprint["fingerprintSha256"])
        self.assertEqual(other, untouched)

    def test_refuses_output_that_still_contains_a_hostname(self) -> None:
        with self.assertRaises(ValueError):
            sanitize_raw.sanitize_lines(['{"note": "https://example.workers.dev"}'])


class Issue20ResultsReproduceTest(unittest.TestCase):
    """The committed sanitized raw must regenerate the committed aggregate exactly."""

    def test_sanitized_raw_has_no_endpoint_registry_or_credentials(self) -> None:
        raw = lzma.decompress((RESULTS_DIR / "raw-issue20.jsonl.xz").read_bytes()).decode("utf-8").lower()
        for needle in FORBIDDEN_SUBSTRINGS:
            self.assertNotIn(needle, raw)

    def test_aggregate_reproduces_committed_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            raw = work / "raw-issue20.jsonl"
            raw.write_bytes(lzma.decompress((RESULTS_DIR / "raw-issue20.jsonl.xz").read_bytes()))
            json_out = work / "aggregate.json"
            markdown_out = work / "aggregate.md"
            completed = subprocess.run(
                [
                    sys.executable,
                    str(BENCH_DIR / "aggregate.py"),
                    "--input",
                    str(raw),
                    "--json-out",
                    str(json_out),
                    "--markdown-out",
                    str(markdown_out),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(
                json_out.read_bytes(),
                lzma.decompress((RESULTS_DIR / "aggregate.json.xz").read_bytes()),
            )
            self.assertEqual(markdown_out.read_bytes(), (RESULTS_DIR / "aggregate.md").read_bytes())


if __name__ == "__main__":
    unittest.main()
