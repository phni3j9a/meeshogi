#!/usr/bin/env bash
# PR #12 acceptance extras: piece-set picker/reflection/persistence, terminal
# mate display, evaluation-chart gestures and display variants.
# Run AFTER scripts/ci/android-acceptance.sh on the same install: it needs the
# saved KeroPona game. Usage: bash scripts/ci/android-pr12-checks.sh
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
printf '%s\n' "$run_id" > "$run_dir/run-id.txt"

original_font_scale=''
record_loop_pid=''
record_loop() {
  local segment=0
  while :; do
    [[ -e "$record_stop" ]] && break
    segment=$((segment + 1))
    local remote="/sdcard/meeshogi-pr12-${segment}.mp4"
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
  adb shell wm size reset >/dev/null 2>&1 || true
  adb shell wm density reset >/dev/null 2>&1 || true
  : > "$record_stop"
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
  shift 2
  local output="$maestro_dir/$name"
  local env_args=()
  local kv
  for kv in "$@"; do env_args+=(-e "$kv"); done
  mkdir -p "$output/test-output"
  maestro test "${env_args[@]}" \
    --format junit \
    --output "$output/junit.xml" \
    --test-output-dir "$output/test-output" \
    "$flow"
}

adb logcat -c

run_flow piece-sets-picker .maestro/piece-sets-picker.yaml
run_flow piece-sets-reflect .maestro/piece-sets-reflect.yaml
run_flow piece-sets-persist .maestro/piece-sets-persist.yaml

# Terminal checkmate display for both winners, via synthesized fixture KIFs.
bash scripts/ci/android-clipboard.sh artifacts/android/fixtures/mate-sente-win.kif
run_flow mate-terminal-sente .maestro/mate-terminal-review.yaml \
  MOVES=27 MOVES_PREV=26 \
  'TERMINAL_LABEL=先手勝ち・詰み終局' \
  'MATE_REGEX=.*\+M.*' \
  'MATE_BADGE=先手・1手詰め ›' \
  'SHOT_PREFIX=82-sente'

bash scripts/ci/android-clipboard.sh artifacts/android/fixtures/mate-gote-win.kif
run_flow mate-terminal-gote .maestro/mate-terminal-review.yaml \
  MOVES=28 MOVES_PREV=27 \
  'TERMINAL_LABEL=後手勝ち・詰み終局' \
  'MATE_REGEX=.*-M.*' \
  'MATE_BADGE=後手・1手詰め ›' \
  'SHOT_PREFIX=83-gote'

# Evaluation-chart gesture checks (adb coordinate level, recorded above).
bash scripts/ci/android-graph-check.sh "$run_dir/graph-check"

run_flow pr12-cleanup-games .maestro/pr12-cleanup-games.yaml

# OS text scaling on the refreshed screens.
original_font_scale="$(adb shell settings get system font_scale | tr -d '\r')"
adb shell settings put system font_scale 1.3
run_flow pr12-large-text .maestro/pr12-large-text.yaml
adb shell settings put system font_scale "$original_font_scale"
original_font_scale=''

# Display variants: a small handset and a tablet-sized viewport on the same
# device (wm size/density override — reported as such, not a dedicated AVD).
variant_dir="$run_dir/display-variants"
mkdir -p "$variant_dir"
variant_shot() {
  local name=$1
  adb shell monkey -p com.meeshogi.app -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
  local lib_seen=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    adb shell uiautomator dump /sdcard/variant-ui.xml >/dev/null 2>&1
    if adb shell cat /sdcard/variant-ui.xml | grep -q 'library-screen'; then lib_seen=1; break; fi
    sleep 1
  done
  if (( lib_seen == 0 )); then
    adb shell input keyevent 4
    sleep 1
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      adb shell uiautomator dump /sdcard/variant-ui.xml >/dev/null 2>&1
      if adb shell cat /sdcard/variant-ui.xml | grep -q 'library-screen'; then lib_seen=1; break; fi
      sleep 1
    done
  fi
  (( lib_seen == 1 )) || printf 'library-screen not found for %s\n' "$name" >> "$variant_dir/missing.txt"
  adb exec-out screencap -p > "$variant_dir/$1-library.png"
  adb shell uiautomator dump /sdcard/variant-ui.xml >/dev/null 2>&1
  local kero
  kero=$(adb shell cat /sdcard/variant-ui.xml | python3 -c "
import re,sys
xml=sys.stdin.read()
m=re.search(r'text=\"[^\"]*KeroPona[^\"]*\"[^>]*bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"', xml)
if not m:
    m=re.search(r'bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"[^>]*text=\"[^\"]*KeroPona[^\"]*\"', xml)
if m: print((int(m.group(1))+int(m.group(3)))//2,(int(m.group(2))+int(m.group(4)))//2)
")
  if [[ -n "$kero" ]]; then
    adb shell input tap $kero
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      adb shell uiautomator dump /sdcard/variant-ui.xml >/dev/null 2>&1
      if adb shell cat /sdcard/variant-ui.xml | grep -q 'game-screen'; then break; fi
      sleep 1
    done
    adb exec-out screencap -p > "$variant_dir/$1-game.png"
    adb shell input keyevent 4
    sleep 1
  else
    printf 'KeroPona row not found for %s\n' "$name" >> "$variant_dir/missing.txt"
  fi
}

# Small phone (approx 720x1280 @ 280dpi).
adb shell wm size 720x1280
adb shell wm density 280
sleep 1
variant_shot small

# Tablet landscape (approx Pixel Tablet 2560x1600 @276dpi).
adb shell wm size 2560x1600
adb shell wm density 276
sleep 1
variant_shot tablet-landscape

# Tablet portrait (1600x2560 @276dpi).
adb shell wm size 1600x2560
adb shell wm density 276
sleep 1
variant_shot tablet-portrait

adb shell wm size reset
adb shell wm density reset
sleep 1
variant_shot default

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

echo "PR12 extra checks finished: $run_dir"
