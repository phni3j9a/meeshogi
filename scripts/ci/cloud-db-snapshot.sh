#!/usr/bin/env bash
# Issue #22 helper: snapshot the app's cloud_attempts/cloud_results tables
# from the device into a text file for evidence.
#
#   Usage: cloud-db-snapshot.sh <android|ios> <out_file>
#
# Android: pulls /data/data/com.meeshogi.app/databases/meeshogi.db (needs
# adbd-as-root — works on google_apis/userdebug emulator images; otherwise
# prints DB_UNAVAILABLE and returns 1).
# iOS: copies meeshogi.db out of the app container on the booted/selected
# Simulator (IOS_SIMULATOR_UDID overrides the device).
#
# Security: the query deliberately excludes cloud_attempts.endpoint (staging
# hostname) and reads no credential material — the credential lives only in
# SecureStore. Output is safe to commit to evidence branches.
set -uo pipefail

platform=${1:?usage: cloud-db-snapshot.sh <android|ios> <out_file>}
out_file=${2:?usage: cloud-db-snapshot.sh <android|ios> <out_file>}

adb_args=()
[[ -n "${ANDROID_SERIAL:-}" ]] && adb_args=(-s "$ANDROID_SERIAL")
sim_udid=${IOS_SIMULATOR_UDID:-booted}

tmp="$(mktemp -d)/meeshogi.db"
trap 'rm -rf "$(dirname "$tmp")"' EXIT

case "$platform" in
  android)
    if adb "${adb_args[@]}" root >/dev/null 2>&1; then
      adb "${adb_args[@]}" wait-for-device >/dev/null 2>&1
    fi
    if ! adb "${adb_args[@]}" exec-out cat /data/data/com.meeshogi.app/databases/meeshogi.db > "$tmp" 2>/dev/null \
       || [[ ! -s $tmp ]]; then
      echo "DB_UNAVAILABLE: cannot read meeshogi.db (adbd root required)" > "$out_file"
      exit 1
    fi
    adb "${adb_args[@]}" exec-out cat /data/data/com.meeshogi.app/databases/meeshogi.db-wal > "$tmp-wal" 2>/dev/null || true
    adb "${adb_args[@]}" exec-out cat /data/data/com.meeshogi.app/databases/meeshogi.db-shm > "$tmp-shm" 2>/dev/null || true
    ;;
  ios)
    container=$(xcrun simctl get_app_container "$sim_udid" com.meeshogi.app data 2>/dev/null) || {
      echo "DB_UNAVAILABLE: get_app_container failed" > "$out_file"
      exit 1
    }
    db=$(find "$container" -name 'meeshogi.db' -type f 2>/dev/null | head -1)
    if [[ -z $db ]]; then
      echo "DB_UNAVAILABLE: meeshogi.db not found under $container" > "$out_file"
      exit 1
    fi
    cp "$db" "$tmp"
    for ext in wal shm; do
      [[ -f "$db-$ext" ]] && cp "$db-$ext" "$tmp-$ext" || true
    done
    ;;
  *)
    echo "unknown platform: $platform" >&2
    exit 2
    ;;
esac

python3 - "$tmp" "$out_file" <<'PY'
import sqlite3, sys
db, out = sys.argv[1], sys.argv[2]
con = sqlite3.connect(db)
# endpoint is intentionally NOT selected: the staging hostname must not
# appear in evidence. SecureStore credentials are never in SQLite.
cols = ("attempt_id","game_id","profile_id","install_id","owner_id","job_id",
        "status","server_status","total_plies","server_next_ply",
        "receive_after_ply","received_count","valid_count","submit_attempted",
        "failure_code","failure_message","last_error",
        "created_at","updated_at","finished_at")
lines = []
try:
    rows = con.execute(
        "SELECT {} FROM cloud_attempts ORDER BY created_at".format(
            ",".join(cols))).fetchall()
    for r in rows:
        lines.append(" | ".join("{}={}".format(c, v if v is not None else "NULL")
                                for c, v in zip(cols, r)))
    if not rows:
        lines.append("(no cloud_attempts rows)")
except sqlite3.Error as e:
    lines.append("cloud_attempts query failed: {}".format(e))
try:
    for (aid, n) in con.execute(
        "SELECT attempt_id, COUNT(*) FROM cloud_results GROUP BY attempt_id"):
        lines.append("cloud_results[{}] = {}".format(aid, n))
except sqlite3.Error as e:
    lines.append("cloud_results query failed: {}".format(e))
try:
    for (k, v) in con.execute("SELECT key, value FROM cloud_meta"):
        if k == "install_id":
            lines.append("cloud_meta.{} = {}".format(k, v))
except sqlite3.Error:
    pass
con.close()
with open(out, "w", encoding="utf-8") as fh:
    fh.write("\n".join(lines) + "\n")
PY
