#!/usr/bin/env bash
set -euo pipefail
mkdir -p artifacts/android
if [[ ${1:-} != --installed ]]; then
  adb push -Z artifacts/android/meeshogi.apk /data/local/tmp/meeshogi-acceptance.apk
  local_digest="$(sha256sum artifacts/android/meeshogi.apk | cut -d ' ' -f 1)"
  device_digest="$(adb shell sha256sum /data/local/tmp/meeshogi-acceptance.apk | cut -d ' ' -f 1)"
  [[ "$local_digest" == "$device_digest" ]] || { echo 'APK transfer digest mismatch' >&2; exit 1; }
  adb shell pm install -r /data/local/tmp/meeshogi-acceptance.apk
  adb shell rm /data/local/tmp/meeshogi-acceptance.apk
fi
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
run_output="$PWD/artifacts/android/maestro/$(date -u +%Y%m%dT%H%M%SZ)"
maestro test --format junit --output artifacts/android/junit.xml --test-output-dir "$run_output" .maestro/import-review.yaml
if adb logcat -d -s AndroidRuntime:E | rg 'FATAL EXCEPTION'; then exit 1; fi
