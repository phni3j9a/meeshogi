#!/usr/bin/env python3
"""Sanitize benchmark raw JSONL for publication.

Run-start fingerprints record the staging endpoint and the full registry image
ref, which include the operator's workers.dev hostname and Cloudflare account
ID. This replaces both with fixed placeholders (keeping the pinned image
digest), recomputes each fingerprintSha256, and rewrites every reference to the
old hash so the aggregator still validates the ledger. All other lines are kept
verbatim.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import lzma
import sys
from pathlib import Path
from typing import Any

PLACEHOLDER_ENDPOINT = "https://staging.invalid"
PLACEHOLDER_REGISTRY = "registry.invalid/meeshogi-analysis"
FORBIDDEN_SUBSTRINGS = ("workers.dev", "registry.cloudflare.com", "bearer ", "authorization")


def canonical_sha256(value: Any) -> str:
    # Same encoding as aggregate.py / run.py fingerprint hashing.
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def replace_strings(value: Any, mapping: dict[str, str]) -> Any:
    if isinstance(value, str):
        return mapping.get(value, value)
    if isinstance(value, list):
        return [replace_strings(item, mapping) for item in value]
    if isinstance(value, dict):
        return {key: replace_strings(item, mapping) for key, item in value.items()}
    return value


def sanitize_fingerprint(fingerprint: dict[str, Any]) -> dict[str, Any]:
    result = {key: value for key, value in fingerprint.items() if key != "fingerprintSha256"}
    result["endpoint"] = PLACEHOLDER_ENDPOINT
    result["imageRef"] = f"{PLACEHOLDER_REGISTRY}@sha256:{fingerprint['imageDigest']}"
    result["fingerprintSha256"] = canonical_sha256(result)
    return result


def sanitize_lines(lines: list[str]) -> list[str]:
    mapping: dict[str, str] = {}
    parsed: list[dict[str, Any] | None] = []
    for line in lines:
        row = json.loads(line)
        if isinstance(row.get("fingerprint"), dict):
            old = row["fingerprint"]["fingerprintSha256"]
            row["fingerprint"] = sanitize_fingerprint(row["fingerprint"])
            mapping[old] = row["fingerprint"]["fingerprintSha256"]
            parsed.append(row)
        else:
            parsed.append(None)
    output: list[str] = []
    for line, row in zip(lines, parsed):
        if row is None and not any(old in line for old in mapping):
            output.append(line)
            continue
        value = row if row is not None else json.loads(line)
        output.append(json.dumps(replace_strings(value, mapping), ensure_ascii=False, separators=(",", ":")))
    lowered = "\n".join(output).lower()
    for needle in FORBIDDEN_SUBSTRINGS:
        if needle in lowered:
            raise ValueError(f"sanitized output still contains {needle!r}")
    return output


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", nargs="+", required=True, type=Path, help="raw JSONL file(s), concatenated in order")
    parser.add_argument("--output", required=True, type=Path, help="sanitized JSONL; .xz is compressed")
    args = parser.parse_args()
    lines: list[str] = []
    for path in args.input:
        lines.extend(line for line in path.read_text(encoding="utf-8").splitlines() if line.strip())
    try:
        output = sanitize_lines(lines)
    except (ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"sanitize failed: {error}", file=sys.stderr)
        return 2
    data = ("\n".join(output) + "\n").encode("utf-8")
    if args.output.suffix == ".xz":
        data = lzma.compress(data, preset=9 | lzma.PRESET_EXTREME)
    args.output.write_bytes(data)
    print(json.dumps({"lines": len(output), "output": str(args.output)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
