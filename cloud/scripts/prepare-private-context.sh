#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CLOUD_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
WEIGHT_ROOT="${SEKIREI_WEIGHT_ROOT:-/home/server/projects/sekirei-weight}"
CONTEXT="$(mktemp -d /tmp/meeshogi-analysis-private.XXXXXX)"
chmod 0700 "$CONTEXT"
cleanup() {
  rm -rf -- "$CONTEXT"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

metadata="$(python3 - "$WEIGHT_ROOT" "$CLOUD_DIR/container/artifact-manifest.json" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
recipe = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
runtime_path = root / "data/manifests/suisho11plus-teacher-runtime.json"
source_path = root / "data/manifests/suisho11plus-source.json"
build_path = root / "data/manifests/yaneuraou-suisho11plus-avx2.json"
runtime = json.loads(runtime_path.read_text(encoding="utf-8"))
source = json.loads(source_path.read_text(encoding="utf-8"))
build = json.loads(build_path.read_text(encoding="utf-8"))

def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def manifest_file(reference: dict) -> Path:
    path = (root / reference["path"]).resolve()
    if not path.is_relative_to(root):
        raise SystemExit("Manifest path escapes the Sekirei weight repository.")
    return path

if runtime["engine"]["sha256"] != recipe["engineSha256"]:
    raise SystemExit("Runtime manifest engine digest differs from the checked-in artifact manifest.")
if runtime["weight"]["sha256"] != recipe["weightSha256"] or source["nn"]["sha256"] != recipe["weightSha256"]:
    raise SystemExit("Weight manifest digests differ from the checked-in artifact manifest.")
source_options = source["source"]["selected_members"]["engine_options.txt"]
archive_options = source["archive"]["selected_members"]["engine_options.txt"]
if source_options["sha256"] != recipe["optionsSha256"] or archive_options["sha256"] != recipe["optionsSha256"]:
    raise SystemExit("Options manifest digest differs from the checked-in artifact manifest.")
if source_options["path"] != source["engine_options"]["path"] or archive_options["path"] != source_options["path"]:
    raise SystemExit("Source and archive manifests point to different engine options files.")
if source["source_archive"]["archive_sha256"] != recipe["sourceArchiveSha256"]:
    raise SystemExit("Source archive digest differs from the checked-in artifact manifest.")
if source["source_archive"]["source_tree_sha256"] != recipe["sourceTreeSha256"]:
    raise SystemExit("Source tree digest differs from the checked-in artifact manifest.")
if build["binary"]["sha256"] != recipe["engineSha256"] or build["nn"]["sha256"] != recipe["weightSha256"]:
    raise SystemExit("Build manifest digests differ from the checked-in artifact manifest.")
if runtime["source_manifest"]["sha256"] != file_hash(source_path):
    raise SystemExit("Runtime manifest no longer points to the current source manifest.")
if runtime["build_manifest"]["sha256"] != file_hash(build_path):
    raise SystemExit("Runtime manifest no longer points to the current engine build manifest.")

engine_path = manifest_file(runtime["engine"])
weight_path = manifest_file(runtime["weight"])
options_path = manifest_file(source_options)
if manifest_file(build["binary"]) != engine_path or manifest_file(source["nn"]) != weight_path:
    raise SystemExit("Runtime, source and build manifests point to different artifacts.")
if options_path.read_text(encoding="ascii") != recipe["optionsText"]:
    raise SystemExit("Engine options are not the single allowlisted FV_SCALE setting.")
print(json.dumps({"engine": str(engine_path), "weight": str(weight_path), "options": str(options_path)}, separators=(",", ":")))
PY
)"

engine_path="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["engine"])' "$metadata")"
weight_path="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["weight"])' "$metadata")"
options_path="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["options"])' "$metadata")"

for source in "$engine_path" "$weight_path" "$options_path"; do
  if [[ ! -f "$source" ]]; then
    echo "A manifest-declared private artifact is missing." >&2
    exit 1
  fi
done

expected="$(python3 - "$CLOUD_DIR/container/artifact-manifest.json" <<'PY'
import json,sys
manifest=json.load(open(sys.argv[1], encoding="utf-8"))
print(manifest["engineSha256"], manifest["weightSha256"], manifest["optionsSha256"])
PY
)"
read -r expected_engine expected_weight expected_options <<<"$expected"
actual_engine="$(sha256sum -- "$engine_path" | cut -d ' ' -f 1)"
actual_weight="$(sha256sum -- "$weight_path" | cut -d ' ' -f 1)"
actual_options="$(sha256sum -- "$options_path" | cut -d ' ' -f 1)"
if [[ "$actual_engine" != "$expected_engine" || "$actual_weight" != "$expected_weight" || "$actual_options" != "$expected_options" ]]; then
  echo "Private artifact bytes do not match the reviewed manifest; temporary context discarded." >&2
  exit 1
fi

install -m 0500 -- "$engine_path" "$CONTEXT/engine"
install -m 0400 -- "$weight_path" "$CONTEXT/nn.bin"
install -m 0400 -- "$options_path" "$CONTEXT/engine_options.txt"
install -m 0440 -- "$CLOUD_DIR/container/driver.py" "$CONTEXT/driver.py"
install -m 0440 -- "$CLOUD_DIR/container/artifact-manifest.json" "$CONTEXT/artifact-manifest.json"
install -m 0440 -- "$CLOUD_DIR/container/Dockerfile" "$CONTEXT/Dockerfile"
install -m 0440 -- "$CLOUD_DIR/container/.dockerignore" "$CONTEXT/.dockerignore"

trap - EXIT INT TERM
python3 - "$CONTEXT" "$actual_engine" "$actual_weight" "$actual_options" <<'PY'
import json,sys
print(json.dumps({"contextPath":sys.argv[1],"engineSha256":sys.argv[2],"weightSha256":sys.argv[3],"optionsSha256":sys.argv[4]}, separators=(",", ":")))
PY
