#!/usr/bin/env python3
"""One operator-only timeout probe; it exposes no fault route and never prints the token."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

STARTPOS = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1"


def main() -> int:
    url = os.environ.get("ANALYSIS_STAGING_URL", "")
    token = os.environ.get("ANALYSIS_INTERNAL_TOKEN", "")
    if not url or not token:
        print("Set ANALYSIS_STAGING_URL and ANALYSIS_INTERNAL_TOKEN; the token is never printed.", file=sys.stderr)
        return 2
    body = json.dumps({"sfen": STARTPOS}, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        url.rstrip("/") + "/internal/analyze",
        data=body,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json",
                 # Cloudflare rejects the default Python-urllib User-Agent with error 1010 (HTTP 403).
                 "User-Agent": "meeshogi-staging-operator/1"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            status = response.status
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        status = error.code
        try:
            payload = json.loads(error.read().decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            payload = {}
    except Exception as error:
        print(f"Timeout probe transport failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps({"httpStatus": status, "body": payload}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
