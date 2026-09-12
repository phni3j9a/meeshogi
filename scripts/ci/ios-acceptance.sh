#!/usr/bin/env bash
set -euo pipefail
mkdir -p artifacts/ios
xcrun simctl list devices available --json > artifacts/ios/devices.json
device="$(python3 - <<'PY'
import json
data = json.load(open("artifacts/ios/devices.json"))
phones = [d for runtime, devices in data["devices"].items() if "iOS" in runtime for d in devices if d.get("isAvailable") and d["name"].startswith("iPhone")]
if not phones: raise SystemExit("No available iPhone Simulator")
print(phones[0]["udid"])
PY
)"
xcrun simctl boot "$device" || true
python3 - "$device" <<'PY'
import subprocess, sys
subprocess.run(["xcrun", "simctl", "bootstatus", sys.argv[1], "-b"], timeout=600, check=True)
PY
xcrun simctl status_bar "$device" override --time 9:41 --batteryState charged --batteryLevel 100
xcrun simctl install "$device" "$RUNNER_TEMP/meeshogi-ios/Build/Products/Release-iphonesimulator/meeshogi.app"
xcrun simctl pbcopy "$device" < fixtures/kif/shogiwars.kif
xcrun simctl io "$device" recordVideo artifacts/ios/flow.mov > artifacts/ios/recording.log 2>&1 &
record_pid=$!
cleanup() {
  local status=$?
  trap - EXIT
  kill -INT "$record_pid" 2>/dev/null || true
  wait "$record_pid" 2>/dev/null || true
  xcrun simctl io "$device" screenshot artifacts/ios/final.png || true
  xcrun simctl spawn "$device" log show --last 10m --style compact --predicate 'process == "meeshogi"' > artifacts/ios/simulator.log || true
  exit "$status"
}
trap cleanup EXIT
run_output="$PWD/artifacts/ios/maestro/$(date -u +%Y%m%dT%H%M%SZ)"
maestro --device "$device" test --format junit --output artifacts/ios/junit.xml --test-output-dir "$run_output" .maestro/import-review.yaml
