# iOS 受入証拠 — feat/expo-57-patch (Expo SDK 57 パッチ)

## 結果: PASS

- run 1 (default visual mode, `ACCEPTANCE_FLOWS` 未設定): 全3フローがスクリプト自動合格。
- run 2 (export 追加確認, `IOS_ACCEPTANCE_MODE=full ACCEPTANCE_FLOWS=export-review-ios`, 同一ビルド済み app): licenses/import/export-review-ios 全合格。export KIF は fixture と sha256 一致。

製品ソース・main は未変更。

## 対象

- repo: `phni3j9a/meeshogi`
- branch: `feat/expo-57-patch`
- commit: `6d52e2f28f565123598e1087a7137e1b9ad6473f`
- 変更: 依存のみ (package.json / package-lock.json)。expo 57.0.25, expo-build-properties 57.0.22, expo-linking 57.0.11, expo-router 57.0.23, expo-sharing 57.0.22。推移的に expo-modules-core 57.0.19, expo-modules-jsi 57.1.1。アプリ・ネイティブ・テストコードの変更なし。

## 環境

- host: Devin Cloud macOS (Apple Silicon)
- Xcode: 26.6 (17F113), SDK `iphonesimulator26.5`
- Simulator: iPhone 18 Pro / iOS 27.0 / `1308A109-3EE0-4711-9287-85246639DBC7`
- node 22.23.2 / cocoapods 1.17.0 / rust 1.96.0 / maestro 2.10.0

## ビルド (新規・先行ビルド不利用)

`git fetch && git reset --hard 6d52e2f28f565123598e1087a7137e1b9ad6473f` → `npm ci` → `npx expo prebuild --platform ios --no-install` → `bash scripts/engine/build-ios.sh` (model SHA-256 `807c18da…2eab` 検証済み・3ターゲット release ビルド→xcframework) → `pod install --project-directory=ios` → `xcodebuild -workspace ios/meeshogi.xcworkspace -scheme meeshogi -configuration Release -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath $RUNNER_TEMP/meeshogi-ios CODE_SIGNING_ALLOWED=NO ARCHS=arm64 ONLY_ACTIVE_ARCH=YES build` → **BUILD SUCCEEDED** (`Release-iphonesimulator/meeshogi.app` 59MB)。

環境メモ: セッション開始時、xcodebuild が simulator destination を0件しか列挙しない状態だった（CoreSimulator 上の runtime は iOS 26.5/27.0 とも Ready）。`xcodebuild -downloadPlatform iOS` で iOS 26.5 Simulator (23F77) を取得後に全 destination が見えるようになり、そこからビルドを実施した。

## インストール・起動

`ios-acceptance.sh` が app を install（`app.install.end` 14:52:01Z）。各 Maestro フローがアプリを起動し画面遷移を実行（flow.mov 368s・各 takeScreenshot を目視確認済み）。

## フロー結果 (全てスクリプト自動・helper 再試行なし)

| flow | 結果 | 時間 |
| --- | --- | --- |
| licenses-review | PASS | 31s |
| import-review | PASS | 51s |
| ios-visual-review | PASS | 2m18s |

`acceptance.end status=0`（exit 0）。run: `artifacts/ios/runs/20260924T145028Z-11073` → 本ブランチ `suite/final-run/`。

timeline.log の keyboard-introduction 行:
`2026-09-24T14:51:27Z keyboard-introduction.suppressed`

## run 2: export 追加確認 (同一ビルド app・再ビルドなし)

`IOS_ACCEPTANCE_MODE=full ACCEPTANCE_FLOWS=export-review-ios bash scripts/ci/ios-acceptance.sh` → run `artifacts/ios/runs/20260924T150709Z-13015` → 本ブランチ `suite/export-run/`。

| flow | 結果 | 時間 |
| --- | --- | --- |
| licenses-review | PASS | 22s |
| import-review | PASS | 48s |
| export-review-ios | PASS | 31s |
| 他11フロー | skip (`flow.skip`、focused run として記録) | — |

`acceptance.end status=0`（exit 0）。export 検証: `verify_export` が `Library/Caches` の shareKif 成果物を fixture `fixtures/kif/shogiwars.kif` と比較 — **sha256 一致** `e527fbd0bd25e88652176ff4e6c572ff638c597b1eacfb902799ea6d202dbf55`（`export-source.txt` = `app-cache-remoteui`、RemoteUI 既知制約により Files 保存ブラウザは自動操作下で提示されず、`Save` 実タップは実行したうえで app cache の同一バイト列を比較）。

timeline.log の keyboard-introduction 行:
`2026-09-24T15:07:10Z keyboard-introduction.suppressed`

## 未実行・未確認

- run 1 (visual) の設計上未実行: player-names, player-names-kiou, analysis-review, analysis-partial-review, candidate-review, file-import, management-review, appearance-review, appearance-dark, background-review, large-text-review, search-delete-review（export-review-ios は run 2 で別途実施済み）。
- 実 iPhone の性能・FPS・発熱: 未確認（Simulator のみ）。
- Save to Files の保存先 UI: 未確認（iOS 27 RemoteUI が自動操作下で提示されない既知制約。run 2 でも RemoteUI ブラウザは出ず、app cache 成果物のバイト列一致で検証）。

## 証拠の内訳

- `suite/final-run/`: run 1 (visual) の成果物 — timeline.log, junit.xml×3, 各フロー takeScreenshot PNG, screen-hierarchy, flow.mov (368s 録画), final.png, simulator.log, devices.json, selected-flows.txt, fixture コピー (kiou.kif UTF-8/Shift_JIS, clipboard-*.txt), files-helper ビルド成果物, recording.log
- `suite/export-run/`: run 2 (export focused) の成果物 — timeline.log, junit.xml×3, takeScreenshot PNG, export KIF (`exported-shogiwars.kifu`) + `export-source.txt`, flow.mov, final.png, simulator.log
- `logs/ios-acceptance.log`: run 1 stdout, `logs/ios-acceptance-export.log`: run 2 stdout
- `logs/xcodebuild.log.gz`: Release ビルド全ログ (gzip)
- `summary.json`: 機械可読サマリ, `manifest.json`: 本ファイル一覧
