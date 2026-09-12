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
  for attempt in {1..30}; do
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
  mkdir -p "$output/test-output"
  maestro test \
    --format junit \
    --output "$output/junit.xml" \
    --test-output-dir "$output/test-output" \
    "$flow"
}

run_flow import-review .maestro/import-review.yaml
bash scripts/ci/android-clipboard.sh "$clipboard_wars"
run_flow player-names .maestro/player-names.yaml
bash scripts/ci/android-clipboard.sh "$clipboard_kiou"
run_flow player-names-kiou .maestro/player-names-kiou.yaml
run_flow analysis-review .maestro/analysis-review.yaml
run_flow candidate-review .maestro/candidate-review.yaml
run_flow file-import .maestro/file-import.yaml
run_flow management-review .maestro/management-review.yaml
run_flow appearance-review .maestro/appearance-review.yaml
run_flow appearance-dark .maestro/appearance-dark.yaml
run_flow export-review .maestro/export-review.yaml
adb pull /sdcard/Download/meeshogi-export.txt "$run_dir/exported.kifu"
cmp fixtures/kif/shogiwars.kif "$run_dir/exported.kifu"
run_flow background-review .maestro/background-review.yaml
original_font_scale="$(adb shell settings get system font_scale | tr -d '\r')"
adb shell settings put system font_scale 1.3
run_flow large-text-review .maestro/large-text-review.yaml
adb shell settings put system font_scale "$original_font_scale"
original_font_scale=''

run_flow search-delete-review .maestro/search-delete-review.yaml

if adb logcat -d -s AndroidRuntime:E | rg 'FATAL EXCEPTION'; then
  exit 1
fi
