# Expo SDK 57 patch — Android 検証レポート

- 対象 SHA: `6d52e2f28f565123598e1087a7137e1b9ad6473f`（branch `feat/expo-57-patch`、`git fetch && git reset --hard` で正確に checkout）
- 変更: dependency-only。expo 57.0.25 / expo-build-properties 57.0.22 / expo-linking 57.0.11 / expo-router 57.0.23 / expo-sharing 57.0.22（推移的に expo-modules-core 57.0.19 / expo-modules-jsi 57.1.1）。app・native・test ソース変更なし
- 手順: `npm ci` → `npx expo prebuild --platform android --no-install --clean`（android/ 完全再生成）→ `./gradlew assembleRelease`（BUILD SUCCESSFUL 6m27s、Rust 4 ABI + CMake + Metro bundle）→ `adb install -r` Success → 起動確認（ライブラリ正常表示・データ永続）→ `bash scripts/ci/android-acceptance.sh`（ACCEPTANCE_FLOWS 未設定 = 全フロー）
- 環境: emulator-5554 / AVD `acceptance` / sdk_gphone64_x86_64 / Android 16 / 1080x2400@420dpi。実機未確認

## 結果: PASS

**15/15 フロー全成功、junit failures 0。** export-review の書き出し KIF は `fixtures/kif/shogiwars.kif` と byte 一致。

| flow | result |
|---|---|
| licenses-review | pass |
| import-review | pass |
| player-names | pass |
| player-names-kiou | pass |
| analysis-review | pass (50k 全局解析) |
| analysis-partial-review | pass |
| candidate-review | pass |
| file-import | pass |
| management-review | pass |
| appearance-review | pass |
| appearance-dark | pass |
| export-review | pass + byte-identical cmp |
| background-review | pass |
| large-text-review | pass (font_scale 1.3) |
| search-delete-review | pass |

run: `artifacts/android/runs/20260924T142506Z-11215`（`selected-flows.txt` = `all`）

失敗なし — 「最初の失敗フロー」の報告対象は発生せず。実機は未検証（エミュレータのみ）。

## evidence パス

- `evidence/maestro/<flow>/` — junit.xml + 各フローのスクリーンショット・ログ
- `evidence/videos/` — フロー録画
- `evidence/logcat.txt` / `androidruntime.logcat.txt` / `final.png` / `exported.kifu` / `selected-flows.txt`
