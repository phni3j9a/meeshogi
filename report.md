# PR #12 iOS 修正後ネイティブ再受入レポート

- 対象 SHA: `ba6c6df839f27394d99061014f13faa3b0b8baee`（`feat/analysis-design-generated-pieces` 先端。修正 `91cc1d0` + iOS受入フロー統合 `aa870e1` + Android受入 `ba6c6df` を含む）
- 前回検証 SHA: `7f877a25958fe4cd5c08341271e8c7f0cb00259b`
- 環境: Xcode 26.6 (17F113) / SDK iphonesimulator26.5 / Node 22.23.2 / CocoaPods 1.17.0 / Rust 1.96.0 / Maestro 2.10.0
- デバイス: iPhone 18 Pro iOS 27.0（主）, iPhone 17e iOS 26.5（レイアウト・最大文字）, iPad mini A17 Pro iOS 26.5（タブレット）
- 受入実施: 2026-09-23 JST / UTC 07:00 台（記録の clock 参照）

## 結論

**両修正とも確認済み。前回指摘の2件（PR12-IOS-1 high / PR12-IOS-2 low）は解消。新たな製品バグ・受入阻害はなし。既存 suite 全15フロー自動合格（ios-visual-review は設計上 skip）、PR固有チェック・レイアウト・実GUIドラッグ・最大文字モーダル・再起動後設定すべて合格。**

## ビルド/インストール/起動（先行ビルド不利用）

1. `git fetch` → `git checkout ba6c6df839f27394d99061014f13faa3b0b8baee`（detached、worktree `/Users/devin/repos/meeshogi-pr12-ios`）
2. `rm -rf ~/runner-temp/meeshogi-ios ios`（先行成果物削除）
3. `npm ci`（648 pkgs）
4. `npx expo prebuild --platform ios --no-install --clean`
5. `bash scripts/engine/build-ios.sh` → MeeshogiSekireiCore.xcframework 再生成
6. `pod install --project-directory=ios`（110 pods）
7. `xcodebuild -workspace ios/meeshogi.xcworkspace -scheme meeshogi -configuration Release -sdk iphonesimulator ARCHS=arm64 CODE_SIGNING_ALLOWED=NO -derivedDataPath $RUNNER_TEMP/meeshogi-ios` → ** BUILD SUCCEEDED **（.app 生成 06:59:50Z。`main.jsbundle` 内に `fullScreenGestureEnabled` シンボル存在を確認）
8. `xcrun simctl install` + `launch` on iPhone 18 Pro → 起動確認（pr12/launch.png）

## 修正1: 評価グラフ横ドラッグ（PR12-IOS-1 → 解消）

実GUI操作（Simulator ウィンドウへのマウスドラッグ＝実タッチ相当、RN PanResponder に到達する経路。先行不具合動画と同条件・同画面・同ゲーム KeroPona 80手・解析済み42/81）を `simctl io recordVideo` で録画しつつ実施。証拠: `pr12/fix1-drag/`。

| 操作 | 開始手数 | 途中の読み出し | リリース後 | pop |
|---|---|---|---|---|
| グラフ中央→右 | 67/80 | 本譜 54手目 未解析 → 74手目 -M4 | 74/80手（一度だけ移動、01-04.png） | なし |
| グラフ中央→左 | 74/80 | 本譜 0手目 未解析 | 0/80手 初期局面（05,06.png） | なし |
| グラフ中央→右端まで長押しドラッグ | 0/80 | 本譜 80手目 後手勝ち・詰み終 | 80/80手（07,08.png） | なし |
| グラフ上を縦ドラッグ | 0/80 | （ページスクロール、スクラブキャンセル、マーカー0手不変） | — | なし |
| 左端（画面縁）→右ドラッグ | 80/80 | interactive pop が指追従（09.png） | ライブラリへ pop（10.png） | 正常動作 |
| ヘッダー「戻る」タップ | 80/80 | — | ライブラリへ pop（11.png） | 正常動作 |

補足: Simulator のマウス入力では interactive pop の開始が画面最縁のごく狭い領域に限定される（システム Files.app でも同じ挙動を確認済み＝iOS 27 Simulator 入力経路の制約であり本アプリ固有ではない）。縁内側での通常ドラッグが pop しないことは意図どおり（= fullscreen gesture 無効化の効果）。

## 修正2: 詰め手順モーダルの手数カウンタ（PR12-IOS-2 → 解消）

iPhone 17e + `content_size accessibility-extra-large`（OS最大文字）で、67手目「後手・3手詰め ›」→ 詰め手順モーダルを開き確認。`0 / 3手` は「3手詰め」タイトルの次行へ折り返し右寄せ表示され、右端の欠けなし。証拠: `pr12/fix2-mate/01-mate-counter-full.png`（全体）, `02-mate-counter-zoom.png`（拡大）。

## 全フロー再実行

`IOS_ACCEPTANCE_MODE=full bash scripts/ci/ios-acceptance.sh` → exit 0、スクリプト自動成功のみ（helper再試行なし）。run: `suite/final-run/`（`artifacts/ios/runs/20260923T140047Z-7262` を収録。junit 15件 failures=0）。

| flow | 結果 |
|---|---|
| licenses-review / import-review / player-names / player-names-kiou | pass |
| analysis-review（50k全局完了） / analysis-partial-review（標準10k partial・ply41欠測・有限再開） | pass |
| candidate-review / file-import / management-review | pass |
| appearance-review / appearance-dark | pass |
| export-review-ios（shareKif 成果物 byte-compare: fixture と sha256 一致 e527fbd0…） | pass |
| background-review / large-text-review / search-delete-review | pass |
| ios-visual-review | skip（visualモード専用、設計上の skip） |

`bash scripts/ci/pr12-ios-checks.sh`（iPhone 18 Pro）→ exit 0: pr12-piece-sets pass（4セット選択・盤上/持駒反映・明暗・反転・再起動後の選択維持）、pr12-graph pass（左右端・中央タップ、欠測 ply41、ply67 mate バッジ→分岐検討→本譜に戻る、縦スクロールキャンセル）。SQLite 永続: settings id=1 に `pieceSet=tsuge`、integrity_check ok。

`bash scripts/ci/pr12-device-layout.sh` → iPhone 17e default pass / 17e accessibility-extra-large pass / iPad mini pass。

## 手操作回帰（実GUI）

上記フローに加え、詰め手順モーダル（最大文字、実タップ遷移）、エッジ pop、ヘッダー戻る、グラフ横ドラッグを GUI で直接操作・録画済み（`pr12/fix1-drag/graph-drag-fix.mp4` 366s、含 Files.app 対照実験）。

## 未確認（既知制約）

- Save to Files の遷移先 UI: iOS 27 RemoteUI が automation 下で提示されない（前回同様）。export バイト列はアプリ Caches 成果物と fixture の byte-compare で検証済み。
- 実機性能・FPS・発熱: 未計測（達成扱いにしない）。
- Simulator マウス入力の縁ジェスチャ開始位置の狭さ（システムアプリでも同じ → 検証フロー問題ではなく環境制約）。

## 証拠パス

```
manifest.json / summary.json / report.md
suite/runs-index.txt
suite/final-run/            … timeline.log, junit×15, takeScreenshot 一式, flow.mp4, exported-shogiwars.kifu + sha256, simulator.log.gz
pr12/checks/                … pr12-piece-sets.mp4 / pr12-graph.mp4 + junit + スクショ, settings-payload.json, db-integrity.txt
pr12/layout/{iphone17e,ipadmini}/ … pr12-layout(.accessibility-extra-large).mp4 + junit + スクショ
pr12/fix1-drag/             … graph-drag-fix.mp4（366s 実操作録画）+ 01..11.png（各段階・手数記録）
pr12/fix2-mate/             … モーダル全体 + カウンタ拡大 PNG
logs/                       … 各スクリプト stdout ログ
```

スクリプト自動成功と helper 再試行の区別: 今回は全てスクリプト一発成功。前回のフロー修正差分は ba6c6df に統合済み（私の verify ブランチ内容は `aa870e1` で取り込み・拡張済みのため、今回のフロー修正差分なし）。
