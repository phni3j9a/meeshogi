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
                manifest_names = (
                    ["pilot-standard-2.json", "pilot-reference-standard-3.json"]
                    if benchmark == "both"
                    else ["pilot-standard-2.json" if benchmark == "standard-2" else "pilot-reference-standard-3.json"]
                )
                command.extend(["--benchmark", "--build-id", "c" * 32])
                for manifest_name in manifest_names:
                    command.extend(["--run-manifest", str(CLOUD_DIR / "bench" / "manifests" / manifest_name)])
            environment = os.environ.copy()
            environment["ANALYSIS_VERIFY_STOP_ENGINE_ONCE"] = inherited_flag
            environment["ANALYSIS_BENCHMARK_ENABLED"] = "1"
            environment["ANALYSIS_EXPECTED_INSTANCE_TYPE"] = "standard-3"
            result = subprocess.run(command, env=environment, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(output.read_text(encoding="utf-8"))

    def test_normal_render_ignores_inherited_flags_and_keeps_three_fixed_apps(self) -> None:
        normal = self.render(inherited_flag="1", verification=False)
        verification = self.render(inherited_flag="0", verification=True)

        self.assertNotIn("ANALYSIS_VERIFY_STOP_ENGINE_ONCE", normal.get("vars", {}))
        self.assertNotIn("ANALYSIS_BENCHMARK_ENABLED", normal.get("vars", {}))
        self.assertNotIn("ANALYSIS_BENCHMARK_BUILD_ID", normal.get("vars", {}))
        self.assertNotIn("ANALYSIS_BENCHMARK_TARGETS", normal.get("vars", {}))
        self.assertEqual(normal["vars"]["ANALYSIS_EXPECTED_INSTANCE_TYPE"], "standard-2")
        self.assertEqual({row["class_name"]: row["instance_type"] for row in normal["containers"]}, {
            "AnalysisContainer": "standard-2",
            "BenchmarkStandard2Container": "standard-2",
            "BenchmarkStandard3Container": "standard-3",
        })
        self.assertTrue(all(row["max_instances"] == 1 for row in normal["containers"]))
        self.assertEqual(normal["migrations"][-1], {
            "tag": "v2",
            "new_sqlite_classes": ["BenchmarkStandard2Container", "BenchmarkStandard3Container"],
        })
        self.assertNotIn("ANALYSIS_BENCHMARK_ENABLED", verification.get("vars", {}))
        self.assertEqual(normal["version_metadata"], {"binding": "CF_VERSION_METADATA"})
        self.assertEqual(
            verification["vars"]["ANALYSIS_VERIFY_STOP_ENGINE_ONCE"],
            "1",
        )

    def test_benchmark_render_binds_both_fixed_type_apps_without_resizing(self) -> None:
        benchmark = self.render(inherited_flag="1", verification=False, benchmark="both")
        self.assertEqual(benchmark["vars"]["ANALYSIS_BENCHMARK_ENABLED"], "1")
        self.assertEqual(benchmark["vars"]["ANALYSIS_EXPECTED_INSTANCE_TYPE"], "standard-2")
        self.assertTrue(all(row["max_instances"] == 1 for row in benchmark["containers"]))
        self.assertEqual({row["name"]: row["class_name"] for row in benchmark["containers"]}, {
            "meeshogi-analysis-mvp-staging-analysis": "AnalysisContainer",
            "meeshogi-analysis-mvp-staging-benchmark-standard-2": "BenchmarkStandard2Container",
            "meeshogi-analysis-mvp-staging-benchmark-standard-3": "BenchmarkStandard3Container",
        })
        self.assertEqual(benchmark["vars"]["ANALYSIS_BENCHMARK_BUILD_ID"], "c" * 32)
        targets = json.loads(benchmark["vars"]["ANALYSIS_BENCHMARK_TARGETS"])
        self.assertEqual(targets[1]["targetId"], f"bench-standard-2-{'c' * 32}-pilot-standard-2")
        self.assertEqual(targets[1]["containerClass"], "BenchmarkStandard2Container")
        standard_three_target = targets[2]
        self.assertEqual(standard_three_target["targetId"], f"bench-standard-3-{'c' * 32}-pilot-reference-standard-3")
        self.assertEqual(standard_three_target["containerClass"], "BenchmarkStandard3Container")
        self.assertEqual(standard_three_target["containerBinding"], "ANALYSIS_BENCHMARK_STANDARD_3")
        self.assertTrue(all(row["targetId"] != "arbitrary-name" for row in targets))
        self.assertNotIn("ANALYSIS_VERIFY_STOP_ENGINE_ONCE", benchmark.get("vars", {}))

    def test_render_rejects_runtime_instance_type_switching(self) -> None:
        with tempfile.TemporaryDirectory(prefix="meeshogi-render-config-") as directory:
            output = Path(directory) / "rendered.json"
            result = subprocess.run(
                [
                    sys.executable, str(RENDERER), str(TEMPLATE), str(output), "a" * 32, "b" * 64,
                    "--benchmark", "--instance-type", "standard-3",
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("Unknown render option", result.stderr)

    def test_deploy_rejects_runtime_instance_type_switching(self) -> None:
        deploy = CLOUD_DIR / "scripts/deploy-staging.sh"
        result = subprocess.run(["bash", str(deploy), "--benchmark", "--instance-type", "standard-3"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("usage:", result.stderr)

    def test_deploy_benchmark_mode_requires_a_finite_run_manifest(self) -> None:
        deploy = CLOUD_DIR / "scripts/deploy-staging.sh"
        result = subprocess.run(["bash", str(deploy), "--benchmark"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("requires at least one --run-manifest", result.stderr)


if __name__ == "__main__":
    unittest.main()
