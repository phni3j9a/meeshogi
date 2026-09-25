"""HTTP-only staging warm-up and non-secret failure diagnostics."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


READINESS_TIMEOUT_SECONDS = 600
READINESS_INTERVAL_SECONDS = 5
OPERATOR_USER_AGENT = "meeshogi-staging-operator/1"


def _redact(value: str, token: str) -> str:
    return value.replace(token, "[redacted]") if token else value


@dataclass
class HttpObservation:
    http_status: int | None
    payload: dict[str, Any]
    body_preview: str | None = None

    def diagnostics(self, token: str = "") -> dict[str, Any]:
        failure = self.payload.get("failure")
        failure_code = failure.get("code") if isinstance(failure, dict) else None
        response_status = self.payload.get("status")
        values: dict[str, Any] = {
            "httpStatus": self.http_status,
            "responseStatus": _redact(response_status, token) if isinstance(response_status, str) else None,
            "failureCode": _redact(failure_code, token) if isinstance(failure_code, str) else None,
        }
        if self.body_preview is not None:
            values["bodyPreview"] = _redact(self.body_preview, token)
        return values


class ReadinessError(Exception):
    def __init__(self, check: str, observation: HttpObservation):
        super().__init__(check)
        self.check = check
        self.observation = observation

    def diagnostics(self, token: str = "") -> dict[str, Any]:
        return self.observation.diagnostics(token)


def post_analysis(url: str, token: str, sfen: str, timeout: float = 120) -> HttpObservation:
    body = json.dumps({"sfen": sfen}, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        url.rstrip("/") + "/internal/analyze",
        data=body,
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "User-Agent": OPERATOR_USER_AGENT,
        },
        method="POST",
    )
    return _read_json_response(request, token, timeout)


def get_worker_health(url: str, token: str, timeout: float = 10) -> HttpObservation:
    request = urllib.request.Request(
        url.rstrip("/") + "/internal/health",
        headers={
            "Authorization": "Bearer " + token,
            "User-Agent": OPERATOR_USER_AGENT,
        },
        method="GET",
    )
    return _read_json_response(request, token, timeout)


def _read_json_response(request: urllib.request.Request, token: str, timeout: float) -> HttpObservation:
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
        return HttpObservation(http_status, {}, _redact(text[:200], token))
    if not isinstance(payload, dict):
        return HttpObservation(http_status, {}, _redact(text[:200], token))
    return HttpObservation(http_status, payload)


def wait_until_ready(
    url: str,
    token: str,
    sfen: str,
    timeout_seconds: int = READINESS_TIMEOUT_SECONDS,
    interval_seconds: int = READINESS_INTERVAL_SECONDS,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    empty_observation = HttpObservation(None, {})
    attempts = 0
    last_observation = empty_observation
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
            return {"attempts": attempts, "observation": last_observation}
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(min(interval_seconds, remaining))
    raise ReadinessError("analysis-readiness-timeout", last_observation)
