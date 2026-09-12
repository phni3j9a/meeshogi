#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"

artifact_dir="$root/artifacts/ios"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
run_dir="$artifact_dir/runs/$run_id"
maestro_dir="$run_dir/maestro"
mkdir -p "$maestro_dir"
trace() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$run_dir/timeline.log"
}
trace acceptance.start

# Keep the clipboard inputs in the ignored artifact tree so the exact bytes
# used by simctl pbcopy remain available with the CI artifact.
clipboard_wars="$run_dir/clipboard-wars.txt"
clipboard_kiou="$run_dir/clipboard-kiou.txt"
printf '%s' 'asitaka_y' > "$clipboard_wars"
printf '%s' 'シシ神' > "$clipboard_kiou"

utf8_fixture="$run_dir/kiou.kif"
shift_jis_fixture="$run_dir/kiou-shift-jis.kif"
cp fixtures/kif/kiou.kif "$utf8_fixture"
iconv -f UTF-8 -t SHIFT_JIS "$utf8_fixture" > "$shift_jis_fixture"

xcrun simctl list devices available --json > "$run_dir/devices.json"
device="$(python3 - "$run_dir/devices.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)
phones = [
    device
    for runtime, devices in data["devices"].items()
    if "iOS" in runtime
    for device in devices
    if device.get("isAvailable") and device["name"].startswith("iPhone")
]
if not phones:
    raise SystemExit("No available iPhone Simulator")
print(phones[0]["udid"])
PY
)"
trace simulator.boot.start
xcrun simctl boot "$device" || true
python3 - "$device" <<'PY'
import subprocess
import sys

subprocess.run(["xcrun", "simctl", "bootstatus", sys.argv[1], "-b"], timeout=600, check=True)
PY
trace simulator.boot.end
xcrun simctl status_bar "$device" override --time 9:41 --batteryState charged --batteryLevel 100
trace app.install.start
xcrun simctl install "$device" "$RUNNER_TEMP/meeshogi-ios/Build/Products/Release-iphonesimulator/meeshogi.app"

trace app.install.end

# Stage both encoding variants in the CI-only helper's public Documents folder.
IOS_FILES_HELPER_OUT="$run_dir/files-helper" \
  bash scripts/ci/ios-fixture-files.sh "$device" "$utf8_fixture" "$shift_jis_fixture"

# The import flow consumes the KIF clipboard. The player-name flows receive
# their independent real OS clipboard values after the import has been saved.
xcrun simctl pbcopy "$device" < fixtures/kif/shogiwars.kif
xcrun simctl io "$device" recordVideo "$run_dir/flow.mov" > "$run_dir/recording.log" 2>&1 &
record_pid=$!

content_size_original=''
content_size_changed=0

restore_content_size() {
  if [[ "$content_size_changed" == 1 && -n "$content_size_original" ]]; then
    xcrun simctl ui "$device" content_size "$content_size_original"
    content_size_changed=0
  fi
}

cleanup() {
  local status=$?
  trap - EXIT
  trace "acceptance.end status=$status"
  restore_content_size || true
  kill -INT "$record_pid" 2>/dev/null || true
  wait "$record_pid" 2>/dev/null || true
  xcrun simctl io "$device" screenshot "$run_dir/final.png" || true
  xcrun simctl spawn "$device" log show --last 10m --style compact --predicate 'process == "meeshogi"' > "$run_dir/simulator.log" || true
  exit "$status"
}
trap cleanup EXIT

run_flow() {
  local name=$1
  local flow=$2
  local output="$maestro_dir/$name"
  mkdir -p "$output/test-output"
  trace "flow.start $name"
  maestro --device "$device" test \
    -e INITIAL_READY_TIMEOUT=180000 \
    --format junit \
    --output "$output/junit.xml" \
    --test-output-dir "$output/test-output" \
    "$flow"
  trace "flow.end $name"
}

run_flow import-review .maestro/import-review.yaml
xcrun simctl pbcopy "$device" < "$clipboard_wars"
run_flow player-names .maestro/player-names.yaml
xcrun simctl pbcopy "$device" < "$clipboard_kiou"
run_flow player-names-kiou .maestro/player-names-kiou.yaml
run_flow analysis-review .maestro/analysis-review.yaml
run_flow candidate-review .maestro/candidate-review.yaml
run_flow file-import .maestro/file-import.yaml
run_flow management-review .maestro/management-review.yaml
run_flow appearance-review .maestro/appearance-review.yaml
run_flow appearance-dark .maestro/appearance-dark.yaml
run_flow export-review-ios .maestro/export-review-ios.yaml

# Save to Files writes into the CI-only helper's public Documents directory.
# shareKif chooses a game-id-based filename, so identify the one new .kifu
# rather than coupling this check to the generated id.
helper_documents="$(xcrun simctl get_app_container "$device" com.meeshogi.testfiles data)/Documents"
exported_paths="$run_dir/exported-kifu-paths.txt"
exported_count=0
for ((attempt = 1; attempt <= 30; attempt += 1)); do
  find "$helper_documents" -maxdepth 1 -type f -name '*.kifu' -print | sort > "$exported_paths"
  exported_count="$(wc -l < "$exported_paths" | tr -d '[:space:]')"
  [[ "$exported_count" != 0 ]] && break
  sleep 1
done
if [[ "$exported_count" != 1 ]]; then
  echo "expected exactly one exported .kifu in $helper_documents, found $exported_count" >&2
  cat "$exported_paths" >&2
  exit 1
fi
exported_kifu="$(sed -n '1p' "$exported_paths")"
cp "$exported_kifu" "$run_dir/exported-shogiwars.kifu"
cmp fixtures/kif/shogiwars.kif "$exported_kifu"
echo "iOS KIF export matches fixtures/kif/shogiwars.kif: $exported_kifu"

run_flow background-review .maestro/background-review.yaml

# Validate the installed Xcode command vocabulary before changing the
# Simulator's Dynamic Type setting. Keep this help output with the run so a
# future Xcode change is diagnosable from CI artifacts.
simctl_ui_help="$run_dir/simctl-ui-help.txt"
xcrun simctl help ui > "$simctl_ui_help" 2>&1
if ! rg -q '(^|[^[:alnum:]_-])content_size([^[:alnum:]_-]|$)' "$simctl_ui_help"; then
  echo "installed simctl does not advertise ui content_size; see $simctl_ui_help" >&2
  exit 1
fi
content_size_target=''
if rg -q '(^|[^[:alnum:]_-])extra-extra-extra-large([^[:alnum:]_-]|$)' "$simctl_ui_help"; then
  content_size_target='extra-extra-extra-large'
fi
if [[ -z "$content_size_target" ]]; then
  echo "simctl ui help has no supported large content_size value; see $simctl_ui_help" >&2
  exit 1
fi

content_size_original="$(
  xcrun simctl ui "$device" content_size |
    tr -d '\r' |
    tail -n 1 |
    tr -d '[:space:]'
)"
if [[ -z "$content_size_original" ]]; then
  echo "could not read the Simulator content_size before large-text review" >&2
  exit 1
fi
printf '%s\n' "$content_size_original" > "$run_dir/content-size-before.txt"
printf '%s\n' "$content_size_target" > "$run_dir/content-size-target.txt"

# Mark the setting dirty before applying it so an interrupted/failed Maestro
# run still causes cleanup() to restore the captured value.
content_size_changed=1
xcrun simctl ui "$device" content_size "$content_size_target"
run_flow large-text-review .maestro/large-text-review.yaml
restore_content_size
printf '%s\n' "$content_size_original" > "$run_dir/content-size-restored.txt"

run_flow search-delete-review .maestro/search-delete-review.yaml
