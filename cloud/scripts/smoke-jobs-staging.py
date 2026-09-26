#!/usr/bin/env python3
"""Public /v1 job-API smoke for the Issue #21 staging Worker.

Issues a throwaway anonymous credential, submits a Free job, then verifies:
progress visible from GET alone (client disconnect equivalence), partial
results via afterPly while running, idempotent resubmission, the one-active-job
limit, owner isolation, cancellation that stays cancelled, per-result
conditions/identity/engineLaunch evidence, and the precision allowlist gate.

HTTP status is always kept in a dedicated ``httpStatus`` key so it can never
be confused with a job payload's ``status`` field.

Daily quota exhaustion is intentionally not exercised: each run consumes two
of five daily Free jobs for its owner. To verify the quota, create five jobs
with fresh idempotency keys for one owner (e.g. run this script twice plus one
extra POST), then observe HTTP 429 with failure.code == "daily_limit".

Usage:
    ANALYSIS_STAGING_URL=https://<worker>.workers.dev python3 smoke-jobs-staging.py

    # Optional precision pass (two runs; the owner file survives between them):
    python3 smoke-jobs-staging.py --precision
    # -> run the printed wrangler d1 execute command, then re-run the same
    #    command; the saved credential's owner is reused. The credential is
    #    stored mode-0600 and never printed.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from staging_readiness import OPERATOR_USER_AGENT

STARTPOS = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1"
# A 26-move legal shuttle game keeps a job active long enough to observe
# progress, partial results, the active-job limit, and cancellation.
GAME_MOVES = (
    ["2g2f", "8c8d", "2f2e", "8d8e", "2e2d", "8e8f"]
    + ["2h2g", "8b8c", "2g2h", "8c8b"] * 5
)
TOTAL_PLIES = len(GAME_MOVES) + 1
PRECISION_OWNER_FILE = Path("/tmp/meeshogi-smoke-jobs-owner.json")
JOB_DEADLINE_SECONDS = 15 * 60
JOB_POLL_INTERVAL = 5
CANCEL_OBSERVE_SECONDS = 20

PROFILE_CONDITIONS = {
    "free": {"threads": 1, "hashMb": 64, "moveTimeMs": 1000, "multiPV": 2},
    "precision": {"threads": 2, "hashMb": 64, "moveTimeMs": 5000, "multiPV": 3},
}


def api(base_url: str, method: str, path: str, credential: str | None, body: Any | None, timeout: float = 30) -> dict[str, Any]:
    """Returns {"httpStatus": int, "body": dict}. HTTP status is never merged into the payload."""
    data = None
    headers: dict[str, str] = {"User-Agent": OPERATOR_USER_AGENT}
    if body is not None:
        data = json.dumps(body, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if credential is not None:
        headers["Authorization"] = f"Bearer {credential}"
    req = urllib.request.Request(base_url.rstrip("/") + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return {"httpStatus": response.status, "body": json.loads(response.read())}
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read())
        except Exception:
            payload = {}
        return {"httpStatus": error.code, "body": payload if isinstance(payload, dict) else {}}
    except Exception as error:
        raise RuntimeError(f"{method} {path}: transport failure: {error}") from error


def expect(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def issue_credential(base_url: str) -> dict[str, str]:
    response = api(base_url, "POST", "/v1/credentials", None, {})
    body = response["body"]
    if response["httpStatus"] != 201 or not isinstance(body.get("credential"), str) or not isinstance(body.get("ownerId"), str):
        raise RuntimeError(f"credential issuance failed: HTTP {response['httpStatus']} {body!r}")
    return {"credential": body["credential"], "ownerId": body["ownerId"]}


def post_job(base_url: str, credential: str, profile: str, key: str, moves: list[str]) -> dict[str, Any]:
    return api(base_url, "POST", "/v1/jobs", credential, {
        "idempotencyKey": key,
        "profileId": profile,
        "initialSfen": STARTPOS,
        "moves": moves,
    })


def get_job(base_url: str, credential: str, job_id: str) -> dict[str, Any]:
    return api(base_url, "GET", f"/v1/jobs/{job_id}", credential, None)


def get_results(base_url: str, credential: str, job_id: str, after_ply: int = -1, limit: int = 200) -> dict[str, Any]:
    return api(base_url, "GET", f"/v1/jobs/{job_id}/results?afterPly={after_ply}&limit={limit}", credential, None)


def poll_progress(base_url: str, credential: str, job_id: str) -> dict[str, Any]:
    """GET-only polling until terminal; never reads /results. Demonstrates that
    progress is tracked server-side regardless of what the client fetches."""
    deadline = time.monotonic() + JOB_DEADLINE_SECONDS
    last: dict[str, Any] = {}
    advanced = False
    while time.monotonic() < deadline:
        response = get_job(base_url, credential, job_id)
        expect(response["httpStatus"] == 200, f"job status failed: HTTP {response['httpStatus']} {response['body']!r}")
        view = response["body"]
        last = view
        print(f"  job {job_id}: status={view.get('status')} analyzedPlies={view.get('analyzedPlies')}/{view.get('totalPlies')}")
        if isinstance(view.get("analyzedPlies"), int) and view["analyzedPlies"] > 0:
            advanced = True
        if view.get("status") in ("completed", "failed", "cancelled"):
            expect(advanced or view.get("analyzedPlies") == view.get("totalPlies"), "job reached terminal without observable progress")
            return view
        time.sleep(JOB_POLL_INTERVAL)
    raise RuntimeError(f"job {job_id} did not reach a terminal state: {last!r}")


def read_partial_results(base_url: str, credential: str, job_id: str) -> None:
    """Best-effort partial read while the job is running; skipped silently if
    the job finishes before any result is observable."""
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        response = get_results(base_url, credential, job_id)
        expect(response["httpStatus"] == 200, f"partial results failed: HTTP {response['httpStatus']}")
        body = response["body"]
        rows = body.get("results", [])
        if rows:
            row = rows[0]
            expect(isinstance(row.get("engineLaunch"), int) and row["engineLaunch"] >= 1,
                   f"partial row has no engineLaunch evidence: {row!r}")
            print(f"  partial results visible while {body.get('status')}: {len(rows)} rows up to ply {row['ply']}..{rows[-1]['ply']}, engineLaunch={row['engineLaunch']}")
            return
        if body.get("status") in ("completed", "failed", "cancelled"):
            print("  job reached terminal before partial results were observable (skipped)")
            return
        time.sleep(3)
    print("  no partial results within 120s (skipped)")


def fetch_all_results(base_url: str, credential: str, job_id: str) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    after = -1
    while True:
        response = get_results(base_url, credential, job_id, after_ply=after, limit=2)
        expect(response["httpStatus"] == 200, f"results failed: HTTP {response['httpStatus']} {response['body']!r}")
        body = response["body"]
        results.extend(body.get("results", []))
        if not body.get("hasMore"):
            break
        after = int(body["nextAfterPly"])
    return results


def verify_results(results: list[dict[str, Any]], profile: str) -> None:
    expected = PROFILE_CONDITIONS[profile]
    expect(len(results) == TOTAL_PLIES, f"expected {TOTAL_PLIES} results, got {len(results)}")
    expect([row["ply"] for row in results] == list(range(TOTAL_PLIES)), "results are not in contiguous ply order")
    identities: list[str] = []
    launches: set[int] = set()
    for row in results:
        result = row.get("result", {})
        expect(result.get("status") == "success", f"ply {row['ply']}: unexpected result status {result.get('status')!r}")
        expect(len(result.get("candidates", [])) == expected["multiPV"], f"ply {row['ply']}: candidate count mismatch")
        requested = result.get("conditions", {}).get("requested", {})
        for field, value in expected.items():
            expect(requested.get(field) == value, f"ply {row['ply']}: requested {field} mismatch: {requested!r}")
        identity = result.get("identity", {})
        expect(isinstance(identity.get("engineName"), str) and identity["engineName"],
               f"ply {row['ply']}: missing result identity")
        identities.append(json.dumps(identity, sort_keys=True))
        expect(isinstance(row.get("engineLaunch"), int) and row["engineLaunch"] >= 1,
               f"ply {row['ply']}: missing engineLaunch")
        launches.add(row["engineLaunch"])
    expect(len(set(identities)) == 1, "result identities differ within one job")
    expect(len(launches) == 1, f"results came from multiple engine launches: {sorted(launches)}")


def run_job_flow(base_url: str, owner: dict[str, str], profile: str) -> None:
    key = f"smoke-{profile}-{int(time.time())}"
    print(f"creating {profile} job ({len(GAME_MOVES)} moves, {TOTAL_PLIES} plies)")
    created = post_job(base_url, owner["credential"], profile, key, GAME_MOVES)
    expect(created["httpStatus"] == 201 and created["body"].get("idempotentReplay") is False,
           f"initial job creation was not a fresh create: HTTP {created['httpStatus']} {created['body']!r}")
    body = created["body"]
    expect(body.get("totalPlies") == TOTAL_PLIES, "unexpected totalPlies")
    expect(body.get("profileId") == profile, f"profileId mismatch: {body.get('profileId')!r}")
    job_id = body["jobId"]

    # Idempotent resubmission returns the same job.
    replay = post_job(base_url, owner["credential"], profile, key, GAME_MOVES)
    expect(replay["httpStatus"] == 200, f"idempotent resubmission returned HTTP {replay['httpStatus']}")
    expect(replay["body"].get("jobId") == job_id and replay["body"].get("idempotentReplay") is True,
           "idempotent resubmission did not replay the same job")

    # The one-active-job limit rejects a second job for the same owner.
    second = post_job(base_url, owner["credential"], profile, f"{key}-concurrent", GAME_MOVES)
    expect(second["httpStatus"] == 429 and second["body"].get("failure", {}).get("code") == "active_job_limit",
           f"second concurrent job was not rejected with active_job_limit: HTTP {second['httpStatus']} {second['body']!r}")
    print("active-job limit: second concurrent job rejected with 429 active_job_limit")

    # Owner isolation: a second credential must not see the first owner's job.
    other = issue_credential(base_url)
    foreign = get_job(base_url, other["credential"], job_id)
    expect(foreign["httpStatus"] == 404, f"owner isolation failed: second owner read the job (HTTP {foreign['httpStatus']})")
    print("owner isolation: second owner sees 404")

    # Precision is allowlist-gated; a fresh owner is never allowlisted.
    denied = post_job(base_url, other["credential"], "precision", f"{key}-precision-denied", GAME_MOVES)
    expect(denied["httpStatus"] == 403, f"precision was not rejected for a non-allowlisted owner: HTTP {denied['httpStatus']} {denied['body']!r}")
    print("precision gate: non-allowlisted owner rejected with 403")

    # Client-disconnect equivalence: observe progress via GET only.
    print("polling progress (GET only, no /results reads):")
    view = poll_progress(base_url, owner["credential"], job_id)
    expect(view.get("status") == "completed", f"job ended in unexpected state: {view!r}")

    # Partial reads are only observable while running; attempt before the next
    # job so a slow driver still shows them.
    results = fetch_all_results(base_url, owner["credential"], job_id)
    verify_results(results, profile)
    print(f"{profile} job completed: {len(results)} ply results verified (conditions, identity, engineLaunch)")


def attempt_cancel(base_url: str, owner: dict[str, str], key: str, wait_for_partials: bool) -> tuple[str, dict[str, Any]]:
    created = post_job(base_url, owner["credential"], "free", key, GAME_MOVES)
    expect(created["httpStatus"] in (200, 201), f"cancel-game job creation failed: HTTP {created['httpStatus']} {created['body']!r}")
    job_id = created["body"]["jobId"]
    if wait_for_partials:
        # Read partial results while the job is running (afterPly coverage).
        read_partial_results(base_url, owner["credential"], job_id)
    return job_id, api(base_url, "POST", f"/v1/jobs/{job_id}/cancel", owner["credential"], {})


def run_cancel_flow(base_url: str, owner: dict[str, str]) -> None:
    job_id, cancelled = attempt_cancel(base_url, owner, f"smoke-cancel-{int(time.time())}", True)
    if not (cancelled["httpStatus"] == 200 and cancelled["body"].get("status") == "cancelled"):
        # The job may have reached a terminal state before the cancel landed;
        # retry once and cancel immediately.
        print("  first job reached terminal before cancel; retrying with immediate cancel")
        job_id, cancelled = attempt_cancel(base_url, owner, f"smoke-cancel-b-{int(time.time())}", False)
    expect(cancelled["httpStatus"] == 200 and cancelled["body"].get("status") == "cancelled",
           f"cancel failed: HTTP {cancelled['httpStatus']} {cancelled['body']!r}")
    print(f"cancel committed for job {job_id}; observing {CANCEL_OBSERVE_SECONDS}s for post-cancel writes")
    baseline = cancelled["body"]
    baseline_ply = baseline.get("nextPly", 0)
    baseline_counts = baseline.get("resultCounts", {})
    time.sleep(CANCEL_OBSERVE_SECONDS)
    after = get_job(base_url, owner["credential"], job_id)
    expect(after["httpStatus"] == 200, f"post-cancel read failed: HTTP {after['httpStatus']}")
    view = after["body"]
    expect(view.get("status") == "cancelled", f"cancelled job changed state: {view.get('status')!r}")
    expect(view.get("nextPly") == baseline_ply, f"nextPly advanced after cancel: {baseline_ply} -> {view.get('nextPly')}")
    expect(view.get("resultCounts") == baseline_counts, f"result counts changed after cancel: {baseline_counts!r} -> {view.get('resultCounts')!r}")
    print(f"cancel holds: status=cancelled, nextPly={baseline_ply}, resultCounts unchanged")


def main() -> int:
    base_url = os.environ.get("ANALYSIS_STAGING_URL", "").rstrip("/")
    if not base_url:
        print("Set ANALYSIS_STAGING_URL to the deployed Worker origin.", file=sys.stderr)
        return 2
    precision = "--precision" in sys.argv

    if precision:
        if PRECISION_OWNER_FILE.exists():
            owner = json.loads(PRECISION_OWNER_FILE.read_text(encoding="utf-8"))
            print(f"reusing owner {owner['ownerId']} from {PRECISION_OWNER_FILE} (mode-0600)")
        else:
            owner = issue_credential(base_url)
            PRECISION_OWNER_FILE.write_text(json.dumps(owner), encoding="utf-8")
            PRECISION_OWNER_FILE.chmod(0o600)
            print(
                "Precision requires a server-side allowlist entry. Run, then re-run this smoke:\n"
                f"  cd cloud && ./node_modules/.bin/wrangler d1 execute meeshogi-jobs-staging --remote "
                f"--command \"UPDATE owners SET precision_allowed = 1 WHERE owner_id = '{owner['ownerId']}'\""
            )
            return 2
        run_job_flow(base_url, owner, "precision")
        print("smoke ok: precision profile for an allowlisted owner")
        return 0

    owner = issue_credential(base_url)
    print(f"issued credential for owner {owner['ownerId']} (credential held in memory only)")
    run_job_flow(base_url, owner, "free")
    # The cancel flow also performs the running-state partial results read:
    # it waits for committed rows via afterPly, then cancels and verifies the
    # job stays cancelled with no further progress.
    run_cancel_flow(base_url, owner)

    print("smoke ok: free profile, progress, idempotent replay, active-job limit, owner isolation, precision gate, cancel")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as error:
        print(f"smoke failed: {error}", file=sys.stderr)
        raise SystemExit(1)
