#!/usr/bin/env bash
# Issue #22: interruption evidence for the in-flight Cloud attempt.
#
#   Usage: cloud-interruption.sh <android|ios> <run_dir>
#
# Steps, each followed by a cloud_attempts snapshot in <run_dir>/cloud/:
#   1. background -> foreground   (server work continues; same job resumes)
#   2. kill -> relaunch           (persisted attempt resumes; results kept)
#   3. real network cut -> restore (same jobId, no duplicate attempt row)
#
# Requirements: adb + userdebug/rootable emulator (Android) or xcrun (iOS),
# python3 (sqlite3). For the iOS network cut, passwordless sudo (pf) is tried
# first; without it the step is recorded as SKIPPED — never silently faked.
#
# Security: the SELECT below deliberately never reads cloud_attempts.endpoint
# (staging hostname) or any credential material. Only non-secret fields are
# dumped. The SecureStore credential is never touched.
set -uo pipefail

platform=${1:?usage: cloud-interruption.sh <android|ios> <run_dir>}
run_dir=${2:?usage: cloud-interruption.sh <android|ios> <run_dir>}
out_dir="$run_dir/cloud"
mkdir -p "$out_dir"
summary="$out_dir/summary.txt"
: > "$summary"

BG_WAIT=${CLOUD_BG_WAIT:-45}
KILL_WAIT=${CLOUD_KILL_WAIT:-20}
NET_WAIT=${CLOUD_NET_WAIT:-60}
SETTLE_WAIT=${CLOUD_SETTLE_WAIT:-20}

note() { printf '%s\n' "$*" | tee -a "$summary"; }
note "# issue22 cloud interruption evidence — $(date -u +%Y-%m-%dT%H:%M:%SZ) platform=$platform"

adb_serial_args=()
[[ -n "${ANDROID_SERIAL:-}" ]] && adb_serial_args=(-s "$ANDROID_SERIAL")
sim_udid=${IOS_SIMULATOR_UDID:-booted}

# --- DB access (delegates to cloud-db-snapshot.sh; endpoint column is never
# dumped so the staging hostname stays out of evidence) ----------------------
dump_db() { # $1 label
  if bash "$(dirname "${BASH_SOURCE[0]}")/cloud-db-snapshot.sh" "$platform" "$out_dir/$1.txt"; then
    note "snapshot $1 -> cloud/$1.txt"
  else
    note "$1: $(head -1 "$out_dir/$1.txt" 2>/dev/null || echo 'DB_UNAVAILABLE')"
    return 1
  fi
}

# Latest attempt fields from a snapshot file:
#   job_id|status|server_next_ply|received_count|attempt_row_count
latest_job() { # $1 = snapshot label
  python3 - "$out_dir/$1.txt" <<'PY' 2>/dev/null
import sys
job = status = snp = rc = "-"; n = 0
for line in open(sys.argv[1], encoding="utf-8"):
    if not line.startswith("attempt_id="):
        continue
    n += 1
    for part in line.split(" | "):
        k, _, v = part.partition("=")
        if k == "job_id": job = v
        if k == "status": status = v
        if k == "server_next_ply": snp = v
        if k == "received_count": rc = v
print("{}|{}|{}|{}|{}".format(job, status, snp, rc, n))
PY
}

screenshot() { # $1 label — device-level shot alongside Maestro's
  case "$platform" in
    android) adb "${adb_serial_args[@]}" exec-out screencap -p > "$out_dir/$1.png" 2>/dev/null ;;
    ios) xcrun simctl io "$sim_udid" screenshot "$out_dir/$1.png" >/dev/null 2>&1 ;;
  esac || true
}

app_bg() {
  case "$platform" in
    android) adb "${adb_serial_args[@]}" shell input keyevent KEYCODE_HOME ;;
    ios) xcrun simctl openurl "$sim_udid" 'https://www.apple.com' ;;
  esac
}
app_fg() {
  case "$platform" in
    android) adb "${adb_serial_args[@]}" shell monkey -p com.meeshogi.app -c android.intent.category.LAUNCHER 1 >/dev/null ;;
    ios) xcrun simctl openurl "$sim_udid" 'meeshogi://' ;;
  esac
}
app_kill() {
  case "$platform" in
    android) adb "${adb_serial_args[@]}" shell am force-stop com.meeshogi.app ;;
    ios) xcrun simctl terminate "$sim_udid" com.meeshogi.app ;;
  esac
}
app_start() {
  case "$platform" in
    android) adb "${adb_serial_args[@]}" shell monkey -p com.meeshogi.app -c android.intent.category.LAUNCHER 1 >/dev/null ;;
    ios) xcrun simctl launch "$sim_udid" com.meeshogi.app ;;
  esac
}

# --- network cut -----------------------------------------------------------
net_state=''
net_cut() {
  case "$platform" in
    android)
      adb "${adb_serial_args[@]}" shell svc wifi disable 2>/dev/null
      adb "${adb_serial_args[@]}" shell svc data disable 2>/dev/null
      adb "${adb_serial_args[@]}" shell settings put global airplane_mode_on 1
      adb "${adb_serial_args[@]}" shell am broadcast \
        -a android.intent.action.AIRPLANE_MODE --ez state true 2>/dev/null
      sleep 3
      if adb "${adb_serial_args[@]}" shell ping -c 1 -W 4 8.8.8.8 >"$out_dir/netcut-ping.txt" 2>&1; then
        note "NETCUT_WARN: emulator still reached 8.8.8.8 after wifi+data+airplane"
      else
        note "netcut verified: ping 8.8.8.8 unreachable (cloud/netcut-ping.txt)"
      fi
      net_state='android-radio'
      ;;
    ios)
      # Simulator traffic is host traffic: block the resolved endpoint IPs via
      # pf so only that destination is cut (needs passwordless sudo).
      if [[ -z "${CLOUD_ENDPOINT:-}" ]]; then
        note "netcut SKIP: CLOUD_ENDPOINT not set (needed to resolve target IPs)"
        return 1
      fi
      local host ips
      host=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.urlparse(sys.argv[1]).hostname)' "$CLOUD_ENDPOINT")
      ips=$( { dscacheutil -q host -a name "$host" | awk '/ip_address:/{print $2}'; \
               dig +short "$host" A 2>/dev/null; } | sort -u | tr '\n' ' ')
      if [[ -z ${ips// /} ]]; then
        note "netcut SKIP: could not resolve endpoint IPs"
        return 1
      fi
      if ! sudo -n true 2>/dev/null; then
        note "netcut SKIP: no passwordless sudo on this host for pf rules"
        return 1
      fi
      local rules="$out_dir/pf.rules" ip
      : > "$rules"
      for ip in $ips; do echo "block drop out quick proto tcp to $ip" >> "$rules"; done
      sudo -n pfctl -e -f "$rules" 2>"$out_dir/pf.log" || {
        note "netcut SKIP: pfctl enable failed (cloud/pf.log)"
        return 1
      }
      sleep 2
      # stderr is discarded: curl error text would embed the staging hostname.
      if curl -s --max-time 8 -o /dev/null "https://$host/" 2>/dev/null; then
        note "NETCUT_WARN: curl to endpoint still succeeded under pf block"
      else
        note "netcut verified: endpoint unreachable from host (curl failed)"
      fi
      if curl -s --max-time 8 -o /dev/null https://github.com/ ; then
        note "netcut scope: github.com still reachable (targeted cut)"
      else
        note "NETCUT_WARN: github.com also unreachable — cut may be wider than endpoint"
      fi
      net_state='ios-pf'
      ;;
  esac
}
net_restore() {
  case "$net_state" in
    android-radio)
      adb "${adb_serial_args[@]}" shell settings put global airplane_mode_on 0
      adb "${adb_serial_args[@]}" shell am broadcast \
        -a android.intent.action.AIRPLANE_MODE --ez state false 2>/dev/null
      adb "${adb_serial_args[@]}" shell svc wifi enable 2>/dev/null
      adb "${adb_serial_args[@]}" shell svc data enable 2>/dev/null
      sleep 5
      if adb "${adb_serial_args[@]}" shell ping -c 1 -W 5 8.8.8.8 >"$out_dir/netrestore-ping.txt" 2>&1; then
        note "restore verified: ping 8.8.8.8 ok (cloud/netrestore-ping.txt)"
      else
        note "RESTORE_WARN: ping still failing — wait for emulator radio recovery"
        sleep 15
      fi
      ;;
    ios-pf)
      sudo -n pfctl -F all -d 2>>"$out_dir/pf.log" || note "RESTORE_WARN: pfctl flush failed"
      net_state=''
      ;;
    *) : ;;
  esac
}
trap net_restore EXIT

# --- sequence ---------------------------------------------------------------
dump_db s00-before || true
before=$(latest_job s00-before)
IFS='|' read -r job0 st0 snp0 rc0 n0 <<< "$before"
note "before: job_id=$job0 status=$st0 server_next_ply=$snp0 received=$rc0 attempts=$n0"
if [[ "$job0" == '-' || "$job0" == 'NULL' ]]; then
  note "NO_ACTIVE_JOB: cloud-free-start left no attempt with a job_id — aborting interruption evidence"
  exit 1
fi

note "--- step: background ($BG_WAIT s) ---"
app_bg || true
sleep "$BG_WAIT"
dump_db s10-backgrounded || true
screenshot s10-backgrounded
note "--- step: foreground ---"
app_fg || true
sleep "$SETTLE_WAIT"
dump_db s11-foregrounded || true
screenshot s11-foregrounded
fg=$(latest_job s11-foregrounded); IFS='|' read -r job1 st1 _ _ n1 <<< "$fg"
[[ "$job1" == "$job0" ]] && note "bg->fg: SAME job_id ($job1)" || note "bg->fg: JOB_ID_CHANGED $job0 -> $job1"
[[ "$n1" == "$n0" ]] && note "bg->fg: attempt count unchanged ($n1)" || note "bg->fg: ATTEMPT_COUNT_CHANGED $n0 -> $n1"

note "--- step: kill + relaunch ---"
app_kill || true
sleep 3
app_start || true
sleep "$KILL_WAIT"
dump_db s20-relaunched || true
screenshot s20-relaunched
rl=$(latest_job s20-relaunched); IFS='|' read -r job2 st2 snp2 rc2 n2 <<< "$rl"
[[ "$job2" == "$job0" ]] && note "kill->relaunch: SAME job_id ($job2)" || note "kill->relaunch: JOB_ID_CHANGED $job0 -> $job2"
if [[ "$rc2" =~ ^[0-9]+$ && "$rc0" =~ ^[0-9]+$ && "$rc2" -ge "$rc0" ]]; then
  note "kill->relaunch: saved results kept (received $rc0 -> $rc2)"
else
  note "kill->relaunch: received_count check inconclusive ($rc0 -> $rc2)"
fi
[[ "$n2" == "$n0" ]] && note "kill->relaunch: attempt count unchanged ($n2)" || note "kill->relaunch: ATTEMPT_COUNT_CHANGED $n0 -> $n2"

note "--- step: network cut ($NET_WAIT s) ---"
if net_cut; then
  sleep "$NET_WAIT"
  dump_db s30-netcut || true   # last_error should show the transport failure
  screenshot s30-netcut
  note "--- step: network restore ---"
  net_restore
  trap - EXIT
  sleep "$SETTLE_WAIT"
  dump_db s31-restored || true
  screenshot s31-restored
  nr=$(latest_job s31-restored); IFS='|' read -r job3 st3 snp3 rc3 n3 <<< "$nr"
  [[ "$job3" == "$job0" ]] && note "netcut->restore: SAME job_id ($job3)" || note "netcut->restore: JOB_ID_CHANGED $job0 -> $job3"
  [[ "$n3" == "$n0" ]] && note "netcut->restore: attempt count unchanged ($n3)" || note "netcut->restore: ATTEMPT_COUNT_CHANGED $n0 -> $n3"
  if [[ "$snp3" =~ ^[0-9]+$ && "$snp0" =~ ^[0-9]+$ && "$snp3" -gt "$snp0" ]]; then
    note "netcut->restore: server_next_ply advanced $snp0 -> $snp3 (server kept working while client offline)"
  else
    note "netcut->restore: server_next_ply $snp0 -> $snp3"
  fi
else
  note "netcut: step skipped (see reason above); leaving network untouched"
fi

note "done. attempt count start=$n0"
