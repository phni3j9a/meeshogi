#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$repo_root/native/target}"
model_path=${1:-assets/model/c-leaf-wrm-seed42.bin}
reference_path=${MEESHOGI_STATIC_EVAL_REFERENCE:-fixtures/analysis/static-eval-reference.tsv}

node scripts/engine/verify-model.mjs "$model_path" >/dev/null

actual=$(mktemp /tmp/meeshogi-static-eval.XXXXXX)
trap 'rm -f "$actual"' EXIT

cargo run --quiet --locked --manifest-path native/sekirei/Cargo.toml \
  --example static_eval_probe -- "$model_path" >"$actual"

expected=$(mktemp /tmp/meeshogi-static-eval-expected.XXXXXX)
trap 'rm -f "$actual" "$expected"' EXIT
awk -F '\t' 'NF && $1 !~ /^#/ && $1 != "name" { print }' "$reference_path" >"$expected"

diff -u "$expected" "$actual"
echo "static evaluation cross-check: exact integer match ($(wc -l <"$actual") positions)"
