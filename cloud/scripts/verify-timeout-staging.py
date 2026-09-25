#!/usr/bin/env python3
"""Verify staging engine timeout/reaping over temporary Wrangler Container SSH."""

from __future__ import annotations

import json
import os
import queue
import re
import select
import shlex
import shutil
import stat
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any
from staging_readiness import (
    HttpObservation,
    ReadinessError,
    collect_instance_states,
    post_analysis,
    wait_until_ready,
)

CLOUD_DIR = Path(__file__).resolve().parents[1]
WRANGLER_WRAPPER = CLOUD_DIR / "scripts/wrangler-staging.sh"
DEPLOY_SCRIPT = CLOUD_DIR / "scripts/deploy-staging.sh"
SMOKE_SCRIPT = CLOUD_DIR / "scripts/smoke-staging.py"
STARTPOS = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1"
LAST_HTTP = HttpObservation(None, {})
LAST_INSTANCE_STATES: list[dict[str, Any]] = [{"state": "unavailable"}]
LAST_APP_ID: str | None = None


class VerificationError(Exception):
    pass


def child_environment(include_ssh_key: bool, include_token: bool = False) -> dict[str, str]:
    env = os.environ.copy()
    env.setdefault("WRANGLER_WRITE_LOGS", "false")
    env.pop("ANALYSIS_SSH_PRIVATE_KEY", None)
    if not include_token:
        env.pop("ANALYSIS_INTERNAL_TOKEN", None)
    if not include_ssh_key:
        env.pop("ANALYSIS_SSH_PUBLIC_KEY", None)
    return env


def validate_inputs() -> tuple[str, str, Path]:
    url = os.environ.get("ANALYSIS_STAGING_URL", "")
    token = os.environ.get("ANALYSIS_INTERNAL_TOKEN", "")
    public_key = os.environ.get("ANALYSIS_SSH_PUBLIC_KEY", "")
    private_key_value = os.environ.get("ANALYSIS_SSH_PRIVATE_KEY", "")
    if not url.startswith("https://") or not token or not public_key or not private_key_value:
        raise VerificationError("required-inputs")
    private_key = Path(private_key_value).expanduser()
    try:
        key_stat = private_key.lstat()
    except OSError as error:
        raise VerificationError("private-key") from error
    if stat.S_ISLNK(key_stat.st_mode) or not stat.S_ISREG(key_stat.st_mode) or key_stat.st_mode & 0o077:
        raise VerificationError("private-key-permissions")
    if not shutil.which("ssh") or not shutil.which("ssh-keygen"):
        raise VerificationError("openssh-tools")
    try:
        derived = subprocess.run(
            ["ssh-keygen", "-y", "-f", str(private_key)],
            check=True,
            capture_output=True,
            text=True,
            stdin=subprocess.DEVNULL,
            timeout=10,
        ).stdout.strip().split()
    except (subprocess.SubprocessError, OSError) as error:
        raise VerificationError("private-key-unusable") from error
    supplied = public_key.split()
    if len(derived) < 2 or len(supplied) < 2 or derived[:2] != supplied[:2] or supplied[0] != "ssh-ed25519":
        raise VerificationError("key-pair-mismatch")
    return url.rstrip("/"), token, private_key


def request_analysis(url: str, token: str) -> tuple[int | None, dict[str, Any]]:
    global LAST_HTTP
    LAST_HTTP = post_analysis(url, token, STARTPOS)
    return LAST_HTTP.http_status, LAST_HTTP.payload


def start_background_request(url: str, token: str) -> tuple[threading.Thread, queue.Queue[tuple[int | None, dict[str, Any]]]]:
    global LAST_HTTP
    LAST_HTTP = HttpObservation(None, {})
    result: queue.Queue[tuple[int | None, dict[str, Any]]] = queue.Queue(maxsize=1)
    worker = threading.Thread(target=lambda: result.put(request_analysis(url, token)), daemon=True)
    worker.start()
    return worker, result


def finish_background_request(
    worker: threading.Thread,
    result: queue.Queue[tuple[int | None, dict[str, Any]]],
) -> tuple[int, dict[str, Any]]:
    worker.join(timeout=125)
    if worker.is_alive():
        raise VerificationError("analysis-response-timeout")
    status, payload = result.get_nowait()
    if status is None:
        raise VerificationError("analysis-transport")
    return status, payload


def start_ssh_command(
    instance_id: str,
    private_key: Path,
    remote_script: str,
    env: dict[str, str],
) -> subprocess.Popen[str]:
    proxy_command = shlex.join([
        "bash", str(WRANGLER_WRAPPER), "containers", "ssh", instance_id, "--stdio",
    ])
    remote_command = "sh -c " + shlex.quote(remote_script)
    command = [
        "ssh",
        "-i", str(private_key),
        "-o", "IdentitiesOnly=yes",
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=25",
        "-o", "ServerAliveInterval=10",
        "-o", "ServerAliveCountMax=3",
        "-o", f"ProxyCommand={proxy_command}",
        "cloudchamber@127.0.0.1",
        remote_command,
    ]
    try:
        process = subprocess.Popen(
            command,
            cwd=CLOUD_DIR,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
    except OSError as error:
        raise VerificationError("ssh-start") from error
    if process.stdout is None:
        process.kill()
        raise VerificationError("ssh-output")
    ready, _, _ = select.select([process.stdout], [], [], 50)
    if not ready:
        process.kill()
        process.communicate()
        raise VerificationError("ssh-connect-timeout")
    marker = process.stdout.readline().rstrip("\r\n")
    if marker != "SSH_READY":
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
        raise VerificationError("ssh-connect")
    return process


def finish_ssh_command(process: subprocess.Popen[str]) -> str:
    try:
        stdout, _ = process.communicate(timeout=90)
    except subprocess.TimeoutExpired as error:
        process.kill()
        process.communicate()
        raise VerificationError("ssh-command-timeout") from error
    if process.returncode != 0:
        raise VerificationError("ssh-command")
    return stdout


def wait_for_engine_script(stop: bool) -> str:
    action = 'kill -STOP "$pid" || exit 22' if stop else ":"
    marker = "STOPPED_PID" if stop else "ENGINE_PID"
    lines = [
        "printf 'SSH_READY\\n'",
        "pid=''",
        "n=0",
        'while [ "$n" -lt 600 ]; do',
        '  for comm in /proc/[0-9]*/comm; do',
        '    [ -r "$comm" ] || continue',
        '    IFS= read -r name < "$comm" || continue',
        '    if [ "$name" = engine ]; then',
        '      pid=${comm#/proc/}',
        '      pid=${pid%/comm}',
        "      break 2",
        "    fi",
        "  done",
        '  n=$((n + 1))',
        "  sleep 0.1",
        "done",
        '[ -n "$pid" ] || exit 19',
        "n=0",
        "ready=0",
        'while [ "$n" -lt 6000 ]; do',
        '  [ -r "/proc/$pid/stat" ] || exit 20',
        '  IFS=" " read -r stat_pid stat_comm state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime < "/proc/$pid/stat" || exit 20',
        '  ticks=$((utime + stime))',
        '  if [ "$ticks" -ge 5 ] && [ "$state" = S ]; then ready=1; break; fi',
        '  n=$((n + 1))',
        "  sleep 0.01",
        "done",
        '[ "$ready" -eq 1 ] || exit 21',
        "n=0",
        'while [ "$n" -lt 6000 ]; do',
        '  [ -r "/proc/$pid/stat" ] || exit 20',
        '  IFS=" " read -r stat_pid stat_comm state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime < "/proc/$pid/stat" || exit 20',
        '  [ "$state" = S ] || break',
        '  n=$((n + 1))',
        "  sleep 0.01",
        "done",
        'sleep 0.02',
        f"{action}",
        f"printf '{marker}=%s\\n' \"$pid\"",
        "exit 0",
    ]
    return "\n".join(lines) + "\n"


def parse_pid(output: str, marker: str) -> int:
    match = re.search(rf"^{marker}=([1-9][0-9]*)$", output, re.MULTILINE)
    if not match:
        raise VerificationError("engine-pid")
    return int(match.group(1))


def process_reaped(instance_id: str, pid: int, private_key: Path, env: dict[str, str]) -> bool:
    lines = [
        "printf 'SSH_READY\\n'",
        f"if [ ! -e /proc/{pid} ]; then printf 'ENGINE_REAPED\\n'; exit 0; fi",
        "printf 'ENGINE_PRESENT\\n'",
        "exit 21",
    ]
    process = start_ssh_command(instance_id, private_key, "\n".join(lines) + "\n", env)
    return finish_ssh_command(process).strip() == "ENGINE_REAPED"


def require_analysis_identity(payload: dict[str, Any], expected: dict[str, Any] | None = None) -> dict[str, Any]:
    identity = payload.get("identity")
    if not isinstance(identity, dict) or not identity or any(not isinstance(value, str) for value in identity.values()):
        raise VerificationError("analysis-identity")
    if expected is not None and identity != expected:
        raise VerificationError("analysis-identity-changed")
    return identity


def verify_timeout(url: str, token: str, private_key: Path) -> None:
    global LAST_APP_ID, LAST_INSTANCE_STATES, LAST_HTTP
    env = child_environment(include_ssh_key=True)
    readiness = wait_until_ready(url, token, STARTPOS, env)
    LAST_HTTP = readiness["observation"]
    LAST_APP_ID = readiness["appId"]
    LAST_INSTANCE_STATES = readiness["instanceStates"]
    instance_id = readiness["instanceId"]
    require_analysis_identity(LAST_HTTP.payload)
    print(json.dumps({
        "phase": "readiness",
        "httpStatus": LAST_HTTP.http_status,
        "status": LAST_HTTP.payload.get("status"),
        "warmupAttempts": readiness["attempts"],
        "instanceStates": LAST_INSTANCE_STATES,
    }, separators=(",", ":")))

    stop_script = start_ssh_command(instance_id, private_key, wait_for_engine_script(stop=True), env)
    first_worker, first_result = start_background_request(url, token)
    stop_output = finish_ssh_command(stop_script)
    stopped_pid = parse_pid(stop_output, "STOPPED_PID")
    timeout_status, timeout_response = finish_background_request(first_worker, first_result)
    if timeout_status != 504 or timeout_response.get("status") != "failure":
        raise VerificationError("timeout-http-status")
    timeout_failure = timeout_response.get("failure")
    if not isinstance(timeout_failure, dict) or timeout_failure.get("code") != "timeout":
        raise VerificationError("timeout-failure-code")
    timeout_identity = require_analysis_identity(timeout_response)
    timeout_meta = timeout_response.get("meta")
    timeout_elapsed = timeout_meta.get("elapsedMs") if isinstance(timeout_meta, dict) else None
    if not isinstance(timeout_elapsed, int) or timeout_elapsed <= 0:
        raise VerificationError("timeout-elapsed")
    if not process_reaped(instance_id, stopped_pid, private_key, env):
        raise VerificationError("stopped-engine-not-reaped")
    print(json.dumps({
        "phase": "timeout",
        "httpStatus": timeout_status,
        "status": timeout_response["status"],
        "failureCode": timeout_failure["code"],
        "stoppedPid": stopped_pid,
        "reaped": True,
        "elapsedMs": timeout_elapsed,
        "identity": timeout_identity,
    }, separators=(",", ":")))

    recovery_ssh = start_ssh_command(instance_id, private_key, wait_for_engine_script(stop=False), env)
    recovery_worker, recovery_result = start_background_request(url, token)
    recovery_pid = parse_pid(finish_ssh_command(recovery_ssh), "ENGINE_PID")
    recovery_status, recovery_response = finish_background_request(recovery_worker, recovery_result)
    if recovery_status != 200 or recovery_response.get("status") != "success":
        raise VerificationError("recovery-http-status")
    recovery_identity = require_analysis_identity(recovery_response, timeout_identity)
    candidates = recovery_response.get("candidates")
    recovery_meta = recovery_response.get("meta")
    recovery_elapsed = recovery_meta.get("elapsedMs") if isinstance(recovery_meta, dict) else None
    if not isinstance(candidates, list) or not candidates or not isinstance(recovery_elapsed, int) or recovery_elapsed <= 0:
        raise VerificationError("recovery-result")
    if recovery_pid == stopped_pid:
        raise VerificationError("recovery-engine-not-fresh")
    if not process_reaped(instance_id, recovery_pid, private_key, env):
        raise VerificationError("recovery-engine-not-reaped")
    print(json.dumps({
        "phase": "recovery",
        "httpStatus": recovery_status,
        "status": recovery_response["status"],
        "enginePid": recovery_pid,
        "freshEngine": True,
        "reaped": True,
        "elapsedMs": recovery_elapsed,
        "identity": recovery_identity,
    }, separators=(",", ":")))


def redeploy_normal_and_smoke() -> tuple[bool, bool]:
    global LAST_APP_ID, LAST_INSTANCE_STATES, LAST_HTTP
    env = child_environment(include_ssh_key=False, include_token=True)
    try:
        deploy = subprocess.run(
            ["bash", str(DEPLOY_SCRIPT)],
            cwd=CLOUD_DIR,
            env=env,
            capture_output=True,
            text=True,
            timeout=900,
        )
        deployed = deploy.returncode == 0
    except (OSError, subprocess.SubprocessError):
        deployed = False
    if deployed:
        if not env.get("ANALYSIS_STAGING_URL") or not env.get("ANALYSIS_INTERNAL_TOKEN"):
            LAST_HTTP = HttpObservation(None, {})
            LAST_INSTANCE_STATES = collect_instance_states(LAST_APP_ID, env)
            print(json.dumps({
                "phase": "normal-readiness",
                "status": "failed",
                "check": "required-inputs",
                **diagnostics(),
            }, separators=(",", ":")), file=sys.stderr)
            return True, False
        try:
            readiness = wait_until_ready(
                env["ANALYSIS_STAGING_URL"],
                env["ANALYSIS_INTERNAL_TOKEN"],
                STARTPOS,
                env,
            )
            LAST_HTTP = readiness["observation"]
            LAST_APP_ID = readiness["appId"]
            LAST_INSTANCE_STATES = readiness["instanceStates"]
            print(json.dumps({
                "phase": "normal-readiness",
                "httpStatus": LAST_HTTP.http_status,
                "status": LAST_HTTP.payload.get("status"),
                "warmupAttempts": readiness["attempts"],
                "instanceStates": LAST_INSTANCE_STATES,
            }, separators=(",", ":")))
        except ReadinessError as error:
            LAST_HTTP = error.observation
            LAST_INSTANCE_STATES = error.instance_states
            print(json.dumps({
                "phase": "normal-readiness",
                "status": "failed",
                "check": error.check,
                **error.diagnostics(),
            }, separators=(",", ":")), file=sys.stderr)
            return True, False
    else:
        LAST_HTTP = HttpObservation(None, {})
        LAST_INSTANCE_STATES = collect_instance_states(LAST_APP_ID, env)
        print(json.dumps({
            "phase": "normal-deploy",
            "status": "failed",
            "check": "deploy",
            **diagnostics(),
        }, separators=(",", ":")), file=sys.stderr)
        return False, False
    try:
        smoke = subprocess.run(
            [sys.executable, str(SMOKE_SCRIPT)],
            cwd=CLOUD_DIR,
            env=env,
            capture_output=True,
            text=True,
            timeout=300,
        )
        smoke_passed = deployed and smoke.returncode == 0
        if not smoke_passed:
            smoke_failure = None
            for line in reversed(smoke.stderr.splitlines()):
                try:
                    parsed = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(parsed, dict) and "httpStatus" in parsed and "instanceStates" in parsed:
                    smoke_failure = parsed
                    break
            print(json.dumps({
                "phase": "normal-smoke",
                "status": "failed",
                "diagnostics": smoke_failure or diagnostics(),
            }, separators=(",", ":")), file=sys.stderr)
    except (OSError, subprocess.SubprocessError):
        smoke_passed = False
        print(json.dumps({
            "phase": "normal-smoke",
            "status": "failed",
            "check": "smoke-process",
            "diagnostics": diagnostics(),
        }, separators=(",", ":")), file=sys.stderr)
    return deployed, smoke_passed


def diagnostics() -> dict[str, Any]:
    return {**LAST_HTTP.diagnostics(), "instanceStates": LAST_INSTANCE_STATES}


def refresh_instance_diagnostics() -> None:
    global LAST_INSTANCE_STATES
    LAST_INSTANCE_STATES = collect_instance_states(LAST_APP_ID, child_environment(include_ssh_key=False))


def main() -> int:
    global LAST_HTTP, LAST_INSTANCE_STATES
    phase = "inputs"
    verification_ok = False
    try:
        url, token, private_key = validate_inputs()
        phase = "timeout-and-recovery"
        verify_timeout(url, token, private_key)
        verification_ok = True
    except ReadinessError as error:
        LAST_HTTP = error.observation
        LAST_INSTANCE_STATES = error.instance_states
        print(json.dumps({"phase": phase, "status": "failed", "check": error.check, **error.diagnostics()}, separators=(",", ":")), file=sys.stderr)
    except VerificationError as error:
        refresh_instance_diagnostics()
        print(json.dumps({"phase": phase, "status": "failed", "check": str(error), **diagnostics()}, separators=(",", ":")), file=sys.stderr)
    except Exception:
        refresh_instance_diagnostics()
        print(json.dumps({"phase": phase, "status": "failed", "check": "unexpected-error", **diagnostics()}, separators=(",", ":")), file=sys.stderr)
    finally:
        phase = "normal-redeploy-and-smoke"
        deployed, smoke_passed = redeploy_normal_and_smoke()
        print(json.dumps({
            "phase": phase,
            "deployWithoutSsh": "passed" if deployed else "failed",
            "smoke": "passed" if smoke_passed else "failed",
            **({"diagnostics": diagnostics()} if not deployed or not smoke_passed else {}),
        }, separators=(",", ":")))
    return 0 if verification_ok and deployed and smoke_passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
