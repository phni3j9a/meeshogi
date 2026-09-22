#!/bin/bash
# Rerun of the 6a54ff5 suite continuation with iOS-merged-label variants.
# Variants keep stock semantics incl. id: tab-games + delay:800; only exact-match
# selectors that iOS merges ("解析の長さ, 標準, Forward" etc.) are widened.
set -uo pipefail
cd /Users/devin/repos/meeshogi
export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/node@22/bin:$HOME/maestro-2.10.0/maestro/bin:$PATH"
DEV=1308A109-3EE0-4711-9287-85246639DBC7
RUN=/Users/devin/repos/meeshogi/artifacts/ios/runs/20260922T204527Z-37636
M=$RUN/maestro
H=artifacts/ios/helpers

seed() {
  local f="$1" rid payload hc res i
  rid="$(python3 -c 'import uuid; print(uuid.uuid4())')"
  payload="$(base64 < "$f" | tr -d '\r\n')"
  hc="$(xcrun simctl get_app_container "$DEV" com.meeshogi.testfiles data)"
  res="$hc/Library/Caches/clipboard-${rid}.txt"
  xcrun simctl terminate "$DEV" com.meeshogi.testfiles >/dev/null 2>&1 || true
  xcrun simctl launch "$DEV" com.meeshogi.testfiles --clipboard-base64 "$payload" --clipboard-request "$rid" >/dev/null
  for i in $(seq 1 61); do
    [[ -f "$res" ]] && { cmp -s "$f" "$res" && echo "seed ok $f" && return 0; }
    sleep 2
  done
  echo "seed FAIL $f"; return 1
}

run() {
  local name="$1" flow="$2" out="$M/$1"
  mkdir -p "$out/test-output"
  echo "=== flow.start $name ($(basename "$flow"))"
  maestro --device "$DEV" test \
    -e INITIAL_READY_TIMEOUT=180000 -e IMPORT_SAVE_TIMEOUT=120000 \
    --format junit --output "$out/junit.xml" \
    --test-output-dir "$out/test-output" "$flow" 2>&1 | tail -3
  echo "=== flow.end $name"
}

seed "$RUN/clipboard-wars.txt" && run player-names "$H/player-names-kbd.yaml"
seed "$RUN/clipboard-kiou.txt" && run player-names-kiou "$H/player-names-kiou-kbd.yaml"
run analysis-review "$H/analysis-review-6a54ff5.yaml"
run analysis-partial-review "$H/analysis-partial-6a54ff5.yaml"
run candidate-review "$H/candidate-review-ios.yaml"
run file-import "$H/file-import-ios.yaml"
run management-review "$H/management-review-ios.yaml"
run appearance-review "$H/appearance-review-6a54ff5.yaml"
run appearance-dark "$H/appearance-dark-ios.yaml"
run export-review-ios "$H/export-review-ios.yaml"
run background-review "$H/background-6a54ff5.yaml"
CS_ORIG="$(xcrun simctl ui "$DEV" content_size | tr -d '\r' | tail -n 1 | tr -d '[:space:]')"
echo "$CS_ORIG" > "$RUN/content-size-before.txt"
xcrun simctl ui "$DEV" content_size extra-extra-extra-large
run large-text "$H/large-text-review-ios.yaml"
xcrun simctl ui "$DEV" content_size "$CS_ORIG"
echo "$CS_ORIG" > "$RUN/content-size-restored.txt"
run search-delete "$H/search-delete-review-ios.yaml"
echo "=== suite continuation done"
