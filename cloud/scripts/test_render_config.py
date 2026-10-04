from __future__ import annotations

import json
from pathlib import Path
import subprocess
import tempfile
import unittest

CLOUD = Path(__file__).resolve().parents[1]
RENDERER = CLOUD / "scripts" / "render-config.py"
TEMPLATE = CLOUD / "wrangler.staging.jsonc"
ACCOUNT = "a" * 32
DIGEST = "b" * 64


class RenderConfigJobConcurrencyTests(unittest.TestCase):
    def render(self, output: Path, template: Path = TEMPLATE) -> dict:
        subprocess.run(
            ["python3", str(RENDERER), str(template), str(output), ACCOUNT, DIGEST],
            check=True, capture_output=True, text=True,
        )
        return json.loads(output.read_text(encoding="utf-8"))

    def test_job_container_caps_match_profile_queue_concurrency(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = self.render(Path(directory) / "rendered.json")
        profiles = json.loads((CLOUD / "config" / "job-profiles.json").read_text(encoding="utf-8"))["profiles"]
        containers = {row["class_name"]: row for row in config["containers"]}
        queues = {row["queue"]: row for row in config["queues"]["consumers"]}
        for profile_id, class_name in (("free", "FreeJobContainer"), ("precision", "PrecisionJobContainer")):
            profile = profiles[profile_id]
            self.assertEqual(containers[class_name]["max_instances"], profile["maxConcurrentJobs"])
            self.assertEqual(queues[profile["queueName"]]["max_concurrency"], profile["maxConcurrentJobs"])
            self.assertEqual(containers[class_name]["max_instances"], queues[profile["queueName"]]["max_concurrency"])
        self.assertEqual(
            {row["queue"] for row in config["queues"]["producers"]},
            {profiles["free"]["queueName"], profiles["precision"]["queueName"]},
        )
        self.assertNotIn("meeshogi-jobs-staging", {row["queue"] for row in config["queues"]["producers"]})

    def test_changed_manifest_drives_both_container_and_queue_caps(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "config").mkdir()
            template = root / "wrangler.staging.jsonc"
            template.write_text(TEMPLATE.read_text(encoding="utf-8"), encoding="utf-8")
            manifest_path = root / "config" / "job-profiles.json"
            manifest = json.loads((CLOUD / "config" / "job-profiles.json").read_text(encoding="utf-8"))
            manifest["profiles"]["free"]["maxConcurrentJobs"] = 4
            manifest["profiles"]["precision"]["maxConcurrentJobs"] = 1
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            config = self.render(root / "rendered.json", template)
        containers = {row["class_name"]: row for row in config["containers"]}
        queues = {row["queue"]: row for row in config["queues"]["consumers"]}
        self.assertEqual(containers["FreeJobContainer"]["max_instances"], 4)
        self.assertEqual(queues["meeshogi-jobs-free-staging"]["max_concurrency"], 4)
        self.assertEqual(containers["PrecisionJobContainer"]["max_instances"], 1)
        self.assertEqual(queues["meeshogi-jobs-precision-staging"]["max_concurrency"], 1)


if __name__ == "__main__":
    unittest.main()
