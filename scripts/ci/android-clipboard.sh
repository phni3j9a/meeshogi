#!/usr/bin/env bash
set -euo pipefail
: "${ANDROID_HOME:?Set ANDROID_HOME}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
build="$root/artifacts/clipboard-helper"
bt="$ANDROID_HOME/build-tools/36.0.0"
android_jar="$ANDROID_HOME/platforms/android-36/android.jar"
mkdir -p "$build"

source_hash="$(sha256sum \
  "$root/scripts/ci/clipboard/AndroidManifest.xml" \
  "$root/scripts/ci/clipboard/ClipboardActivity.java" \
  "$root/scripts/ci/clipboard/ShareReceiverActivity.java" \
  | sha256sum | cut -d ' ' -f 1)"
if [[ ! -f "$build/helper.apk" || ! -f "$build/source.sha256" || "$(cat "$build/source.sha256")" != "$source_hash" ]]; then
  rm -rf "$build/classes" "$build/dex" "$build/unsigned.apk" "$build/aligned.apk" "$build/helper.apk"
  mkdir -p "$build/classes" "$build/dex"
  javac -source 8 -target 8 -classpath "$android_jar" -d "$build/classes" \
    "$root/scripts/ci/clipboard/ClipboardActivity.java" \
    "$root/scripts/ci/clipboard/ShareReceiverActivity.java"
  "$bt/d8" --lib "$android_jar" --output "$build/dex" \
    "$build/classes/com/meeshogi/testclipboard/ClipboardActivity.class" \
    "$build/classes/com/meeshogi/testclipboard/ShareReceiverActivity.class"
  "$bt/aapt2" link -I "$android_jar" --manifest "$root/scripts/ci/clipboard/AndroidManifest.xml" -o "$build/unsigned.apk"
  (cd "$build/dex" && zip -qj "$build/unsigned.apk" classes.dex)
  if [[ ! -f "$build/debug.keystore" ]]; then
    keytool -genkeypair -keystore "$build/debug.keystore" -storepass android -keypass android \
      -alias androiddebugkey -keyalg RSA -validity 365 -dname "CN=Test"
  fi
  "$bt/zipalign" -f 4 "$build/unsigned.apk" "$build/aligned.apk"
  "$bt/apksigner" sign --ks "$build/debug.keystore" --ks-pass pass:android --out "$build/helper.apk" "$build/aligned.apk"
  printf '%s\n' "$source_hash" > "$build/source.sha256"
fi

if [[ "${1:-}" == "--build-only" ]]; then
  exit 0
fi
if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <UTF-8-text-file>" >&2
  exit 2
fi

adb install --no-incremental -r "$build/helper.apk"
payload="$(base64 < "$1" | tr -d '\n')"
adb shell am start -W -n com.meeshogi.testclipboard/.ClipboardActivity --es payload "$payload"
