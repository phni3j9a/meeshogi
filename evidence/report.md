# PR #12 Android 再受入レポート — ba6c6df

- 対象 SHA: `ba6c6df839f27394d99061014f13faa3b0b8baee`（`git fetch` → `git reset --hard` で正確に checkout）
- 前回受入 SHA: `7f877a25958fe4cd5c08341271e8c7f0cb00259b`
- 製品差分（前回→今回）: `app/_layout.tsx`（iOS 用 `fullScreenGestureEnabled:false` のみ）、`app/mate.tsx`（手数カウンタ折返し修正）。**`src/ui/charts.tsx` を含む Android 挙動に関わるコードは一切変更なし（byte-identical）**
- 環境: emulator-5554 / AVD `acceptance` / sdk_gphone64_x86_64 / Android 16 / 1080x2400@420dpi。実機は未確認（エミュレータのみ）
- ビルド: 実エンジン Release APK 新規ビルド（Rust 4 ABI）→ `adb install -r` Success → 起動確認（ライブラリ表示、前回データ永続確認）。デモ解析・Web 代替なし
- 検証ブランチ: `verification/pr12-android-fix-20260923`（新規検証スクリプト `scripts/ci/android-vertscroll-check.sh` のみ追加。製品コード変更なし）

## 結果サマリ

| 範囲 | 結果 |
|---|---|
| 既存 suite 15 フロー（`scripts/ci/android-acceptance.sh`） | **15/15 PASS、junit failures 0**（export は `fixtures/kif/shogiwars.kif` と byte 一致） |
| PR12 追加フロー（`android-pr12-checks.sh`） | **7/7 PASS**（piece-sets picker/reflect/persist、mate-terminal sente/gote、cleanup、large-text） |
| graph-check（adb 座標系） | PASS×9 / INFO×2 / WARN×1（WARN の中身は下記） |
| 表示バリアント | 8 枚（default / small / tablet 縦横 × ライブラリ+解析。wm オーバーライド、専用タブレット実機ではない） |

## 主目的 1: グラフ上の縦ドラッグ → ページスクロール

**結論: 製品バグではない（再現せず）。** ba6c6df では、スクロール余地がある画面状態でグラフ上からの縦ドラッグは正しくページをスクロールする。前回「スクロールしない」と報告したのは検証条件のアーティファクトで、製品の差ではない。

同一ジェスチャ（上方向 400px / 400ms、marker=共有 ScrollView 内要素の y-bounds）の比較：

| 条件 | chart_top | 変化量 |
|---|---|---|
| グラフ上から上ドラッグ | 1605 → 1267 | **-338（スクロールする）** |
| グラフ外から同一ドラッグ | 1605 → 1200 | -405 |
| グラフ上から下ドラッグ（スクロール最上端） | 1981 → 1981 | 0（上に余地なし） |
| グラフ外から同下ドラッグ | 1981 → 1981 | 0（同一） |
| 前回シーケンス再現後の上ドラッグ | 1605 → 1301 | スクロールする |

- グラフ上ドラッグがグラフ外より約 65–70px 短いのは、パン判定（`|dx|>7 && |dx|>|dy|*1.3`）が横方向を否定して親 ScrollView へ引き渡すまでの消費分。縦ジェスチャは常に引き渡される。
- **前回との差の根拠**: 前回の graph-check は ply 0 で実行しており、その局面状態ではページ全体がビューポート内に収まる（候補手カードが空、スクロール余地ゼロ）→ 上下どちらも 0。今回 ba6c6df で同一条件を再現すると同じく `1605 → 1605`（今回の pr12-run の graph-check でも同じ WARN が再現）。スクロール余地がある状態（ply 34、候補手・モデル通知あり）では同一ビルドで -338 動く。charts.tsx は両 SHA で byte-identical。

証拠: `evidence/vertscroll/`（`vertscroll.mp4`、開始/終了 PNG `vs-00`〜`vs-07`、`results.txt`、`results-extra.txt`）

## 主目的 2: 横ドラッグ読み出し・離し確定・タップ・キャンセル

- 端タップ: 左端 → ply 0、右端 → ply 80
- 横ドラッグ中読み出し: `本譜 27手目 +41` バブル表示、カウンタは 80/80 のまま（プレビューは未確定）— `sc-03-scrub-mid.png`、`scrub.mp4`
- 離した位置への確定: x60% で離し → ply 44（期待 ~47、合成スワイプのサンプリング粒度内）、1 回だけ確定
- タップ選択: x75% → ply 58（期待 ~60）
- キャンセル/同一位置確定: 往復スクラブで同一 index に戻して離す → 58 のまま（余分な遷移なし）、左端外リリースは 0 にクランプ
- 縦ドラッグのスクラブキャンセル: `graph-vertical-no-move` PASS（縦ドラッグで手数は変わらない）

## 主目的 3: mate.tsx 手数表示（OS 大文字）

font_scale=1.3 で詰め手順画面を開き、カウンタ `0 / 1手` → `1 / 1手` の両状態で右端欠けなしを確認（bounds x860–1028 < 1080、右余白 ~52px）。タイトル `1手詰め`・出典 `26手目の局面`・`先手が詰ませられます`・代表手順 `▲４一桂成 詰み` ・持駒表示も正常。証拠: `evidence/vertscroll/mate-large-{1,2,3}.png`

回帰（全て PASS、スクリーンショットは pr12 ビデオ/スクリーンショット内）:
- 4 駒セットのプレビュー/選択 → 盤・持駒・反転・詰み手順への反映（piece-sets-picker/reflect）
- kill/relaunch 後の選択保持（piece-sets-persist）
- 先手/後手の詰み終局表示（mate-terminal-sente/gote）
- 盤反転は reflect フロー内で両向き撮影済み

## 未確認・制約

- 実機未確認（エミュレータのみ）。FPS・実機性能は未測定
- OS 起因の真のジェスチャキャンセルは合成 input では不可。縦ドラッグキャンセルで代替確認
- tablet は `wm size/density` オーバーライドでの代替確認

## 発見事項

製品バグなし。Main への情報: graph-check の `graph-vertical-page-scroll` WARN は「その時点のページ状態にスクロール余地がない」と計測される条件依存のもの（ply 0 でページがビューポート内に収まる）。将来のフロー修正としては「スクロール余地がある状態で計測する」か、本件のように手動比較で確認するのが正しい。

## 実行区分

- スクリプト自動成功: suite 15 フロー、pr12 maestro 7 フロー、graph-check（WARN はフロー内計測、失敗ではない）
- 手動 helper 操作: 縦スクロール対照実験・スクラブ計測・mate 大文字撮影（`android-vertscroll-check.sh` + adb 直叩き、`evidence/vertscroll/`）

## evidence パス

- `evidence/suite/` — run `20260923T141103Z-23840`: junit 15 件、各フロー screenshots/logs、`videos/`、`exported.kifu`、logcat
- `evidence/pr12/` — run `20260923T143118Z-34182`: junit 7 件、graph-check PNG/results、`display-variants/` 8 枚、`videos/`、logcat
- `evidence/vertscroll/` — 主目的 1–3 の手動計測一式（動画 2 本含む）
- `summary.json` — 機械可読サマリ
