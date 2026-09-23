#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
CLOUD_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
CONFIG_NAME="wrangler.staging.jsonc"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      if [[ $# -lt 2 || -z "$2" ]]; then
        printf '%s\n' "Refusing deploy: --config requires a staging config filename." >&2
        exit 2
      fi
      CONFIG_NAME="$2"
      shift 2
      ;;
    *)
      printf '%s\n' "Refusing deploy: unsupported argument '$1'." >&2
      exit 2
      ;;
  esac
done

case "${CONFIG_NAME}" in
  wrangler.staging.jsonc|wrangler.staging-2vcpu.jsonc) ;;
  *)
    printf '%s\n' "Refusing deploy: --config must name wrangler.staging.jsonc or wrangler.staging-2vcpu.jsonc." >&2
    exit 2
    ;;
esac
CONFIG="${CLOUD_DIR}/${CONFIG_NAME}"

if [[ -n "${WRANGLER_ENV:-}" && "${WRANGLER_ENV}" != "staging" ]]; then
  printf '%s\n' "Refusing deploy: WRANGLER_ENV must be unset or staging." >&2
  exit 2
fi

if [[ ! -x "${CLOUD_DIR}/node_modules/.bin/wrangler" ]]; then
  printf '%s\n' "Wrangler is not installed in cloud/node_modules; run the cloud package install first." >&2
  exit 2
fi

python3 - "${CONFIG}" "${CONFIG_NAME}" <<'PY'
import json
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
config_name = sys.argv[2]
text = path.read_text(encoding="utf-8")
text = re.sub(r"(?m)^\s*//.*$", "", text)
try:
    config = json.loads(text)
except json.JSONDecodeError as error:
    raise SystemExit(f"Refusing deploy: staging config is not valid JSONC: {error}")

name = config.get("name")
if not isinstance(name, str) or not name.endswith("-staging"):
    raise SystemExit("Refusing deploy: worker name must end in -staging.")
if config.get("env") or "env" in config:
    raise SystemExit("Refusing deploy: environment overrides are not permitted in the staging-only config.")
if name != "meeshogi-analysis-staging":
    raise SystemExit("Refusing deploy: unexpected staging worker name.")
expected_instance_type = "standard-3" if config_name == "wrangler.staging-2vcpu.jsonc" else "standard-2"
if any(item.get("instance_type") != expected_instance_type for item in config.get("containers", [])):
    raise SystemExit("Refusing deploy: instance type does not match the selected staging config.")
if not config.get("containers") or not all(
    str(item.get("class_name", "")).endswith("Container") for item in config["containers"]
):
    raise SystemExit("Refusing deploy: staging container configuration is missing or invalid.")
PY

cd "${CLOUD_DIR}"
printf '%s\n' "Deploying ${CONFIG} (staging only). Wrangler output follows."
"${CLOUD_DIR}/node_modules/.bin/wrangler" deploy -c "${CONFIG}"
