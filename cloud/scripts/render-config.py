#!/usr/bin/env python3
"""Render a temporary Wrangler config with an account and pinned image digest."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bench"))
from targeting import SINGLETON_TARGET_ID, targets_for_run  # noqa: E402


def main() -> int:
    args = sys.argv[1:]
    if len(args) < 4:
        print("usage: render-config.py TEMPLATE OUTPUT ACCOUNT_ID IMAGE_DIGEST [--verification-stop-engine-once] [--benchmark --instance-type standard-2|standard-3 --build-id BUILD_ID --run-manifest FILE ...]", file=sys.stderr)
        return 2
    template, output, account_id, image_digest = args[:4]
    switches = args[4:]
    verification_stop_once = "--verification-stop-engine-once" in switches
    benchmark_enabled = "--benchmark" in switches
    instance_type: str | None = None
    build_id: str | None = None
    manifest_paths: list[Path] = []
    allowed_switches = {"--verification-stop-engine-once", "--benchmark", "--instance-type", "--build-id", "--run-manifest"}
    index = 0
    while index < len(switches):
        option = switches[index]
        if option not in allowed_switches:
            print("Unknown render option.", file=sys.stderr)
            return 2
        if option in {"--verification-stop-engine-once", "--benchmark"}:
            index += 1
            continue
        if index + 1 >= len(switches):
            print(f"{option} requires a value.", file=sys.stderr)
            return 2
        value = switches[index + 1]
        if option == "--instance-type":
            if instance_type is not None:
                print("--instance-type may be specified only once.", file=sys.stderr)
                return 2
            instance_type = value
        elif option == "--build-id":
            if build_id is not None:
                print("--build-id may be specified only once.", file=sys.stderr)
                return 2
            build_id = value
        else:
            manifest_paths.append(Path(value))
        index += 2
    if benchmark_enabled and instance_type not in {"standard-2", "standard-3"}:
        print("Benchmark mode requires --instance-type standard-2 or standard-3.", file=sys.stderr)
        return 2
    if not benchmark_enabled and instance_type is not None:
        print("--instance-type is only valid with --benchmark.", file=sys.stderr)
        return 2
    if benchmark_enabled and (not build_id or not re.fullmatch(r"[0-9a-f]{32}", build_id)):
        print("Benchmark mode requires --build-id with 32 lowercase hex characters.", file=sys.stderr)
        return 2
    if benchmark_enabled and not manifest_paths:
        print("Benchmark mode requires at least one --run-manifest.", file=sys.stderr)
        return 2
    if not benchmark_enabled and (build_id is not None or manifest_paths):
        print("--build-id and --run-manifest are only valid with --benchmark.", file=sys.stderr)
        return 2
    instance_type = instance_type or "standard-2"
    if not re.fullmatch(r"[0-9a-f]{32}", account_id) or not re.fullmatch(r"[0-9a-f]{64}", image_digest):
        print("Account ID or image digest has an invalid format.", file=sys.stderr)
        return 2
    source = Path(template).read_text(encoding="utf-8")
    rendered = source.replace("__ACCOUNT_ID__", account_id).replace("__IMAGE_DIGEST__", image_digest)
    if "__ACCOUNT_ID__" in rendered or "__IMAGE_DIGEST__" in rendered:
        print("Wrangler template contains an unresolved placeholder.", file=sys.stderr)
        return 1
    config = json.loads(rendered)
    if config.get("name") != "meeshogi-analysis-mvp-staging" or config.get("name") == "meeshogi-analysis-staging":
        print("Refusing to target any Worker except the dedicated Issue 19 staging name.", file=sys.stderr)
        return 1
    worker_vars = config.get("vars", {})
    if not isinstance(worker_vars, dict):
        print("Worker vars must be a JSON object.", file=sys.stderr)
        return 1
    worker_vars.pop("ANALYSIS_VERIFY_STOP_ENGINE_ONCE", None)
    worker_vars.pop("ANALYSIS_BENCHMARK_ENABLED", None)
    worker_vars.pop("ANALYSIS_BENCHMARK_BUILD_ID", None)
    worker_vars.pop("ANALYSIS_BENCHMARK_TARGETS", None)
    worker_vars["ANALYSIS_EXPECTED_INSTANCE_TYPE"] = instance_type
    if verification_stop_once:
        worker_vars["ANALYSIS_VERIFY_STOP_ENGINE_ONCE"] = "1"
    if benchmark_enabled:
        worker_vars["ANALYSIS_BENCHMARK_ENABLED"] = "1"
        conditions_path = Path(__file__).resolve().parents[1] / "bench" / "conditions.json"
        conditions_manifest = json.loads(conditions_path.read_text(encoding="utf-8"))
        conditions = {
            row["conditionId"]: row
            for row in conditions_manifest.get("conditions", [])
            if isinstance(row, dict) and isinstance(row.get("conditionId"), str)
        }
        allowlist = [{
            "targetId": SINGLETON_TARGET_ID,
            "segmentId": "preexisting-singleton",
            "instanceType": None,
            "buildId": None,
            "purpose": "capacity-control",
        }]
        seen_target_ids = {SINGLETON_TARGET_ID}
        for manifest_path in manifest_paths:
            run_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            for target in targets_for_run(run_manifest, conditions, build_id, instance_type):
                if target["targetId"] in seen_target_ids:
                    raise ValueError(f"duplicate benchmark target ID: {target['targetId']}")
                seen_target_ids.add(target["targetId"])
                allowlist.append(target)
        if len(allowlist) > 24:
            raise ValueError("benchmark target allowlist may contain at most 24 names")
        worker_vars["ANALYSIS_BENCHMARK_BUILD_ID"] = build_id
        worker_vars["ANALYSIS_BENCHMARK_TARGETS"] = json.dumps(allowlist, separators=(",", ":"))
    if worker_vars:
        config["vars"] = worker_vars
    else:
        config.pop("vars", None)
    if not isinstance(config.get("containers"), list) or len(config["containers"]) != 1:
        print("Refusing to modify a config without exactly one staging Container.", file=sys.stderr)
        return 1
    config["containers"][0]["instance_type"] = instance_type
    config["containers"][0]["max_instances"] = 2 if benchmark_enabled else 1
    Path(output).write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, json.JSONDecodeError, ValueError, KeyError) as error:
        print(f"invalid benchmark render input: {error}", file=sys.stderr)
        raise SystemExit(2)
