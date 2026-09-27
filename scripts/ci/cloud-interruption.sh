#!/usr/bin/env bash
# Issue #22: interruption evidence for the in-flight Cloud attempt.
#
#   Usage: cloud-interruption.sh <android|ios> <run_dir>
#
# Steps (select/order via CLOUD_INTERRUPTION_STEPS, default "bg,kill,net"):
#   bg   — background -> foreground   (server work continues; same job resumes)
#   kill — kill -> relaunch           (persisted attempt resumes; results kept)
#   net  — real network cut -> restore (app transport must actually fail while
#          the server keeps working; same jobId / attempt count afterwards)
# `net` alone is supported: it takes its own s29-precut snapshot right after
# job start and refuses to cut unless the attempt is a live job (job_id known,
# local status and server_status both non-terminal).
#
# Each step is judged against a snapshot taken immediately BEFORE that step.
# The final verdict lines are `RESULT bg=...` / `RESULT kill=...` /
# `RESULT net=...` with PASS|FAIL|UNVERIFIED|SKIPPED; any selected step that
# did not PASS — or any cleanup that failed — makes the script exit non-zero.
#
# Requirements: adb + userdebug/rootable emulator (Android) or xcrun (iOS),
# python3 (sqlite3). For the iOS network cut, passwordless sudo (pf) is tried
# first; without it the step is recorded as SKIPPED — never silently faked.
#
# Security: the SELECT below deliberately never reads cloud_attempts.endpoint
# (staging hostname) or any credential material, and last_error is reduced to
# a kind flag so no message text reaches the summary. The SecureStore
# credential is never touched.
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
CUT_FIRST_WAIT=${CLOUD_CUT_FIRST_WAIT:-10}
SETTLE_WAIT=${CLOUD_SETTLE_WAIT:-20}
RESUME_WAIT=${CLOUD_RESUME_WAIT:-120}
RESUME_POLL=10
STEPS=${CLOUD_INTERRUPTION_STEPS:-bg,kill,net}
# macOS /etc/pf.conf ends with `anchor "com.apple/*"` (a wildcard anchor), so
# an anchor named com.apple/<x> is evaluated without touching the main
# ruleset — Apple itself uses this namespace for system packet filtering.
PF_ANCHOR='com.apple/meeshogi-netcut'

note() { printf '%s\n' "$*" | tee -a "$summary"; }
note "# issue22 cloud interruption evidence — $(date -u +%Y-%m-%dT%H:%M:%SZ) platform=$platform steps=$STEPS"

adb_serial_args=()
[[ -n "${ANDROID_SERIAL:-}" ]] && adb_serial_args=(-s "$ANDROID_SERIAL")
sim_udid=${IOS_SIMULATOR_UDID:-booted}

result_bg=SKIPPED
result_kill=SKIPPED
result_net=SKIPPED
cleanup_fail=0

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

# Latest attempt fields from a snapshot FILE:
#   attempt_id|job_id|status|server_status|server_next_ply|received_count|
#   rows|err_kind|updated_at
# err_kind classifies last_error WITHOUT printing it (message text never
# reaches the summary — it could conceivably contain a hostname):
#   transport — the client's network-failure text (`status===0`, client.ts),
#               the only message that proves the app's transport broke
#   http      — mapped API messages that only exist when an HTTP response
#               arrived (4xx/5xx/invalid_response): connectivity during the
#               cut would contradict the block, so these are FAIL evidence
#   other     — local failures (SecureStore read, storage) or unknown text:
#               neither proof of cut nor of connectivity
latest_job_file() { # $1 = snapshot file path
  python3 - "$1" <<'PY' 2>/dev/null
import sys
# Exact-match only: the producer writes either the bare text or, in dev
# builds, the text plus `（network）` (mapApiError appends `（<code>）`).
# Anything else starting with the same prefix is NOT transport evidence.
TRANSPORT = {
    "Cloudサーバーへ接続できませんでした。",
    "Cloudサーバーへ接続できませんでした。（network）",
}
HTTP_PREFIXES = (
    "Cloudの認証情報が無効です",
    "精密解析はこの端末では利用できません",
    "本日のCloud・無料の解析回数",
    "短時間に多くの解析要求",
    "実行中のCloud解析があるため",
    "同じ解析要求が既に終了しています",
    "解析要求がサーバーに拒否されました",
    "Cloudサーバー上に解析ジョブが見つかりません",
    "Cloudサーバーの応答を解釈できませんでした",
    "Cloud応答をJSONとして読めませんでした",
    "Cloud応答の形式が不正です",
    "Cloudサーバーで一時的なエラーが発生しました",
    "Cloudサーバーがエラーを返しました",
)
def kind(v):
    if v in ("NULL", "", "-", None):
        return "none"
    if v in TRANSPORT:
        return "transport"
    if any(v.startswith(p) for p in HTTP_PREFIXES):
        return "http"
    return "other"
aid = job = status = srv = snp = rc = upd = "-"; err = "none"; n = 0
for line in open(sys.argv[1], encoding="utf-8"):
    if not line.startswith("attempt_id="):
        continue
    n += 1
    aid = job = status = srv = snp = rc = upd = "-"; err = "none"
    for part in line.split(" | "):
        k, _, v = part.partition("=")
        if k == "attempt_id": aid = v
        if k == "job_id": job = v
        if k == "status": status = v
        if k == "server_status": srv = v
        if k == "server_next_ply": snp = v
        if k == "received_count": rc = v
        if k == "updated_at": upd = v
        if k == "last_error": err = kind(v)
print("{}|{}|{}|{}|{}|{}|{}|{}|{}".format(aid, job, status, srv, snp, rc, n, err, upd))
PY
}
latest_job() { latest_job_file "$out_dir/$1.txt"; } # $1 = snapshot label

is_num() { [[ $1 =~ ^[0-9]+$ ]]; }
is_terminal() { # attempt.status / server_status terminal set
  case "$1" in completed | failed | cancelled | error) return 0 ;; *) return 1 ;; esac
}
# Same-attempt check. When the baseline has a real job_id, both ids must
# match; otherwise (job not yet assigned) compare attempt_id alone — bg/kill
# only. step_net additionally requires job_id itself to be non-null.
same_attempt() { # $1..$4 = aid_a job_a aid_b job_b
  if [[ -n $2 && $2 != '-' && $2 != 'NULL' ]]; then
    [[ $1 == "$3" && $2 == "$4" ]]
  else
    [[ $1 == "$3" ]]
  fi
}
srv_terminal() { case "$1" in completed | failed | cancelled) return 0 ;; *) return 1 ;; esac }

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
    # simctl openurl of the meeshogi:// scheme is gated behind iOS's
    # 'Open in meeshogi?' consent dialog that never resolves unattended;
    # simctl launch foregrounds a running instance directly.
    ios) xcrun simctl launch "$sim_udid" com.meeshogi.app >/dev/null ;;
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

# --- network cut / restore --------------------------------------------------
# net_state records WHAT must be undone and is set BEFORE the first mutating
# command so a signal mid-way still restores (FP-022). Both cut and restore
# check every command's exit status; restore is idempotent and a failed
# restore keeps net_state set (retried by the EXIT trap) and fails the run.
net_state=''
# Responsibility for every mutation is recorded BEFORE the external command
# runs and cleared ONLY when its release command succeeds — a signal or a
# partial failure therefore can't orphan pf state (FP-022).
pf_ref_state='none'   # none | unknown (-E ran but token state unclear) | held:<token>
pf_main_loaded=0      # we loaded the temporary 1-line main ruleset
pf_anchor_loaded=0    # rules were loaded into our dedicated anchor
pf_base_main=''       # main ruleset content captured before any change
pf_base_status=''     # Enabled|Disabled captured before any change
pf_status_word() { # extract only Enabled|Disabled from `pfctl -s info` output
  awk '/^Status:/{print $2; exit}' <<< "$1" | grep -xE 'Enabled|Disabled' || true
}
net_cut() {
  case "$platform" in
    android)
      net_state='android-radio' # record before mutating (FP-022)
      local cf=0
      adb "${adb_serial_args[@]}" shell svc wifi disable 2>/dev/null || cf=1
      adb "${adb_serial_args[@]}" shell svc data disable 2>/dev/null || cf=1
      adb "${adb_serial_args[@]}" shell settings put global airplane_mode_on 1 || cf=1
      adb "${adb_serial_args[@]}" shell am broadcast \
        -a android.intent.action.AIRPLANE_MODE --ez state true 2>/dev/null || cf=1
      (( cf )) && note "NETCUT_WARN: one or more radio-off commands failed — app observation decides"
      sleep 3
      if adb "${adb_serial_args[@]}" shell ping -c 1 -W 4 8.8.8.8 >"$out_dir/netcut-ping.txt" 2>&1; then
        note "NETCUT_WARN: emulator still reached 8.8.8.8 after wifi+data+airplane"
      else
        note "netcut verified: ping 8.8.8.8 unreachable (cloud/netcut-ping.txt)"
      fi
      ;;
    ios)
      # Simulator traffic is host traffic: block the resolved endpoint IPs via
      # a dedicated pf anchor so only that destination is cut (needs
      # passwordless sudo). Both A and AAAA addresses are blocked for
      # { tcp udp } — HTTPS can otherwise keep flowing over QUIC/UDP or an
      # IPv6 route (FP-021). The anchor lives under `com.apple/` because the
      # stock /etc/pf.conf wildcard-references `anchor "com.apple/*"`; restore
      # flushes only our anchor and releases only our enable token, never
      # `pfctl -F all -d` (which would wipe the host's whole ruleset).
      if [[ -z "${CLOUD_ENDPOINT:-}" ]]; then
        note "netcut SKIP: CLOUD_ENDPOINT not set (needed to resolve target IPs)"
        return 1
      fi
      local host ips4 ips6
      host=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.urlparse(sys.argv[1]).hostname)' "$CLOUD_ENDPOINT")
      ips4=$( { dscacheutil -q host -a name "$host" | awk '/^ip_address:/{print $2}'; \
                dig +short "$host" A 2>/dev/null; } | grep -E '^[0-9]+\.' | sort -u )
      ips6=$( { dscacheutil -q host -a name "$host" | awk '/^ipv6_address:/{print $2}'; \
                dig +short "$host" AAAA 2>/dev/null; } | grep ':' | sort -u )
      if [[ -z $ips4 && -z $ips6 ]]; then
        note "netcut SKIP: could not resolve endpoint IPs"
        return 1
      fi
      if ! sudo -n true 2>/dev/null; then
        note "netcut SKIP: no passwordless sudo on this host for pf rules"
        return 1
      fi
      # --- baseline capture (BEFORE any mutation; FP-023/FP-024) -----------
      # Both queries must exit 0 and Status must parse to Enabled|Disabled —
      # a failed or unreadable baseline means we do not touch pf at all (a
      # failed -s rules returning empty must never be read as "ruleset is
      # empty", or we would overwrite real host rules). The narrow allowed
      # baselines:
      #   (a) main references `anchor "com.apple/*"` or our anchor -> use the
      #       anchor only
      #   (b) main is verified-empty                       -> load a 1-line
      #       temp main ruleset referencing only our anchor; flush it back
      #   (c) anything else                                 -> SKIPPED
      local main_rules pf_info
      if ! main_rules=$(sudo -n pfctl -s rules 2>>"$out_dir/pf.log"); then
        note "netcut SKIP: could not query pf main ruleset (pfctl -s rules failed) — touching nothing"
        return 1
      fi
      if ! pf_info=$(sudo -n pfctl -s info 2>>"$out_dir/pf.log"); then
        note "netcut SKIP: could not query pf status (pfctl -s info failed) — touching nothing"
        return 1
      fi
      pf_base_status=$(pf_status_word "$pf_info")
      if [[ -z $pf_base_status ]]; then
        note "netcut SKIP: pf Status word unreadable — touching nothing"
        return 1
      fi
      pf_base_main=$main_rules
      local pf_mode
      if grep -q 'anchor "com.apple/\*"\|anchor "com.apple/meeshogi-netcut"' <<< "$main_rules"; then
        pf_mode='anchor'
      elif [[ -z $main_rules ]]; then
        pf_mode='temp-main'
      else
        note "netcut SKIP: main pf ruleset is non-empty and does not reference anchors — leaving it untouched"
        return 1
      fi
      note "pf baseline: mode=$pf_mode status=$pf_base_status main_ruleset_lines=$(printf '%s' "$main_rules" | grep -c . || true)"

      local rules="$out_dir/pf.rules" ip
      : > "$rules"
      for ip in $ips4; do echo "block drop out quick inet proto { tcp udp } to $ip" >> "$rules"; done
      for ip in $ips6; do echo "block drop out quick inet6 proto { tcp udp } to $ip" >> "$rules"; done

      net_state='ios-pf' # record BEFORE the first mutation (enable reference)
      pf_ref_state='unknown' # -E may create a reference we can't see; never assume none
      local eout pf_token
      eout=$(sudo -n pfctl -E 2>&1) || true
      printf '%s\n' "$eout" >> "$out_dir/pf.log"
      pf_token=$(printf '%s' "$eout" | awk '/^Token/{print $NF}')
      if [[ -n $pf_token ]]; then
        pf_ref_state="held:$pf_token"
      else
        note "netcut SKIP: pfctl -E failed or returned no token — release state unknown"
        if net_restore; then net_state=''; else cleanup_fail=1; fi
        return 1
      fi
      # (b): an empty main ruleset has no anchor reference — load a 1-line
      # temp main pointing at our dedicated anchor. Responsibility is recorded
      # BEFORE the load so a mid-load signal still flushes it back.
      if [[ $pf_mode == 'temp-main' ]]; then
        printf 'anchor "%s"\n' "$PF_ANCHOR" > "$out_dir/pf-main.rules"
        pf_main_loaded=1
        if ! sudo -n pfctl -f "$out_dir/pf-main.rules" 2>>"$out_dir/pf.log"; then
          note "netcut SKIP: could not load temporary main ruleset (cloud/pf.log) — restoring"
          if net_restore; then net_state=''; else cleanup_fail=1; fi
          return 1
        fi
      fi
      pf_anchor_loaded=1
      if ! sudo -n pfctl -a "$PF_ANCHOR" -f "$rules" 2>>"$out_dir/pf.log"; then
        note "netcut SKIP: pfctl anchor load failed (cloud/pf.log) — restoring"
        if net_restore; then net_state=''; else cleanup_fail=1; fi
        return 1
      fi
      sleep 2
      # stderr is discarded: curl error text would embed the staging hostname.
      # These host-side probes are diagnostics only — the verdict comes from
      # the app's own DB observation below.
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
      ;;
  esac
}
net_restore() {
  case "$net_state" in
    android-radio)
      local rf=0
      adb "${adb_serial_args[@]}" shell settings put global airplane_mode_on 0 || rf=1
      adb "${adb_serial_args[@]}" shell am broadcast \
        -a android.intent.action.AIRPLANE_MODE --ez state false 2>/dev/null || rf=1
      adb "${adb_serial_args[@]}" shell svc wifi enable 2>/dev/null || rf=1
      adb "${adb_serial_args[@]}" shell svc data enable 2>/dev/null || rf=1
      (( rf )) && return 1
      sleep 5
      if adb "${adb_serial_args[@]}" shell ping -c 1 -W 5 8.8.8.8 >"$out_dir/netrestore-ping.txt" 2>&1; then
        note "restore verified: ping 8.8.8.8 ok (cloud/netrestore-ping.txt)"
      else
        note "RESTORE_WARN: ping still failing — wait for emulator radio recovery"
        sleep 15
      fi
      ;;
    ios-pf)
      local rf=0
      # Every release is idempotent and re-attempted by the EXIT trap while
      # its flag stays set; flags clear only on success (FP-022).
      if (( pf_anchor_loaded )); then
        sudo -n pfctl -a "$PF_ANCHOR" -F rules 2>>"$out_dir/pf.log" \
          && pf_anchor_loaded=0 || rf=1
      fi
      # If we loaded the temporary main ruleset, flush main back to empty.
      if (( pf_main_loaded )); then
        sudo -n pfctl -F rules 2>>"$out_dir/pf.log" \
          && pf_main_loaded=0 || rf=1
      fi
      # held:<token> -> release our own reference. `unknown` cannot be -X'd —
      # it is settled by the baseline comparison below (never by pfctl -d or
      # a global flush).
      if [[ $pf_ref_state == held:* ]]; then
        if sudo -n pfctl -X "${pf_ref_state#held:}" 2>>"$out_dir/pf.log"; then
          pf_ref_state='none'
        else
          rf=1
        fi
      fi
      (( rf )) && return 1
      # Post-restore verification: a failed query means restore is UNVERIFIED
      # — never report baseline restored without reading it back (FP-023).
      local now_rules now_info now_status
      if ! now_rules=$(sudo -n pfctl -s rules 2>>"$out_dir/pf.log"); then
        note "CLEANUP_FAIL: could not verify pf main ruleset after restore"
        return 1
      fi
      if ! now_info=$(sudo -n pfctl -s info 2>>"$out_dir/pf.log"); then
        note "CLEANUP_FAIL: could not verify pf status after restore"
        return 1
      fi
      now_status=$(pf_status_word "$now_info")
      if [[ -z $now_status ]]; then
        note "CLEANUP_FAIL: pf Status unreadable after restore"
        return 1
      fi
      # temp-main mode expects empty, anchor mode expects the baseline content
      # — both reduce to equality with pf_base_main.
      if [[ $now_rules != "$pf_base_main" ]]; then
        note "CLEANUP_FAIL: main pf ruleset does not match baseline after restore"
        return 1
      fi
      if [[ $now_status != "$pf_base_status" ]]; then
        if [[ $pf_ref_state == 'unknown' ]]; then
          note "CLEANUP_FAIL: pf reference not released (token unknown)"
        else
          note "CLEANUP_FAIL: pf Status '$now_status' != baseline '$pf_base_status'"
        fi
        return 1
      fi
      if [[ $pf_ref_state == 'unknown' ]]; then
        note "RESTORE_WARN: pf enable reference state unknown (token lost); status matches baseline"
      fi
      note "pf restored to baseline (status=$now_status)"
      ;;
    *) return 0 ;;
  esac
  return 0
}
# shellcheck disable=SC2317  # invoked via EXIT/INT/TERM/HUP traps below
cleanup() { # idempotent; keeps state on failure so EXIT retry still sees it
  if [[ -n $net_state ]]; then
    if net_restore; then
      net_state=''
    else
      return 1
    fi
  fi
  return 0
}
# shellcheck disable=SC2317  # trap handler
on_signal() {
  trap - INT TERM HUP # don't re-enter
  note "interrupted by signal — restoring network state before exit"
  cleanup || note "CLEANUP_FAIL: restore failed after signal; cut state may persist"
  exit 130
}
# shellcheck disable=SC2317  # trap handler
on_exit() {
  if ! cleanup; then
    note "CLEANUP_FAIL: network restore failed; cut state may persist"
    exit 1
  fi
}
trap on_signal INT TERM HUP
trap on_exit EXIT # stays armed for the whole run — never cleared mid-script

# --- steps ------------------------------------------------------------------
step_bg() {
  note "--- step: background ($BG_WAIT s) ---"
  dump_db s05-pre-bg || true
  local pre; pre=$(latest_job s05-pre-bg)
  IFS='|' read -r aidp jobp _ _ _ _ np _ _ <<< "$pre"
  app_bg || true
  sleep "$BG_WAIT"
  dump_db s10-backgrounded || true
  screenshot s10-backgrounded
  note "--- step: foreground ---"
  app_fg || true
  sleep "$SETTLE_WAIT"
  dump_db s11-foregrounded || true
  screenshot s11-foregrounded
  local fg; fg=$(latest_job s11-foregrounded)
  IFS='|' read -r aid1 job1 _ _ _ _ n1 _ _ <<< "$fg"
  if [[ -z $aid1 || $aid1 == '-' ]]; then
    note "bg->fg: snapshot unavailable — no DB verdict"
    result_bg=UNVERIFIED
    return
  fi
  if same_attempt "$aidp" "$jobp" "$aid1" "$job1" && [[ $n1 == "$np" ]]; then
    note "bg->fg: SAME attempt/job ($job1), attempt count unchanged ($n1)"
    result_bg=PASS
  else
    note "bg->fg: FAIL attempt $aidp/$jobp -> $aid1/$job1, count $np -> $n1"
    result_bg=FAIL
  fi
}

step_kill() {
  note "--- step: kill + relaunch ---"
  dump_db s15-pre-kill || true
  local pre; pre=$(latest_job s15-pre-kill)
  IFS='|' read -r aidp jobp _ _ _ rcp np _ _ <<< "$pre"
  app_kill || true
  sleep 3
  app_start || true
  sleep "$KILL_WAIT"
  dump_db s20-relaunched || true
  screenshot s20-relaunched
  local rl; rl=$(latest_job s20-relaunched)
  IFS='|' read -r aid2 job2 _ _ _ rc2 n2 _ _ <<< "$rl"
  if [[ -z $aid2 || $aid2 == '-' ]]; then
    note "kill->relaunch: snapshot unavailable — no DB verdict"
    result_kill=UNVERIFIED
    return
  fi
  if is_num "$rc2" && is_num "$rcp" && [[ $rc2 -lt $rcp ]]; then
    note "kill->relaunch: FAIL saved results lost (received $rcp -> $rc2)"
    result_kill=FAIL
    return
  fi
  is_num "$rc2" && is_num "$rcp" &&
    note "kill->relaunch: saved results kept (received $rcp -> $rc2)"
  if same_attempt "$aidp" "$jobp" "$aid2" "$job2" && [[ $n2 == "$np" ]]; then
    note "kill->relaunch: SAME attempt/job ($job2), attempt count unchanged ($n2)"
    result_kill=PASS
  else
    note "kill->relaunch: FAIL attempt $aidp/$jobp -> $aid2/$job2, count $np -> $n2"
    result_kill=FAIL
  fi
}

step_net() {
  note "--- step: network cut ($NET_WAIT s) ---"
  # Baseline = the state immediately before the cut, not the start of the run.
  # The cut only counts if it severs a LIVE job: a known job_id plus a
  # non-terminal local status AND a non-terminal server_status. A requesting
  # row without jobId can't prove same-job continuation afterwards.
  dump_db s29-precut || true
  local pre; pre=$(latest_job s29-precut)
  IFS='|' read -r aidp jobp stp srvp snpp rcp np errp updp <<< "$pre"
  if [[ -z $aidp || $aidp == '-' ]]; then
    note "NETCUT_UNVERIFIED: no attempt readable before cut"
    result_net=UNVERIFIED
    return
  fi
  if [[ -z $jobp || $jobp == '-' || $jobp == 'NULL' ]]; then
    note "NETCUT_UNVERIFIED: no job_id recorded before cut (status=$stp) — same-job resume would be unprovable"
    result_net=UNVERIFIED
    return
  fi
  if [[ -z $stp || $stp == '-' ]]; then
    note "NETCUT_UNVERIFIED: local status unreadable before cut"
    result_net=UNVERIFIED
    return
  fi
  if is_terminal "$stp"; then
    note "NETCUT_UNVERIFIED: job already terminal before cut (status=$stp)"
    result_net=UNVERIFIED
    return
  fi
  case "$srvp" in
    queued | running) : ;;
    *)
      note "NETCUT_UNVERIFIED: server_status not live before cut (server_status=$srvp)"
      result_net=UNVERIFIED
      return
      ;;
  esac
  if ! is_num "$rcp" || ! is_num "$np" || [[ -z $updp || $updp == '-' ]]; then
    note "NETCUT_UNVERIFIED: precut snapshot fields unreadable (received=$rcp attempts=$np updated_at=$updp)"
    result_net=UNVERIFIED
    return
  fi
  note "precut: attempt=$aidp job_id=$jobp status=$stp server_status=$srvp server_next_ply=$snpp received=$rcp"
  if ! net_cut; then
    note "netcut: step skipped (see reason above); cleanup handled by trap"
    result_net=SKIPPED
    return
  fi

  sleep "$CUT_FIRST_WAIT"
  dump_db s30a-cut-start || true
  local c0; c0=$(latest_job s30a-cut-start)
  IFS='|' read -r aida joba _ _ _ rca na _ _ <<< "$c0"
  local rest=$((NET_WAIT - CUT_FIRST_WAIT))
  (( rest > 0 )) && sleep "$rest"
  dump_db s30-netcut || true
  screenshot s30-netcut
  local c1; c1=$(latest_job s30-netcut)
  IFS='|' read -r aid30 job30 st30 srv30 snp30 rc30 n30 err30 upd30 <<< "$c1"
  note "server_next_ply during cut: $snpp -> $snp30"
  note "cut observation: received $rca -> $rc30, status=$st30 server_status=$srv30, last_error=$err30 (updated_at=$upd30)"

  local cut_result=UNVERIFIED
  # Explicit missing-value rejection: every field the verdict relies on must
  # be present — a parser '-' is never evidence.
  if [[ -z $aida || $aida == '-' || -z $joba || $joba == '-' || -z $rca || $rca == '-' || -z $na || $na == '-' ]] ||
     [[ -z $aid30 || $aid30 == '-' || -z $job30 || $job30 == '-' || -z $st30 || $st30 == '-' ||
        -z $srv30 || $srv30 == '-' || -z $rc30 || $rc30 == '-' || -z $upd30 || $upd30 == '-' ]]; then
    note "NETCUT_UNVERIFIED: a cut-window snapshot field was unreadable"
  elif [[ $aida != "$aidp" || $joba != "$jobp" || $aid30 != "$aidp" || $job30 != "$jobp" || $na != "$np" || $n30 != "$np" ]]; then
    note "NETCUT_FAIL: cut snapshot refers to a different attempt/job or row count"
    cut_result=FAIL
  elif ! is_num "$rca" || ! is_num "$rc30"; then
    note "NETCUT_UNVERIFIED: cut-window received_count unreadable ($rca -> $rc30)"
  elif (( rc30 > rca )); then
    note "NETCUT_FAIL: app still received during cut (received $rca -> $rc30)"
    cut_result=FAIL
  elif is_terminal "$st30" || srv_terminal "$srv30" || [[ $srv30 == 'not_created' ]]; then
    # Any server-terminal view (incl. not_created: a POST rejection is still a
    # response) reaching the app mid-cut proves connectivity survived.
    note "NETCUT_FAIL: app still received during cut (terminal status=$st30 server_status=$srv30 observed)"
    cut_result=FAIL
  elif (( rc30 < rca )); then
    note "NETCUT_FAIL: received_count regressed during cut ($rca -> $rc30)"
    cut_result=FAIL
  elif [[ $err30 == 'transport' ]]; then
    # Newness: an unset pre-cut last_error is the primary basis. If s29
    # already held the SAME transport error no timestamp advance can prove a
    # new error — UNVERIFIED. A different error kind needs an updated_at advance.
    if [[ $errp == 'none' ]] || { [[ $errp != 'transport' ]] && [[ $upd30 > $updp ]]; }; then
      note "netcut: app transport failure observed (received $rc30 stalled, new transport last_error)"
      cut_result=PASS
    else
      note "NETCUT_UNVERIFIED: transport last_error not provably new (pre-cut kind=$errp)"
    fi
  elif [[ $err30 == 'http' ]]; then
    if [[ $errp == 'none' ]] || { [[ $errp != 'http' ]] && [[ $upd30 > $updp ]]; }; then
      note "NETCUT_FAIL: server response observed during cut (a non-transport error proves connectivity)"
      cut_result=FAIL
    else
      note "NETCUT_UNVERIFIED: only a stale server error present during cut"
    fi
  else
    note "NETCUT_UNVERIFIED: no new transport error recorded during cut"
  fi

  note "--- step: network restore ---"
  if net_restore; then
    net_state=''
  else
    cleanup_fail=1
    note "CLEANUP_FAIL: network restore failed; cut state may persist (retried at exit)"
  fi
  # Wait for the app to actually resume receiving on the SAME attempt/job
  # (intermediate polls reuse one scratch file; the snapshot the PASS
  # decision rests on is saved as s31-restored — no unverified refetch).
  local deadline=$((SECONDS + RESUME_WAIT)) resumed=1 saw aidr jobr str srvr rcr nr
  if (( cleanup_fail == 0 )); then
    while (( SECONDS < deadline )); do
      sleep "$RESUME_POLL"
      if bash "$(dirname "${BASH_SOURCE[0]}")/cloud-db-snapshot.sh" "$platform" \
          "$out_dir/.netcut-poll.txt" >/dev/null 2>&1; then
        saw=$(latest_job_file "$out_dir/.netcut-poll.txt")
        IFS='|' read -r aidr jobr str srvr _ rcr nr _ _ <<< "$saw"
        [[ -z $aidr || $aidr == '-' ]] && continue # unreadable poll — keep waiting
        if [[ $aidr != "$aidp" || $jobr != "$jobp" ]]; then
          note "netcut->restore: FAIL attempt/job changed $aidp/$jobp -> $aidr/$jobr"
          resumed=2; break
        fi
        if [[ $nr != "$np" ]]; then
          note "netcut->restore: FAIL attempt count $np -> $nr"
          resumed=2; break
        fi
        if [[ $str == 'error' ]]; then
          resumed=2; break
        fi
        if srv_terminal "$srvr" && is_num "$rcr" && is_num "$rc30" && (( rcr >= rc30 )); then
          resumed=0; break
        fi
        if is_num "$rcr" && is_num "$rc30" && (( rcr > rc30 )); then
          resumed=0; break
        fi
      fi
    done
  fi
  local s31_saved=1
  if (( resumed == 0 )); then
    # The PASS verdict rests on the last VERIFIED poll snapshot — save it as
    # s31-restored instead of trusting a fresh refetch (FP-021).
    if cp "$out_dir/.netcut-poll.txt" "$out_dir/s31-restored.txt" 2>/dev/null; then
      s31_saved=0
      note "snapshot s31-restored -> cloud/s31-restored.txt (verified poll snapshot)"
    else
      note "NETCUT_WARN: could not save s31-restored — PASS evidence cannot be finalized"
    fi
  else
    dump_db s31-restored || true
  fi
  screenshot s31-restored
  rm -f "$out_dir/.netcut-poll.txt"
  local fin; fin=$(latest_job s31-restored)
  IFS='|' read -r aid3 job3 st3 srv3 _ rc3 n3 _ _ <<< "$fin"
  # Re-verify the saved snapshot itself: all required fields present, same
  # attempt/job/row count, and the resume condition (received > s30, or
  # server-terminal with received >= s30).
  local fin_ok=1
  if (( s31_saved == 0 )) &&
     [[ $aid3 == "$aidp" && $job3 == "$jobp" && $n3 == "$np" ]] &&
     [[ -n $st3 && $st3 != '-' && -n $srv3 && $srv3 != '-' ]] &&
     is_num "$rc3" && is_num "$rc30"; then
    if (( rc3 > rc30 )) || { srv_terminal "$srv3" && (( rc3 >= rc30 )); }; then
      fin_ok=0
    fi
  fi
  if (( resumed == 0 )) && [[ $cut_result == PASS ]] && (( fin_ok == 0 )); then
    note "netcut->restore: PASS same attempt/job ($job3), attempts=$n3, received $rc30 -> $rc3 (status=$st3 server_status=$srv3)"
    result_net=PASS
  elif (( resumed != 0 )); then
    # Even a clean cut without a confirmed resume is a FAIL, not UNVERIFIED.
    note "netcut->restore: FAIL no resume within ${RESUME_WAIT}s (attempt=$aid3 job=$job3 status=$st3 received $rc30 -> $rc3)"
    result_net=FAIL
  elif [[ $cut_result == PASS ]]; then
    # Resume confirmed but the saved evidence could not be verified — never
    # fall back to the cut verdict for PASS (FP-021).
    note "netcut->restore: UNVERIFIED s31-restored unusable for final verification"
    result_net=UNVERIFIED
  else
    note "netcut->restore: resumed but cut evidence inconclusive (received $rc30 -> $rc3, status=$st3)"
    result_net=$cut_result
  fi
  (( cleanup_fail )) && { note "cleanup failure overrides the step verdict"; result_net=FAIL; }
  return 0
}

# --- sequence ---------------------------------------------------------------
dump_db s00-before || true
before=$(latest_job s00-before)
IFS='|' read -r aid0 job0 st0 srv0 snp0 rc0 n0 _ _ <<< "$before"
note "before: attempt=$aid0 job_id=$job0 status=$st0 server_status=$srv0 server_next_ply=$snp0 received=$rc0 attempts=$n0"
if [[ $n0 == '0' || -z $aid0 || $aid0 == '-' ]]; then
  note "NO_ATTEMPT: no cloud_attempts row readable before the steps — aborting interruption evidence"
  exit 1
fi

IFS=',' read -ra step_list <<< "$STEPS"
for s in "${step_list[@]}"; do
  case "$s" in
    bg) step_bg ;;
    kill) step_kill ;;
    net) step_net ;;
    *) note "unknown step '$s' in CLOUD_INTERRUPTION_STEPS (valid: bg,kill,net)"; exit 2 ;;
  esac
done

for s in "${step_list[@]}"; do
  case "$s" in
    bg) note "RESULT bg=$result_bg" ;;
    kill) note "RESULT kill=$result_kill" ;;
    net) note "RESULT net=$result_net" ;;
  esac
done
note "done. attempt count start=$n0"

rc_exit=0
for s in "${step_list[@]}"; do
  case "$s" in
    bg) [[ $result_bg == PASS ]] || rc_exit=1 ;;
    kill) [[ $result_kill == PASS ]] || rc_exit=1 ;;
    net) [[ $result_net == PASS ]] || rc_exit=1 ;;
  esac
done
(( cleanup_fail )) && rc_exit=1
exit "$rc_exit"
