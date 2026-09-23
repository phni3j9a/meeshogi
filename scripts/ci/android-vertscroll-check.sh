#!/usr/bin/env bash
# Repro: does a vertical drag that starts ON the evaluation chart scroll the
# page? Compare with the identical drag (same direction, distance, duration)
# starting OFF the chart. Marker for page position = element y-bounds inside
# the shared scroll container (evaluation-chart top, candidate-0 top).
# Usage: android-vertscroll-check.sh <run_dir>
set -euo pipefail
run_dir=${1:?usage}
mkdir -p "$run_dir"
results="$run_dir/results.txt"; : > "$results"

dump() { adb shell uiautomator dump /sdcard/vs.xml >/dev/null 2>&1; adb pull /sdcard/vs.xml "$run_dir/ui.xml" >/dev/null 2>&1; }
top_of() { # resource-id -> y_top of its bounds
  python3 - "$run_dir/ui.xml" "$1" <<'PY'
import re,sys
x=open(sys.argv[1],encoding='utf-8',errors='replace').read()
m=re.search(r'resource-id="'+re.escape(sys.argv[2])+r'"[^>]*bounds="\[(\d+),(\d+)\]',x)
print(m.group(2) if m else '')
PY
}
shot() { adb exec-out screencap -p > "$run_dir/$1.png"; }

# Recording (screenrecord) started before, stopped after all gestures.
adb shell screenrecord /sdcard/vs.mp4 >/dev/null 2>&1 &
rec_pid=$!
trap 'adb shell pkill -INT screenrecord >/dev/null 2>&1 || true; sleep 1; adb pull /sdcard/vs.mp4 "$run_dir/vertscroll.mp4" >/dev/null 2>&1 || true' EXIT

drag_on()  { adb shell input swipe 540 1700 540 1300 400; }  # chart center, up 400
drag_off() { adb shell input swipe 540 1100 540 700  400; }  # board area,   up 400

# -- state S0: default scroll (chart + first candidate visible) ---------------
dump
shot vs-00-start
c0=$(top_of candidate-0); g0=$(top_of evaluation-chart)
echo "S0 chart_top=$g0 cand_top=$c0" | tee -a "$results"

# -- gesture A: 400px upward drag starting ON the chart ------------------------
drag_on; sleep 0.6; dump; shot vs-01-after-onchart
c1=$(top_of candidate-0); g1=$(top_of evaluation-chart)
echo "A(on-chart up400) chart_top=$g1 cand_top=$c1 delta_cand=$(( ${c1:-0} - ${c0:-0} ))" | tee -a "$results"

# -- reset: back to library, reopen game --------------------------------------
adb shell input keyevent 4; sleep 1.2
adb shell 'input tap 540 800'; sleep 2.2
dump
rc=$(top_of candidate-0); rg=$(top_of evaluation-chart)
echo "reset chart_top=$rg cand_top=$rc" | tee -a "$results"

# -- gesture B: identical 400px upward drag starting OFF the chart ------------
drag_off; sleep 0.6; dump; shot vs-02-after-offchart
c2=$(top_of candidate-0); g2=$(top_of evaluation-chart)
echo "B(off-chart up400) chart_top=$g2 cand_top=$c2 delta_cand=$(( ${c2:-0} - ${rc:-0} ))" | tee -a "$results"

# -- gesture C: 400px DOWNWARD drag ON the chart (reverse direction) ----------
adb shell input keyevent 4; sleep 1.2; adb shell 'input tap 540 800'; sleep 2.2
dump; shot vs-03-restart
c3=$(top_of candidate-0)
adb shell input swipe 540 1700 540 2100 400; sleep 0.6; dump; shot vs-04-after-onchart-down
c4=$(top_of candidate-0)
echo "C(on-chart down400) cand_top=$c3 -> $c4 delta=$(( ${c4:-0} - ${c3:-0} ))" | tee -a "$results"

# -- gesture D: identical down-drag OFF the chart -----------------------------
adb shell input keyevent 4; sleep 1.2; adb shell 'input tap 540 800'; sleep 2.2
dump
c5=$(top_of candidate-0)
adb shell input swipe 540 1100 540 1500 400; sleep 0.6; dump; shot vs-05-after-offchart-down
c6=$(top_of candidate-0)
echo "D(off-chart down400) cand_top=$c5 -> $c6 delta=$(( ${c6:-0} - ${c5:-0} ))" | tee -a "$results"

echo "---- vertscroll results ----"; cat "$results"
