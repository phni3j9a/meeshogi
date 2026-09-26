#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"

artifact_dir="$root/artifacts/android"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
run_dir="$artifact_dir/runs/$run_id"
maestro_dir="$run_dir/maestro"
video_dir="$run_dir/video"
record_state="$video_dir/current-recording.state"
record_stop="$video_dir/stop-recording"
mkdir -p "$maestro_dir" "$video_dir"

# Focused runs: ACCEPTANCE_FLOWS="analysis-review,candidate-review" runs only
# those flows, in the normal order, after the licenses/import setup flows.
# Later flows reuse app state from earlier ones, so a focused run is iteration
# evidence, not acceptance; leave it unset for the full run.
known_flows=",licenses-review,import-review,player-names,player-names-kiou,analysis-review,analysis-partial-review,candidate-review,file-import,management-review,appearance-review,appearance-dark,export-review,background-review,large-text-review,search-delete-review,cloud-method-picker,cloud-free-start,cloud-interruptions,cloud-free-verify,cloud-branch-local,cloud-cancel,cloud-precision-denied,cloud-precision-run,cloud-export,"
if [[ -n "${ACCEPTANCE_FLOWS:-}" ]]; then
  IFS=, read -r -a requested_flows <<< "$ACCEPTANCE_FLOWS"
  for requested in "${requested_flows[@]}"; do
    if [[ "$known_flows" != *",$requested,"* ]]; then
      echo "ACCEPTANCE_FLOWS has an unknown flow: $requested" >&2
      exit 2
    fi
  done
fi
flow_selected() {
  [[ -z "${ACCEPTANCE_FLOWS:-}" || "$1" == licenses-review || "$1" == import-review ||
     ",${ACCEPTANCE_FLOWS}," == *",$1,"* ]]
}
# Issue #22 cloud flows are opt-in only: they need a Release build bundled
# with EXPO_PUBLIC_CLOUD_ENDPOINT (and real staging quota), so they never run
# in the default "all" suite — only via an explicit ACCEPTANCE_FLOWS list.
flow_requested() {
  [[ -n "${ACCEPTANCE_FLOWS:-}" && ",${ACCEPTANCE_FLOWS}," == *",$1,"* ]]
}
printf '%s\n' "${ACCEPTANCE_FLOWS:-all}" > "$run_dir/selected-flows.txt"

if [[ ${1:-} != --installed ]]; then
  adb push -Z artifacts/android/meeshogi.apk /data/local/tmp/meeshogi-acceptance.apk
  local_digest="$(sha256sum artifacts/android/meeshogi.apk | cut -d ' ' -f 1)"
  device_digest="$(adb shell sha256sum /data/local/tmp/meeshogi-acceptance.apk | cut -d ' ' -f 1)"
  [[ "$local_digest" == "$device_digest" ]] || { echo 'APK transfer digest mismatch' >&2; exit 1; }
  adb shell pm install -r /data/local/tmp/meeshogi-acceptance.apk
  adb shell rm /data/local/tmp/meeshogi-acceptance.apk
fi

# Keep the clipboard inputs in the ignored artifact tree so the exact bytes
# used by the OS clipboard remain available with the CI artifact.
clipboard_wars="$run_dir/clipboard-wars.txt"
clipboard_kiou="$run_dir/clipboard-kiou.txt"
printf '%s' 'asitaka_y' > "$clipboard_wars"
printf '%s' 'シシ神' > "$clipboard_kiou"

utf8_fixture="$run_dir/kiou.kif"
shift_jis_fixture="$run_dir/kiou-shift-jis.kif"
cp fixtures/kif/kiou.kif "$utf8_fixture"
iconv -f UTF-8 -t SHIFT_JIS "$utf8_fixture" > "$shift_jis_fixture"
adb shell mkdir -p /sdcard/Download
adb push "$utf8_fixture" /sdcard/Download/kiou.kif
adb push "$shift_jis_fixture" /sdcard/Download/kiou-shift-jis.kif

# The import flow consumes the KIF clipboard. The player-name flows receive
# their independent real OS clipboard values after the import has been saved.
bash scripts/ci/android-clipboard.sh fixtures/kif/shogiwars.kif
adb logcat -c

original_font_scale=''
record_loop_pid=''
record_loop() {
  local segment=0
  while :; do
    [[ -e "$record_stop" ]] && break
    segment=$((segment + 1))
    local remote="/sdcard/meeshogi-flow-${segment}.mp4"
    local local_output="$video_dir/flow-${segment}.mp4"
    local segment_log="$video_dir/recording-${segment}.log"
    [[ -e "$record_stop" ]] && break
    adb shell rm -f "$remote" >/dev/null 2>&1 || true
    adb shell screenrecord --time-limit 180 "$remote" >"$segment_log" 2>&1 &
    local recorder_pid=$!
    printf '%s\n%s\n%s\n' "$remote" "$local_output" "$segment_log" > "$record_state.tmp"
    printf '%s\n' "$recorder_pid" >> "$record_state.tmp"
    mv "$record_state.tmp" "$record_state"
    wait "$recorder_pid" 2>/dev/null || true
    adb pull "$remote" "$local_output" >>"$segment_log" 2>&1 || true
    adb shell rm -f "$remote" >/dev/null 2>&1 || true
    rm -f "$record_state"
    [[ -e "$record_stop" ]] && break
  done
}
record_loop &
record_loop_pid=$!

cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$original_font_scale" ]]; then
    adb shell settings put system font_scale "$original_font_scale" || true
  fi
  : > "$record_stop"
  # Stop the remote recorder without killing the host adb process. The loop
  # must receive its normal exit, finalize the MP4, and pull it before wait.
  for _ in {1..30}; do
    kill -0 "$record_loop_pid" 2>/dev/null || break
    adb shell pkill -INT screenrecord 2>/dev/null || true
    sleep 0.2
  done
  wait "$record_loop_pid" 2>/dev/null || true
  if [[ -s "$record_state" ]]; then
    mapfile -t recording_state < "$record_state" || true
    remote=${recording_state[0]:-}
    local_output=${recording_state[1]:-}
    segment_log=${recording_state[2]:-}
    recorder_pid=${recording_state[3]:-}
    if [[ -n "$remote" && -n "$local_output" ]]; then
      adb pull "$remote" "$local_output" >>"${segment_log:-/dev/null}" 2>&1 || true
      adb shell rm -f "$remote" >/dev/null 2>&1 || true
    fi
    if [[ -n "$recorder_pid" && -n "$segment_log" ]]; then
      printf 'host recorder pid %s finalized during cleanup\n' "$recorder_pid" >> "$segment_log"
    fi
    rm -f "$record_state"
  fi
  rm -f "$record_state.tmp" "$record_stop"
  adb logcat -d -v threadtime > "$run_dir/logcat.txt" || true
  adb exec-out screencap -p > "$run_dir/final.png" || true
  exit "$status"
}
trap cleanup EXIT

run_flow() {
  local name=$1
  local flow=$2
  local output="$maestro_dir/$name"
  if ! flow_selected "$name"; then
    echo "flow.skip $name"
    return 0
  fi
  mkdir -p "$output/test-output"
  maestro test \
    --format junit \
    --output "$output/junit.xml" \
    --test-output-dir "$output/test-output" \
    "$flow"
}

run_flow licenses-review .maestro/licenses-review.yaml
run_flow import-review .maestro/import-review.yaml
if flow_selected player-names; then
  bash scripts/ci/android-clipboard.sh "$clipboard_wars"
fi
run_flow player-names .maestro/player-names.yaml
if flow_selected player-names-kiou; then
  bash scripts/ci/android-clipboard.sh "$clipboard_kiou"
fi
run_flow player-names-kiou .maestro/player-names-kiou.yaml
run_flow analysis-review .maestro/analysis-review.yaml
run_flow analysis-partial-review .maestro/analysis-partial-review.yaml
run_flow candidate-review .maestro/candidate-review.yaml
run_flow file-import .maestro/file-import.yaml
run_flow management-review .maestro/management-review.yaml
run_flow appearance-review .maestro/appearance-review.yaml
run_flow appearance-dark .maestro/appearance-dark.yaml
run_flow export-review .maestro/export-review.yaml
if flow_selected export-review; then
  adb pull /sdcard/Download/meeshogi-export.txt "$run_dir/exported.kifu"
  cmp fixtures/kif/shogiwars.kif "$run_dir/exported.kifu"
fi
run_flow background-review .maestro/background-review.yaml

# --- Issue #22 cloud acceptance (opt-in; see flow_requested above) ---------
# Requires a Release APK bundled with EXPO_PUBLIC_CLOUD_ENDPOINT=<staging>
# and EXPO_PUBLIC_ENABLE_ANALYSIS_EXPORT=1. Runs against staging with real
# Free/Precision quota.
mkdir -p "$run_dir/cloud"
if flow_requested cloud-method-picker; then
  bash scripts/ci/cloud-db-snapshot.sh android "$run_dir/cloud/picker-before.txt" || true
  run_flow cloud-method-picker .maestro/cloud-method-picker.yaml
  bash scripts/ci/cloud-db-snapshot.sh android "$run_dir/cloud/picker-after.txt" || true
fi
# cloud-cancel runs FIRST: it starts attempt #1 and cancels it while the job
# is live (a completed Free job would make cloud-start disabled), then
# cloud-free-start creates attempt #2 ('再試行') which interruptions exercise.
if flow_requested cloud-cancel; then
  run_flow cloud-cancel .maestro/cloud-cancel.yaml
  bash scripts/ci/cloud-db-snapshot.sh android "$run_dir/cloud/cancel-after.txt" || true
fi
if flow_requested cloud-free-start; then
  run_flow cloud-free-start .maestro/cloud-free-start.yaml
fi
if flow_requested cloud-interruptions; then
  bash scripts/ci/cloud-interruption.sh android "$run_dir" \
    || echo 'cloud-interruption.sh reported failures — see cloud/summary.txt' >&2
fi
if flow_requested cloud-free-verify; then
  run_flow cloud-free-verify .maestro/cloud-free-verify.yaml
fi
if flow_requested cloud-branch-local; then
  bash scripts/ci/cloud-db-snapshot.sh android "$run_dir/cloud/branch-before.txt" || true
  run_flow cloud-branch-local .maestro/cloud-branch-local.yaml
  bash scripts/ci/cloud-db-snapshot.sh android "$run_dir/cloud/branch-after.txt" || true
fi
if flow_requested cloud-precision-denied; then
  run_flow cloud-precision-denied .maestro/cloud-precision-denied.yaml
  bash scripts/ci/cloud-db-snapshot.sh android "$run_dir/cloud/precision-denied.txt" || true
fi
if flow_requested cloud-precision-run; then
  run_flow cloud-precision-run .maestro/cloud-precision-run.yaml
  bash scripts/ci/cloud-db-snapshot.sh android "$run_dir/cloud/precision-run.txt" || true
fi
if flow_requested cloud-export; then
  run_flow cloud-export .maestro/cloud-export.yaml
  adb pull /sdcard/Download/meeshogi-comparison.json "$run_dir/comparison-export.json" \
    || echo 'comparison export not in /sdcard/Download (helper share step did not run?)' >&2
fi
# ---------------------------------------------------------------------------

if flow_selected large-text-review; then
  original_font_scale="$(adb shell settings get system font_scale | tr -d '\r')"
  adb shell settings put system font_scale 1.3
  run_flow large-text-review .maestro/large-text-review.yaml
  adb shell settings put system font_scale "$original_font_scale"
  original_font_scale=''
fi

run_flow search-delete-review .maestro/search-delete-review.yaml

if ! command -v grep >/dev/null 2>&1; then
  echo 'grep is required to inspect AndroidRuntime logcat output' >&2
  exit 1
fi
fatal_logcat="$run_dir/androidruntime.logcat.txt"
logcat_status=0
adb logcat -d -s AndroidRuntime:E > "$fatal_logcat" || logcat_status=$?
if (( logcat_status != 0 )); then
  echo "adb logcat failed while checking AndroidRuntime (status $logcat_status)" >&2
  exit 1
fi
grep_status=0
grep -q 'FATAL EXCEPTION' "$fatal_logcat" || grep_status=$?
if (( grep_status == 0 )); then
  exit 1
fi
if (( grep_status > 1 )); then
  echo "grep failed while checking $fatal_logcat (status $grep_status)" >&2
  exit 1
fi
