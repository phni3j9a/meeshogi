#!/usr/bin/env python3
"""Render a temporary Wrangler config with an account and pinned image digest."""

from __future__ import annotations

import base64
import binascii
import json
import os
import re
import struct
import sys
from pathlib import Path


def validate_ssh_public_key(value: str) -> str:
    if not value or value.strip() != value or any(ord(char) < 0x20 or ord(char) > 0x7E for char in value):
        raise ValueError
    match = re.fullmatch(r"ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: ([\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?))?", value)
    if not match:
        raise ValueError
    encoded = match.group(1)
    try:
        blob = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as error:
        raise ValueError from error
    if base64.b64encode(blob).decode("ascii") != encoded or len(blob) < 4:
        raise ValueError
    algorithm_length = struct.unpack(">I", blob[:4])[0]
    algorithm_end = 4 + algorithm_length
    if algorithm_end + 4 > len(blob) or blob[4:algorithm_end] != b"ssh-ed25519":
        raise ValueError
    key_length = struct.unpack(">I", blob[algorithm_end:algorithm_end + 4])[0]
    key_start = algorithm_end + 4
    if key_length != 32 or key_start + key_length != len(blob):
        raise ValueError
    return value


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
    public_key = os.environ.get("ANALYSIS_SSH_PUBLIC_KEY")
    container = config["containers"][0]
    container.pop("ssh", None)
    container.pop("authorized_keys", None)
    if public_key is not None:
        try:
            public_key = validate_ssh_public_key(public_key)
        except ValueError:
            print("ANALYSIS_SSH_PUBLIC_KEY must be one valid ssh-ed25519 public-key line.", file=sys.stderr)
            return 2
        container["ssh"] = {"enabled": True}
        container["authorized_keys"] = [{
            "name": "issue-19-timeout-verification",
            "public_key": public_key,
        }]
    Path(output).write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
