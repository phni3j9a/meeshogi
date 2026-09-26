# Issue #22 受入 — Cloud 共存（ドラフト）

Issue #22「Sekirei と Cloud（Free / Precision）の一時共存」の受入手順と証跡の取り方。
全既存フローを含む最終受入は最終 candidate で別途行う。この文書は focused run と
Cloud 固有証跡の手順だけを扱う。

## ビルド条件

受入用 Release ビルドには次の2つが必要（bundler 時点で埋め込まれる）:

- `EXPO_PUBLIC_CLOUD_ENDPOINT` = staging base URL。**値は公開リポジトリ・evidence
  ブランチ・レポートへ書かない**。committed な資料では `<staging>` と表記する。
- `EXPO_PUBLIC_ENABLE_ANALYSIS_EXPORT=1` — 開発用の比較レポート書き出しを有効にする。

両OSとも「新規 install → credential 発行 → owner 作成」で staging quota を消費する。
Free は 5 job/owner/JST日（cancel 済みも含む）・同時 active 1。

## Flow 選択（両OS共通の追加フロー）

`ACCEPTANCE_FLOWS` に以下を列挙する（cloud-* は opt-in。未指定の既定 suite では
実行されない。licenses-review / import-review は常に先行する）:

| flow | 内容 |
|---|---|
| `cloud-method-picker` | 設定／検討画面の方式 picker。Sekirei 初期値・Cloud 選択が job を作らないこと |
| `cloud-free-start` | Cloud Free 全局 job を開始し running のまま残す |
| `cloud-interruptions` | （Maestro ではなく helper script）background / kill / 通信遮断 → 同一 jobId 復帰 |
| `cloud-free-verify` | 同一 job の完了・グラフ・候補手・PV・通常 mate 表示・詰めバッジ非表示（Sekirei では同一手数でバッジ表示） |
| `cloud-branch-local` | Cloud 選択中の分岐・深掘りが ローカル（Sekirei）表記であること + DB で新規 job なし |
| `cloud-cancel` | 明示取消が server 確認済み `cancelled` になること |
| `cloud-precision-denied` | allowlist 前の Precision が 403 `profile_not_allowed` を表示 |
| `cloud-precision-run` | allowlist 後の Precision job が終端まで進行すること |
| `cloud-export` | 開発メニュー「比較レポートを書き出す」で JSON を出力 |

Android 例:

```bash
ACCEPTANCE_FLOWS="cloud-method-picker,cloud-free-start,cloud-interruptions,cloud-free-verify,cloud-branch-local,cloud-cancel,cloud-precision-denied,cloud-export" \
  bash scripts/ci/android-acceptance.sh
```

iOS 例（full mode が要るのは helper/clipboard 前提ではないが、flow 群自体は visual でも
動く。中断証跡は host 側操作なので mode に無関係）:

```bash
IOS_ACCEPTANCE_MODE=full \
ACCEPTANCE_FLOWS="cloud-method-picker,cloud-free-start,cloud-interruptions,cloud-free-verify,cloud-branch-local,cloud-cancel,cloud-precision-denied,cloud-export" \
  bash scripts/ci/ios-acceptance.sh
```

## 中断証跡の取り方

`scripts/ci/cloud-interruption.sh <android|ios> <run_dir>` が受入スクリプト内で
`cloud-free-start` の直後に走る。`<run_dir>/cloud/` に次を残す:

- `s00-before.txt` などの `cloud_attempts` スナップショット（`endpoint` 列は意図的に
  除外し hostname を証跡へ入れない。credential は SecureStore で SQLite に無い）
- `summary.txt` — jobId 同一性・attempt 数不変・received_count 継続・server_next_ply
  前進の判定行
- 各時点の端末 screenshot（`sXX-*.png`）

中断の作り方:

- background: Android `input keyevent KEYCODE_HOME` / iOS `simctl openurl` で Safari を
  前面へ → AppState の `pauseCloudJobs` がポンプを止める（server は継続）
- kill: `am force-stop` / `simctl terminate` → 再起動で永続 attempt から resume
- 通信遮断:
  - Android: `svc wifi disable` + `svc data disable` + airplane mode。遮断は emulator
    からの `ping 8.8.8.8` 失敗で実証
  - iOS: 実機相当の遮断は host でやるしかない。`CLOUD_ENDPOINT` のホストを解決して
    `pf` に `block drop out quick proto tcp to <ip>` を立てる（passwordless sudo 必須。
    なければ `SKIPPED` と明記して中断しない）。遮断中は endpoint への curl が失敗し、
    github.com への curl が成功することを両方記録して targeted cut を証明
  - 復帰後も同一 `jobId`・`cloud_attempts` 行数不変・server_next_ply 前進を確認。
    遮断中の snapshot の `last_error` に `Cloudサーバーへ接続できませんでした` が
    残ることで「アプリ側が実際に transport 失敗を観測した」証拠にもなる

POST 応答喪失の厳密タイミング（submitAttempted=1 からの冪等 replay）は live では
狙い打てないため focused 単体テスト側で保証済み。ここで検証するのは polling/受信中の
実遮断である。

## 比較 export の回収

- iOS: `xcrun simctl get_app_container <dev> com.meeshogi.app data` の
  `Library/Caches/meeshogi-comparison-<gameId>.json` を `comparison-export.json` として保存
- Android Release は `run-as` 不可のため、CI helper `com.meeshogi.testclipboard` に
  `application/json` の ACTION_SEND を追加済み → `/sdcard/Download/meeshogi-comparison.json`
  を `adb pull`

回収後はローカルで:

```bash
npm run analysis-compare -- comparison-export.json --markdown report.md --json report.json
# hostname / credential が混入していないこと
grep -n 'mcd1_\|<staging-host>' comparison-export.json && exit 1
```

## Precision allowlist（受入 install のみ）

ownerId は `cloud/<label>.txt` snapshot の `owner_id=` から読める（非 secret）。
allowlist は `/home/server/projects/meeshogi/cloud` からのみ、受入 install の
owner に限って実施:

```bash
./node_modules/.bin/wrangler d1 execute meeshogi-jobs-staging --remote \
  --command "UPDATE owners SET precision_allowed = 1 WHERE owner_id = 'own_<24 hex>'"
```

`cloud-precision-denied` は allowlist 前、`cloud-precision-run` は allowlist 後に実行する。

## 残る確認（このドラフト時点で未検証）

- 512手超の棋譜に対する notice（fixture 未整備のため未検証と明記）
- POST 応答喪失タイミングの live 再現（単体テストで代替保証）
- 物理端末での発熱・実 network 環境（emulator/simulator のみ）
