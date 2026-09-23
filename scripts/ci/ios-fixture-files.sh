#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
bundle_id='com.meeshogi.testfiles'
app_name='MeeshogiFixtures.app'
arch=${IOS_SIM_ARCH:-$(uname -m)}
deployment_target=${IOS_SIM_DEPLOYMENT_TARGET:-16.4}

usage() {
  cat >&2 <<'EOF'
Usage: scripts/ci/ios-fixture-files.sh <simulator-udid> <utf8-file> <shift-jis-file>

Builds and installs the CI-only Files fixture helper, then copies both input
files into its Documents directory. The input basenames are kept as the Files
app display names.
EOF
}

if [[ $# -ne 3 ]]; then
  usage
  exit 2
fi

udid=$1
utf8_file=$2
shift_jis_file=$3
for source in "$utf8_file" "$shift_jis_file"; do
  if [[ ! -f "$source" ]]; then
    echo "fixture file does not exist: $source" >&2
    exit 1
  fi
done

utf8_name=$(basename "$utf8_file")
shift_jis_name=$(basename "$shift_jis_file")
if [[ "$utf8_name" == "$shift_jis_name" ]]; then
  echo "fixture basenames must be different so Files can show both inputs" >&2
  exit 1
fi

sdk_root=$(xcrun --sdk iphonesimulator --show-sdk-path)
clang_path=$(xcrun --sdk iphonesimulator --find clang)
output_root=${IOS_FILES_HELPER_OUT:-$repo_root/artifacts/ios/files-helper}
app_path="$output_root/$app_name"

rm -rf "$output_root"
mkdir -p "$app_path"

"$clang_path" \
  -arch "$arch" \
  -isysroot "$sdk_root" \
  -mios-simulator-version-min="$deployment_target" \
  -fobjc-arc \
  -framework UIKit \
  -framework Foundation \
  "$repo_root/scripts/ci/files-ios/main.m" \
  -o "$app_path/MeeshogiFixtures"
cp "$repo_root/scripts/ci/files-ios/Info.plist" "$app_path/Info.plist"
codesign --force --deep --sign - "$app_path" >/dev/null

xcrun simctl boot "$udid" >/dev/null 2>&1 || true
xcrun simctl bootstatus "$udid" -b
xcrun simctl uninstall "$udid" "$bundle_id" >/dev/null 2>&1 || true
xcrun simctl install "$udid" "$app_path"

data_container=$(xcrun simctl get_app_container "$udid" "$bundle_id" data)
documents="$data_container/Documents"
mkdir -p "$documents"
cp "$utf8_file" "$documents/$utf8_name"
cp "$shift_jis_file" "$documents/$shift_jis_name"
chmod 644 "$documents/$utf8_name" "$documents/$shift_jis_name"

test -f "$documents/$utf8_name"
test -f "$documents/$shift_jis_name"
printf 'Installed %s\n' "$app_path"
printf 'Documents: %s\n' "$documents"
printf 'Fixture: %s\n' "$documents/$utf8_name"
printf 'Fixture: %s\n' "$documents/$shift_jis_name"
