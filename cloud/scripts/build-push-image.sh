#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CLOUD_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$CLOUD_DIR"

: "${CLOUDFLARE_ACCOUNT_ID:?Set CLOUDFLARE_ACCOUNT_ID to the target account ID.}"
: "${ANALYSIS_IMAGE_TAG:?Set ANALYSIS_IMAGE_TAG to an immutable staging tag, for example issue19-20260925.}"
[[ "$CLOUDFLARE_ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]] || { echo "CLOUDFLARE_ACCOUNT_ID must be 32 lowercase hex characters." >&2; exit 2; }
[[ "$ANALYSIS_IMAGE_TAG" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ ]] || { echo "ANALYSIS_IMAGE_TAG contains unsupported characters." >&2; exit 2; }

context_json="$(bash "$SCRIPT_DIR/prepare-private-context.sh")"
CONTEXT="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["contextPath"])' "$context_json")"
DOCKER_CONFIG_DIR="$(mktemp -d /tmp/meeshogi-analysis-docker.XXXXXX)"
chmod 0700 "$DOCKER_CONFIG_DIR"
CONFIG_FILE="$(mktemp "$CLOUD_DIR/.wrangler.staging.build.XXXXXX.jsonc")"
cleanup() {
  rm -rf -- "$CONTEXT" "$DOCKER_CONFIG_DIR"
  rm -f -- "$CONFIG_FILE"
}
trap cleanup EXIT INT TERM
export DOCKER_CONFIG="$DOCKER_CONFIG_DIR"

# Building an image never creates a verification deployment.
unset ANALYSIS_VERIFY_STOP_ENGINE_ONCE
python3 "$SCRIPT_DIR/render-config.py" "$CLOUD_DIR/wrangler.staging.jsonc" "$CONFIG_FILE" "$CLOUDFLARE_ACCOUNT_ID" "$(printf '%064d' 0)"

LOCAL_TAG="meeshogi-analysis-mvp-staging:${ANALYSIS_IMAGE_TAG}"
./node_modules/.bin/wrangler containers build "$CONTEXT" --tag "$LOCAL_TAG" --push --config "$CONFIG_FILE"
REMOTE_TAG="registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID}/meeshogi-analysis-mvp-staging:${ANALYSIS_IMAGE_TAG}"
MANIFEST="$(docker manifest inspect -v "$REMOTE_TAG")"
DIGEST="$(python3 -c 'import json,sys; value=json.loads(sys.argv[1]); digest=value.get("Descriptor",{}).get("digest"); print(digest or "")' "$MANIFEST")"
[[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "Cloudflare registry did not return a pinned sha256 manifest digest." >&2; exit 1; }
IMAGE_REF="registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID}/meeshogi-analysis-mvp-staging@${DIGEST}"
printf 'ANALYSIS_IMAGE_REF=%s\n' "$IMAGE_REF"
