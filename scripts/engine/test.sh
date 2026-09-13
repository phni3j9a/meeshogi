#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$repo_root/native/target}"
node scripts/engine/verify-model.mjs
cargo test --locked --manifest-path native/sekirei/Cargo.toml
