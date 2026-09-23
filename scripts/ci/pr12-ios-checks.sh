#!/usr/bin/env bash
# PR #12 native acceptance driver (verification branch only — not part of the
# shipped suite). Runs the PR-specific Maestro flows against the booted
# simulator the acceptance script selected, records screen video per flow,
# and captures the settings row from SQLite for the piece-set persistence
# check. Usage:
#   RUNNER_TEMP=$HOME/runner-temp bash scripts/ci/pr12-ios-checks.sh <device-udid> <out-dir>
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"

device="$1"
run_dir="$2"
mkdir -p "$run_dir"

trace() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$run_dir/timeline.log"; }
record_pid=''
stop_recording() {
  if [[ -n "${record_pid:-}" ]]; then
    kill -INT "$record_pid" 2>/dev/null || true
    wait "$record_pid" 2>/dev/null || true
    record_pid=''
  fi
}
run_flow() {
  local name=$1 flow=$2
  local output="$run_dir/maestro/$name"
  mkdir -p "$output/test-output"
  trace "flow.start $name"
  xcrun simctl io "$device" recordVideo "$run_dir/$name.mov" > "$run_dir/$name.record.log" 2>&1 &
  record_pid=$!
  local status=0
  "${MAESTRO_BIN:-maestro}" --device "$device" test \
    -e INITIAL_READY_TIMEOUT=180000 -e IMPORT_SAVE_TIMEOUT=120000 \
    --format junit --output "$output/junit.xml" \
    --test-output-dir "$output/test-output" "$flow" || status=$?
  stop_recording
  trace "flow.end $name status=$status"
  return "$status"
}

run_flow pr12-piece-sets .maestro/pr12-piece-sets.yaml
run_flow pr12-graph .maestro/pr12-graph.yaml

# Settings persistence evidence: the settings table must contain the set
# selected before the final relaunch (青磁 was re-selected to 黄楊 at the end
# of the flow, so expect pieceSet=tsuge; the relaunch screenshot proves the
# 青磁 value survived kill/relaunch).
container="$(xcrun simctl get_app_container "$device" com.meeshogi.app data)"
find "$container" -name 'meeshogi.db' -print > "$run_dir/db-paths.txt"
db="$(head -1 "$run_dir/db-paths.txt")"
if [[ -n "$db" ]]; then
  sqlite3 "$db" 'SELECT payload FROM settings WHERE id = 1' > "$run_dir/settings-payload.json"
  sqlite3 "$db" 'PRAGMA integrity_check' > "$run_dir/db-integrity.txt"
fi
xcrun simctl io "$device" screenshot "$run_dir/final.png"
trace "pr12-checks.end"
