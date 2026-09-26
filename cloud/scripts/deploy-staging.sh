#!/usr/bin/env bash
set -euo pipefail

VERIFICATION_MODE=false
BENCHMARK_MODE=false
RUN_MANIFESTS=()
while (($#)); do
  case "$1" in
    --verification) VERIFICATION_MODE=true; shift ;;
    --benchmark) BENCHMARK_MODE=true; shift ;;
    --run-manifest)
      (($# >= 2)) || { echo "--run-manifest requires a JSON path." >&2; exit 2; }
      RUN_MANIFESTS+=("$2")
      shift 2
      ;;
    *) echo "usage: deploy-staging.sh [--verification] [--benchmark --run-manifest FILE ...]" >&2; exit 2 ;;
  esac
done
if [[ "$BENCHMARK_MODE" == true && ${#RUN_MANIFESTS[@]} -eq 0 ]]; then
  echo "Benchmark deployment requires at least one --run-manifest." >&2
  exit 2
fi
if [[ "$BENCHMARK_MODE" != true && ${#RUN_MANIFESTS[@]} -gt 0 ]]; then
  echo "--run-manifest is available only with --benchmark." >&2
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
unset ANALYSIS_BENCHMARK_BUILD_ID
unset ANALYSIS_BENCHMARK_TARGETS

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CLOUD_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$CLOUD_DIR"

: "${CLOUDFLARE_ACCOUNT_ID:?Set CLOUDFLARE_ACCOUNT_ID to the target account ID.}"
: "${ANALYSIS_IMAGE_REF:?Set ANALYSIS_IMAGE_REF to the digest-pinned output of build-push-image.sh.}"
: "${ANALYSIS_INTERNAL_TOKEN:?Set ANALYSIS_INTERNAL_TOKEN in the shell; it is piped to Wrangler and never printed.}"
: "${JOBS_D1_DATABASE_ID:?Set JOBS_D1_DATABASE_ID to the UUID of the meeshogi-jobs-staging D1 database (wrangler d1 create).}"
[[ "$CLOUDFLARE_ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]] || { echo "CLOUDFLARE_ACCOUNT_ID must be 32 lowercase hex characters." >&2; exit 2; }
[[ "$JOBS_D1_DATABASE_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || {
  echo "JOBS_D1_DATABASE_ID must be a D1 database UUID." >&2
  exit 2
}
[[ "$ANALYSIS_IMAGE_REF" =~ ^registry\.cloudflare\.com/${CLOUDFLARE_ACCOUNT_ID}/meeshogi-analysis-mvp-staging@sha256:[0-9a-f]{64}$ ]] || {
  echo "ANALYSIS_IMAGE_REF must be a digest-pinned image for this account and staging repository." >&2
  exit 2
}

TEMP_CONFIG="$(mktemp "$CLOUD_DIR/.wrangler.staging.deploy.XXXXXX.jsonc")"
cleanup() { rm -f -- "$TEMP_CONFIG"; }
trap cleanup EXIT INT TERM
IMAGE_DIGEST="${ANALYSIS_IMAGE_REF##*@sha256:}"
RENDER_D1=(--d1-database-id "$JOBS_D1_DATABASE_ID")
if [[ "$BENCHMARK_MODE" == true ]]; then
  : "${ANALYSIS_BUILD_ID:?Set ANALYSIS_BUILD_ID to the build ID printed by build-push-image.sh.}"
  [[ "$ANALYSIS_BUILD_ID" =~ ^[0-9a-f]{32}$ ]] || { echo "ANALYSIS_BUILD_ID must be 32 lowercase hex characters." >&2; exit 2; }
fi
if [[ "$VERIFICATION_MODE" == true ]]; then
  python3 "$SCRIPT_DIR/render-config.py" "$CLOUD_DIR/wrangler.staging.jsonc" "$TEMP_CONFIG" "$CLOUDFLARE_ACCOUNT_ID" "$IMAGE_DIGEST" "${RENDER_D1[@]}" --verification-stop-engine-once
elif [[ "$BENCHMARK_MODE" == true ]]; then
  RENDER_ARGS=("$CLOUD_DIR/wrangler.staging.jsonc" "$TEMP_CONFIG" "$CLOUDFLARE_ACCOUNT_ID" "$IMAGE_DIGEST" "${RENDER_D1[@]}" --benchmark --build-id "$ANALYSIS_BUILD_ID")
  for manifest in "${RUN_MANIFESTS[@]}"; do
    RENDER_ARGS+=(--run-manifest "$manifest")
  done
  python3 "$SCRIPT_DIR/render-config.py" "${RENDER_ARGS[@]}"
else
  python3 "$SCRIPT_DIR/render-config.py" "$CLOUD_DIR/wrangler.staging.jsonc" "$TEMP_CONFIG" "$CLOUDFLARE_ACCOUNT_ID" "$IMAGE_DIGEST" "${RENDER_D1[@]}"
fi

# Create the Worker and its Container before adding the secret. Requests fail closed while it is unset.
internal_token="$ANALYSIS_INTERNAL_TOKEN"
unset ANALYSIS_INTERNAL_TOKEN
./node_modules/.bin/wrangler deploy --config "$TEMP_CONFIG" --strict --containers-rollout immediate
# Secret input is consumed by Wrangler stdin. It is not inherited by deploy or put in a config, argument, or image.
printf '%s' "$internal_token" | ./node_modules/.bin/wrangler secret put ANALYSIS_INTERNAL_TOKEN --config "$TEMP_CONFIG"
unset internal_token
# Apply the async job schema to the staging D1 database.
./node_modules/.bin/wrangler d1 migrations apply meeshogi-jobs-staging --config "$TEMP_CONFIG" --remote
