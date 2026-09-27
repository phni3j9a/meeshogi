# Issue #22 受入 — Cloud 共存

Issue #22「Sekirei と Cloud（Free / Precision）の一時共存」の受入手順・証跡の取り方と、
focused run・最終候補 `7d35caa` での両OSの受入結果。

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

2026-09-27 の受入で allowlist した test owner（解除していない）: `own_9c6f1db0cca5fa3b441bfe41`、
`own_4ab3475df041bba085c20ce8`、`own_1035ee920b4da452c3846291`、`own_046c9799647cba629d12a08c`、
`own_4129c89c73a30cd4b170f75b`、`own_8ed94592f7ddc4be4ad0abdc`（iOS）、`own_910abdfc3c3d76485bc3e917`（Android）。

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

## 実施済み結果（Android 最終候補 `7d35caa`）

`evidence/issue22-android-final2-20260927`（AVD emulator、Android 16、新規 Release build・新規 install）。

| 項目 | 結果 |
|---|---|
| 既存全フロー suite | 15/15 PASS |
| cloud phase A（method-picker・cancel／free-start・interruptions・free-verify・branch-local・precision-denied） | 7/7 PASS。part1→part2 間に 90 秒待ち（#29 回避） |
| 中断耐性（健全 Free job `job_72c9dd0f…`） | PASS — bg/fg・kill/relaunch・実通信遮断 60s で同一 `job_id`・attempt 数 1 のまま。**遮断中に server_next_ply 0→81 が進行**し、復帰後に 81/81 受信 |
| Precision 403 画面（FP-017/018 修正確認） | PASS — 日本語「精密解析はこの端末では利用できません（サーバー側の許可が必要です）。」、`Cloud解析を再試行` あり、`中断した解析を取消` なし。DB は `server_status=not_created` |
| 403 拒否後の通常削除（FP-017/019/020 修正確認） | PASS — 確認ダイアログは通常の「棋譜を削除しますか？」のみ（`ローカルだけ削除` なし）、削除後の `cloud_attempts` は 0 行 |
| フロー修正・製品不具合疑い | なし |

観測: この fixture の Free 結果は ply 37 のみ `incomplete`（受信 81・有効 80）。UI は「有効80/81」と表示し、
欠測をゼロ評価や完了扱いにしていない（前回 run と同じ挙動）。

## 実施済み結果（iOS 最終候補 `7d35caa`）

`evidence/issue22-ios-final2-20260927`（iPhone 18 Pro Simulator、iOS 27.0、新規 Release-iphonesimulator build、adhoc 署名）。

| 項目 | 結果 |
|---|---|
| 既存全フロー suite（`IOS_ACCEPTANCE_MODE=full`） | 15/15 PASS |
| cloud phase A | 7/7 PASS（branch-local は下記フロー修正後） |
| 中断耐性（健全 Free job `job_f9fbd55f…`） | PASS — bg/fg・kill/relaunch・pf による endpoint 限定遮断 45s で同一 `job_id`・attempt 数 1 のまま。**遮断中に server_next_ply 0→81 が進行**し、復帰後に 81/81 受信 |
| 明示取消 | PASS（`job_ac5432dc…` → server `cancelled`） |
| Cloud 選択中の分岐・深掘り | PASS — `分岐の評価・ローカル`・`分岐の解析結果（ローカル・Sekirei）`・`この局面を深く解析（ローカル・Sekirei）` |
| Precision 403 画面（FP-017/018） | PASS — 日本語メッセージ、`Cloud解析を再試行` あり、取消ボタンなし、`server_status=not_created` |
| 403 拒否後の通常削除（FP-017/019/020） | PASS — 通常の確認ダイアログのみ、削除後 `cloud_attempts` 0 行 |
| quota 拒否（429 `daily_quota_exceeded`）時の表示 | 旧 owner で偶発的に観測 — 日本語メッセージ・`not_created`・取消ボタンなし |

フロー修正（製品コード非変更）: `cloud-branch-local` の iOS 経路は、対局画面の方式行が完了 job
レイアウトで ScrollView 深部にあり synthesized tap が発火しないため、設定画面の picker で方式を
選ぶよう変更した（手動タップでは正常に開く）。Android の手順は同じコマンドを `platform: Android`
ブロックへ移しただけで、この変更後の Android 再実行はしていない。

iOS 固有の観測:
- **Keychain は app uninstall 後も残る**。再 install すると `install_id` は新しくなるが、SecureStore の
  credential が再利用され同じ owner になる（再 install で Free quota はリセットされない）。受入で新しい
  owner が要る場合は `xcrun simctl keychain <UDID> reset` を uninstall 後に行う。
- `CODE_SIGNING_ALLOWED=NO` のビルドは entitlement が埋め込まれず SecureStore が `KeyChainException`
  になる。受入ビルドは `CODE_SIGN_IDENTITY=-`（adhoc）で行う。

## 最終候補での扱い（両OS共通）

最終候補 `7d35caa` と前回 run（Android `bd0788b`、iOS `905a907`/`c94f88b`）の製品差分は Cloud の
4xx 拒否処理・日本語メッセージ・iOS keychain entitlement のみ。最終確認では新規 build で既存全フロー・
cloud phase A・修正箇所（403 画面と通常削除）を再実行し、Precision 正常系 81/81・3方式 export・
比較レポートは前回 run の証跡を引き継ぐ（該当コードは差分に含まれない）。

## 残る確認（未検証）

- 512手超の棋譜に対する notice（fixture 未整備のため未検証）
- POST 応答喪失タイミングの live 再現（単体テストで代替保証）
- 物理端末での発熱・実 network 環境（emulator/simulator のみ）
- 最終候補で変更したフロー（iOS 方式選択経路）の Android 側再実行
- iOS の `cloud-precision-run` の job 開始タップ・`cloud-export` 末尾 assert は harness 側の a11y
  タイミング問題で手動 GUI 操作・目視確認で補った（フロー自体の自動化は未完）
- Android の `cloud-export` は共有先の選択でフローが止まり、export は手動回収
- staging 側の既知問題: cancel 直後の次 Free job が `retry_exhausted` になる（#29）、
  standard-3 / singleton container が sleepAfter 後も停止しない（#30）。いずれもアプリ起因ではない
