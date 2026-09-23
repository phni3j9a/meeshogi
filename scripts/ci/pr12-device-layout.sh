#!/usr/bin/env bash
# PR #12 native acceptance — layout sweep on secondary simulators.
# Installs the already-built Release app and seeds the KeroPona game by
# copying the main device app container's SQLite payload (the suite leaves a
# fully analyzed 標準 game), then runs .maestro/pr12-layout.yaml with screen
# recording. A second pass runs with an enlarged OS content size when
# PR12_CONTENT_SIZE is set.
#
# Usage:
#   RUNNER_TEMP=$HOME/runner-temp bash scripts/ci/pr12-device-layout.sh \
#     <target-udid> <out-dir> [content-size]
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"

device="$1"
run_dir="$2"
content_size="${3:-}"
mkdir -p "$run_dir"
maestro_bin="${MAESTRO_BIN:-maestro}"

app_path="${RUNNER_TEMP:?set RUNNER_TEMP}/meeshogi-ios/Build/Products/Release-iphonesimulator/meeshogi.app"
[[ -d "$app_path" ]] || { echo "app not found: $app_path" >&2; exit 1; }

source_container="$(xcrun simctl get_app_container "${PR12_SOURCE_DEVICE:?set PR12_SOURCE_DEVICE}" com.meeshogi.app data)"

xcrun simctl boot "$device" >/dev/null 2>&1 || true
xcrun simctl bootstatus "$device" -b
xcrun simctl install "$device" "$app_path"
xcrun simctl launch "$device" com.meeshogi.app >/dev/null 2>&1 || true
sleep 4
xcrun simctl terminate "$device" com.meeshogi.app >/dev/null 2>&1 || true

# Seed the analyzed game: the app stores everything in Documents/SQLite.
target_container="$(xcrun simctl get_app_container "$device" com.meeshogi.app data)"
mkdir -p "$target_container/Documents/SQLite"
cp "$source_container/Documents/SQLite/"meeshogi.db* "$target_container/Documents/SQLite/"

trace() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$run_dir/timeline.log"; }
record_pid=''
stop_recording() {
  if [[ -n "${record_pid:-}" ]]; then
    kill -INT "$record_pid" 2>/dev/null || true
    wait "$record_pid" 2>/dev/null || true
    record_pid=''
  fi
}

run_layout() {
  local name=$1
  local output="$run_dir/maestro/$name"
  mkdir -p "$output/test-output"
  trace "flow.start $name"
  xcrun simctl io "$device" recordVideo "$run_dir/$name.mov" > "$run_dir/$name.record.log" 2>&1 &
  record_pid=$!
  local status=0
  "$maestro_bin" --device "$device" test \
    -e INITIAL_READY_TIMEOUT=180000 -e IMPORT_SAVE_TIMEOUT=120000 \
    --format junit --output "$output/junit.xml" \
    --test-output-dir "$output/test-output" .maestro/pr12-layout.yaml || status=$?
  stop_recording
  trace "flow.end $name status=$status"
  return "$status"
}

run_layout pr12-layout
if [[ -n "$content_size" ]]; then
  xcrun simctl ui "$device" content_size "$content_size"
  run_layout "pr12-layout-${content_size}"
  xcrun simctl ui "$device" content_size large
fi
xcrun simctl io "$device" screenshot "$run_dir/final.png"
trace "device-layout.end"
