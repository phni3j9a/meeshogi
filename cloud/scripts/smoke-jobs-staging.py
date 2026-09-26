#!/usr/bin/env python3
"""Public /v1 job-API smoke for the Issue #21 staging Worker.

Issues a throwaway anonymous credential, submits a short Free job, polls for
progress and results, verifies idempotent resubmission, owner isolation, and
cancellation. The credential is only ever held in memory or in a mode-0600
operator file for the optional precision step; it is never printed.

Usage:
    ANALYSIS_STAGING_URL=https://<worker>.workers.dev python3 smoke-jobs-staging.py

    # Optional precision pass (two runs; the file survives between them):
    python3 smoke-jobs-staging.py --precision
    # -> run the printed wrangler d1 execute command, then re-run the same
    #    command; the saved credential's owner is reused.
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
GAME_MOVES = ["2g2f", "8c8d", "2f2e", "8d8e"]
# A longer legal game keeps the second job active long enough to cancel.
CANCEL_MOVES = (
    ["2g2f", "8c8d", "2f2e", "8d8e", "2e2d", "8e8f"]
    + ["2h2g", "8b8c", "2g2h", "8c8b"] * 5
)
PRECISION_OWNER_FILE = Path("/tmp/meeshogi-smoke-jobs-owner.json")
JOB_DEADLINE_SECONDS = 15 * 60
JOB_POLL_INTERVAL = 10


def request(base_url: str, method: str, path: str, credential: str | None, body: Any | None, timeout: float = 30) -> tuple[int, dict[str, Any]]:
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
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read())
        except Exception:
            return error.code, {}
        return error.code, payload if isinstance(payload, dict) else {}
    except Exception as error:
        raise RuntimeError(f"{method} {path}: transport failure: {error}") from error


def issue_credential(base_url: str) -> dict[str, str]:
    status, body = request(base_url, "POST", "/v1/credentials", None, {})
    if status != 201 or not isinstance(body.get("credential"), str) or not isinstance(body.get("ownerId"), str):
        raise RuntimeError(f"credential issuance failed: HTTP {status} {body!r}")
    return {"credential": body["credential"], "ownerId": body["ownerId"]}


def create_job(base_url: str, credential: str, profile: str, key: str) -> dict[str, Any]:
    status, body = request(base_url, "POST", "/v1/jobs", credential, {
        "idempotencyKey": key,
        "profileId": profile,
        "initialSfen": STARTPOS,
        "moves": GAME_MOVES,
    })
    if status not in (200, 201):
        raise RuntimeError(f"job creation failed: HTTP {status} {body!r}")
    return {"status": status, **body}


def wait_for_job(base_url: str, credential: str, job_id: str) -> dict[str, Any]:
    deadline = time.monotonic() + JOB_DEADLINE_SECONDS
    last: dict[str, Any] = {}
    while time.monotonic() < deadline:
        status, body = request(base_url, "GET", f"/v1/jobs/{job_id}", credential, None)
        if status != 200:
            raise RuntimeError(f"job status failed: HTTP {status} {body!r}")
        last = body
        print(f"  job {job_id}: status={body.get('status')} analyzedPlies={body.get('analyzedPlies')}/{body.get('totalPlies')}")
        if body.get("status") in ("completed", "failed", "cancelled"):
            return body
        time.sleep(JOB_POLL_INTERVAL)
    raise RuntimeError(f"job {job_id} did not reach a terminal state: {last!r}")


def fetch_results(base_url: str, credential: str, job_id: str) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    after = -1
    while True:
        status, body = request(base_url, "GET", f"/v1/jobs/{job_id}/results?afterPly={after}&limit=2", credential, None)
        if status != 200:
            raise RuntimeError(f"results failed: HTTP {status} {body!r}")
        results.extend(body.get("results", []))
        if not body.get("hasMore"):
            break
        after = int(body["nextAfterPly"])
    return results


def expect(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def main() -> int:
    base_url = os.environ.get("ANALYSIS_STAGING_URL", "").rstrip("/")
    if not base_url:
        print("Set ANALYSIS_STAGING_URL to the deployed Worker origin.", file=sys.stderr)
        return 2
    precision = "--precision" in sys.argv

    if precision and PRECISION_OWNER_FILE.exists():
        owner = json.loads(PRECISION_OWNER_FILE.read_text(encoding="utf-8"))
        print(f"reusing owner {owner['ownerId']} from {PRECISION_OWNER_FILE} (mode-0600)")
    else:
        owner = issue_credential(base_url)
        print(f"issued credential for owner {owner['ownerId']} (credential held in memory only)")

    if precision and not PRECISION_OWNER_FILE.exists():
        PRECISION_OWNER_FILE.write_text(json.dumps(owner), encoding="utf-8")
        PRECISION_OWNER_FILE.chmod(0o600)
        print(
            "Precision requires a server-side allowlist entry. Run, then re-run this smoke:\n"
            f"  cd cloud && ./node_modules/.bin/wrangler d1 execute meeshogi-jobs-staging --remote "
            f"--command \"UPDATE owners SET precision_allowed = 1 WHERE owner_id = '{owner['ownerId']}'\""
        )
        return 2

    profile = "precision" if precision else "free"
    expected = {"free": {"moveTimeMs": 1000, "multiPV": 2}, "precision": {"moveTimeMs": 5000, "multiPV": 3}}[profile]

    print(f"creating {profile} job ({len(GAME_MOVES)} moves, {len(GAME_MOVES) + 1} plies)")
    key = f"smoke-{int(time.time())}"
    created = create_job(base_url, owner["credential"], profile, key)
    job_id = created["jobId"]
    expect(created["status"] == 201 and created.get("idempotentReplay") is False, "initial job creation was not a fresh create")
    expect(created.get("totalPlies") == len(GAME_MOVES) + 1, "unexpected totalPlies")

    # Idempotent resubmission returns the same job.
    replay = create_job(base_url, owner["credential"], profile, key)
    expect(replay["jobId"] == job_id, "idempotent resubmission created a different job")

    # Owner isolation: a second credential must not see the first owner's job.
    other = issue_credential(base_url)
    status, _ = request(base_url, "GET", f"/v1/jobs/{job_id}", other["credential"], None)
    expect(status == 404, f"owner isolation failed: second owner read the job (HTTP {status})")
    print("owner isolation: second owner sees 404")

    view = wait_for_job(base_url, owner["credential"], job_id)
    expect(view.get("status") == "completed", f"job ended in unexpected state: {view!r}")
    results = fetch_results(base_url, owner["credential"], job_id)
    expect(len(results) == len(GAME_MOVES) + 1, f"expected {len(GAME_MOVES) + 1} results, got {len(results)}")
    expect([row["ply"] for row in results] == list(range(len(GAME_MOVES) + 1)), "results are not in contiguous ply order")
    for row in results:
        result = row.get("result", {})
        expect(result.get("status") == "success", f"ply {row['ply']}: unexpected result status {result.get('status')!r}")
        expect(len(result.get("candidates", [])) == expected["multiPV"], f"ply {row['ply']}: candidate count mismatch")
        requested = result.get("conditions", {}).get("requested", {})
        expect(requested.get("moveTimeMs") == expected["moveTimeMs"], f"ply {row['ply']}: requested conditions mismatch")
    print(f"{profile} job completed: {len(results)} ply results verified")

    # Cancellation: submit a longer job and cancel it; it must stay cancelled.
    # The daily Free quota is 5 jobs and each smoke run uses two; a 429 here
    # means the day's quota is already consumed.
    cancel_key = f"smoke-cancel-{int(time.time())}"
    status, cancel_job = request(base_url, "POST", "/v1/jobs", owner["credential"], {
        "idempotencyKey": cancel_key,
        "profileId": profile,
        "initialSfen": STARTPOS,
        "moves": CANCEL_MOVES,
    })
    expect(status in (200, 201), f"cancel-game job creation failed: HTTP {status} {cancel_job!r}")
    status, view = request(base_url, "POST", f"/v1/jobs/{cancel_job['jobId']}/cancel", owner["credential"], {}, timeout=30)
    expect(status == 200 and view.get("status") == "cancelled", f"cancel failed: HTTP {status} {view!r}")
    print(f"cancel committed for job {cancel_job['jobId']}")
    # The cancelled job still counts toward the daily quota; only report it.
    status, view = request(base_url, "GET", f"/v1/jobs/{cancel_job['jobId']}", owner["credential"], None)
    expect(view.get("status") == "cancelled", "cancelled job changed state afterwards")

    print(f"smoke ok: {profile} profile, idempotent replay, owner isolation, cancel")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as error:
        print(f"smoke failed: {error}", file=sys.stderr)
        raise SystemExit(1)
