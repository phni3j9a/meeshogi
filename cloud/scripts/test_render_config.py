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

    def test_profile_instance_cap_only_changes_container_limit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = self.render(Path(directory) / "rendered.json")
        profiles = json.loads((CLOUD / "config" / "job-profiles.json").read_text(encoding="utf-8"))["profiles"]
        containers = {row["class_name"]: row for row in config["containers"]}
        queues = {row["queue"]: row for row in config["queues"]["consumers"]}
        for profile_id, class_name in (("free", "FreeJobContainer"), ("precision", "PrecisionJobContainer")):
            profile = profiles[profile_id]
            self.assertEqual(containers[class_name]["max_instances"], profile["maxInstances"])
            self.assertNotIn("max_concurrency", queues[profile["queueName"]])
            self.assertNotIn("visibility_timeout_ms", queues[profile["queueName"]])
        self.assertEqual(
            {row["queue"] for row in config["queues"]["producers"]},
            {profiles["free"]["queueName"], profiles["precision"]["queueName"]},
        )
        self.assertNotIn("meeshogi-jobs-staging", {row["queue"] for row in config["queues"]["producers"]})

    def test_changed_instance_cap_does_not_change_queue_delivery_settings(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "config").mkdir()
            template = root / "wrangler.staging.jsonc"
            template.write_text(TEMPLATE.read_text(encoding="utf-8"), encoding="utf-8")
            manifest_path = root / "config" / "job-profiles.json"
            manifest = json.loads((CLOUD / "config" / "job-profiles.json").read_text(encoding="utf-8"))
            manifest["profiles"]["free"]["maxInstances"] = 4
            manifest["profiles"]["precision"]["maxInstances"] = 1
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            config = self.render(root / "rendered.json", template)
        containers = {row["class_name"]: row for row in config["containers"]}
        queues = {row["queue"]: row for row in config["queues"]["consumers"]}
        self.assertEqual(containers["FreeJobContainer"]["max_instances"], 4)
        self.assertEqual(containers["PrecisionJobContainer"]["max_instances"], 1)
        for consumer in queues.values():
            self.assertNotIn("max_concurrency", consumer)
            self.assertNotIn("visibility_timeout_ms", consumer)
            self.assertEqual(consumer["max_batch_size"], 1)
            self.assertEqual(consumer["max_batch_timeout"], 0)
            self.assertEqual(consumer["max_retries"], 3)


if __name__ == "__main__":
    unittest.main()
