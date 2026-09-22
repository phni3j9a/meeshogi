#!/usr/bin/env bash
set -euo pipefail

# Diagnostic-only A/B/C/D comparison for Issue #7. This script never changes
# the product Cargo files and never uses private game records. B and C are
# reconstructed in a temporary directory; D compiles the bridge source from
# this worktree into the temporary runner before probing the controlled core.

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/../.." && pwd)
fixture_path=${MEESHOGI_DIAGNOSTIC_FIXTURE:-$repo_root/fixtures/analysis/positions.json}
model_path=${MEESHOGI_DIAGNOSTIC_MODEL:-$repo_root/assets/model/c-leaf-wrm-seed42.bin}
output_dir=${MEESHOGI_DIAGNOSTIC_OUTPUT_DIR:-}
diagnostic_cargo_home=${MEESHOGI_DIAGNOSTIC_CARGO_HOME:-${CARGO_HOME:-/home/server/.cargo}}
v037_source=${MEESHOGI_DIAGNOSTIC_V037_SOURCE:-}
keep_scratch=${MEESHOGI_DIAGNOSTIC_KEEP_SCRATCH:-0}

if [[ ! -f "$fixture_path" ]]; then
  echo "fixture not found: $fixture_path" >&2
  exit 2
fi
if [[ ! -f "$model_path" ]]; then
  echo "model not found: $model_path" >&2
  exit 2
fi

if [[ -z "$output_dir" ]]; then
  output_dir=$(mktemp -d /tmp/meeshogi-issue7-diagnostics.XXXXXX)
else
  mkdir -p "$output_dir"
fi
raw_dir="$output_dir/raw"
mkdir -p "$raw_dir"
scratch_dir=$(mktemp -d /tmp/meeshogi-issue7-build.XXXXXX)
if [[ "$keep_scratch" == "1" ]]; then
  echo "scratch directory retained: $scratch_dir" >&2
else
  trap 'rm -rf "$scratch_dir"' EXIT
fi

cargo_git_db=$(find "$diagnostic_cargo_home/git/db" -maxdepth 1 -type d -name 'sekirei-*' -print -quit 2>/dev/null || true)
if [[ -z "$cargo_git_db" ]]; then
  echo "Sekirei git cache is unavailable under $diagnostic_cargo_home/git/db" >&2
  echo "Set MEESHOGI_DIAGNOSTIC_CARGO_HOME to a prepared offline Cargo cache." >&2
  exit 3
fi

v036_rev=aeb6ea30d58f93cad84ffe98bc13441feb807fa8
v037_rev=7fd1d9b42a85fbc5aeb222f8aa453d3e08f3c0ac
git --git-dir="$cargo_git_db" cat-file -e "$v036_rev^{commit}"
if git --git-dir="$cargo_git_db" cat-file -e "$v037_rev^{commit}" 2>/dev/null; then
  v037_source_mode=git-cache
else
  if [[ -z "$v037_source" || ! -f "$v037_source/Cargo.toml" ]]; then
    echo "Sekirei v0.3.37 commit is not in the offline Cargo git cache." >&2
    echo "Set MEESHOGI_DIAGNOSTIC_V037_SOURCE to a verified v0.3.37 crates/sekirei-core tree." >&2
    exit 3
  fi
  if ! rg -q '^version = "0\.3\.37"$' "$v037_source/Cargo.toml" \
    || ! rg -q 'NnueOutputMode::ResidualMaterial' "$v037_source/src/eval.rs" \
    || ! rg -q 'moves\.len\(\) == 1' "$v037_source/src/search.rs"; then
    echo "MEESHOGI_DIAGNOSTIC_V037_SOURCE does not look like Sekirei v0.3.37." >&2
    exit 3
  fi
  v037_source_mode=verified-external-tree
fi

node "$repo_root/scripts/engine/verify-model.mjs" "$model_path" > "$output_dir/model-verification.log"
printf '%s\n' \
  "fixture=$fixture_path" \
  "fixture_sha256=$(sha256sum "$fixture_path" | awk '{print $1}')" \
  "model=$model_path" \
  "model_sha256=$(sha256sum "$model_path" | awk '{print $1}')" \
  "v036=$v036_rev" \
  "v037=$v037_rev" \
  "v037_source_mode=$v037_source_mode" \
  "v037_source=${v037_source:-cargo-git-cache}" \
  "threads=1" \
  "specTopN=0" \
  "ttMiB=16" \
  "maxDepth=8" \
  "budgets=1,10000,100000,1000000(sequence positions)" \
  "cargo_net_offline=true" > "$output_dir/run-metadata.txt"

make_core_variant() {
  local variant=$1
  local revision=$2
  local destination=$3
  mkdir -p "$destination"
  git --git-dir="$cargo_git_db" archive "$revision" crates/sekirei-core | tar -x -C "$destination"
}

make_v037_variant() {
  local destination=$1
  if [[ "$v037_source_mode" == git-cache ]]; then
    make_core_variant "$2" "$v037_rev" "$destination"
  else
    mkdir -p "$destination/crates"
    cp -a "$v037_source" "$destination/crates/sekirei-core"
  fi
}

make_core_variant A "$v036_rev" "$scratch_dir/A"
mkdir -p "$scratch_dir/B/crates"
cp -a "$scratch_dir/A/crates/sekirei-core" "$scratch_dir/B/crates/"
(cd "$scratch_dir/B" && git apply "$script_dir/single-root-search.patch")
make_v037_variant "$scratch_dir/C" C
make_v037_variant "$scratch_dir/D" D

make_manifest() {
  local variant=$1
  local core_path=$2
  local manifest_dir="$scratch_dir/$variant"
  sed "s|CORE_PATH|$core_path|g" "$script_dir/Cargo.toml.template" > "$manifest_dir/Cargo.toml"
  mkdir -p "$manifest_dir/src"
  cp "$script_dir/runner.rs" "$manifest_dir/src/main.rs"
  CARGO_HOME="$diagnostic_cargo_home" CARGO_NET_OFFLINE=true \
    cargo generate-lockfile --offline --manifest-path "$manifest_dir/Cargo.toml" \
    > "$output_dir/$variant-lock.log" 2>&1
}

make_manifest A crates/sekirei-core
make_manifest B crates/sekirei-core
make_manifest C crates/sekirei-core
make_manifest D crates/sekirei-core

run_variant() {
  local variant=$1
  local features=()
  local bridge_env=()
  if [[ "$variant" == D ]]; then
    features=(--features product_bridge)
    bridge_env=(MEESHOGI_DIAGNOSTIC_BRIDGE="$repo_root/native/sekirei/src/lib.rs")
    ln -sf "$repo_root/native/sekirei/src/lib.rs" "$scratch_dir/$variant/src/product_bridge.rs"
  fi
  local command_log="$output_dir/$variant-command.txt"
  {
    printf 'CARGO_HOME=%q CARGO_NET_OFFLINE=true MEESHOGI_DIAGNOSTIC_DEEP=1 ' "$diagnostic_cargo_home"
    printf 'CARGO_TARGET_DIR=%q ' "$scratch_dir/target-$variant"
    printf 'cargo run --offline --locked --release --manifest-path %q ' "$scratch_dir/$variant/Cargo.toml"
    if ((${#features[@]})); then
      printf '%q ' "${features[@]}"
    fi
    printf -- '-- %q %q %q\n' "$variant" "$model_path" "$fixture_path"
  } > "$command_log"
  env CARGO_HOME="$diagnostic_cargo_home" CARGO_NET_OFFLINE=true \
    MEESHOGI_DIAGNOSTIC_DEEP=1 CARGO_TARGET_DIR="$scratch_dir/target-$variant" \
    "${bridge_env[@]}" \
    cargo run --offline --locked --release --manifest-path "$scratch_dir/$variant/Cargo.toml" \
    "${features[@]}" -- "$variant" "$model_path" "$fixture_path" \
    > "$raw_dir/$variant.jsonl" 2> "$output_dir/$variant-build.log"
}

run_variant A
run_variant B
run_variant C
run_variant D

python3 "$script_dir/assemble.py" --input-dir "$raw_dir" --output-dir "$output_dir" \
  > "$output_dir/assemble.log"

printf 'diagnostic output: %s\n' "$output_dir"
printf 'combined JSON: %s\n' "$output_dir/combined.json"
printf 'combined TSV: %s\n' "$output_dir/combined.tsv"
