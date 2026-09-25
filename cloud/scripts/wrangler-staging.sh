#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CLOUD_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$CLOUD_DIR"
: "${CLOUDFLARE_ACCOUNT_ID:?Set CLOUDFLARE_ACCOUNT_ID to the target account ID.}"
: "${ANALYSIS_IMAGE_REF:?Set ANALYSIS_IMAGE_REF to the deployed digest-pinned image.}"
[[ "$ANALYSIS_IMAGE_REF" =~ ^registry\.cloudflare\.com/${CLOUDFLARE_ACCOUNT_ID}/meeshogi-analysis-mvp-staging@sha256:([0-9a-f]{64})$ ]] || {
  echo "ANALYSIS_IMAGE_REF must match the staging image and account." >&2
  exit 2
}
IMAGE_DIGEST="${BASH_REMATCH[1]}"
TEMP_CONFIG="$(mktemp "$CLOUD_DIR/.wrangler.staging.operator.XXXXXX.jsonc")"
trap 'rm -f -- "$TEMP_CONFIG"' EXIT INT TERM
python3 "$SCRIPT_DIR/render-config.py" "$CLOUD_DIR/wrangler.staging.jsonc" "$TEMP_CONFIG" "$CLOUDFLARE_ACCOUNT_ID" "$IMAGE_DIGEST"
./node_modules/.bin/wrangler --config "$TEMP_CONFIG" "$@"
