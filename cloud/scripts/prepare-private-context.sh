#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"

python3 - "${REPO_ROOT}" <<'PY'
import hashlib
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

repo = Path(sys.argv[1]).resolve()
source_root = Path("/home/server/projects/sekirei-weight").resolve()
manifest_root = source_root / "data" / "manifests"
runtime_path = manifest_root / "suisho11plus-teacher-runtime.json"
source_path = manifest_root / "suisho11plus-source.json"
build_path = manifest_root / "yaneuraou-suisho11plus-avx2.json"
created: Path | None = None


def fail(message: str) -> None:
    raise SystemExit(message)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_json(path: Path) -> tuple[dict, str]:
    try:
        raw = path.read_bytes()
        parsed = json.loads(raw)
    except (OSError, json.JSONDecodeError) as error:
        fail(f"Cannot read authoritative manifest: {path.name} ({type(error).__name__}).")
    if not isinstance(parsed, dict):
        fail(f"Invalid manifest root: {path.name}.")
    return parsed, hashlib.sha256(raw).hexdigest()


def checked_artifact(path_text: object, expected: object, label: str) -> tuple[Path, str]:
    if not isinstance(path_text, str) or not isinstance(expected, str) or len(expected) != 64:
        fail(f"Invalid {label} path or digest in manifest.")
    if any(char not in "0123456789abcdef" for char in expected):
        fail(f"Invalid {label} digest in manifest.")
    path = Path(path_text)
    if not path.is_absolute() or path.is_symlink():
        fail(f"{label} path must be an absolute regular file path.")
    resolved = path.resolve(strict=True)
    if not resolved.is_relative_to(source_root) or not resolved.is_file():
        fail(f"{label} path escapes the private artifact root or is not a file.")
    actual = sha256(resolved)
    if actual != expected:
        fail(f"{label} SHA-256 does not match its manifest.")
    return resolved, actual


try:
    runtime, _runtime_hash = read_json(runtime_path)
    source, source_hash = read_json(source_path)
    build, build_hash = read_json(build_path)

    if runtime.get("source_manifest", {}).get("sha256") != source_hash:
        fail("Source manifest SHA-256 does not match the runtime manifest reference.")
    if runtime.get("build_manifest", {}).get("sha256") != build_hash:
        fail("Build manifest SHA-256 does not match the runtime manifest reference.")

    engine_path, engine_hash = checked_artifact(
        runtime.get("engine", {}).get("absolute_path"), runtime.get("engine", {}).get("sha256"), "engine"
    )
    weight_path, weight_hash = checked_artifact(
        runtime.get("weight", {}).get("absolute_path"), runtime.get("weight", {}).get("sha256"), "weight"
    )
    source_weight = source.get("source", {}).get("selected_members", {}).get("nn.bin", {}).get("sha256")
    if source_weight != weight_hash or build.get("binary", {}).get("sha256") != engine_hash:
        fail("Runtime engine or weight digest does not match its source/build manifest.")
    if build.get("build", {}).get("sha256") != engine_hash:
        fail("Runtime engine digest does not match the build artifact digest.")

    options_entry = source.get("source", {}).get("selected_members", {}).get("engine_options.txt", {})
    options_relative = options_entry.get("path")
    if not isinstance(options_relative, str):
        fail("engine_options.txt is not allowlisted by the source manifest.")
    options_candidate = source_root / options_relative
    if options_candidate.is_symlink():
        fail("engine_options.txt must not be a symbolic link.")
    options_path = options_candidate.resolve(strict=True)
    if not options_path.is_relative_to(source_root):
        fail("engine_options.txt path escapes the private artifact root.")
    options_hash = options_entry.get("sha256")
    options_path, options_hash = checked_artifact(str(options_path), options_hash, "engine_options.txt")
    normalized_options = options_path.read_bytes().replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    if normalized_options != b"FV_SCALE 40\n":
        fail("engine_options.txt contents are not the reviewed FV_SCALE 40 setting.")

    created = Path(tempfile.mkdtemp(prefix="meeshogi-analysis-staging-", dir=tempfile.gettempdir()))
    if created.resolve().is_relative_to(repo):
        fail("Temporary private build context unexpectedly resolved inside the repository.")
    created.chmod(0o700)
    for source_file, destination_name, mode in (
        (engine_path, "engine", 0o500),
        (weight_path, "nn.bin", 0o400),
        (options_path, "engine_options.txt", 0o400),
    ):
        destination = created / destination_name
        shutil.copyfile(source_file, destination)
        destination.chmod(mode)
        if sha256(destination) != sha256(source_file):
            fail(f"Copied {destination_name} digest changed during staging.")

    print(
        json.dumps(
            {
                "contextPath": str(created),
                "engineSha256": engine_hash,
                "weightSha256": weight_hash,
                "engineOptionsSha256": options_hash,
            },
            separators=(",", ":"),
        )
    )
except (OSError, ValueError, KeyError, TypeError) as error:
    if created is not None:
        shutil.rmtree(created, ignore_errors=True)
    fail(f"Private context preparation failed closed ({type(error).__name__}).")
except SystemExit:
    if created is not None:
        shutil.rmtree(created, ignore_errors=True)
    raise
PY
