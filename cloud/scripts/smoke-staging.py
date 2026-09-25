#!/usr/bin/env python3
"""Fixed, public-fixture smoke for the Issue 19 staging Worker."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
START_ID = "non-mate-startpos"
TERMINAL_ID = "checkmate-white"
EXPECTED_IDENTITY = {
    "engineName": "YaneuraOu NNUE 9.70git 64AVX2",
    "engineSha256": "0cb27c8302f6eb357cd360372defe172401519c06fb4bf28eb2bf72ee0f39d80",
    "modelId": "Suisho11 Plus SFNN_halfka2_1024_7_64_k3k3",
    "weightSha256": "a78b7f889843037d344f482623b3febd124ead5c1f34f134d9f1c2c78cd0f829",
    "optionsSha256": "9c242cd8820c158292af4a6d58890e37ae060000a9a6344d7a549abf7f44f0b3",
    "sourceArchiveSha256": "3bd58802922c245e44fdc8fea57019f86b14960a52b7581e39d8b815ee5a4b80",
    "sourceTreeSha256": "3b57f1ce5ff6587e9bab35ae6ee397d31f527da469ad0cf85d7de839790af0f6",
    "sourceArchive": "yaneuraou-V970-dev-mac-all.7z",
    "buildInfo": "YaneuraOu V970-dev source archive; make normal YANEURAOU_ENGINE_SFNN_halfka2_1024_7_64_k3k3 TARGET_CPU=AVX2 COMPILER=g++",
    "driverVersion": "usi-driver-v1",
    "contractVersion": "analysis-json-v1",
}


def load_positions() -> list[dict[str, str]]:
    main = json.loads((ROOT / "fixtures/analysis/positions.json").read_text(encoding="utf-8"))
    extra = json.loads((ROOT / "cloud/fixtures/analysis/staging-positions.json").read_text(encoding="utf-8"))
    main_by_id = {item["id"]: item for item in main["positions"]}
    extra_by_id = {item["id"]: item for item in extra["positions"]}
    return [
        {"id": START_ID, "sfen": main_by_id[START_ID]["sfen"], "expect": "analysis"},
        {"id": "middlegame-synthetic", "sfen": extra_by_id["middlegame-synthetic"]["sfen"], "expect": "analysis"},
        {"id": "mate-in-one-synthetic", "sfen": extra_by_id["mate-in-one-synthetic"]["sfen"], "expect": "mate"},
        {"id": TERMINAL_ID, "sfen": main_by_id[TERMINAL_ID]["sfen"], "expect": "checkmate"},
    ]


def request_analysis(url: str, token: str, sfen: str) -> tuple[int, dict[str, Any]]:
    body = json.dumps({"sfen": sfen}, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        url.rstrip("/") + "/internal/analyze",
        data=body,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            return error.code, json.loads(error.read().decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return error.code, {}


def check_result(position: dict[str, str], status: int, value: dict[str, Any]) -> None:
    if status != 200 or value.get("schemaVersion") != 1 or value.get("sfen") != position["sfen"]:
        raise RuntimeError(f"{position['id']}: HTTP or response echo check failed (HTTP {status}).")
    if value.get("identity") != EXPECTED_IDENTITY:
        raise RuntimeError(f"{position['id']}: artifact identity mismatch.")
    if value.get("perspective") != "sente":
        raise RuntimeError(f"{position['id']}: score perspective is missing or incorrect.")

    if position["expect"] == "checkmate":
        if value.get("status") != "terminal" or value.get("terminal") != "checkmate" or value.get("candidates") != []:
            raise RuntimeError("checkmate-white: terminal classification or empty candidate check failed.")
        if value.get("meta") != {"nodes": None, "completedDepth": None, "elapsedMs": None}:
            raise RuntimeError("checkmate-white: missing search values must remain null.")
        if value.get("conditions", {}).get("actual") is not None:
            raise RuntimeError("checkmate-white: terminal input must not claim engine conditions ran.")
        return

    if value.get("status") != "success":
        raise RuntimeError(f"{position['id']}: expected a completed engine analysis.")
    candidates = value.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        raise RuntimeError(f"{position['id']}: no legal engine candidates were returned.")
    meta = value.get("meta", {})
    for name in ("nodes", "completedDepth", "elapsedMs"):
        item = meta.get(name)
        if not isinstance(item, int) or item <= 0:
            raise RuntimeError(f"{position['id']}: {name} must be a positive measured value.")
    actual = value.get("conditions", {}).get("actual", {})
    if actual.get("multiPV") != len(candidates) or not 1 <= actual.get("multiPV", 0) <= 3:
        raise RuntimeError(f"{position['id']}: actual MultiPV does not match the candidate count.")
    for candidate in candidates:
        if not isinstance(candidate.get("move"), str) or not candidate.get("pv") or candidate["pv"][0] != candidate["move"]:
            raise RuntimeError(f"{position['id']}: candidate first move and PV do not match.")
        score = candidate.get("score")
        if not isinstance(score, dict) or score.get("kind") not in {"cp", "mate"} or not isinstance(score.get("value"), int):
            raise RuntimeError(f"{position['id']}: exact cp/mate score is missing.")
    if position["expect"] == "mate" and not any(candidate["score"]["kind"] == "mate" for candidate in candidates):
        raise RuntimeError("mate-in-one-synthetic: engine did not report a normal mate score.")


def main() -> int:
    url = os.environ.get("ANALYSIS_STAGING_URL", "")
    token = os.environ.get("ANALYSIS_INTERNAL_TOKEN", "")
    if not url or not token:
        print("Set ANALYSIS_STAGING_URL and ANALYSIS_INTERNAL_TOKEN; the token is never printed.", file=sys.stderr)
        return 2
    if not url.startswith("https://"):
        print("ANALYSIS_STAGING_URL must use HTTPS.", file=sys.stderr)
        return 2
    try:
        for position in load_positions():
            status, value = request_analysis(url, token, position["sfen"])
            check_result(position, status, value)
            meta = value["meta"]
            print(json.dumps({
                "id": position["id"],
                "status": value["status"],
                "terminal": value["terminal"],
                "candidateCount": len(value["candidates"]),
                "nodes": meta["nodes"],
                "completedDepth": meta["completedDepth"],
                "elapsedMs": meta["elapsedMs"],
                "mateReported": any(candidate["score"]["kind"] == "mate" for candidate in value["candidates"]),
            }, separators=(",", ":")))
    except Exception as error:
        print(f"Staging smoke failed: {error}", file=sys.stderr)
        return 1
    print("staging smoke passed: 4 fixed public/synthetic positions")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
