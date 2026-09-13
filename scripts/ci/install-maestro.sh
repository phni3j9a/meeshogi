#!/usr/bin/env bash
set -euo pipefail
destination="${RUNNER_TEMP:-/tmp}/meeshogi-maestro-2.10.0"
mkdir -p "$destination"
if [[ ! -f "$destination/maestro/bin/maestro" ]]; then
  curl --fail --location --retry 3 https://github.com/mobile-dev-inc/Maestro/releases/download/cli-2.10.0/maestro.zip -o "$destination/maestro.zip"
  python3 - "$destination/maestro.zip" <<'PY'
import hashlib, sys
assert hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest() == "29b675e10cc12080e445e9bfb2e2b4e4dfb9c0f2e30d5884120d258b5e1cd991"
PY
  unzip -q "$destination/maestro.zip" -d "$destination"
fi
if [[ -n "${GITHUB_PATH:-}" ]]; then echo "$destination/maestro/bin" >> "$GITHUB_PATH"; fi
"$destination/maestro/bin/maestro" --version
