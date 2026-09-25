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
    def render(self, inherited_flag: str, verification: bool) -> dict:
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
            environment = os.environ.copy()
            environment["ANALYSIS_VERIFY_STOP_ENGINE_ONCE"] = inherited_flag
            result = subprocess.run(command, env=environment, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(output.read_text(encoding="utf-8"))

    def test_normal_render_ignores_inherited_flag_and_verification_is_explicit(self) -> None:
        normal = self.render(inherited_flag="1", verification=False)
        verification = self.render(inherited_flag="0", verification=True)

        self.assertNotIn("ANALYSIS_VERIFY_STOP_ENGINE_ONCE", normal.get("vars", {}))
        self.assertEqual(
            verification["vars"]["ANALYSIS_VERIFY_STOP_ENGINE_ONCE"],
            "1",
        )


if __name__ == "__main__":
    unittest.main()
