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

## 実施済み結果（Android focused run、candidate e6db45f 相当の製品コード）

`evidence/issue22-android-20260927`（AVD emulator、Android 16、Release build）。

| 項目 | 結果 |
|---|---|
| 方式 picker（設定・検討）・Sekirei 既定・切替で job 非発行 | PASS（DB `cloud_attempts` が切替前後とも 0 行） |
| Cloud Free 開始・進行・完了 UI | PASS（job 複数、81/81 完走を確認） |
| 中断耐性（bg/fg・kill/relaunch・実通信遮断+復帰） | PASS — 全 step で同一 `job_id`・attempt 数不変・受信結果保持。遮断は `ping 8.8.8.8` 不通で実証 |
| 完了後のグラフ・候補・PV・通常 mate 表示 | PASS |
| Cloud 選択中の証明詰めバッジ非表示 | PASS — ply 53 で Cloud は `-M1` のみ、同一 ply で Sekirei は `後手・1手詰め ›` |
| 分岐・深掘りがローカル Sekirei | PASS（`分岐の解析結果（ローカル・Sekirei）` 等、DB に新規 cloud job なし） |
| 明示取消 | PASS（live 中に取消 → server `cancelled`、受信 2 ply） |
| Precision allowlist 前 403 | PASS（`profile_not_allowed` + Notice + 再試行） |
| Precision allowlist 後 正常系 | PASS 6m04s（`job_daef4ff5b3a6d21bd5a1a47e`、81/81、owner `own_4129c89c73a30cd4b170f75b`） |
| 3方式 export + analysis-compare | PASS — `meeshogi-comparison-3methods.json`（232KB）は同一棋譜の sekirei/cloud-free/cloud-precision を収録 |

観測（Issue #24 判断材料）: この端末で Sekirei 全局解析は `65/81` で partial 終了
（16 局面が恒久的な探索量不足）、Cloud Free/Precision は `81/81` 完走。

## 実施済み結果（iOS focused run、product `e6db45f`+`c94f88b` SecureStore entitlement 修正）

`evidence/issue22-ios-20260927`（iPhone 18 Pro Simulator、iOS 27.0、Release-iphonesimulator）。
全既存フロー 33/33 PASS + cloud phase A 7/7 PASS + phase B（precision-run・3方式 export・健全 job 中断）実施済み。

| 項目 | 結果 |
|---|---|
| 方式 picker・Sekirei 既定・切替で job 非発行 | PASS |
| Cloud Free 開始・進行・完了 UI | PASS（`job_88f7c806…` 81/81 完走） |
| 明示取消 | PASS（live 中 `job_f290c653…` → server cancelled、受信 5 ply） |
| 中断耐性（bg/fg・kill/relaunch・pf netcut 60s） | PASS — 同一 job_id・attempt 数不変。**健全 Precision job では遮断中に server_next_ply 1→37 が進行し、復帰後受信継続→完走 78/78**（Android で未観測だった「中断中の server 側進行」をこちらで実証）。pf による endpoint 限定遮断は curl fail+github.com OK で検証済み |
| 完了後のグラフ・候補・PV・通常 mate 表示・Cloud での詰めバッジ非表示/Sekirei で表示 | PASS（ply 53 A/B 両者スクリーンショット確認済み） |
| 分岐・深掘りがローカル Sekirei | PASS |
| Precision allowlist 前 403 | PASS（`profile_not_allowed` + Notice + `Cloud解析を再試行`） |
| Precision allowlist 後 正常系 | PASS（`job_b3bee287…` 81/81 完走。ただし flow の `cloud-start` タップは stale-a11y-frame の harness 問題で未着火 — job 開始は手動 GUI タップ、完了 assert はフローで検証） |
| 3方式 export + analysis-compare | PASS — `comparison-export.json`（232KB、81 plies、sekirei+cloud-free+cloud-precision、両 Cloud profile の engine identity 全 SHA 付き） |
| Free 日次 quota | 実測 — 6 件目の Free job が `daily_quota_exceeded`（5/owner/day が機能） |

iOS 固有の発見:
- **製品修正 `c94f88b`**: adhoc 署名の simulator ビルドは entitlement 空で SecItem が `errSecMissingEntitlement` → cloud credential が読めず全 cloud flow が不可。`app.json` に `keychain-access-groups` を追加して解消（製品ブランチ側の修正）。
- harness（フロー側）: XCTest は footer 下の ScrollView 子を a11y tree に残すため scrollUntilVisible が無効化 → `platform: iOS` の実スワイプで対応（`ede2195`）。`simctl openurl` は「Open in meeshogi?」consent ダイアログを残すため `simctl launch` に変更（`2230bba`）。複合 a11y ラベルには `.*` matcher（`bd0788b`）。
- `retry_exhausted` は staging 既知 Issue #29（cancel 直後 ~30-40s の次 Free job が 0手目失敗）に該当 — app 起因でないことを双方の run で確認。

### 運用注意（run で判明）

- `import-review.yaml` の `clearState: true`（と reinstall）は SecureStore の
  credential を wipe し install_id/owner_id が再生成される。precision allowlist は
  owner 単位なので、phase B は **reinstall/clearState なし・同一 owner で** 実行する。
- staging の Free job は busy 時に `retry_exhausted` になり得る（cancelled job の
  drain と競合したとみられる一過性）。UI は正しく失敗+再試行 affordance を表示。
- RN の header/ActionSheet: 大量 cloud 結果の同期再描画中は a11y ノード tap が
  onPress を発火しないことがあり、Modal mount も遅延する。`cloud-export` は
  座標 tap + 長め待機で安定化済み。

## 残る確認（このドラフト時点で未検証）

- 512手超の棋譜に対する notice（fixture 未整備のため未検証と明記）
- POST 応答喪失タイミングの live 再現（単体テストで代替保証）
- 物理端末での発熱・実 network 環境（emulator/simulator のみ）
- Android 側で「中断中に server が進行する」姿の再実施（iOS では
  interruptions-precision で server_next_ply 1→37 を実証済み。
  Android は対象 job が Issue #29 の retry_exhausted に当たり未観測）
