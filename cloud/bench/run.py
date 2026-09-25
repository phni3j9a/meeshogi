#!/usr/bin/env python3
"""Serial, resumable operator runner for the Issue 20 benchmark endpoint."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
from targeting import NORMAL_CONTAINER_TARGET, SINGLETON_TARGET_ID, targets_for_run


DEFAULT_CONDITIONS = HERE / "conditions.json"
DEFAULT_POSITIONS = HERE / "dataset" / "positions.json"
DEFAULT_GAME = HERE / "dataset" / "game.json"
USER_AGENT = "meeshogi-issue20-benchmark/1.0"
MAX_RESPONSE_BYTES = 1_048_576
IDENTITY_DIGEST_KEYS = (
    "engineSha256", "weightSha256", "optionsSha256", "sourceArchiveSha256", "sourceTreeSha256",
)
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
BUILD_ID_RE = re.compile(r"^[0-9a-f]{32}$")
GIT_COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
WORKER_FAILURE_CODES = frozenset({
    "auth_unconfigured", "unauthorized", "invalid", "busy", "timeout",
    "identity_mismatch", "instance_mismatch", "engine_error",
})
WORKER_FAILURE_DETAIL_RE = re.compile(
    r"^check=[A-Za-z0-9_.-]{1,64}; driverStatus=[A-Za-z0-9_.-]{1,64}; "
    r"(?:failureCode=[A-Za-z0-9_.-]{1,64}; )?containerHttpStatus=[0-9]{3}$"
)
SAFE_FAILURE_MESSAGE_RE = re.compile(r"^[^\x00-\x1f\x7f]{1,256}$")


def wall_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def canonical_sha256(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return sha256_text(encoded)


def pinned_image_digest(image_ref: str) -> str:
    match = re.search(r"@sha256:([0-9a-f]{64})$", image_ref)
    if not match:
        raise ValueError("--image-ref must be pinned to an @sha256:<64 lowercase hex> digest")
    return match.group(1)


def safe_identity_digests(value: Any) -> dict[str, str] | None:
    if not isinstance(value, dict) or any(
        not isinstance(value.get(key), str) or not SHA256_RE.fullmatch(value[key])
        for key in IDENTITY_DIGEST_KEYS
    ):
        return None
    return {key: value[key] for key in IDENTITY_DIGEST_KEYS}


def safe_worker_failure(value: Any) -> dict[str, Any] | None:
    """Retain only the Worker v1 failure envelope, never driver identity or request data."""
    if not isinstance(value, dict) or value.get("schemaVersion") != 1 or value.get("status") != "failure":
        return None
    if any(key in value for key in ("identity", "identityDigests", "buildId", "gitCommit", "driverBootId")):
        return None
    failure = value.get("failure")
    if not isinstance(failure, dict):
        return None
    code = failure.get("code")
    message = failure.get("message")
    if not isinstance(code, str) or code not in WORKER_FAILURE_CODES or not isinstance(message, str) or not SAFE_FAILURE_MESSAGE_RE.fullmatch(message):
        return None
    safe_failure: dict[str, str] = {"code": code, "message": message}
    detail = failure.get("detail")
    if isinstance(detail, str) and len(detail) <= 256 and WORKER_FAILURE_DETAIL_RE.fullmatch(detail):
        safe_failure["detail"] = detail
    return {"schemaVersion": 1, "status": "failure", "failure": safe_failure}


def normalize_response_identity(
    response: dict[str, Any] | None,
    expected_build_id: str,
    expected_git_commit: str,
    expected_identity_digests: dict[str, str],
    transport_error: str | None,
) -> tuple[dict[str, Any] | None, str | None, str | None, dict[str, Any] | None, bool]:
    worker_failure = safe_worker_failure(response)
    if worker_failure is not None:
        # Worker-created v1 failures carry no validated driver build identity.
        return None, None, transport_error, worker_failure, False

    response_build_id_raw = response.get("buildId") if isinstance(response, dict) else None
    response_build_id = (
        response_build_id_raw
        if isinstance(response_build_id_raw, str) and BUILD_ID_RE.fullmatch(response_build_id_raw)
        else None
    )
    if transport_error is None and response_build_id != expected_build_id:
        identity_error = "build-id-mismatch" if response_build_id is not None else "build-id-missing"
        return None, response_build_id, identity_error, None, False
    identity_confirmed = (
        isinstance(response, dict)
        and response_build_id == expected_build_id
        and response.get("gitCommit") == expected_git_commit
        and response.get("identityDigests") == expected_identity_digests
    )
    return response, response_build_id, transport_error, None, identity_confirmed


def fingerprint_endpoint(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("endpoint must be an http(s) URL without credentials, query, or fragment")
    host = f"[{parsed.hostname}]" if ":" in parsed.hostname else parsed.hostname
    if parsed.port is not None:
        host += f":{parsed.port}"
    return urlunsplit((parsed.scheme, host, parsed.path.rstrip("/"), "", ""))


def build_run_fingerprint(
    *,
    image_ref: str,
    expected_build_id: str,
    mode: str,
    endpoint: str,
    health: dict[str, Any],
    conditions_path: Path,
    dataset_path: Path,
    dataset_manifest_sha256: str,
    manifest_path: Path,
) -> dict[str, Any]:
    image_digest = pinned_image_digest(image_ref)
    if not BUILD_ID_RE.fullmatch(expected_build_id):
        raise ValueError("--expected-build-id must be 32 lowercase hex characters")
    if mode not in {"positions", "game", "cold"}:
        raise ValueError("benchmark mode is invalid")
    if health.get("buildId") != expected_build_id:
        raise ValueError("health response buildId does not match --expected-build-id; refusing a stale Container")
    git_commit = health.get("gitCommit")
    if not isinstance(git_commit, str) or not GIT_COMMIT_RE.fullmatch(git_commit):
        raise ValueError("health response lacks a valid image gitCommit")
    identities = safe_identity_digests(health.get("identityDigests"))
    if identities is None:
        raise ValueError("health response lacks the five validated identityDigests required for benchmark provenance")
    if health.get("status") != "ready" or not isinstance(health.get("driverVersion"), str) or not isinstance(health.get("contractVersion"), str):
        raise ValueError("health response is not ready or lacks driverVersion/contractVersion")
    container_identity = {
        "containerApp": health.get("containerApp"),
        "containerClass": health.get("containerClass"),
        "containerBinding": health.get("containerBinding"),
    }
    if any(not isinstance(value, str) or not value for value in container_identity.values()):
        raise ValueError("health response lacks benchmark Container app/class/binding identity")
    value = {
        "imageRef": image_ref,
        "imageDigest": image_digest,
        "buildId": expected_build_id,
        "gitCommit": git_commit,
        "mode": mode,
        "workerVersionId": health.get("workerVersionId"),
        "workerVersionTag": health.get("workerVersionTag"),
        "workerVersionTimestamp": health.get("workerVersionTimestamp"),
        "identityDigests": identities,
        "driverVersion": health["driverVersion"],
        "contractVersion": health["contractVersion"],
        **container_identity,
        "conditionsSha256": sha256_file(conditions_path),
        "datasetSha256": sha256_file(dataset_path),
        "datasetManifestSha256": dataset_manifest_sha256,
        "runManifestSha256": sha256_file(manifest_path),
        "endpoint": fingerprint_endpoint(endpoint),
    }
    value["fingerprintSha256"] = canonical_sha256(value)
    return value


def existing_run_fingerprint(path: Path, run_id: str) -> dict[str, Any] | None:
    if not path.exists():
        return None
    found: dict[str, Any] | None = None
    found_attempts: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(record, dict) or record.get("runId") != run_id:
                continue
            if record.get("recordType") == "run-start":
                if found is not None:
                    raise ValueError(f"run {run_id} has duplicate run-start fingerprints")
                fingerprint = record.get("fingerprint")
                if not isinstance(fingerprint, dict):
                    raise ValueError(f"run-start fingerprint is invalid at {path}:{line_number}")
                found = fingerprint
            elif record.get("recordType") in {"attempt", "attempt-start", "pending"}:
                found_attempts.append(record)
    if found is None and found_attempts:
        raise ValueError(f"run {run_id} has existing attempts but no immutable run-start fingerprint; refusing resume")
    if found is not None:
        for attempt in found_attempts:
            if (
                attempt.get("runFingerprintSha256") != found.get("fingerprintSha256")
                or attempt.get("imageDigest") != found.get("imageDigest")
                or attempt.get("identityDigests") != found.get("identityDigests")
                or attempt.get("expectedBuildId") != found.get("buildId")
                or attempt.get("mode") != found.get("mode")
            ):
                raise ValueError(f"run {run_id} contains an attempt that does not match its immutable fingerprint")
    return found


def assert_resume_fingerprint(existing: dict[str, Any] | None, expected: dict[str, Any], run_id: str) -> None:
    if existing is not None and existing != expected:
        raise ValueError(f"run {run_id} fingerprint changed; refusing to mix measurements")


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
    identity_record = safe_identity_digests(payload.get("identityDigests"))
    return {
        "httpStatus": http_status,
        "elapsedMs": elapsed_ms,
        "status": payload.get("status") if isinstance(payload.get("status"), str) else None,
        "buildId": payload.get("buildId") if isinstance(payload.get("buildId"), str) and BUILD_ID_RE.fullmatch(payload["buildId"]) else None,
        "gitCommit": payload.get("gitCommit") if isinstance(payload.get("gitCommit"), str) and GIT_COMMIT_RE.fullmatch(payload["gitCommit"]) else None,
        "driverBootId": payload.get("driverBootId") if isinstance(payload.get("driverBootId"), str) else None,
        "driverVersion": payload.get("driverVersion") if isinstance(payload.get("driverVersion"), str) else None,
        "contractVersion": payload.get("contractVersion") if isinstance(payload.get("contractVersion"), str) else None,
        "identityDigests": identity_record,
        "workerVersionId": payload.get("workerVersionId") if isinstance(payload.get("workerVersionId"), str) else None,
        "workerVersionTag": payload.get("workerVersionTag") if isinstance(payload.get("workerVersionTag"), str) else None,
        "workerVersionTimestamp": payload.get("workerVersionTimestamp") if isinstance(payload.get("workerVersionTimestamp"), str) else None,
        "expectedInstanceType": payload.get("expectedInstanceType") if isinstance(payload.get("expectedInstanceType"), str) else None,
        "workerExpectedInstanceType": payload.get("workerExpectedInstanceType") if isinstance(payload.get("workerExpectedInstanceType"), str) else None,
        "workerBenchmarkEnabled": payload.get("workerBenchmarkEnabled") if isinstance(payload.get("workerBenchmarkEnabled"), bool) else None,
        "targetId": payload.get("targetId") if isinstance(payload.get("targetId"), str) else None,
        "segmentId": payload.get("segmentId") if isinstance(payload.get("segmentId"), str) else None,
        "targetPurpose": payload.get("targetPurpose") if isinstance(payload.get("targetPurpose"), str) else None,
        "targetInstanceType": payload.get("targetInstanceType") if isinstance(payload.get("targetInstanceType"), str) else None,
        "expectedBuildId": payload.get("expectedBuildId") if isinstance(payload.get("expectedBuildId"), str) else None,
        "containerApp": payload.get("containerApp") if isinstance(payload.get("containerApp"), str) else None,
        "containerClass": payload.get("containerClass") if isinstance(payload.get("containerClass"), str) else None,
        "containerBinding": payload.get("containerBinding") if isinstance(payload.get("containerBinding"), str) else None,
        "containerState": payload.get("containerState") if isinstance(payload.get("containerState"), str) else None,
        "containerStateLastChangeWall": payload.get("containerStateLastChangeWall") if isinstance(payload.get("containerStateLastChangeWall"), str) else None,
        "runtime": {
            key: runtime_record.get(key)
            for key in (
                "osCpuCount", "affinityCpuCount", "cpuMax", "cpuQuota", "memoryMaxBytes",
                "memTotalBytes", "rootDiskTotalBytes",
            )
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


def target_seen(path: Path, target_id: str) -> bool:
    if not path.exists():
        return False
    with path.open("r", encoding="utf-8") as stream:
        for line in stream:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(record, dict) and record.get("targetId") == target_id:
                return True
            for field in ("healthAtRunStart", "healthSnapshot"):
                health = record.get(field) if isinstance(record, dict) else None
                if isinstance(health, dict) and health.get("targetId") == target_id:
                    return True
    return False


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
        if pending.get("mode") == "cold":
            pending["coldEvidence"] = {
                "label": "new-instance cold start",
                "targetId": pending.get("targetId"),
                "segmentId": pending.get("segmentId"),
                "unusedNameEvidence": pending.get("unusedNameEvidence"),
                "firstDispatchWall": pending.get("requestStartWall"),
                "firstHttpWallMs": None,
                "timeToFirstSuccessMs": None,
                "httpAttempts": [{
                    "attemptNo": 1,
                    "dispatchWall": pending.get("requestStartWall"),
                    "responseWall": None,
                    "httpStatus": None,
                    "httpElapsedMs": None,
                    "transportError": "interrupted-before-response",
                }],
                "responseBootId": None,
                "responseRuntime": None,
                "idleSleepResumeVerified": False,
            }
        with raw_path.open("a", encoding="utf-8") as stream:
            append_record(stream, pending)
    pending_path.unlink()
    return True


def health_snapshot(
    base_url: str,
    token: str,
    timeout: float = 15,
    target: dict[str, Any] | None = None,
) -> dict[str, Any]:
    start_wall = wall_now()
    path = "/internal/health"
    if target is not None:
        path = "/internal/benchmark/health?targetId=" + target["targetId"]
    status, payload, elapsed, error = request_json(base_url.rstrip("/") + path, token, "GET", timeout=timeout)
    result = safe_health(payload, status, elapsed)
    result["requestStartWall"] = start_wall
    result["requestEndWall"] = wall_now()
    if error:
        result["error"] = error
    return result


def stop_target(
    base_url: str,
    token: str,
    target: dict[str, Any],
    stream,
    *,
    expected_instance_type: str | None = None,
    expected_build_id: str | None = None,
    first_dispatch_wall: str | None = None,
) -> bool:
    started = wall_now()
    status, payload, elapsed_ms, error = request_json(
        base_url.rstrip("/") + "/internal/benchmark/stop",
        token,
        "POST",
        {"targetId": target["targetId"]},
        timeout=30,
    )
    ended = wall_now()
    confirmed = status == 200 and isinstance(payload, dict) and payload.get("stopped") is True
    response = payload if isinstance(payload, dict) else None
    append_record(stream, {
        "recordType": "target-stop",
        "targetId": target["targetId"],
        "segmentId": target.get("segmentId"),
        "targetPurpose": target.get("purpose"),
        "containerApp": target.get("containerApp"),
        "containerClass": target.get("containerClass"),
        "containerBinding": target.get("containerBinding"),
        "expectedInstanceType": expected_instance_type or target.get("instanceType"),
        "expectedBuildId": expected_build_id or target.get("buildId"),
        "firstDispatchWall": first_dispatch_wall,
        "requestStartWall": started,
        "requestEndWall": ended,
        "httpElapsedMs": elapsed_ms,
        "httpStatus": status,
        "transportError": error,
        "stopConfirmed": confirmed,
        "stopResponse": response,
        "preexistingStartTimeUnknown": target.get("purpose") == "capacity-control",
        "stopCheckedWithoutFetch": isinstance(payload, dict) and payload.get("stopCheckedWithoutFetch") is True,
    })
    return confirmed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path, help="run manifest JSON")
    parser.add_argument("--conditions", type=Path, default=DEFAULT_CONDITIONS)
    parser.add_argument("--dataset", type=Path, help="positions.json or game.json; inferred from mode when omitted")
    parser.add_argument("--base-url", default=os.environ.get("ANALYSIS_STAGING_URL"))
    parser.add_argument("--image-ref", default=os.environ.get("ANALYSIS_IMAGE_REF"), help="pinned container image ref (or ANALYSIS_IMAGE_REF)")
    parser.add_argument("--expected-build-id", default=os.environ.get("ANALYSIS_BUILD_ID"), help="32-hex build ID printed by build-push-image.sh (or ANALYSIS_BUILD_ID)")
    parser.add_argument("--output", required=True, type=Path, help="append-only raw JSONL path")
    args = parser.parse_args()

    token = os.environ.get("ANALYSIS_INTERNAL_TOKEN")
    if not token:
        parser.error("ANALYSIS_INTERNAL_TOKEN is required in the environment")
    if not args.base_url:
        parser.error("--base-url or ANALYSIS_STAGING_URL is required")
    if not args.image_ref:
        parser.error("--image-ref or ANALYSIS_IMAGE_REF is required")
    if not args.expected_build_id:
        parser.error("--expected-build-id or ANALYSIS_BUILD_ID is required")
    if not BUILD_ID_RE.fullmatch(args.expected_build_id):
        parser.error("--expected-build-id must be 32 lowercase hex characters")
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
        selected_types = {condition.get("instanceType") for condition in selected_conditions}
        if len(selected_types) != 1 or next(iter(selected_types)) not in {"standard-2", "standard-3"}:
            raise ValueError("each deployed run manifest must use exactly one Container instance type")
        expected_instance_type = next(iter(selected_types))
        allowed_targets = targets_for_run(run, conditions, args.expected_build_id, expected_instance_type)
        targets_by_purpose = {target["purpose"]: target for target in allowed_targets if target["purpose"] != "cold-trial"}
        cold_targets = {target["coldTrialNo"]: target for target in allowed_targets if target["purpose"] == "cold-trial"}
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
            if len(selected_conditions) != 1:
                raise ValueError("cold mode uses one selected condition per run manifest")
            if not cold_targets or not isinstance(targets_by_purpose.get("cold-preflight"), dict):
                raise ValueError("cold mode requires a finite preflight target and one target per trial")
        else:
            if not isinstance(targets_by_purpose.get("measurement"), dict):
                raise ValueError("warm mode requires one allowlisted measurement target")
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
    run_started = time.monotonic()
    run_started_wall = wall_now()
    singleton_target = {
        "targetId": SINGLETON_TARGET_ID,
        "segmentId": "preexisting-singleton",
        "purpose": "capacity-control",
        "instanceType": None,
        "buildId": None,
        **NORMAL_CONTAINER_TARGET,
    }
    with args.output.open("a", encoding="utf-8") as stream:
        if not stop_target(args.base_url, token, singleton_target, stream):
            print("singleton stop was not confirmed; stopping before allocating a measurement target", file=sys.stderr)
            return 2
    run_start_target = targets_by_purpose["cold-preflight"] if mode == "cold" else targets_by_purpose["measurement"]
    run_start_health = health_snapshot(args.base_url, token, target=run_start_target)
    run_start_target_stopped = False

    def release_run_start_target() -> bool:
        nonlocal run_start_target_stopped
        if run_start_target_stopped:
            return True
        with args.output.open("a", encoding="utf-8") as stream:
            confirmed = stop_target(
                args.base_url, token, run_start_target, stream,
                expected_instance_type=expected_instance_type,
                expected_build_id=args.expected_build_id,
                first_dispatch_wall=run_start_health.get("requestStartWall"),
            )
        run_start_target_stopped = confirmed
        return confirmed
    try:
        if (
            run_start_health.get("targetId") != run_start_target["targetId"]
            or run_start_health.get("segmentId") != run_start_target["segmentId"]
            or run_start_health.get("expectedBuildId") != args.expected_build_id
            or run_start_health.get("targetInstanceType") != expected_instance_type
            or run_start_health.get("workerExpectedInstanceType") != expected_instance_type
            or run_start_health.get("containerApp") != run_start_target["containerApp"]
            or run_start_health.get("containerClass") != run_start_target["containerClass"]
            or run_start_health.get("containerBinding") != run_start_target["containerBinding"]
        ):
            raise ValueError("benchmark health returned a different target, segment, Container class, or bound build ID")
        fingerprint = build_run_fingerprint(
            image_ref=args.image_ref,
            expected_build_id=args.expected_build_id,
            mode=mode,
            endpoint=args.base_url,
            health=run_start_health,
            conditions_path=args.conditions,
            dataset_path=dataset_path,
            dataset_manifest_sha256=dataset["manifestSha256"],
            manifest_path=args.manifest,
        )
        previous_fingerprint = existing_run_fingerprint(args.output, run["runId"])
        assert_resume_fingerprint(previous_fingerprint, fingerprint, run["runId"])
    except (OSError, ValueError) as error:
        release_run_start_target()
        print(f"cannot establish benchmark provenance: {error}", file=sys.stderr)
        return 2
    pending_path = args.output.with_name(args.output.name + ".pending.json")
    pending_record: dict[str, Any] | None = None
    if pending_path.exists():
        try:
            pending_record = load_json(pending_path)
        except (OSError, json.JSONDecodeError, ValueError) as error:
            release_run_start_target()
            print(f"cannot read pending attempt: {type(error).__name__}", file=sys.stderr)
            return 2
        if pending_record.get("runId") != run["runId"]:
            release_run_start_target()
            print("cannot recover pending attempt for a different runId", file=sys.stderr)
            return 2
        if (
            pending_record.get("runFingerprintSha256") != fingerprint["fingerprintSha256"]
            or pending_record.get("imageDigest") != fingerprint["imageDigest"]
            or pending_record.get("identityDigests") != fingerprint["identityDigests"]
        ):
            release_run_start_target()
            print("pending attempt fingerprint changed; refusing to recover it", file=sys.stderr)
            return 2
    if previous_fingerprint is None:
        with args.output.open("a", encoding="utf-8") as stream:
            append_record(stream, {
                "recordType": "run-start",
                "runId": run["runId"],
                "mode": mode,
                "expectedBuildId": args.expected_build_id,
                "containerApp": run_start_target["containerApp"],
                "containerClass": run_start_target["containerClass"],
                "containerBinding": run_start_target["containerBinding"],
                "runStartedWall": run_started_wall,
                "fingerprint": fingerprint,
                "healthAtRunStart": run_start_health,
            })
    if previous_fingerprint is not None:
        with args.output.open("a", encoding="utf-8") as stream:
            append_record(stream, {
                "recordType": "run-resume-check",
                "runId": run["runId"],
                "mode": mode,
                "expectedBuildId": args.expected_build_id,
                "containerApp": run_start_target["containerApp"],
                "containerClass": run_start_target["containerClass"],
                "containerBinding": run_start_target["containerBinding"],
                "runFingerprintSha256": fingerprint["fingerprintSha256"],
                "healthAtRunStart": run_start_health,
            })
    if mode == "cold":
        with args.output.open("a", encoding="utf-8") as stream:
            if not stop_target(
                args.base_url, token, run_start_target, stream,
                expected_instance_type=expected_instance_type,
                expected_build_id=args.expected_build_id,
                first_dispatch_wall=run_start_health.get("requestStartWall"),
            ):
                print("cold preflight target stop was not confirmed; stopping before cold trials", file=sys.stderr)
                return 2
            run_start_target_stopped = True
    if pending_path.exists():
        try:
            recover_pending(args.output, pending_path)
        except (OSError, json.JSONDecodeError, ValueError) as error:
            print(f"cannot recover pending attempt: {type(error).__name__}", file=sys.stderr)
            release_run_start_target()
            return 2
        if pending_record is not None and isinstance(pending_record.get("targetId"), str):
            pending_target = next((target for target in allowed_targets if target["targetId"] == pending_record["targetId"]), None)
            if pending_target is None:
                release_run_start_target()
                print("pending attempt names a target outside this run manifest; refusing to continue", file=sys.stderr)
                return 2
            with args.output.open("a", encoding="utf-8") as stream:
                if not stop_target(
                    args.base_url, token, pending_target, stream,
                    expected_instance_type=expected_instance_type,
                    expected_build_id=args.expected_build_id,
                    first_dispatch_wall=pending_record.get("requestStartWall"),
                ):
                    release_run_start_target()
                    print("pending target stop was not confirmed; refusing to allocate another name", file=sys.stderr)
                    return 2
            if pending_target["targetId"] == run_start_target["targetId"]:
                run_start_target_stopped = True
    completed = read_existing(args.output, run["runId"])
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
    latest_health = run_start_health
    since_health = 0
    measurement_target = targets_by_purpose.get("measurement")
    current_target: dict[str, Any] | None = None
    current_target_first_dispatch: str | None = None
    stop_failure = False
    with args.output.open("a", encoding="utf-8") as stream:
        try:
            for condition, position, attempt_no in schedule:
                key = (mode, condition["conditionId"], position["id"], attempt_no)
                if key in completed:
                    if mode == "game":
                        game_resumed.add(f"{condition['conditionId']}#rep{attempt_no}")
                    continue
                if total_requests >= max_requests or time.monotonic() - run_started >= time_budget_seconds:
                    print("stopped at run manifest limit; remaining attempts are resumable", file=sys.stderr)
                    break

                if mode == "cold":
                    target = cold_targets.get(attempt_no)
                    if target is None:
                        print(f"cold trial {attempt_no} is absent from the deploy allowlist", file=sys.stderr)
                        stop_failure = True
                        break
                    if target_seen(args.output, target["targetId"]):
                        print(f"cold target {target['targetId']} already appears in the raw ledger; refusing to reuse it", file=sys.stderr)
                        stop_failure = True
                        break
                else:
                    target = measurement_target
                    if since_health >= int(run.get("healthEveryRequests", 10)):
                        latest_health = health_snapshot(args.base_url, token, target=target)
                        since_health = 0
                        if (
                            latest_health.get("buildId") != args.expected_build_id
                            or latest_health.get("targetId") != target["targetId"]
                            or latest_health.get("containerApp") != target["containerApp"]
                            or latest_health.get("containerClass") != target["containerClass"]
                            or latest_health.get("containerBinding") != target["containerBinding"]
                        ):
                            print("benchmark target health identity changed; stopping this segment", file=sys.stderr)
                            stop_failure = True
                            break

                request_start = wall_now()
                if current_target is None:
                    current_target = target
                if current_target_first_dispatch is None:
                    current_target_first_dispatch = (
                        request_start if mode == "cold" or run_start_target_stopped
                        else run_start_health.get("requestStartWall")
                    )
                started_mono = time.monotonic()
                group_id = f"{condition['conditionId']}#rep{attempt_no}" if mode == "game" else None
                cold_trial_id = f"{run['runId']}-cold-trial-{attempt_no}" if mode == "cold" else None
                unused_name_evidence = None if mode != "cold" else {
                    "allowlistedAtDeploy": True,
                    "evidenceScope": "unused target name only; this does not prove the Container started",
                    "source": "runner raw ledger and unique build+segment+trial target name",
                    "priorRunnerUseCount": 0,
                    "healthOrWarmupBeforeFirstAnalysis": False,
                }
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
                    "expectedBuildId": args.expected_build_id,
                    "runFingerprintSha256": fingerprint["fingerprintSha256"],
                    "imageDigest": fingerprint["imageDigest"],
                    "identityDigests": fingerprint["identityDigests"],
                    "buildId": fingerprint["buildId"],
                    "targetId": target["targetId"],
                    "segmentId": target["segmentId"],
                    "targetPurpose": target["purpose"],
                    "expectedInstanceType": expected_instance_type,
                    "coldTrialId": cold_trial_id,
                    "containerApp": target["containerApp"],
                    "containerClass": target["containerClass"],
                    "containerBinding": target["containerBinding"],
                    "unusedNameEvidence": unused_name_evidence,
                    "requestStartWall": request_start,
                    "gameAttemptId": group_id,
                    "gameSequence": position.get("ply"),
                    "gamePositionCount": len(positions) if mode == "game" else None,
                    "healthAtRunStart": run_start_health,
                    "healthSnapshot": latest_health if mode != "cold" else None,
                }
                persist_pending(pending_path, pending_attempt)
                timeout = max(60, condition["moveTimeMs"] / 1000 + 45)
                status, response, elapsed_ms, error = request_json(
                    args.base_url.rstrip("/") + "/internal/benchmark",
                    token,
                    "POST",
                    {
                        "sfen": position["sfen"],
                        "conditionId": condition["conditionId"],
                        "targetId": target["targetId"],
                        "segmentId": target["segmentId"],
                    },
                    timeout=timeout,
                )
                request_end = wall_now()
                response, response_build_id, error, worker_failure, driver_identity_confirmed = normalize_response_identity(
                    response, args.expected_build_id, fingerprint["gitCommit"], fingerprint["identityDigests"], error,
                )
                response_value = response.get("driverBootId") if isinstance(response, dict) else None
                response_boot_id = response_value if isinstance(response_value, str) and re.fullmatch(r"[0-9a-f]{32}", response_value) else None
                response_identity_digests = response.get("identityDigests") if isinstance(response, dict) else None
                response_identity_digests = safe_identity_digests(response_identity_digests)
                cold_http_attempts = None if mode != "cold" else [{
                    "attemptNo": 1,
                    "dispatchWall": request_start,
                    "responseWall": request_end,
                    "httpStatus": status,
                    "httpElapsedMs": elapsed_ms,
                    "transportError": error,
                }]
                cold_success = mode == "cold" and status == 200 and isinstance(response, dict) and response.get("status") in {"success", "terminal"}
                cold_evidence = None if mode != "cold" else {
                    "label": "new-instance cold start",
                    "targetId": target["targetId"],
                    "segmentId": target["segmentId"],
                    "unusedNameEvidence": unused_name_evidence,
                    "firstDispatchWall": request_start,
                    "containerApp": target["containerApp"],
                    "containerClass": target["containerClass"],
                    "containerBinding": target["containerBinding"],
                    "firstHttpWallMs": elapsed_ms,
                    "timeToFirstSuccessMs": elapsed_ms if cold_success else None,
                    "httpAttempts": cold_http_attempts,
                    "responseBootId": response_boot_id,
                    "responseRuntime": response.get("runtime") if isinstance(response, dict) else None,
                    "idleSleepResumeVerified": False,
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
                    "expectedBuildId": args.expected_build_id,
                    "expectedInstanceType": expected_instance_type,
                    "containerApp": target["containerApp"],
                    "containerClass": target["containerClass"],
                    "containerBinding": target["containerBinding"],
                    "runFingerprintSha256": fingerprint["fingerprintSha256"],
                    "imageDigest": fingerprint["imageDigest"],
                    "identityDigests": fingerprint["identityDigests"],
                    "buildId": fingerprint["buildId"],
                    "targetId": target["targetId"],
                    "segmentId": target["segmentId"],
                    "targetPurpose": target["purpose"],
                    "coldTrialId": cold_trial_id,
                    "unusedNameEvidence": unused_name_evidence,
                    "requestStartWall": request_start,
                    "requestEndWall": request_end,
                    "httpElapsedMs": elapsed_ms,
                    "httpStatus": status,
                    "transportError": error,
                    "response": response,
                    "runtime": response.get("runtime") if isinstance(response, dict) else None,
                    "driverBootId": response_boot_id,
                    "workerFailure": worker_failure,
                    "driverIdentityConfirmed": driver_identity_confirmed,
                    "responseBuildId": response_build_id,
                    "responseBootId": response_boot_id,
                    "responseIdentityDigests": response_identity_digests,
                    "healthAtRunStart": run_start_health,
                    "healthSnapshot": latest_health if mode != "cold" else None,
                    "coldEvidence": cold_evidence,
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
                if mode != "cold":
                    since_health += 1
                if mode == "cold":
                    if not stop_target(
                        args.base_url, token, target, stream,
                        expected_instance_type=expected_instance_type,
                        expected_build_id=args.expected_build_id,
                        first_dispatch_wall=request_start,
                    ):
                        print("cold trial target stop was not confirmed; stopping before the next cold name", file=sys.stderr)
                        stop_failure = True
                        current_target = None
                        break
                    current_target = None
                    current_target_first_dispatch = None
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
                print(json.dumps({
                    "conditionId": condition["conditionId"], "positionId": position["id"],
                    "attemptNo": attempt_no, "targetId": target["targetId"],
                    "httpStatus": status, "elapsedMs": elapsed_ms,
                }, separators=(",", ":")), flush=True)
        finally:
            if current_target is not None:
                if not stop_target(
                    args.base_url, token, current_target, stream,
                    expected_instance_type=expected_instance_type,
                    expected_build_id=args.expected_build_id,
                    first_dispatch_wall=current_target_first_dispatch,
                ):
                    print("measurement target stop was not confirmed; no next target will be used", file=sys.stderr)
                    stop_failure = True
            elif mode != "cold" and not run_start_target_stopped:
                if not stop_target(
                    args.base_url, token, measurement_target, stream,
                    expected_instance_type=expected_instance_type,
                    expected_build_id=args.expected_build_id,
                    first_dispatch_wall=run_start_health.get("requestStartWall"),
                ):
                    print("measurement target stop was not confirmed; no next target will be used", file=sys.stderr)
                    stop_failure = True
    return 2 if stop_failure else 0


if __name__ == "__main__":
    raise SystemExit(main())
