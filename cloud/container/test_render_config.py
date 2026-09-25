from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


CLOUD_DIR = Path(__file__).resolve().parents[1]
RENDERER = CLOUD_DIR / "scripts/render-config.py"
TEMPLATE = CLOUD_DIR / "wrangler.staging.jsonc"


class RenderConfigTests(unittest.TestCase):
    def render(self, inherited_flag: str, verification: bool, benchmark: str | None = None) -> dict:
        with tempfile.TemporaryDirectory(prefix="meeshogi-render-config-") as directory:
            output = Path(directory) / "rendered.json"
            command = [
                sys.executable,
                str(RENDERER),
                str(TEMPLATE),
                str(output),
                "a" * 32,
                "b" * 64,
            ]
            if verification:
                command.append("--verification-stop-engine-once")
            if benchmark is not None:
                command.extend(["--benchmark", "--instance-type", benchmark])
            environment = os.environ.copy()
            environment["ANALYSIS_VERIFY_STOP_ENGINE_ONCE"] = inherited_flag
            environment["ANALYSIS_BENCHMARK_ENABLED"] = "1"
            environment["ANALYSIS_EXPECTED_INSTANCE_TYPE"] = "standard-3"
            result = subprocess.run(command, env=environment, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(output.read_text(encoding="utf-8"))

    def test_normal_render_ignores_inherited_flag_and_verification_is_explicit(self) -> None:
        normal = self.render(inherited_flag="1", verification=False)
        verification = self.render(inherited_flag="0", verification=True)

        self.assertNotIn("ANALYSIS_VERIFY_STOP_ENGINE_ONCE", normal.get("vars", {}))
        self.assertNotIn("ANALYSIS_BENCHMARK_ENABLED", normal.get("vars", {}))
        self.assertEqual(normal["vars"]["ANALYSIS_EXPECTED_INSTANCE_TYPE"], "standard-2")
        self.assertEqual(normal["containers"][0]["instance_type"], "standard-2")
        self.assertEqual(normal["version_metadata"], {"binding": "CF_VERSION_METADATA"})
        self.assertEqual(
            verification["vars"]["ANALYSIS_VERIFY_STOP_ENGINE_ONCE"],
            "1",
        )

    def test_benchmark_and_instance_type_are_explicit_render_options(self) -> None:
        standard_three = self.render(inherited_flag="1", verification=False, benchmark="standard-3")
        self.assertEqual(standard_three["vars"]["ANALYSIS_BENCHMARK_ENABLED"], "1")
        self.assertEqual(standard_three["vars"]["ANALYSIS_EXPECTED_INSTANCE_TYPE"], "standard-3")
        self.assertEqual(standard_three["containers"][0]["instance_type"], "standard-3")
        self.assertNotIn("ANALYSIS_VERIFY_STOP_ENGINE_ONCE", standard_three.get("vars", {}))

    def test_benchmark_render_requires_explicit_supported_instance_type(self) -> None:
        with tempfile.TemporaryDirectory(prefix="meeshogi-render-config-") as directory:
            output = Path(directory) / "rendered.json"
            result = subprocess.run(
                [sys.executable, str(RENDERER), str(TEMPLATE), str(output), "a" * 32, "b" * 64, "--benchmark"],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("requires --instance-type", result.stderr)

    def test_deploy_benchmark_mode_requires_explicit_instance_type(self) -> None:
        deploy = CLOUD_DIR / "scripts/deploy-staging.sh"
        result = subprocess.run(["bash", str(deploy), "--benchmark"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("requires an explicit --instance-type", result.stderr)


if __name__ == "__main__":
    unittest.main()
