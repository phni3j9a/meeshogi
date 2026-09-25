#!/usr/bin/env python3
"""Serial, resumable operator runner for the Issue 20 benchmark endpoint."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
DEFAULT_CONDITIONS = HERE / "conditions.json"
DEFAULT_POSITIONS = HERE / "dataset" / "positions.json"
DEFAULT_GAME = HERE / "dataset" / "game.json"
USER_AGENT = "meeshogi-issue20-benchmark/1.0"
MAX_RESPONSE_BYTES = 1_048_576


def wall_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def load_conditions(path: Path) -> dict[str, dict[str, Any]]:
    manifest = load_json(path)
    if manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("conditions"), list):
        raise ValueError("invalid benchmark conditions manifest")
    result: dict[str, dict[str, Any]] = {}
    for condition in manifest["conditions"]:
        if not isinstance(condition, dict) or not isinstance(condition.get("conditionId"), str):
            raise ValueError("invalid condition row")
        if condition["conditionId"] in result:
            raise ValueError("duplicate conditionId in conditions manifest")
        result[condition["conditionId"]] = condition
    return result


def load_positions(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    dataset = load_json(path)
    rows = dataset.get("positions")
    if dataset.get("schemaVersion") != 1 or not isinstance(rows, list) or not isinstance(dataset.get("manifestSha256"), str):
        raise ValueError("invalid positions dataset")
    positions: list[dict[str, Any]] = []
    seen: set[str] = set()
    seen_keys: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("invalid dataset position")
        position_id, phase, sfen, expected_hash = row.get("id"), row.get("phase"), row.get("sfen"), row.get("sha256")
        if not all(isinstance(item, str) and item for item in (position_id, sfen, expected_hash)):
            raise ValueError("dataset position must have id, sfen, and sha256")
        if phase not in {"opening", "middlegame", "endgame"}:
            raise ValueError(f"invalid phase for {position_id}")
        if sha256_text(sfen) != expected_hash:
            raise ValueError(f"SFEN hash mismatch for {position_id}")
        sfen_key = row.get("sfenKey")
        if not isinstance(sfen_key, str) or sfen_key != " ".join(sfen.split(" ")[:3]):
            raise ValueError(f"SFEN key mismatch for {position_id}")
        if sfen_key in seen_keys:
            raise ValueError(f"duplicate SFEN position key: {position_id}")
        if position_id in seen:
            raise ValueError(f"duplicate position ID: {position_id}")
        seen.add(position_id)
        seen_keys.add(sfen_key)
        positions.append({"id": position_id, "phase": phase, "sfen": sfen, "sha256": expected_hash, "source": row.get("source")})
    if not positions:
        raise ValueError("positions dataset is empty")
    return dataset, positions


def load_game(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    game = load_json(path)
    rows = game.get("positions")
    if game.get("schemaVersion") != 1 or not isinstance(rows, list) or not isinstance(game.get("manifestSha256"), str):
        raise ValueError("invalid game dataset")
    positions: list[dict[str, Any]] = []
    last_ply: int | None = None
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("invalid game position")
        ply, sfen, expected_hash = row.get("ply"), row.get("sfen"), row.get("sha256")
        if (
            type(ply) is not int
            or (last_ply is not None and ply <= last_ply)
            or not isinstance(sfen, str)
            or not isinstance(expected_hash, str)
        ):
            raise ValueError("game positions must have increasing ply, SFEN, and hash")
        if sha256_text(sfen) != expected_hash:
            raise ValueError(f"SFEN hash mismatch at ply {ply}")
        last_ply = ply
        positions.append({"id": f"ply-{ply}", "ply": ply, "phase": None, "sfen": sfen, "sha256": expected_hash, "source": None})
    if not positions:
        raise ValueError("game dataset is empty")
    if game.get("plies") != len(positions):
        raise ValueError("game position count does not match plies")
    return game, positions


def safe_health(payload: dict[str, Any] | None, http_status: int | None, elapsed_ms: int | None) -> dict[str, Any]:
    payload = payload or {}
    runtime = payload.get("runtime")
    runtime_record = runtime if isinstance(runtime, dict) else {}
    return {
        "httpStatus": http_status,
        "elapsedMs": elapsed_ms,
        "status": payload.get("status") if isinstance(payload.get("status"), str) else None,
        "driverBootId": payload.get("driverBootId") if isinstance(payload.get("driverBootId"), str) else None,
        "driverVersion": payload.get("driverVersion") if isinstance(payload.get("driverVersion"), str) else None,
        "contractVersion": payload.get("contractVersion") if isinstance(payload.get("contractVersion"), str) else None,
        "expectedInstanceType": payload.get("expectedInstanceType") if isinstance(payload.get("expectedInstanceType"), str) else None,
        "workerExpectedInstanceType": payload.get("workerExpectedInstanceType") if isinstance(payload.get("workerExpectedInstanceType"), str) else None,
        "workerBenchmarkEnabled": payload.get("workerBenchmarkEnabled") if isinstance(payload.get("workerBenchmarkEnabled"), bool) else None,
        "runtime": {
            key: runtime_record.get(key)
            for key in ("osCpuCount", "affinityCpuCount", "cpuMax", "cpuQuota", "memoryMaxBytes")
        },
    }


def request_json(
    url: str,
    token: str,
    method: str,
    body: dict[str, Any] | None = None,
    timeout: float = 30,
) -> tuple[int | None, dict[str, Any] | None, int | None, str | None]:
    data = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
    headers = {"Authorization": "Bearer " + token, "User-Agent": USER_AGENT}
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = response.status
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        status = error.code
        try:
            raw = error.read(MAX_RESPONSE_BYTES + 1)
        except Exception:
            raw = b""
    except Exception as error:  # Store only the class name; exception text may contain request details.
        return None, None, max(0, round((time.monotonic() - started) * 1000)), type(error).__name__
    elapsed_ms = max(0, round((time.monotonic() - started) * 1000))
    if len(raw) > MAX_RESPONSE_BYTES:
        return status, None, elapsed_ms, "response_too_large"
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return status, None, elapsed_ms, "non_json_response"
    return status, payload if isinstance(payload, dict) else None, elapsed_ms, None


def read_existing(path: Path, run_id: str) -> set[tuple[str, str, str, int]]:
    completed: set[tuple[str, str, str, int]] = set()
    if not path.exists():
        return completed
    with path.open("r", encoding="utf-8") as stream:
        for line in stream:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if record.get("recordType") != "attempt" or record.get("runId") != run_id:
                continue
            completed.add((record.get("mode", ""), record.get("conditionId", ""), record.get("positionId", ""), record.get("attemptNo", 0)))
    return completed


def append_record(stream, record: dict[str, Any]) -> None:
    stream.write(json.dumps(record, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
    stream.flush()


def persist_pending(path: Path, record: dict[str, Any]) -> None:
    temporary = path.with_name(path.name + f".tmp-{os.getpid()}")
    with temporary.open("w", encoding="utf-8") as stream:
        stream.write(json.dumps(record, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def recover_pending(raw_path: Path, pending_path: Path) -> bool:
    if not pending_path.exists():
        return False
    pending = load_json(pending_path)
    pending_key = (pending.get("mode", ""), pending.get("conditionId", ""), pending.get("positionId", ""), pending.get("attemptNo", 0))
    previous = read_existing(raw_path, pending.get("runId", ""))
    if pending_key not in previous:
        pending.update({
            "recordType": "attempt",
            "requestEndWall": None,
            "httpElapsedMs": None,
            "httpStatus": None,
            "transportError": "interrupted-before-response",
            "response": None,
            "coldEvidence": None,
            "healthAfterCold": None,
        })
        with raw_path.open("a", encoding="utf-8") as stream:
            append_record(stream, pending)
    pending_path.unlink()
    return True


def health_snapshot(base_url: str, token: str, timeout: float = 15) -> dict[str, Any]:
    start_wall = wall_now()
    status, payload, elapsed, error = request_json(base_url.rstrip("/") + "/internal/health", token, "GET", timeout=timeout)
    result = safe_health(payload, status, elapsed)
    result["requestStartWall"] = start_wall
    result["requestEndWall"] = wall_now()
    if error:
        result["error"] = error
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path, help="run manifest JSON")
    parser.add_argument("--conditions", type=Path, default=DEFAULT_CONDITIONS)
    parser.add_argument("--dataset", type=Path, help="positions.json or game.json; inferred from mode when omitted")
    parser.add_argument("--base-url", default=os.environ.get("ANALYSIS_STAGING_URL"))
    parser.add_argument("--output", required=True, type=Path, help="append-only raw JSONL path")
    args = parser.parse_args()

    token = os.environ.get("ANALYSIS_INTERNAL_TOKEN")
    if not token:
        parser.error("ANALYSIS_INTERNAL_TOKEN is required in the environment")
    if not args.base_url:
        parser.error("--base-url or ANALYSIS_STAGING_URL is required")
    try:
        run = load_json(args.manifest)
        if run.get("schemaVersion") != 1 or not isinstance(run.get("runId"), str) or not run["runId"]:
            raise ValueError("run manifest requires schemaVersion 1 and a non-empty runId")
        mode = run.get("mode")
        if mode not in {"positions", "game", "cold"}:
            raise ValueError("run mode must be positions, game, or cold")
        condition_ids = run.get("conditionIds")
        if not isinstance(condition_ids, list) or not condition_ids or any(not isinstance(item, str) for item in condition_ids):
            raise ValueError("run manifest requires conditionIds")
        if len(set(condition_ids)) != len(condition_ids):
            raise ValueError("conditionIds must not contain duplicates")
        conditions = load_conditions(args.conditions)
        selected_conditions = [conditions[item] for item in condition_ids]
        repetitions = run.get("repetitions", 1)
        if isinstance(repetitions, bool) or not isinstance(repetitions, (int, dict)):
            raise ValueError("repetitions must be an integer or conditionId-to-count object")
        for condition in selected_conditions:
            count = repetitions.get(condition["conditionId"], 1) if isinstance(repetitions, dict) else repetitions
            if isinstance(count, bool) or not isinstance(count, int) or count < 1:
                raise ValueError("each repetition count must be a positive integer")
        attempt_start = run.get("attemptNoStart", 1)
        if isinstance(attempt_start, bool) or not isinstance(attempt_start, (int, dict)):
            raise ValueError("attemptNoStart must be an integer or conditionId-to-integer object")
        for condition in selected_conditions:
            first = attempt_start.get(condition["conditionId"], 1) if isinstance(attempt_start, dict) else attempt_start
            if isinstance(first, bool) or not isinstance(first, int) or first < 1:
                raise ValueError("each attemptNoStart must be a positive integer")
        dataset_path = args.dataset or (DEFAULT_GAME if mode == "game" else DEFAULT_POSITIONS)
        if mode == "game":
            dataset, positions = load_game(dataset_path)
        else:
            dataset, positions = load_positions(dataset_path)
        position_ids = run.get("positionIds")
        if position_ids is not None:
            if not isinstance(position_ids, list) or any(not isinstance(item, str) for item in position_ids):
                raise ValueError("positionIds must be a list of IDs")
            selected = set(position_ids)
            positions = [row for row in positions if row["id"] in selected]
            if len(positions) != len(selected):
                raise ValueError("positionIds contains an unknown dataset ID")
        position_limit = run.get("positionLimit")
        if position_limit is not None:
            if isinstance(position_limit, bool) or not isinstance(position_limit, int) or position_limit < 1:
                raise ValueError("positionLimit must be a positive integer")
            positions = positions[:position_limit]
        if mode == "cold" and not positions:
            raise ValueError("cold mode needs at least one position")
        if not positions:
            raise ValueError("no positions selected")
        if mode == "cold":
            instances = {condition["instanceType"] for condition in selected_conditions}
            if len(instances) != len(selected_conditions):
                raise ValueError("cold conditions must not repeat an instance type; use unique conditions per type")
            sleep_after = run.get("sleepAfterSeconds", 300)
            idle_seconds = run.get("idleSeconds")
            if not isinstance(sleep_after, int) or not isinstance(idle_seconds, int) or idle_seconds <= sleep_after:
                raise ValueError("cold mode requires integer idleSeconds greater than sleepAfterSeconds")
        else:
            sleep_after = run.get("sleepAfterSeconds", 300)
            idle_seconds = None
        max_requests = run.get("maxRequests", 5000)
        time_budget_seconds = run.get("timeBudgetSeconds", 21600)
        if isinstance(max_requests, bool) or not isinstance(max_requests, int) or max_requests < 1:
            raise ValueError("maxRequests must be a positive integer")
        if isinstance(time_budget_seconds, bool) or not isinstance(time_budget_seconds, int) or time_budget_seconds < 1:
            raise ValueError("timeBudgetSeconds must be a positive integer")
        seed = run.get("orderSeed", 0)
        if isinstance(seed, bool) or not isinstance(seed, int):
            raise ValueError("orderSeed must be an integer")
    except (OSError, json.JSONDecodeError, ValueError, KeyError) as error:
        print(f"invalid benchmark input: {error}", file=sys.stderr)
        return 2

    args.output.parent.mkdir(parents=True, exist_ok=True)
    pending_path = args.output.with_name(args.output.name + ".pending.json")
    if pending_path.exists():
        try:
            recover_pending(args.output, pending_path)
        except (OSError, json.JSONDecodeError, ValueError) as error:
            print(f"cannot recover pending attempt: {type(error).__name__}", file=sys.stderr)
            return 2
    completed = read_existing(args.output, run["runId"])
    run_started = time.monotonic()
    total_requests = len(completed)
    schedule: list[tuple[dict[str, Any], dict[str, Any], int]] = []
    for condition in selected_conditions:
        repeat_count = repetitions.get(condition["conditionId"], 1) if isinstance(repetitions, dict) else repetitions
        first_attempt = attempt_start.get(condition["conditionId"], 1) if isinstance(attempt_start, dict) else attempt_start
        chosen_positions = positions[:1] if mode == "cold" else positions
        for attempt_no in range(first_attempt, first_attempt + repeat_count):
            for position in chosen_positions:
                schedule.append((condition, position, attempt_no))
    if mode == "game":
        groups = []
        for condition in selected_conditions:
            repeat_count = repetitions.get(condition["conditionId"], 1) if isinstance(repetitions, dict) else repetitions
            first_attempt = attempt_start.get(condition["conditionId"], 1) if isinstance(attempt_start, dict) else attempt_start
            groups.extend((condition, None, attempt_no) for attempt_no in range(first_attempt, first_attempt + repeat_count))
        random.Random(seed).shuffle(groups)
        schedule = [
            (condition, position, attempt_no)
            for condition, _unused, attempt_no in groups
            for position in positions
        ]
    else:
        random.Random(seed).shuffle(schedule)
    game_groups: dict[str, list[dict[str, Any]]] = {}
    game_started_monotonic: dict[str, float] = {}
    game_resumed: set[str] = set()
    run_start_health = None if mode == "cold" else health_snapshot(args.base_url, token)
    latest_health = run_start_health
    since_health = 0
    with args.output.open("a", encoding="utf-8") as stream:
        for condition, position, attempt_no in schedule:
            key = (mode, condition["conditionId"], position["id"], attempt_no)
            if key in completed:
                if mode == "game":
                    game_resumed.add(f"{condition['conditionId']}#rep{attempt_no}")
                continue
            if total_requests >= max_requests or time.monotonic() - run_started >= time_budget_seconds:
                print("stopped at run manifest limit; remaining attempts are resumable", file=sys.stderr)
                break
            cold_before = None
            if mode == "cold":
                cold_before = health_snapshot(args.base_url, token)
                idle_started = wall_now()
                sleep_for = max(idle_seconds or 0, sleep_after + 1)
                if time.monotonic() - run_started + sleep_for >= time_budget_seconds:
                    print("cold idle wait would exceed the time budget; remaining attempts are resumable", file=sys.stderr)
                    break
                time.sleep(sleep_for)
                cold_idle = {"startedWall": idle_started, "seconds": sleep_for, "requiredSleepAfterSeconds": sleep_after, "noRequestsDuringWait": True}
            else:
                cold_idle = None
                if since_health >= int(run.get("healthEveryRequests", 10)):
                    latest_health = health_snapshot(args.base_url, token)
                    since_health = 0
            request_start = wall_now()
            started_mono = time.monotonic()
            group_id = f"{condition['conditionId']}#rep{attempt_no}" if mode == "game" else None
            pending_attempt = {
                "recordType": "pending",
                "runId": run["runId"],
                "mode": mode,
                "comparisonRole": run.get("comparisonRole", "primary"),
                "attemptNo": attempt_no,
                "conditionId": condition["conditionId"],
                "condition": condition,
                "positionId": position["id"],
                "positionSha256": position["sha256"],
                "phase": position["phase"],
                "ply": position.get("ply"),
                "datasetManifestSha256": dataset["manifestSha256"],
                "requestStartWall": request_start,
                "gameAttemptId": group_id,
                "gameSequence": position.get("ply"),
                "gamePositionCount": len(positions) if mode == "game" else None,
                "coldIdle": cold_idle,
                "healthBeforeCold": cold_before,
                "healthAtRunStart": run_start_health,
                "healthSnapshot": latest_health,
                "sleepAfterSeconds": sleep_after,
            }
            persist_pending(pending_path, pending_attempt)
            timeout = max(60, condition["moveTimeMs"] / 1000 + 45)
            status, response, elapsed_ms, error = request_json(
                args.base_url.rstrip("/") + "/internal/benchmark",
                token,
                "POST",
                {"sfen": position["sfen"], "conditionId": condition["conditionId"]},
                timeout=timeout,
            )
            request_end = wall_now()
            if error is None and elapsed_ms is not None:
                error = None
            cold_after = health_snapshot(args.base_url, token) if mode == "cold" else None
            before_id = cold_before.get("driverBootId") if cold_before else None
            after_id = cold_after.get("driverBootId") if cold_after else None
            cold_evidence = None if mode != "cold" else {
                "bootIdBeforeIdle": before_id,
                "bootIdAfterAttempt": after_id,
                "bootChanged": bool(before_id and after_id and before_id != after_id),
                "idleExceededSleepAfter": bool(cold_idle and cold_idle["seconds"] > cold_idle["requiredSleepAfterSeconds"]),
            }
            record = {
                "recordType": "attempt",
                "runId": run["runId"],
                "mode": mode,
                "comparisonRole": run.get("comparisonRole", "primary"),
                "attemptNo": attempt_no,
                "conditionId": condition["conditionId"],
                "condition": condition,
                "positionId": position["id"],
                "positionSha256": position["sha256"],
                "phase": position["phase"],
                "ply": position.get("ply"),
                "datasetManifestSha256": dataset["manifestSha256"],
                "requestStartWall": request_start,
                "requestEndWall": request_end,
                "httpElapsedMs": elapsed_ms,
                "sleepAfterSeconds": sleep_after,
                "httpStatus": status,
                "transportError": error,
                "response": response,
                "healthAtRunStart": run_start_health,
                "healthSnapshot": latest_health,
                "healthBeforeCold": cold_before,
                "coldIdle": cold_idle,
                "coldEvidence": cold_evidence,
                "healthAfterCold": cold_after,
                "gameAttemptId": group_id,
                "gameSequence": position.get("ply"),
                "gamePositionCount": len(positions) if mode == "game" else None,
            }
            if mode == "game":
                game_groups.setdefault(group_id or "", []).append(record)
                game_started_monotonic.setdefault(group_id or "", started_mono)
            append_record(stream, record)
            pending_path.unlink(missing_ok=True)
            completed.add(key)
            total_requests += 1
            since_health += 1
            if mode == "game" and position is positions[-1]:
                group_records = game_groups.get(group_id or "", [])
                wall_ms = None if group_id in game_resumed else max(
                    0,
                    round((time.monotonic() - game_started_monotonic.get(group_id or "", time.monotonic())) * 1000),
                )
                completed_count = sum(
                    (mode, condition["conditionId"], item["id"], attempt_no) in completed for item in positions
                )
                append_record(stream, {
                    "recordType": "game-summary",
                    "runId": run["runId"],
                    "conditionId": condition["conditionId"],
                    "gameAttemptId": group_id,
                    "positionCount": completed_count,
                    "gameWallMs": wall_ms,
                    "complete": completed_count == len(positions),
                    "resumed": group_id in game_resumed,
                    "startedWall": group_records[0]["requestStartWall"] if group_records else None,
                    "endedWall": request_end,
                })
            print(json.dumps({"conditionId": condition["conditionId"], "positionId": position["id"], "attemptNo": attempt_no, "httpStatus": status, "elapsedMs": elapsed_ms}, separators=(",", ":")), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
