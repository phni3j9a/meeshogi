# meeshogi PR #12 / Issue #16 — iOS ネイティブ受入レポート

- **対象**: phni3j9a/meeshogi `feat/analysis-design-generated-pieces`
- **ソース完全SHA**: `7f877a25958fe4cd5c08341271e8c7f0cb00259b` ("Merge main into PR #12 and preserve analysis correctness in refreshed screens")
- **検証フロー branch**: `verify/pr12-ios-flows` @ `f7458ead061f04dee3ba65ee93c4be6bdf7fc7d5`
- **evidence branch**: `evidence/pr12-ios-20260923` (このファイルと成果物一式)
- **環境**: macOS 26.5.2 (25F84) Apple Silicon / Xcode 26.6 (17F113) / Maestro 2.10.0
- **端末**: iPhone 18 Pro iOS 27.0 `1308A109-…` (主), iPhone 17e iOS 27.0 (小画面+文字拡大), iPad mini (A17 Pro) iOS 27.0 (tablet)
- **ビルド**: `npm ci → expo prebuild --no-install → build-ios.sh (実sekirei) → pod install → xcodebuild Release-iphonesimulator ARCHS=arm64 → ios-app-artifact.sh`。simctl install+launch OK。`cargo test --locked` = 24/24 pass。

## 1. 既存 suite (`IOS_ACCEPTANCE_MODE=full`)

最終自動 run: `suite/final-run/` (= runs/20260923T105327Z-30703)。script 自動成功と helper 再実行を区別。

| フロー | 結果 | 手段 |
|---|---|---|
| import-review (取り込み) | PASS | script 自動 |
| file-import (KIFファイル) | PASS | script 自動 |
| player-names / player-names-kiou (名前) | PASS / PASS | script 自動 |
| analysis-review (長め50k全局完了: 80手・投了) | PASS | script 自動 |
| analysis-partial-review (標準10k partial/ply41欠測/有限再開) | PASS | script 自動 |
| candidate-review (候補分岐→本譜) | PASS | script 自動 |
| management-review (戦績/お気に入り/削除) | PASS | script 自動 |
| appearance-review + appearance-dark (明暗) | PASS / PASS | script 自動 |
| licenses-review | PASS | script 自動 |
| export-review-ios (KIF export一致) | PASS (helper 再実行) | in-run FAIL → 手動再実行 PASS + `Library/Caches` 成果物 byte MATCH (`fixtures/kif/shogiwars.kif`) |
| background-review (背景停止) | PASS (helper 再実行) | 手動 |
| large-text-review (文字拡大) | PASS (helper 再実行) | 手動 |
| search-delete-review (検索削除) | PASS (helper 再実行) | 手動 |
| ios-visual-review | SKIP | visual mode 専用 (本 run 対象外) |

- UI 刷新で古い文言/label grouping 不一致だった箇所は意味を維持して修正し、`verify/pr12-ios-flows` に diff として残した (a11y composite label への `'.*….*'` マッチ、action-sheet 落ち着き待ち、Files picker のアイコンタップ、favorite 書き込み flush 待ち、hideKeyboard 代替タップ等)。
- RemoteUI 制約 (iOS 27): **Save to Files の保存ブラウザは automation 下では一切提示されない** (タップ→シート閉→ブラウザ無し)。同じ「Save to Files をタップする」操作は残しつつ、export バイト列は app container `Library/Caches/meeshogi-*.kifu` を fixture と `cmp` で一致確認。Files 保存先 UI の遷移先は未確認。

## 2. PR 固有チェック

### 駒セット (`pr12/checks/pr12-piece-sets.mp4`, 2m39s PASS)
- 設定→駒セット 4種 (黄楊/白木/桜木/青磁) のプレビュー/選択 → 盤上・持駒・盤反転・詰め手順モーダルへの反映を各セット×light/darkで撮影 (28枚 `takeScreenshot/60-85*.png`)。
- 青磁選択後 `stopApp`→`launchApp` (kill/relaunch) → 盤上で青磁維持 + SQLite `settings.payload` = `"pieceSet":"tsuge"` + `PRAGMA integrity_check` = ok。最後に黄楊+lightへ復元。棋譜/解析は壊れず (`.*６八角打.*` 等レコード継続)。

### レイアウト (`pr12/layout/`)
- iPhone 18 Pro (通常) / iPhone 17e (小画面) / iPad mini (tablet) ���3端末で `pr12-layout` PASS: 盤・評価ヘッダ・第一候補・固定手送りバー・戻る/閉じる・safe area。
- iPhone 17e で OS 最大文字 (`simctl ui content_size accessibility-extra-large`) 追加 PASS。盤・候補・手送りは崩れず (候補行・手順再生ボタンは折返しで機能維持)。

### 新グラフ (`pr12/checks/pr12-graph.mov`, 27s PASS)
- タップ選択: 左端→`0 / 80手`、右端→`80 / 80手`、中間→`40 / 80手`、欠測→`41 / 80手` (評価 `—`・`候補手はまだありません`・`解析 39 / 81` 表示、混同しないこと確認)。
- ply67 → `後手・3手詰め ›` バッジ → 詰め手順 (通常mateと詰み終局を区別)。
- 縦スワイプ (上/下) → ページスクロールのみ・マーカー不変 = ドラッグキャンセル相当を確認。
- 分岐: ply67 候補1 → `分岐検討` で評価グラフ非表示 (`assertNotVisible evaluation-chart`) = 本譜と分離。`本譜に戻る` → `67 / 80手` 復元。
- `fixtures/analysis/positions.json`: `cargo test` 24/24 + 上記 in-flow assert で終局の正負・欠測・候補なしを確認。

## 3. 発見事項

### PR12-IOS-1 [high/製品バグ] iOS 26+ で評価グラフの横ドラッグが画面popに奪われる
- **原因**: react-native-screens ~4.26 `RNSScreen.mm` `isFullScreenSwipeEffectivelyEnabled` が `RNSOptionalBooleanUndefined` で iOS 26+ なら `YES` を返す (fullscreen swipe-back が既定ON)。expo-router NativeStack は `vertical` 以外では `fullScreenGestureEnabled` を立てず、`game/[id]` (card/horizontal) は screens 既定を継承 → 画面内どこからの横ドラッグも interactive pop が先に獲得し、チャート PanResponder に release が届かない。
- **画面**: `game/[id]` 解析画面・評価グラフ。
- **再現** (実Simulator GUI操作・録画): グラフ上を水平ドラッグ → `本譜 N手目` readout が一瞬出る → そのまま横移動で画面自体が右へスライドしライブラリが覗く → しきい値超えて離すとライブラリまで pop。~50pt の短いドラッグでも pop することを確認。
- **影響**: 「横ドラッグ中の本譜評価ラベル」「離した位置への一度の移動」が iOS 26+ 実ユーザーに届かない (選択確定できない)。**タップ選択は正常** (16%→ply0 / 56%→ply40 / 96%→ply80、`chartIndexAtX` 端クランプ込み)。
- **最小修正案**: `app/_layout.tsx` `Stack.Screen name="game/[id]"` に `fullScreenGestureEnabled: false` (製品修正はMain担当のため私は未着手)。
- **evidence**: `pr12/graph-drag-gui.mov` (82s), `pr12/graph-drag-gui2.mov` (68s), `pr12/frame-*.png`。

### PR12-IOS-2 [low/cosmetic] OS 最大文字で詰め手順モーダルの `0 / 3手` カウンタが右端ではみ出す
- iPhone 17e + accessibility-extra-large。タイトル `3手詰め` の横のカウンタが画面端で切れる (a11y 上は存在し機能は動作)。`手順を再生` ボタンの文字も折返し。`pr12/layout/iphone17e/.../layout-05-mate-modal.png`。

### PR12-IOS-3 [info/制約] Files 保存ブラウザ (RemoteUI) は automation 下で提示されない
- 「Save to Files をタップ」は実施済みだが保存先選択 UI は出ず (iOS 27 制約)。export バイト列一致は別経路で検証済み。遷移先 UI は未確認。

## 4. 動画レビュー
- 保存した全録画を通常速度で通覧し、遷移/keyboard/戻る/graph gesture はコマ送り相当 (ffmpeg フレーム抽出 `pr12/frames-review/`, `pr12/frame-*.png`) でも確認。
- `suite/final-run/flow.mp4` は suite 一連 (h264 再圧縮, 元は simctl hevc)。`pr12/*` は各 PR 固有フロー。

## 5. 未確認 / 制約
- Files 保存先 UI 遷移先 (RemoteUI)。export バイト一致は検証済み。
- 横ドラッグのスクラブ・選択確定 (製品バグ PR12-IOS-1)。タップ経路は全確認済み。
- 実機性能・FPS・実機���の熱量等: シミュレータのみ。計測していないため「達成」とは扱わない。
- Pixel 相当端末・Android 側: iOS のみ担当 (別担当者が実施)。

## 6. 検証フロー差分
`verify/pr12-ios-flows` (最終 `f7458ea`)。全て受入フローの修正のみ、製品コード無変更:
- composite a11y label への `'.*….*'` ラッパマッチ (b585b67, f40cbfe, 412ee1e)
- in-app action-sheet の落ち着き待ち (4b269b0, 799ea82)
- Files picker のアイコンタップ (f1f7d31)
- favorite トグル settle+DB 検証 (a87c329)
- hideKeyboard→中立タップ (d415bea)
- export-review-ios: RemoteUI フォールバック + `Library/Caches` byte-compare (2fbb907)
- pr12 フロー: 候補分岐・駒セット・レイアウト (3571382, 5240ecb, e9471e4)
- game 画面は push で tab bar 非表示 → `戻る` で pop してから `設定` tab へ遷移し `.*KeroPona.*` で再進入 (f7458ea)
- `recordVideo -f` (rerun 時に古い動画を残さない) (f7458ea)
