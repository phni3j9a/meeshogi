#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$repo_root/native/target}"
node scripts/engine/verify-model.mjs

[[ "$(uname -s)" == "Darwin" ]] || { echo 'iOS Rust builds require macOS/Xcode.' >&2; exit 1; }
command -v xcodebuild >/dev/null 2>&1 || { echo 'xcodebuild is required.' >&2; exit 1; }
command -v lipo >/dev/null 2>&1 || { echo 'lipo is required.' >&2; exit 1; }

manifest=native/sekirei/Cargo.toml
out="$repo_root/native/target/ios"
rm -rf "$out"
mkdir -p "$out/sim"

cargo build --locked --release --manifest-path "$manifest" --target aarch64-apple-ios
cargo build --locked --release --manifest-path "$manifest" --target aarch64-apple-ios-sim
cargo build --locked --release --manifest-path "$manifest" --target x86_64-apple-ios

lipo -create \
  "$CARGO_TARGET_DIR/aarch64-apple-ios-sim/release/libmeeshogi_sekirei.a" \
  "$CARGO_TARGET_DIR/x86_64-apple-ios/release/libmeeshogi_sekirei.a" \
  -output "$out/sim/libmeeshogi_sekirei.a"

xcodebuild -create-xcframework \
  -library "$CARGO_TARGET_DIR/aarch64-apple-ios/release/libmeeshogi_sekirei.a" -headers native/sekirei/include \
  -library "$out/sim/libmeeshogi_sekirei.a" -headers native/sekirei/include \
  -output "$out/MeeshogiSekireiCore.xcframework"

# CocoaPods evaluates the local podspec from its pod root. Stage the generated
# native framework and model below that root so the podspec does not depend on
# paths outside the sandbox CocoaPods creates during `pod install`.
pod_root="$repo_root/modules/sekirei/ios"
generated="$pod_root/generated"
rm -rf "$generated"
mkdir -p "$generated/model"
cp -R "$out/MeeshogiSekireiCore.xcframework" "$generated/"
cp "$repo_root/assets/model/c-leaf-wrm-seed42.bin" "$generated/model/"

[[ -d "$generated/MeeshogiSekireiCore.xcframework" ]] \
  || { echo 'generated iOS XCFramework is missing.' >&2; exit 1; }
[[ -f "$generated/model/c-leaf-wrm-seed42.bin" ]] \
  || { echo 'generated iOS model is missing.' >&2; exit 1; }
