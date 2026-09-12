#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$repo_root/native/target}"
node scripts/engine/verify-model.mjs

if ! command -v cargo-ndk >/dev/null 2>&1 && ! cargo ndk --help >/dev/null 2>&1; then
  echo 'cargo-ndk is required (install cargo-ndk and configure the Android NDK).' >&2
  exit 1
fi

abis_csv=${MEESHOGI_ANDROID_ABIS:-arm64-v8a,x86_64}
platform=${MEESHOGI_ANDROID_PLATFORM:-24}
output_dir=${MEESHOGI_ANDROID_OUTPUT:-native/target/android-libs}
case "$output_dir" in
  /*) ;;
  *) output_dir="$repo_root/$output_dir" ;;
esac
mkdir -p "$output_dir"

read -r -a abis <<< "${abis_csv//,/ }"
target_args=()
for abi in "${abis[@]}"; do
  [[ -n "$abi" ]] || continue
  target_args+=("-t" "$abi")
done
((${#target_args[@]} > 0)) || { echo 'MEESHOGI_ANDROID_ABIS must contain at least one ABI.' >&2; exit 1; }

(cd native/sekirei && cargo ndk "${target_args[@]}" -P "$platform" -o "$output_dir" \
  build --locked --release)
