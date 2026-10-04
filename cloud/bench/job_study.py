#!/usr/bin/env python3
"""Issue #46: measure candidate Free / Precision profiles through the public job API.

`run` analyzes the Issue #20 positions (one job per position) and the benchmark game
(one job per repetition) with whatever profile staging currently serves, and appends
JSONL rows. `compare` scores those rows against the Issue #20 reference attempts.
Standard library only; the anonymous credential stays in memory.
"""
from __future__ import annotations

import argparse
import json
import lzma
import os
import statistics
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

BENCH_DIR = Path(__file__).resolve().parent
POSITIONS_PATH = BENCH_DIR / "dataset" / "positions.json"
GAME_MOVES_PATH = BENCH_DIR / "dataset" / "game-moves.json"
ISSUE20_RAW = BENCH_DIR / "results" / "issue-20" / "raw-issue20.jsonl.xz"
REFERENCE_ID = "reference-standard-3-t2-10000ms-mpv3"
USER_AGENT = "meeshogi-job-study/1"
POLL_SECONDS = 0.5
JOB_TIMEOUT_SECONDS = 3600
PHASES = ("opening", "middlegame", "endgame")


def api(
    base: str,
    method: str,
    path: str,
    credential: str | None,
    body: Any | None,
    *,
    internal_token: str | None = None,
) -> tuple[int, dict[str, Any]]:
    headers = {"User-Agent": USER_AGENT}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    if credential:
        headers["Authorization"] = f"Bearer {credential}"
    elif internal_token:
        headers["Authorization"] = f"Bearer {internal_token}"
    request = urllib.request.Request(base.rstrip("/") + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        try:
            return error.code, json.loads(error.read() or b"{}")
        except json.JSONDecodeError:
            return error.code, {}


def run_job(base: str, profile: str, key: str, initial_sfen: str, moves: list[str], internal_token: str) -> dict[str, Any]:
    credential_status, credential_body = api(base, "POST", "/v1/credentials", None, {})
    if credential_status != 201 or not isinstance(credential_body.get("credential"), str):
        raise RuntimeError(f"credential issuance failed: HTTP {credential_status} {credential_body!r}")
    credential = credential_body["credential"]
    started = time.monotonic()
    status, body = api(base, "POST", "/v1/jobs", credential, {
        "idempotencyKey": key, "profileId": profile, "initialSfen": initial_sfen, "moves": moves,
    })
    if status not in (200, 201) or not isinstance(body.get("jobId"), str):
        raise RuntimeError(f"job creation failed: HTTP {status} {body!r}")
    job_id = body["jobId"]
    first_result_ms = None
    while True:
        if time.monotonic() - started > JOB_TIMEOUT_SECONDS:
            raise RuntimeError(f"job {job_id} timed out")
        status, view = api(base, "GET", f"/v1/jobs/{job_id}", credential, None)
        if status != 200:
            raise RuntimeError(f"job status failed: HTTP {status} {view!r}")
        if first_result_ms is None and isinstance(view.get("analyzedPlies"), int) and view["analyzedPlies"] > 0:
            first_result_ms = round((time.monotonic() - started) * 1000)
        if view.get("status") in ("completed", "failed", "cancelled"):
            break
        time.sleep(POLL_SECONDS)
    terminal_ms = round((time.monotonic() - started) * 1000)
    terminal_at = datetime.now(timezone.utc).isoformat()
    stop_confirmed_at = None
    terminal_to_stop_ms = None
    stop_view: dict[str, Any] | None = None
    stop_deadline = time.monotonic() + 60
    while time.monotonic() < stop_deadline:
        state_status, state = api(
            base, "GET", f"/internal/jobs/{job_id}/container", None, None,
            internal_token=internal_token,
        )
        if state_status != 200:
            raise RuntimeError(f"job Container state failed: HTTP {state_status} {state!r}")
        stop_view = state
        container_state = state.get("containerState")
        if isinstance(container_state, dict) and container_state.get("status") in {"stopped", "stopped_with_code"}:
            stop_confirmed_at = datetime.now(timezone.utc).isoformat()
            terminal_to_stop_ms = round((time.monotonic() - started) * 1000) - terminal_ms
            break
        time.sleep(POLL_SECONDS)
    results: list[dict[str, Any]] = []
    after = -1
    while view.get("status") == "completed":
        status, page = api(base, "GET", f"/v1/jobs/{job_id}/results?afterPly={after}&limit=200", credential, None)
        if status != 200:
            raise RuntimeError(f"results failed: HTTP {status} {page!r}")
        results.extend(page.get("results", []))
        if not page.get("hasMore"):
            break
        after = int(page["nextAfterPly"])
    return {
        "jobId": job_id, "jobStatus": view.get("status"), "failure": view.get("failure"),
        "wallMs": terminal_ms, "firstResultMs": first_result_ms,
        "postToFirstResultMs": first_result_ms, "postToCompleteMs": terminal_ms,
        "terminalAt": terminal_at, "containerStopConfirmedAt": stop_confirmed_at,
        "postToContainerStopConfirmedMs": (terminal_ms + terminal_to_stop_ms) if terminal_to_stop_ms is not None else None,
        "terminalToContainerStopConfirmedMs": terminal_to_stop_ms,
        "containerStopConfirmed": stop_confirmed_at is not None,
        "containerState": stop_view.get("containerState") if stop_view else None,
        "results": results,
    }


def requested_conditions(job: dict[str, Any]) -> dict[str, Any] | None:
    for row in job["results"]:
        conditions = row.get("result", {}).get("conditions", {})
        if isinstance(conditions.get("requested"), dict):
            return conditions["requested"]
    return None


def command_run(args: argparse.Namespace) -> int:
    base = args.base_url or os.environ.get("ANALYSIS_STAGING_URL")
    if not base:
        print("Set ANALYSIS_STAGING_URL or pass --base-url.", file=sys.stderr)
        return 2
    internal_token = os.environ.get("ANALYSIS_INTERNAL_TOKEN")
    if not internal_token:
        print("Set ANALYSIS_INTERNAL_TOKEN to record job Container stop confirmation.", file=sys.stderr)
        return 2
    if args.parallel_jobs < 1:
        print("--parallel-jobs must be at least 1.", file=sys.stderr)
        return 2
    stamp = time.strftime("%Y%m%dT%H%M%S")
    output = Path(args.output)

    def emit(row: dict[str, Any]) -> None:
        with output.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")

    positions = json.loads(POSITIONS_PATH.read_text(encoding="utf-8"))["positions"]
    game = json.loads(GAME_MOVES_PATH.read_text(encoding="utf-8"))
    tasks: list[dict[str, Any]] = []
    if args.mode in ("positions", "both"):
        tasks.extend({
            "recordType": "position", "key": position["id"], "initialSfen": position["sfen"], "moves": [],
            "position": position,
        } for position in positions)
    if args.mode in ("game", "both"):
        for repetition in range(1, args.game_repetitions + 1):
            tasks.append({
                "recordType": "game", "key": f"game-{repetition}",
                "initialSfen": game["initialSfen"], "moves": game["moves"], "repetition": repetition,
            })

    def run_one(index: int, task: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        profile = ("free" if index % 2 == 0 else "precision") if args.profile == "mixed" else args.profile
        job = run_job(
            base, profile, f"{args.label}-{stamp}-{task['key']}",
            task["initialSfen"], task["moves"], internal_token,
        )
        served = requested_conditions(job)
        if args.expect_movetime and served and served.get("moveTimeMs") != args.expect_movetime:
            raise RuntimeError(
                f"job {job['jobId']} serves moveTimeMs={served.get('moveTimeMs')}, expected {args.expect_movetime}"
            )
        row = {
            "recordType": task["recordType"], "label": args.label, "profile": profile,
            "conditions": served, "jobId": job["jobId"], "jobStatus": job["jobStatus"],
            "failure": job["failure"], "wallMs": job["wallMs"],
            "postToFirstResultMs": job["postToFirstResultMs"],
            "postToCompleteMs": job["postToCompleteMs"],
            "terminalAt": job["terminalAt"],
            "containerStopConfirmedAt": job["containerStopConfirmedAt"],
            "postToContainerStopConfirmedMs": job["postToContainerStopConfirmedMs"],
            "terminalToContainerStopConfirmedMs": job["terminalToContainerStopConfirmedMs"],
            "containerStopConfirmed": job["containerStopConfirmed"],
            "containerState": job["containerState"],
        }
        if task["recordType"] == "position":
            position = task["position"]
            row.update({
                "positionId": position["id"], "phase": position["phase"],
                "positionSha256": position["sha256"],
                "result": job["results"][0]["result"] if job["results"] else None,
            })
        else:
            statuses = [result.get("result", {}).get("status") for result in job["results"]]
            row.update({
                "repetition": task["repetition"], "firstResultMs": job["firstResultMs"],
                "positions": len(job["results"]),
                "statusCounts": {status: statuses.count(status) for status in sorted(set(map(str, statuses)))},
            })
        return index, row

    with ThreadPoolExecutor(max_workers=max(args.parallel_jobs, 1)) as pool:
        futures = [pool.submit(run_one, index, task) for index, task in enumerate(tasks)]
        completed = sorted((future.result() for future in as_completed(futures)), key=lambda item: item[0])
    for index, row in completed:
        emit(row)
        print(f"  [{index + 1}/{len(tasks)}] {row['recordType']} {row.get('positionId', row.get('repetition'))} "
              f"profile={row['profile']} {row['jobStatus']} post→complete={row['postToCompleteMs']} ms "
              f"post→stopped={row['postToContainerStopConfirmedMs']}")
        if not row["containerStopConfirmed"]:
            print(f"  WARNING: job {row['jobId']} did not report a stopped Container within 60s.", file=sys.stderr)
    return 0


def quantile(values: list[float], probability: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def load_issue20() -> dict[tuple[str, int], dict[str, Any]]:
    """Issue #20 attempts keyed by (conditionId:positionId, attemptNo), positions mode only."""
    rows: dict[tuple[str, int], dict[str, Any]] = {}
    with lzma.open(ISSUE20_RAW, "rt", encoding="utf-8") as handle:
        for line in handle:
            row = json.loads(line)
            if row.get("recordType") != "attempt" or row.get("mode", "positions") != "positions":
                continue
            if row.get("comparisonRole") == "pilot":
                continue
            rows[(f"{row['conditionId']}:{row['positionId']}", row["attemptNo"])] = row
    return rows


def score_pairs(pairs: list[tuple[str, dict[str, Any] | None, dict[str, Any]]]) -> dict[str, Any]:
    """pairs: (phase, candidate result or None, reference result)."""
    total = len(pairs)
    success = top1 = included = 0
    cp: dict[str, list[float]] = {"all": [], **{phase: [] for phase in PHASES}}
    kind_num = kind_den = 0
    for phase, candidate, reference in pairs:
        if not candidate or candidate.get("status") != "success" or not candidate.get("candidates"):
            continue
        success += 1
        moves = [row["move"] for row in candidate["candidates"]]
        best = reference["candidates"][0]
        top1 += int(moves[0] == best["move"])
        included += int(best["move"] in moves)
        a, b = candidate["candidates"][0].get("score", {}), best.get("score", {})
        if a.get("kind") and b.get("kind"):
            kind_den += 1
            kind_num += int(a["kind"] == b["kind"])
            if a["kind"] == b["kind"] == "cp":
                diff = abs(a["value"] - b["value"])
                cp["all"].append(diff)
                cp[phase].append(diff)
    def pct(n: int, d: int) -> str:
        return f"{100 * n / d:.0f}% ({n}/{d})" if d else "–"
    def stat(values: list[float]) -> str:
        return f"{quantile(values, 0.5):.0f} / {quantile(values, 0.9):.0f}" if values else "–"
    return {"success": pct(success, total), "top1": pct(top1, success), "included": pct(included, success),
            "scoreKind": pct(kind_num, kind_den), "cpAll": stat(cp["all"]),
            **{f"cp_{phase}": stat(cp[phase]) for phase in PHASES}}


def command_compare(args: argparse.Namespace) -> int:
    issue20 = load_issue20()
    positions = json.loads(POSITIONS_PATH.read_text(encoding="utf-8"))["positions"]
    reference = {p["id"]: issue20[(f"{REFERENCE_ID}:{p['id']}", 1)]["response"] for p in positions}
    rows = [json.loads(line) for path in args.input for line in Path(path).read_text(encoding="utf-8").splitlines() if line]
    table: list[tuple[str, dict[str, Any], str, str]] = []

    def add(label: str, results: dict[str, dict[str, Any] | None], timing: str, game: str) -> None:
        pairs = [(p["phase"], results.get(p["id"]), reference[p["id"]]) for p in positions]
        table.append((label, score_pairs(pairs), timing, game))

    for repetition in (2, 3):
        add(f"基準解析の{repetition}回目（ばらつきの目安）",
            {p["id"]: issue20[(f"{REFERENCE_ID}:{p['id']}", repetition)].get("response") for p in positions}, "–", "–")
    for condition in args.issue20_condition:
        add(f"#20経路 {condition}",
            {p["id"]: issue20.get((f"{condition}:{p['id']}", 1), {}).get("response") for p in positions}, "–", "–")
    labels = list(dict.fromkeys(row["label"] for row in rows if row["recordType"] == "position"))
    for label in labels:
        mine = [row for row in rows if row["label"] == label]
        position_rows = [row for row in mine if row["recordType"] == "position"]
        walls = [row["wallMs"] / 1000 for row in position_rows]
        games = [row for row in mine if row["recordType"] == "game" and row["jobStatus"] == "completed"]
        timing = f"{statistics.median(walls):.1f}s / {quantile(walls, 0.9):.1f}s" if walls else "–"
        game = " / ".join(f"{row['wallMs'] / 1000:.0f}s" for row in games) or "–"
        add(label, {row["positionId"]: row["result"] for row in position_rows}, timing, game)

    lines = [
        "| 条件 | 完了率 | Top-1一致 | 基準の最善手が候補内 | 評価種別一致 | CP差 中央値/p90 | 序盤 | 中盤 | 終盤 | 1局面job 中央値/p90 | 92手1局job |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for label, value, timing, game in table:
        lines.append(f"| {label} | {value['success']} | {value['top1']} | {value['included']} | {value['scoreKind']} | "
                     f"{value['cpAll']} | {value['cp_opening']} | {value['cp_middlegame']} | {value['cp_endgame']} | "
                     f"{timing} | {game} |")
    text = "\n".join(lines) + "\n"
    if args.markdown_out:
        Path(args.markdown_out).write_text(text, encoding="utf-8")
    print(text)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run")
    run.add_argument("--base-url")
    run.add_argument("--profile", choices=("free", "precision", "mixed"), required=True)
    run.add_argument("--label", required=True)
    run.add_argument("--mode", choices=("positions", "game", "both"), default="both")
    run.add_argument("--game-repetitions", type=int, default=2)
    run.add_argument("--parallel-jobs", type=int, default=1,
                     help="Run up to N cold jobIds concurrently. Each job gets a separate owner credential.")
    run.add_argument("--expect-movetime", type=int)
    run.add_argument("--output", required=True)
    compare = sub.add_parser("compare")
    compare.add_argument("--input", nargs="+", required=True)
    compare.add_argument("--issue20-condition", action="append", default=[])
    compare.add_argument("--markdown-out")
    args = parser.parse_args()
    return command_run(args) if args.command == "run" else command_compare(args)


if __name__ == "__main__":
    sys.exit(main())
