#!/usr/bin/env python3
"""Render a temporary Wrangler config with an account and pinned image digest."""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 5:
        print("usage: render-config.py TEMPLATE OUTPUT ACCOUNT_ID IMAGE_DIGEST", file=sys.stderr)
        return 2
    template, output, account_id, image_digest = sys.argv[1:]
    if not re.fullmatch(r"[0-9a-f]{32}", account_id) or not re.fullmatch(r"[0-9a-f]{64}", image_digest):
        print("Account ID or image digest has an invalid format.", file=sys.stderr)
        return 2
    source = Path(template).read_text(encoding="utf-8")
    rendered = source.replace("__ACCOUNT_ID__", account_id).replace("__IMAGE_DIGEST__", image_digest)
    if "__ACCOUNT_ID__" in rendered or "__IMAGE_DIGEST__" in rendered:
        print("Wrangler template contains an unresolved placeholder.", file=sys.stderr)
        return 1
    config = json.loads(rendered)
    if config.get("name") != "meeshogi-analysis-mvp-staging" or config.get("name") == "meeshogi-analysis-staging":
        print("Refusing to target any Worker except the dedicated Issue 19 staging name.", file=sys.stderr)
        return 1
    verification_flag = os.environ.get("ANALYSIS_VERIFY_STOP_ENGINE_ONCE", "")
    if verification_flag not in {"", "0", "1"}:
        print("ANALYSIS_VERIFY_STOP_ENGINE_ONCE must be unset, 0, or 1.", file=sys.stderr)
        return 2
    worker_vars = config.get("vars", {})
    if not isinstance(worker_vars, dict):
        print("Worker vars must be a JSON object.", file=sys.stderr)
        return 1
    worker_vars.pop("ANALYSIS_VERIFY_STOP_ENGINE_ONCE", None)
    if verification_flag == "1":
        worker_vars["ANALYSIS_VERIFY_STOP_ENGINE_ONCE"] = "1"
    if worker_vars:
        config["vars"] = worker_vars
    else:
        config.pop("vars", None)
    Path(output).write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
