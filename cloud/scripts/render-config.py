#!/usr/bin/env python3
"""Render a temporary Wrangler config with an account and pinned image digest."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


def main() -> int:
    args = sys.argv[1:]
    if len(args) < 4:
        print("usage: render-config.py TEMPLATE OUTPUT ACCOUNT_ID IMAGE_DIGEST [--verification-stop-engine-once] [--benchmark --instance-type standard-2|standard-3]", file=sys.stderr)
        return 2
    template, output, account_id, image_digest = args[:4]
    switches = args[4:]
    verification_stop_once = "--verification-stop-engine-once" in switches
    benchmark_enabled = "--benchmark" in switches
    instance_type: str | None = None
    if "--instance-type" in switches:
        index = switches.index("--instance-type")
        if index + 1 >= len(switches):
            print("--instance-type requires standard-2 or standard-3.", file=sys.stderr)
            return 2
        instance_type = switches[index + 1]
    allowed_switches = {"--verification-stop-engine-once", "--benchmark", "--instance-type", instance_type}
    if any(value not in allowed_switches for value in switches) or switches.count("--instance-type") > 1:
        print("Unknown or duplicate render option.", file=sys.stderr)
        return 2
    if benchmark_enabled and instance_type not in {"standard-2", "standard-3"}:
        print("Benchmark mode requires --instance-type standard-2 or standard-3.", file=sys.stderr)
        return 2
    if not benchmark_enabled and instance_type is not None:
        print("--instance-type is only valid with --benchmark.", file=sys.stderr)
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
    worker_vars["ANALYSIS_EXPECTED_INSTANCE_TYPE"] = instance_type
    if verification_stop_once:
        worker_vars["ANALYSIS_VERIFY_STOP_ENGINE_ONCE"] = "1"
    if benchmark_enabled:
        worker_vars["ANALYSIS_BENCHMARK_ENABLED"] = "1"
    if worker_vars:
        config["vars"] = worker_vars
    else:
        config.pop("vars", None)
    if not isinstance(config.get("containers"), list) or len(config["containers"]) != 1:
        print("Refusing to modify a config without exactly one staging Container.", file=sys.stderr)
        return 1
    config["containers"][0]["instance_type"] = instance_type
    Path(output).write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
