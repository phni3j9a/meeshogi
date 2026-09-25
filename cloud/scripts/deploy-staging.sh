#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CLOUD_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$CLOUD_DIR"

: "${CLOUDFLARE_ACCOUNT_ID:?Set CLOUDFLARE_ACCOUNT_ID to the target account ID.}"
: "${ANALYSIS_IMAGE_REF:?Set ANALYSIS_IMAGE_REF to the digest-pinned output of build-push-image.sh.}"
: "${ANALYSIS_INTERNAL_TOKEN:?Set ANALYSIS_INTERNAL_TOKEN in the shell; it is piped to Wrangler and never printed.}"
[[ "$CLOUDFLARE_ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]] || { echo "CLOUDFLARE_ACCOUNT_ID must be 32 lowercase hex characters." >&2; exit 2; }
[[ "$ANALYSIS_IMAGE_REF" =~ ^registry\.cloudflare\.com/${CLOUDFLARE_ACCOUNT_ID}/meeshogi-analysis-mvp-staging@sha256:[0-9a-f]{64}$ ]] || {
  echo "ANALYSIS_IMAGE_REF must be a digest-pinned image for this account and staging repository." >&2
  exit 2
}

TEMP_CONFIG="$(mktemp "$CLOUD_DIR/.wrangler.staging.deploy.XXXXXX.jsonc")"
cleanup() { rm -f -- "$TEMP_CONFIG"; }
trap cleanup EXIT INT TERM
IMAGE_DIGEST="${ANALYSIS_IMAGE_REF##*@sha256:}"
python3 "$SCRIPT_DIR/render-config.py" "$CLOUD_DIR/wrangler.staging.jsonc" "$TEMP_CONFIG" "$CLOUDFLARE_ACCOUNT_ID" "$IMAGE_DIGEST"
# The verification-only Worker var is in the rendered config; Wrangler needs no inherited control flag.
unset ANALYSIS_VERIFY_STOP_ENGINE_ONCE

# Create the Worker and its Container before adding the secret. Requests fail closed while it is unset.
internal_token="$ANALYSIS_INTERNAL_TOKEN"
unset ANALYSIS_INTERNAL_TOKEN
./node_modules/.bin/wrangler deploy --config "$TEMP_CONFIG" --strict --containers-rollout immediate
# Secret input is consumed by Wrangler stdin. It is not inherited by deploy or put in a config, argument, or image.
printf '%s' "$internal_token" | ./node_modules/.bin/wrangler secret put ANALYSIS_INTERNAL_TOKEN --config "$TEMP_CONFIG"
unset internal_token
