#!/usr/bin/env bash
set -euo pipefail
: "${ANDROID_HOME:?Set ANDROID_HOME}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
build="$root/artifacts/clipboard-helper"
bt="$ANDROID_HOME/build-tools/36.0.0"
android_jar="$ANDROID_HOME/platforms/android-36/android.jar"
mkdir -p "$build/classes" "$build/dex"
if [[ ! -f "$build/helper.apk" ]]; then
  javac -source 8 -target 8 -classpath "$android_jar" -d "$build/classes" "$root/scripts/ci/clipboard/ClipboardActivity.java"
  "$bt/d8" --lib "$android_jar" --output "$build/dex" "$build/classes/com/meeshogi/testclipboard/ClipboardActivity.class"
  "$bt/aapt2" link -I "$android_jar" --manifest "$root/scripts/ci/clipboard/AndroidManifest.xml" -o "$build/unsigned.apk"
  (cd "$build/dex" && zip -qj "$build/unsigned.apk" classes.dex)
  keytool -genkeypair -keystore "$build/debug.keystore" -storepass android -keypass android -alias androiddebugkey -keyalg RSA -validity 365 -dname "CN=Test"
  "$bt/zipalign" -f 4 "$build/unsigned.apk" "$build/aligned.apk"
  "$bt/apksigner" sign --ks "$build/debug.keystore" --ks-pass pass:android --out "$build/helper.apk" "$build/aligned.apk"
fi
adb install --no-incremental -r "$build/helper.apk"
if [[ "${1:-}" != "--build-only" ]]; then
  payload="$(base64 < "$1" | tr -d '\n')"
  adb shell am start -W -n com.meeshogi.testclipboard/.ClipboardActivity --es payload "$payload"
fi
