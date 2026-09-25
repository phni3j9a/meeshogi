#!/usr/bin/env bash
set -euo pipefail

VERIFICATION_MODE=false
BENCHMARK_MODE=false
INSTANCE_TYPE="standard-2"
INSTANCE_TYPE_SET=false
while (($#)); do
  case "$1" in
    --verification) VERIFICATION_MODE=true; shift ;;
    --benchmark) BENCHMARK_MODE=true; shift ;;
    --instance-type)
      (($# >= 2)) || { echo "--instance-type requires standard-2 or standard-3." >&2; exit 2; }
      INSTANCE_TYPE="$2"
      INSTANCE_TYPE_SET=true
      shift 2
      ;;
    *) echo "usage: deploy-staging.sh [--verification] [--benchmark --instance-type standard-2|standard-3]" >&2; exit 2 ;;
  esac
done
[[ "$INSTANCE_TYPE" == "standard-2" || "$INSTANCE_TYPE" == "standard-3" ]] || { echo "Unsupported Container instance type." >&2; exit 2; }
if [[ "$BENCHMARK_MODE" == true && "$INSTANCE_TYPE_SET" != true ]]; then
  echo "Benchmark deployment requires an explicit --instance-type." >&2
  exit 2
fi
if [[ "$BENCHMARK_MODE" != true && "$INSTANCE_TYPE_SET" == true ]]; then
  echo "--instance-type is available only with --benchmark." >&2
  exit 2
fi
if [[ "$BENCHMARK_MODE" == true && "$VERIFICATION_MODE" == true ]]; then
  echo "--verification and --benchmark cannot be combined." >&2
  exit 2
fi
# The environment variable is never a deployment-mode switch.
unset ANALYSIS_VERIFY_STOP_ENGINE_ONCE
unset ANALYSIS_BENCHMARK_ENABLED
unset ANALYSIS_EXPECTED_INSTANCE_TYPE

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
if [[ "$VERIFICATION_MODE" == true ]]; then
  python3 "$SCRIPT_DIR/render-config.py" "$CLOUD_DIR/wrangler.staging.jsonc" "$TEMP_CONFIG" "$CLOUDFLARE_ACCOUNT_ID" "$IMAGE_DIGEST" --verification-stop-engine-once
elif [[ "$BENCHMARK_MODE" == true ]]; then
  python3 "$SCRIPT_DIR/render-config.py" "$CLOUD_DIR/wrangler.staging.jsonc" "$TEMP_CONFIG" "$CLOUDFLARE_ACCOUNT_ID" "$IMAGE_DIGEST" --benchmark --instance-type "$INSTANCE_TYPE"
else
  python3 "$SCRIPT_DIR/render-config.py" "$CLOUD_DIR/wrangler.staging.jsonc" "$TEMP_CONFIG" "$CLOUDFLARE_ACCOUNT_ID" "$IMAGE_DIGEST"
fi

# Create the Worker and its Container before adding the secret. Requests fail closed while it is unset.
internal_token="$ANALYSIS_INTERNAL_TOKEN"
unset ANALYSIS_INTERNAL_TOKEN
./node_modules/.bin/wrangler deploy --config "$TEMP_CONFIG" --strict --containers-rollout immediate
# Secret input is consumed by Wrangler stdin. It is not inherited by deploy or put in a config, argument, or image.
printf '%s' "$internal_token" | ./node_modules/.bin/wrangler secret put ANALYSIS_INTERNAL_TOKEN --config "$TEMP_CONFIG"
unset internal_token
