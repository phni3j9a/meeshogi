#!/usr/bin/env bash
set -euo pipefail
mkdir -p artifacts/android
adb install --no-incremental -r artifacts/android/meeshogi.apk
bash scripts/ci/android-clipboard.sh fixtures/kif/shogiwars.kif
adb logcat -c
adb shell screenrecord --time-limit 180 /sdcard/meeshogi-flow.mp4 > artifacts/android/recording.log 2>&1 &
record_pid=$!
cleanup() {
  local status=$?
  trap - EXIT
  kill "$record_pid" 2>/dev/null || true
  adb shell pkill -INT screenrecord 2>/dev/null || true
  wait "$record_pid" 2>/dev/null || true
  adb pull /sdcard/meeshogi-flow.mp4 artifacts/android/flow.mp4 || true
  adb logcat -d -v threadtime > artifacts/android/logcat.txt || true
  adb exec-out screencap -p > artifacts/android/final.png || true
  exit "$status"
}
trap cleanup EXIT
maestro test --format junit --output artifacts/android/junit.xml --debug-output artifacts/android/maestro -e ARTIFACT_DIR=artifacts/android .maestro/import-review.yaml
if adb logcat -d -s AndroidRuntime:E | rg 'FATAL EXCEPTION'; then exit 1; fi
