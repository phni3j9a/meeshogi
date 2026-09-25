#!/usr/bin/env python3
"""Deploy the one-shot verification config, prove timeout/reap, then restore normal staging."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from staging_readiness import (
    HttpObservation,
    ReadinessError,
    get_worker_health,
    post_analysis,
)

CLOUD_DIR = Path(__file__).resolve().parents[1]
DEPLOY_SCRIPT = CLOUD_DIR / "scripts/deploy-staging.sh"
SMOKE_SCRIPT = CLOUD_DIR / "scripts/smoke-staging.py"
STARTPOS = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1"
MIDDLEGAME = "1nrg3n1/l2s2k2/p1p1gp1pl/1p1pp2s1/6P1p/b1P5P/PP1PPP1P1/L1KSRSG2/1NG4NL b BP 1"
READINESS_TIMEOUT_SECONDS = 600
CONTAINER_HEALTH_INTERVAL_SECONDS = 15
# Keep this aligned with AnalysisContainer.sleepAfter = '5m'.
CONTAINER_SLEEP_AFTER_SECONDS = 300
CONTAINER_SLEEP_BUFFER_SECONDS = 15
DRIVER_BOOT_ID_RE = re.compile(r"^[0-9a-f]{32}$")
LAST_HTTP = HttpObservation(None, {})


class VerificationError(Exception):
    def __init__(self, check: str, observation: HttpObservation | None = None):
        super().__init__(check)
        self.check = check
        self.observation = observation


def child_environment() -> dict[str, str]:
    env = os.environ.copy()
    env.setdefault("WRANGLER_WRITE_LOGS", "false")
    env.pop("ANALYSIS_VERIFY_STOP_ENGINE_ONCE", None)
    return env


def validate_inputs() -> tuple[str, str]:
    url = os.environ.get("ANALYSIS_STAGING_URL", "")
    token = os.environ.get("ANALYSIS_INTERNAL_TOKEN", "")
    account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    image_ref = os.environ.get("ANALYSIS_IMAGE_REF", "")
    if not url.startswith("https://") or not token:
        raise VerificationError("required-analysis-inputs")
    if not re.fullmatch(r"[0-9a-f]{32}", account_id):
        raise VerificationError("cloudflare-account-id")
    if not re.fullmatch(
        rf"registry\.cloudflare\.com/{account_id}/meeshogi-analysis-mvp-staging@sha256:[0-9a-f]{{64}}",
        image_ref,
    ):
        raise VerificationError("digest-pinned-image-ref")
    return url.rstrip("/"), token


def deploy(verification: bool) -> bool:
    command = ["bash", str(DEPLOY_SCRIPT)]
    if verification:
        command.append("--verification")
    try:
        result = subprocess.run(
            command,
            cwd=CLOUD_DIR,
            env=child_environment(),
            capture_output=True,
            text=True,
            timeout=900,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def container_health_matches(observation: HttpObservation, expected_enabled: bool) -> bool:
    payload = observation.payload
    return (
        observation.http_status == 200
        and payload.get("status") == "ready"
        and payload.get("workerVerifyStopEngineOnceEnabled") is expected_enabled
        and payload.get("verifyStopEngineOnceEnabled") is expected_enabled
        and isinstance(payload.get("driverBootId"), str)
        and DRIVER_BOOT_ID_RE.fullmatch(payload["driverBootId"]) is not None
        and (
            not expected_enabled
            or payload.get("verifyStopEngineOnceConsumed") is False
        )
    )


def poll_container_health(
    url: str,
    token: str,
    expected_enabled: bool,
) -> tuple[dict[str, Any] | None, HttpObservation, int]:
    global LAST_HTTP
    deadline = time.monotonic() + READINESS_TIMEOUT_SECONDS
    attempts = 0
    while time.monotonic() < deadline:
        remaining = deadline - time.monotonic()
        LAST_HTTP = get_worker_health(url, token, timeout=min(15, max(1, remaining)))
        attempts += 1
        if time.monotonic() < deadline and container_health_matches(LAST_HTTP, expected_enabled):
            return {"attempts": attempts, "observation": LAST_HTTP}, LAST_HTTP, attempts
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(min(CONTAINER_HEALTH_INTERVAL_SECONDS, remaining))
    return None, LAST_HTTP, attempts


def wait_for_container_configuration(
    url: str,
    token: str,
    expected_enabled: bool,
    phase: str,
) -> dict[str, Any]:
    global LAST_HTTP
    readiness, last_observation, attempts = poll_container_health(url, token, expected_enabled)
    if readiness is not None:
        return {**readiness, "quietRestartWait": False}

    quiet_seconds = CONTAINER_SLEEP_AFTER_SECONDS + CONTAINER_SLEEP_BUFFER_SECONDS
    print(json.dumps({
        "phase": f"{phase}-container-restart-wait",
        "status": "waiting",
        "expectedContainerFlag": expected_enabled,
        "pollAttempts": attempts,
        "quietSeconds": quiet_seconds,
        **last_observation.diagnostics(token),
    }, separators=(",", ":")))
    quiet_deadline = time.monotonic() + quiet_seconds
    while True:
        remaining = quiet_deadline - time.monotonic()
        if remaining <= 0:
            break
        time.sleep(min(CONTAINER_HEALTH_INTERVAL_SECONDS, remaining))

    LAST_HTTP = get_worker_health(url, token, timeout=15)
    attempts += 1
    if container_health_matches(LAST_HTTP, expected_enabled):
        return {
            "attempts": attempts,
            "observation": LAST_HTTP,
            "quietRestartWait": True,
            "quietSeconds": quiet_seconds,
        }
    check = "container-verification-config-not-applied" if expected_enabled else "container-normal-config-not-applied"
    raise ReadinessError(check, LAST_HTTP)


def require_verification_evidence(payload: dict[str, Any]) -> dict[str, Any]:
    evidence = payload.get("verification")
    if not isinstance(evidence, dict):
        raise VerificationError("verification-evidence-missing", LAST_HTTP)
    if (
        not isinstance(evidence.get("driverBootId"), str)
        or not DRIVER_BOOT_ID_RE.fullmatch(evidence["driverBootId"])
        or not isinstance(evidence.get("enginePid"), int)
        or isinstance(evidence.get("enginePid"), bool)
        or evidence["enginePid"] <= 0
        or not isinstance(evidence.get("engineEpoch"), int)
        or isinstance(evidence.get("engineEpoch"), bool)
        or evidence["engineEpoch"] <= 0
        or evidence.get("engineReaped") is not True
        or evidence.get("waitReturned") is not True
        or not isinstance(evidence.get("waitReturnCode"), int)
        or isinstance(evidence.get("waitReturnCode"), bool)
        or not isinstance(evidence.get("stopInjected"), bool)
    ):
        raise VerificationError("verification-evidence-invalid", LAST_HTTP)
    return evidence


def run_timeout_and_recovery(url: str, token: str) -> None:
    global LAST_HTTP
    if not deploy(verification=True):
        raise VerificationError("verification-deploy")
    print(json.dumps({"phase": "verification-deploy", "status": "passed"}, separators=(",", ":")))

    readiness = wait_for_container_configuration(
        url,
        token,
        expected_enabled=True,
        phase="verification",
    )
    health_payload = readiness["observation"].payload
    health_boot_id = health_payload["driverBootId"]
    print(json.dumps({
        "phase": "verification-readiness",
        "status": "passed",
        "httpStatus": readiness["observation"].http_status,
        "attempts": readiness["attempts"],
        "quietRestartWait": readiness["quietRestartWait"],
        "quietSeconds": readiness.get("quietSeconds", 0),
        "driverBootId": health_boot_id,
        "driverVersion": health_payload["driverVersion"],
        "contractVersion": health_payload["contractVersion"],
        "identityDigests": health_payload["identityDigests"],
        "workerVerifyStopEngineOnceEnabled": health_payload["workerVerifyStopEngineOnceEnabled"],
        "verifyStopEngineOnceEnabled": health_payload["verifyStopEngineOnceEnabled"],
        "verifyStopEngineOnceConsumed": health_payload["verifyStopEngineOnceConsumed"],
    }, separators=(",", ":")))

    # The first analysis request reaches the configured driver and consumes its in-memory one-shot.
    LAST_HTTP = post_analysis(url, token, STARTPOS, timeout=120)
    timeout_payload = LAST_HTTP.payload
    failure = timeout_payload.get("failure")
    if (
        LAST_HTTP.http_status != 504
        or timeout_payload.get("status") != "failure"
        or not isinstance(failure, dict)
        or failure.get("code") != "timeout"
    ):
        raise VerificationError("timeout-response", LAST_HTTP)
    timeout_evidence = require_verification_evidence(timeout_payload)
    if (
        not timeout_evidence["stopInjected"]
        or timeout_evidence["waitReturnCode"] >= 0
        or timeout_evidence["driverBootId"] != health_boot_id
    ):
        raise VerificationError("timeout-reap-evidence", LAST_HTTP)
    print(json.dumps({
        "phase": "timeout",
        "httpStatus": LAST_HTTP.http_status,
        "status": timeout_payload.get("status"),
        "failureCode": failure["code"],
        "healthDriverBootId": health_boot_id,
        **timeout_evidence,
    }, separators=(",", ":")))

    # A different position proves the same driver process accepts a fresh engine after reaping.
    LAST_HTTP = post_analysis(url, token, MIDDLEGAME, timeout=120)
    recovery_payload = LAST_HTTP.payload
    if LAST_HTTP.http_status != 200 or recovery_payload.get("status") != "success":
        raise VerificationError("recovery-response", LAST_HTTP)
    recovery_evidence = require_verification_evidence(recovery_payload)
    if (
        recovery_evidence["stopInjected"]
        or recovery_evidence["driverBootId"] != timeout_evidence["driverBootId"]
        or recovery_evidence["driverBootId"] != health_boot_id
        or recovery_evidence["engineEpoch"] <= timeout_evidence["engineEpoch"]
        or recovery_evidence["enginePid"] == timeout_evidence["enginePid"]
        or recovery_evidence["waitReturnCode"] != 0
    ):
        raise VerificationError("recovery-fresh-engine", LAST_HTTP)
    print(json.dumps({
        "phase": "recovery",
        "httpStatus": LAST_HTTP.http_status,
        "status": recovery_payload.get("status"),
        "freshEngine": True,
        "healthDriverBootId": health_boot_id,
        **recovery_evidence,
    }, separators=(",", ":")))


def smoke_diagnostics(stderr: str) -> dict[str, Any] | None:
    for line in reversed(stderr.splitlines()):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and "httpStatus" in value:
            return value
    return None


def run_normal_deploy_and_smoke(url: str, token: str) -> tuple[bool, bool]:
    global LAST_HTTP
    LAST_HTTP = HttpObservation(None, {})
    if not deploy(verification=False):
        print(json.dumps({
            "phase": "normal-deploy",
            "status": "failed",
            "check": "deploy",
            **LAST_HTTP.diagnostics(os.environ.get("ANALYSIS_INTERNAL_TOKEN", "")),
        }, separators=(",", ":")), file=sys.stderr)
        return False, False
    print(json.dumps({"phase": "normal-deploy", "status": "passed", "verificationStopEngineOnce": False}, separators=(",", ":")))
    try:
        readiness = wait_for_container_configuration(
            url,
            token,
            expected_enabled=False,
            phase="normal",
        )
    except ReadinessError as error:
        LAST_HTTP = error.observation
        print(json.dumps({
            "phase": "normal-readiness",
            "status": "failed",
            "check": error.check,
            **error.diagnostics(token),
        }, separators=(",", ":")), file=sys.stderr)
        return True, False
    normal_health = readiness["observation"].payload
    print(json.dumps({
        "phase": "normal-readiness",
        "status": "passed",
        "httpStatus": readiness["observation"].http_status,
        "attempts": readiness["attempts"],
        "quietRestartWait": readiness["quietRestartWait"],
        "quietSeconds": readiness.get("quietSeconds", 0),
        "driverBootId": normal_health["driverBootId"],
        "driverVersion": normal_health["driverVersion"],
        "contractVersion": normal_health["contractVersion"],
        "identityDigests": normal_health["identityDigests"],
        "workerVerifyStopEngineOnceEnabled": normal_health["workerVerifyStopEngineOnceEnabled"],
        "verifyStopEngineOnceEnabled": normal_health["verifyStopEngineOnceEnabled"],
    }, separators=(",", ":")))
    try:
        result = subprocess.run(
            [sys.executable, str(SMOKE_SCRIPT)],
            cwd=CLOUD_DIR,
            env=child_environment(),
            capture_output=True,
            text=True,
            timeout=900,
        )
    except (OSError, subprocess.SubprocessError):
        print(json.dumps({"phase": "normal-smoke", "status": "failed", "check": "smoke-process"}, separators=(",", ":")), file=sys.stderr)
        return True, False
    if result.returncode != 0:
        print(json.dumps({
            "phase": "normal-smoke",
            "status": "failed",
            "diagnostics": smoke_diagnostics(result.stderr),
        }, separators=(",", ":")), file=sys.stderr)
        return True, False
    fixtures: list[str] = []
    for line in result.stdout.splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and isinstance(value.get("id"), str):
            fixtures.append(value["id"])
    smoke_succeeded = len(fixtures) == 4
    print(json.dumps({
        "phase": "normal-smoke",
        "status": "passed" if smoke_succeeded else "failed",
        "fixtureIds": fixtures,
    }, separators=(",", ":")))
    return True, smoke_succeeded


def main() -> int:
    global LAST_HTTP
    verification_attempted = False
    verification_ok = False
    deployed = False
    smoke_passed = False
    phase = "inputs"
    url = ""
    token = os.environ.get("ANALYSIS_INTERNAL_TOKEN", "")
    try:
        url, token = validate_inputs()
        phase = "timeout-and-recovery"
        verification_attempted = True
        run_timeout_and_recovery(url, token)
        verification_ok = True
    except ReadinessError as error:
        LAST_HTTP = error.observation
        print(json.dumps({
            "phase": phase,
            "status": "failed",
            "check": error.check,
            **error.diagnostics(token),
        }, separators=(",", ":")), file=sys.stderr)
    except VerificationError as error:
        if error.observation is not None:
            LAST_HTTP = error.observation
        print(json.dumps({
            "phase": phase,
            "status": "failed",
            "check": error.check,
            **LAST_HTTP.diagnostics(token),
        }, separators=(",", ":")), file=sys.stderr)
    except Exception:
        print(json.dumps({
            "phase": phase,
            "status": "failed",
            "check": "unexpected-error",
            **LAST_HTTP.diagnostics(token),
        }, separators=(",", ":")), file=sys.stderr)
    finally:
        if verification_attempted:
            deployed, smoke_passed = run_normal_deploy_and_smoke(url, token)
        else:
            print(json.dumps({
                "phase": "normal-deploy-and-smoke",
                "status": "skipped",
                "reason": "verification inputs were not accepted; no verification deployment was attempted",
            }, separators=(",", ":")))
    return 0 if verification_ok and deployed and smoke_passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
