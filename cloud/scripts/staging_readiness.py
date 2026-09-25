"""Bounded staging Container warm-up and non-secret failure diagnostics."""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


CLOUD_DIR = Path(__file__).resolve().parents[1]
WRANGLER_WRAPPER = CLOUD_DIR / "scripts/wrangler-staging.sh"
TARGET_CONTAINER = "meeshogi-analysis-mvp-staging-analysis"
READINESS_TIMEOUT_SECONDS = 600
READINESS_INTERVAL_SECONDS = 5


def _redact_text(value: str, token: str = "") -> str:
    public_key = os.environ.get("ANALYSIS_SSH_PUBLIC_KEY", "")
    secrets = [
        token,
        os.environ.get("ANALYSIS_INTERNAL_TOKEN", ""),
        public_key,
        os.environ.get("ANALYSIS_SSH_PRIVATE_KEY", ""),
    ]
    public_key_parts = public_key.split()
    if len(public_key_parts) >= 2:
        secrets.append(" ".join(public_key_parts[:2]))
    private_key_path = os.environ.get("ANALYSIS_SSH_PRIVATE_KEY", "")
    if private_key_path:
        try:
            path = Path(private_key_path).expanduser()
            key_stat = path.lstat()
            if path.is_file() and not path.is_symlink() and key_stat.st_size <= 16 * 1024:
                secrets.append(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError):
            pass
    for secret in secrets:
        if secret:
            value = value.replace(secret, "[redacted]")
    private_marker = re.search(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----", value)
    if private_marker:
        value = value[:private_marker.start()] + "[redacted]"
    return value


@dataclass
class HttpObservation:
    http_status: int | None
    payload: dict[str, Any]
    body_preview: str | None = None

    def diagnostics(self) -> dict[str, Any]:
        failure = self.payload.get("failure")
        failure_code = failure.get("code") if isinstance(failure, dict) else None
        response_status = self.payload.get("status")
        values: dict[str, Any] = {
            "httpStatus": self.http_status,
            "responseStatus": (
                _redact_text(response_status)
                if isinstance(response_status, str)
                else (None if response_status is None else "invalid")
            ),
            "failureCode": (
                _redact_text(failure_code)
                if isinstance(failure_code, str)
                else (None if failure_code is None else "invalid")
            ),
        }
        if self.body_preview is not None:
            values["bodyPreview"] = _redact_text(self.body_preview)
        return values


class ReadinessError(Exception):
    def __init__(self, check: str, observation: HttpObservation, instance_states: list[dict[str, Any]]):
        super().__init__(check)
        self.check = check
        self.observation = observation
        self.instance_states = instance_states

    def diagnostics(self) -> dict[str, Any]:
        return {**self.observation.diagnostics(), "instanceStates": self.instance_states}


def _redact_body(body: str, token: str) -> str:
    return _redact_text(body[:200], token)


def post_analysis(url: str, token: str, sfen: str, timeout: float = 120) -> HttpObservation:
    body = json.dumps({"sfen": sfen}, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        url.rstrip("/") + "/internal/analyze",
        data=body,
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "User-Agent": "meeshogi-staging-operator/1",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            http_status = response.status
            raw = response.read()
    except urllib.error.HTTPError as error:
        http_status = error.code
        try:
            raw = error.read()
        except Exception:
            return HttpObservation(http_status, {})
    except Exception:
        return HttpObservation(None, {})
    text = raw.decode("utf-8", errors="replace")
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return HttpObservation(http_status, {}, _redact_body(text, token))
    if not isinstance(payload, dict):
        return HttpObservation(http_status, {}, _redact_body(text, token))
    return HttpObservation(http_status, payload)


def _wrangler_environment(env: dict[str, str]) -> dict[str, str]:
    child_env = env.copy()
    child_env.setdefault("WRANGLER_WRITE_LOGS", "false")
    child_env.pop("ANALYSIS_INTERNAL_TOKEN", None)
    child_env.pop("ANALYSIS_SSH_PRIVATE_KEY", None)
    return child_env


def _wrangler_json(
    args: list[str],
    env: dict[str, str],
    timeout_seconds: float = 60,
) -> list[dict[str, Any]]:
    try:
        result = subprocess.run(
            ["bash", str(WRANGLER_WRAPPER), *args],
            cwd=CLOUD_DIR,
            env=_wrangler_environment(env),
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeError("wrangler-command") from error
    if result.returncode != 0:
        raise RuntimeError("wrangler-command")
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("wrangler-json") from error
    if isinstance(value, dict):
        value = value.get("instances", value.get("containers"))
    if not isinstance(value, list) or any(not isinstance(row, dict) for row in value):
        raise RuntimeError("wrangler-json-shape")
    return value


def resolve_app_id(env: dict[str, str], timeout_seconds: float = 60) -> str:
    containers = _wrangler_json(["containers", "list", "--json"], env, timeout_seconds)
    matches = [row for row in containers if row.get("name") == TARGET_CONTAINER]
    if len(matches) != 1 or not isinstance(matches[0].get("id"), str) or not matches[0]["id"]:
        raise RuntimeError("container-app-id")
    return matches[0]["id"]


def get_instance_states(
    app_id: str,
    env: dict[str, str],
    timeout_seconds: float = 60,
) -> list[dict[str, Any]]:
    rows = _wrangler_json(["containers", "instances", app_id, "--json"], env, timeout_seconds)
    return [
        {"id": row.get("id"), "state": row.get("state", "unknown")}
        for row in rows
    ]


def collect_instance_states(
    app_id: str | None,
    env: dict[str, str],
    timeout_seconds: float = 5,
) -> list[dict[str, Any]]:
    if not app_id:
        return [{"state": "unavailable"}]
    try:
        return get_instance_states(app_id, env, timeout_seconds)
    except RuntimeError:
        return [{"state": "unavailable"}]


def wait_until_ready(
    url: str,
    token: str,
    sfen: str,
    env: dict[str, str],
    timeout_seconds: int = READINESS_TIMEOUT_SECONDS,
    interval_seconds: int = READINESS_INTERVAL_SECONDS,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    empty_observation = HttpObservation(None, {})
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ReadinessError("analysis-readiness-timeout", empty_observation, [{"state": "unavailable"}])
    try:
        app_id = resolve_app_id(env, min(60, remaining))
    except RuntimeError as error:
        raise ReadinessError(str(error), empty_observation, [{"state": "unavailable"}]) from error

    attempts = 0
    last_observation = empty_observation
    warmup_succeeded = False
    while time.monotonic() < deadline:
        remaining = deadline - time.monotonic()
        last_observation = post_analysis(url, token, sfen, timeout=min(30, max(1, remaining)))
        attempts += 1
        if (
            time.monotonic() < deadline
            and last_observation.http_status == 200
            and last_observation.payload.get("status") == "success"
            and last_observation.payload.get("sfen") == sfen
            and isinstance(last_observation.payload.get("identity"), dict)
        ):
            warmup_succeeded = True
            break
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(min(interval_seconds, remaining))
    if not warmup_succeeded:
        states = collect_instance_states(app_id, env)
        raise ReadinessError("analysis-readiness-timeout", last_observation, states)

    last_states: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            last_states = get_instance_states(app_id, env, min(60, remaining))
        except RuntimeError:
            last_states = [{"state": "unavailable"}]
        running = [row for row in last_states if row.get("state") == "running"]
        if len(running) == 1 and isinstance(running[0].get("id"), str) and running[0]["id"]:
            return {
                "appId": app_id,
                "instanceId": running[0]["id"],
                "attempts": attempts,
                "observation": last_observation,
                "instanceStates": last_states,
            }
        if len(running) > 1:
            raise ReadinessError("multiple-running-instances", last_observation, last_states)
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(min(interval_seconds, remaining))
    raise ReadinessError("container-instance-not-running", last_observation, last_states)
