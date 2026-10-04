#!/usr/bin/env python3
"""Render a temporary Wrangler config with an account and pinned image digest."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bench"))
from targeting import NORMAL_CONTAINER_TARGET, SINGLETON_TARGET_ID, targets_for_run  # noqa: E402


def main() -> int:
    args = sys.argv[1:]
    if len(args) < 4:
        print("usage: render-config.py TEMPLATE OUTPUT ACCOUNT_ID IMAGE_DIGEST [--d1-database-id D1_ID] [--verification-stop-engine-once] [--benchmark --build-id BUILD_ID --run-manifest FILE ...]", file=sys.stderr)
        return 2
    template, output, account_id, image_digest = args[:4]
    switches = args[4:]
    verification_stop_once = "--verification-stop-engine-once" in switches
    benchmark_enabled = "--benchmark" in switches
    build_id: str | None = None
    d1_database_id: str | None = None
    manifest_paths: list[Path] = []
    allowed_switches = {"--verification-stop-engine-once", "--benchmark", "--build-id", "--run-manifest", "--d1-database-id"}
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
        if option == "--build-id":
            if build_id is not None:
                print("--build-id may be specified only once.", file=sys.stderr)
                return 2
            build_id = value
        elif option == "--d1-database-id":
            if d1_database_id is not None:
                print("--d1-database-id may be specified only once.", file=sys.stderr)
                return 2
            d1_database_id = value
        else:
            manifest_paths.append(Path(value))
        index += 2
    if benchmark_enabled and (not build_id or not re.fullmatch(r"[0-9a-f]{32}", build_id)):
        print("Benchmark mode requires --build-id with 32 lowercase hex characters.", file=sys.stderr)
        return 2
    if benchmark_enabled and not manifest_paths:
        print("Benchmark mode requires at least one --run-manifest.", file=sys.stderr)
        return 2
    if not benchmark_enabled and manifest_paths:
        print("--run-manifest is only valid with --benchmark.", file=sys.stderr)
        return 2
    if not benchmark_enabled and build_id is not None:
        print("--build-id is only valid with --benchmark.", file=sys.stderr)
        return 2
    if d1_database_id is not None and not re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", d1_database_id
    ):
        print("--d1-database-id must be a D1 database UUID.", file=sys.stderr)
        return 2
    if not re.fullmatch(r"[0-9a-f]{32}", account_id) or not re.fullmatch(r"[0-9a-f]{64}", image_digest):
        print("Account ID or image digest has an invalid format.", file=sys.stderr)
        return 2
    source = Path(template).read_text(encoding="utf-8")
    rendered = source.replace("__ACCOUNT_ID__", account_id).replace("__IMAGE_DIGEST__", image_digest)
    if d1_database_id is not None:
        rendered = rendered.replace("__D1_DATABASE_ID__", d1_database_id)
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
    worker_vars["ANALYSIS_EXPECTED_INSTANCE_TYPE"] = "standard-2"
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
            **NORMAL_CONTAINER_TARGET,
        }]
        seen_target_ids = {SINGLETON_TARGET_ID}
        for manifest_path in manifest_paths:
            run_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            for target in targets_for_run(run_manifest, conditions, build_id):
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
    fixed_containers = {
        ("meeshogi-analysis-mvp-staging-analysis", "AnalysisContainer", "standard-2"),
        ("meeshogi-analysis-mvp-staging-benchmark-standard-2", "BenchmarkStandard2Container", "standard-2"),
        ("meeshogi-analysis-mvp-staging-benchmark-standard-3", "BenchmarkStandard3Container", "standard-3"),
        ("meeshogi-analysis-mvp-staging-job-free", "FreeJobContainer", "standard-2"),
        ("meeshogi-analysis-mvp-staging-job-precision", "PrecisionJobContainer", "standard-3"),
    }
    containers = config.get("containers")
    if not isinstance(containers, list) or len(containers) != len(fixed_containers):
        print("Refusing to modify a config without the normal, benchmark, and two job Containers.", file=sys.stderr)
        return 1
    rendered_container_specs = {
        (row.get("name"), row.get("class_name"), row.get("instance_type"))
        for row in containers if isinstance(row, dict)
    }
    if rendered_container_specs != fixed_containers:
        print("Refusing to modify a config whose Container apps are not fixed to their class instance types.", file=sys.stderr)
        return 1

    profiles_path = Path(template).resolve().parent / "config" / "job-profiles.json"
    profiles_manifest = json.loads(profiles_path.read_text(encoding="utf-8"))
    profiles = profiles_manifest.get("profiles")
    if not isinstance(profiles, dict) or set(profiles) != {"free", "precision"}:
        raise ValueError("job-profiles.json must define exactly free and precision profiles")
    profile_rows: dict[str, dict[str, object]] = {}
    for profile_id in ("free", "precision"):
        row = profiles[profile_id]
        if not isinstance(row, dict) or type(row.get("maxConcurrentJobs")) is not int or not 1 <= row["maxConcurrentJobs"] <= 250:
            raise ValueError(f"job-profiles.json profile {profile_id} has invalid maxConcurrentJobs")
        if not isinstance(row.get("queueName"), str) or not isinstance(row.get("deadLetterQueueName"), str):
            raise ValueError(f"job-profiles.json profile {profile_id} has invalid queue names")
        profile_rows[profile_id] = row

    app_for_profile = {
        "free": ("meeshogi-analysis-mvp-staging-job-free", "FreeJobContainer"),
        "precision": ("meeshogi-analysis-mvp-staging-job-precision", "PrecisionJobContainer"),
    }
    for profile_id, (app_name, class_name) in app_for_profile.items():
        row = next(row for row in containers if row.get("name") == app_name and row.get("class_name") == class_name)
        row["max_instances"] = profile_rows[profile_id]["maxConcurrentJobs"]
    for row in containers:
        if row.get("class_name") not in {"FreeJobContainer", "PrecisionJobContainer"}:
            if row.get("max_instances") != 1:
                print("Refusing to change the existing normal or benchmark Container instance cap.", file=sys.stderr)
                return 1

    queues = config.get("queues")
    if not isinstance(queues, dict):
        raise ValueError("queues must be an object")
    producers, consumers = queues.get("producers"), queues.get("consumers")
    expected_queue_bindings = {
        profile_rows["free"]["queueName"]: "JOBS_FREE_QUEUE",
        profile_rows["precision"]["queueName"]: "JOBS_PRECISION_QUEUE",
    }
    if not isinstance(producers, list) or len(producers) != 2:
        raise ValueError("expected exactly two job Queue producers")
    if {(row.get("queue"), row.get("binding")) for row in producers if isinstance(row, dict)} != set(expected_queue_bindings.items()):
        raise ValueError("job Queue producers do not match job-profiles.json")
    if not isinstance(consumers, list) or len(consumers) != 2:
        raise ValueError("expected exactly two job Queue consumers")
    consumers_by_queue = {row.get("queue"): row for row in consumers if isinstance(row, dict)}
    if set(consumers_by_queue) != set(expected_queue_bindings):
        raise ValueError("job Queue consumers do not match job-profiles.json")
    for profile_id, profile in profile_rows.items():
        consumer = consumers_by_queue[profile["queueName"]]
        if consumer.get("dead_letter_queue") != profile["deadLetterQueueName"]:
            raise ValueError(f"{profile_id} dead-letter queue does not match job-profiles.json")
        consumer["max_concurrency"] = profile["maxConcurrentJobs"]
    for profile_id, (app_name, _) in app_for_profile.items():
        app = next(row for row in containers if row.get("name") == app_name)
        concurrency = consumers_by_queue[profile_rows[profile_id]["queueName"]]["max_concurrency"]
        if app["max_instances"] != concurrency:
            raise ValueError(f"{profile_id} Container and Queue concurrency differ")
    Path(output).write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, json.JSONDecodeError, ValueError, KeyError) as error:
        print(f"invalid benchmark render input: {error}", file=sys.stderr)
        raise SystemExit(2)
