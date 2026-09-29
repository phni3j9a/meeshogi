# Issue #22 受入 — Cloud 共存

この文書は当時の受入記録。通常の変更に必要な検証は [DEVELOPMENT.md](DEVELOPMENT.md) に従い、この全手順や証拠ブランチ運用を繰り返す必要はない。

動画・大量ログを保持していたevidenceブランチは2026-09-30に削除した。以下のブランチ名・run IDは過去の実行を識別する記録であり、取得先ではない。結果の要約は本書と [PR #31](https://github.com/phni3j9a/meeshogi/pull/31)・[PR #32](https://github.com/phni3j9a/meeshogi/pull/32) に残す。

Issue #22「Sekirei と Cloud（Free / Precision）の一時共存」の受入手順・証跡の取り方と、
focused run・最終候補 `7d35caa` での両OSの受入結果。

## ビルド条件

受入用 Release ビルドには次の2つが必要（bundler 時点で埋め込まれる）:

- `EXPO_PUBLIC_CLOUD_ENDPOINT` = staging base URL。**値は公開リポジトリ・evidence
  ブランチ・レポートへ書かない**。committed な資料では `<staging>` と表記する。
- `EXPO_PUBLIC_ENABLE_ANALYSIS_EXPORT=1` — 開発用の比較レポート書き出しを有効にする。

Issue #34以降、開発専用stagingの既定はFree回数制限なし・Precision個別許可不要。同時active 1は維持する。以下のIssue #22の過去受入は、Free 5 job/owner/JST日・Precision allowlist有効時の記録。`cloud-precision-denied`を再実行する場合は、事前にWorkerの`JOBS_REQUIRE_PRECISION_ALLOWLIST`を`"true"`へ戻してdeployし、対象ownerを非許可にする。通常の開発設定では`cloud-precision-denied`を選ばず、`cloud-precision-run`を個別許可なしで実行する。Free quotaの再検証には`JOBS_ENFORCE_FREE_QUOTAS="true"`も必要。詳しくは[設定手順](../cloud/README.md#development-staging-access-issue-34)を参照。

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
`cloud-free-start` の直後に走る。実行するステップと順序は `CLOUD_INTERRUPTION_STEPS`
（既定 `bg,kill,net`）で選べ、`net` 単独指定も可能（job 開始直後に遮断するため、
判定の基準は必ず各ステップ直前の snapshot を取り直す）。`<run_dir>/cloud/` に次を残す:

- `s00-before.txt` などの `cloud_attempts` スナップショット（`endpoint` 列は意図的に
  除外し hostname を証跡へ入れない。credential は SecureStore で SQLite に無い）
- `summary.txt` — 判定行と末尾の `RESULT bg=…` / `RESULT kill=…` / `RESULT net=…`
  （PASS / FAIL / UNVERIFIED / SKIPPED。選択したステップで PASS 以外があれば
  スクリプトは非ゼロ終了）
- 各時点の端末 screenshot（`sXX-*.png`）

中断の作り方:

- background: Android `input keyevent KEYCODE_HOME` / iOS `simctl openurl` で Safari を
  前面へ → AppState の `pauseCloudJobs` がポンプを止める（server は継続）
- kill: `am force-stop` / `simctl terminate` → 再起動で永続 attempt から resume
- 通信遮断（`net` ステップ）:
  - 遮断直前に `s29-precut` を取り、`job_id` 既知・ローカル `status` 非終端・
    `server_status` が `queued`/`running` の3条件を満たさなければ
    `NETCUT_UNVERIFIED` を出して**遮断せず非ゼロ終了**（終端済み・job未作成への
    遮断は証拠にならない）
  - Android: `svc wifi disable` + `svc data disable` + airplane mode。遮断は emulator
    からの `ping 8.8.8.8` 失敗で実証
  - iOS: 実機相当の遮断は host でやるしかない。`CLOUD_ENDPOINT` の A/AAAA を解決し、
    IPv4 は `inet`・IPv6 は `inet6` で `proto { tcp udp }` の `pf` block を専用 anchor
    `com.apple/meeshogi-netcut` に立てる（passwordless sudo 必須。passwordless sudo が
    なければ `SKIPPED` と明記して中断しない）。許可する baseline を狭く定義し、
    どれでもない場合は pf を一切触らず `SKIPPED`・非ゼロ:
    - まず変更前に `pfctl -s rules` / `pfctl -s info` で baseline を取得。**両クエリが
      exit 0** で、Status 行の直後の状態語が `Enabled`/`Disabled` に読めた場合のみ
      続行（query 失敗・状態語不明は何も変更せず `SKIPPED` — 空出力を「ruleset 空」と
      誤認して host ルールを上書きしない。経過時間 `for 0 days …`・`Debug:` 欄は
      状態語の抽出・比較から除外する）
    - (a) main ruleset に `anchor "com.apple/*"` 等の参照が既にある → anchor だけ使う
    - (b) main ruleset が**query 成功かつ空**（実測: Devin VM は PF 無効・main 空で
      起動する）→ `anchor "com.apple/meeshogi-netcut"` 1行だけの一時 main ruleset を
      `pfctl -f` で読み、復旧時に main を空へ戻す
    - (c) それ以外（非空で参照なし等）→ `SKIPPED`。`/etc/pf.conf` の全量読み込みや
      `pfctl -F all` / `-d` は行わない
    有効化は `pfctl -E` の token を stdout/stderr 両方から捕捉して保持する。責任の
    記録は外部コマンドの**実行前**（`pf_ref_state`=`none`/`held:<token>`/`unknown`、
    `pf_main_loaded`、`pf_anchor_loaded`）で、signal・部分失敗でも解除経路が残るよう
    解除コマンドが成功したときだけ消す（各解除は冪等で EXIT trap が再試行する）。
    `-E` 異常終了や token 未取得は `unknown` のまま扱い、「参照なし」と推定しない。
    復旧は `pfctl -a <anchor> -F rules`・(b) の場合 main の `-F rules`・
    `pfctl -X <token>` に限定する。復旧後の `-s rules`/`-s info` も exit 0 と状態語を
    確認し、query 失敗は「復旧確認不能」= `CLEANUP_FAIL`（成功扱いしない）。main は
    (b) なら空・(a) なら baseline と同一内容であること、Status が baseline 状態語と
    一致することを確認して `pf restored to baseline` を記録。`unknown` 状態のまま
    Status が baseline と違っていれば `CLEANUP_FAIL: pf reference not released
    (token unknown)` を記録して非ゼロ（`pfctl -d` や全体 flush で代用しない）。
    endpoint への curl 失敗と github.com への curl 成功は targeted cut の補助証拠
    として記録するが、**最終判定はアプリ側の DB 観測が正**とする
  - 遮断中に `s30a-cut-start` と `s30-netcut` を取り、attempt_id・job_id・行数が
    s29 と一致し、`received_count` が両点で整数として同値、かつ `last_error` が
    遮断中に**新たに**立ったことが PASS の前提。判定で使う全項目
    （status・server_status・job_id・attempt_id・received_count・last_error 分類・
    updated_at）は parser の欠落値 `-` / NULL を明示的に拒否し、欠けていれば
    `NETCUT_UNVERIFIED`。エラーの新規性は「s29 で last_error 未設定 → 遮断中に
    transport 出現」を主根拠とし、s29 に既に**同じ transport エラー**がある場合は
    `updated_at` 前進だけでは新規とみなさず `NETCUT_UNVERIFIED`（別種別の古い
    エラー→transport は `updated_at` 前進で新規と判定）。
    判定はアプリの transport 失敗文言 `Cloudサーバーへ接続できませんでした。` または
    dev ビルドの `Cloudサーバーへ接続できませんでした。（network）` への**完全一致**
    でのみ成立（prefix 一致・任意 suffix 付きは他分類）。summary には文言の値ではなく
    分類（transport/http/other/none）のみ記録し、hostname を含む生エラー文は
    証跡へ書かない。遮断中にサーバー応答由来のエラー（503 等）が記録されれば接続が
    生きていた証拠として `NETCUT_FAIL`、受信増加・終端到達も `NETCUT_FAIL`、
    エラーが古い/不明なら `NETCUT_UNVERIFIED`
  - 復帰後は最大 `CLOUD_RESUME_WAIT` 秒（既定120s）ポーリングし、同一 attempt_id・
    job_id・attempt 数不変・`received_count` が s30 より増加（または server_status 終端
    かつ受信数 ≥ s30）を確認。PASS 判定に使った検証済み snapshot 自体を
    `s31-restored` として保存し、全必須項目の存在・identity・行数・受信増加を
    再検証する（再取得値を信用しない）。`s31-restored` の保存失敗や再検証不一致は
    cut 判定への fallback をせず必ず非 PASS・非ゼロ終了。`server_next_ply` の前進は
    s29→s30 の遮断区間として記録
  - 中断・異常終了の後始末: EXIT/INT/TERM/HUP trap で net 遮断状態（Android radio・
    iOS pf anchor + enable 参照 + 一時 main ruleset）を必ず復旧に向かわせ、
    復旧コマンドの失敗は `CLEANUP_FAIL` として非ゼロ終了（警告で流さない）
  - 遮断中の snapshot の `last_error` に `Cloudサーバーへ接続できませんでした` が
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
| 中断耐性（bg/fg・kill/relaunch） | PASS — 同一 `job_id`・attempt 数不変・受信結果保持。通信遮断はこの run では job 完了後に行われており証拠にならない（FP-021、下記の再実施で判定） |
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
| 中断耐性（bg/fg・kill/relaunch） | PASS — 同一 job_id・attempt 数不変。旧スクリプトの pf 遮断（TCP・A レコードのみ）はアプリの受信を止められておらず（遮断中も受信 19→33）、通信遮断の証拠にならない（FP-021、下記の再実施で判定） |
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
| 中断耐性（Free job `job_72c9dd0f…`） | bg/fg・kill/relaunch は PASS（同一 `job_id`・attempt 数 1、受信 45→81）。通信遮断は kill→relaunch の時点で job が完了済みだったため**未検証**（FP-021、下記の再実施で PASS） |
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
| 中断耐性（Free job `job_f9fbd55f…`） | bg/fg・kill/relaunch は PASS（同一 `job_id`・attempt 数 1、受信 33→47）。通信遮断は旧 pf ルールが効かず遮断中も受信 47→81 と進んだため**未検証**（FP-021、下記の再実施で PASS） |
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

## 通信遮断の再実施（FP-021〜024、製品 `7d35caa` のビルド）

Astra の最終チェックで、上記の通信遮断が「遮断直前に job が進行中」「遮断中にアプリ自身の通信が失敗」
「復帰後に同一 job で受信再開」を確かめていなかったことが判明した（旧判定は全手順開始時の
server_next_ply と比較していた）。判定を遮断直前・遮断中・復帰後の snapshot に基づくよう直し、
iOS の pf を A/AAAA・TCP/UDP（QUIC）に広げて、`CLOUD_INTERRUPTION_STEPS=net CLOUD_NET_WAIT=30` で
job 開始直後に遮断した。その後のレビューで判定の抜け（欠落値・保存失敗・前方一致の文言判定）と
pf 後始末の問題（中断時の残留、token 取得、baseline 取得失敗の誤判定、Status 表示の経過時間）を
直した最終版 `e3df618` で、両OSをもう一度実行した（`netcut2`）。最初の `021ff11` での実行は、
最終版の判定条件（遮断前 server_status 非終端・last_error 未設定、遮断中に transport 文言が新規記録、
同一 attempt/job・1 行、最終 snapshot の検証）で読み直しても成立していることを Main と Reviewer が確認した。

| OS | 遮断直前 s29 | 遮断中 s30a→s30 | 復帰後 s31 | 判定 | 遮断直前 s29 | 遮断中 s30a→s30 | 復帰後 s31 | 判定 |
|---|---|---|---|---|
| Android（`evidence/issue22-android-netcut-20260927`、`job_017ed763…`） | running・受信 1 | 受信 1→1、`last_error` 記録（ping 不通・機内モード表示） | 同一 job・attempt 1・受信 63（server completed） | `RESULT net=PASS` |
| iOS（`evidence/issue22-ios-netcut-20260927`、`job_a8c08a59…`） | running・受信 3 | 受信 3→3、`last_error` 記録（endpoint curl 失敗・github.com 到達） | 同一 job・attempt 1・受信 45 | `RESULT net=PASS` |
| Android 最終版（`evidence/issue22-android-netcut2-20260927`、`job_11cd8100…`） | queued・受信 0 | 受信 0→0、transport エラーを新規記録（ping 不通） | 同一 job・attempt 1・受信 57 | `RESULT net=PASS` |
| iOS 最終版（`evidence/issue22-ios-netcut2-20260927`、`job_c53ce112…`） | running・受信 0 | 受信 0→0、transport エラーを新規記録（endpoint curl 失敗・github.com 到達） | 同一 job・attempt 1・受信 42、`pf restored to baseline (status=Disabled)` | `RESULT net=PASS` |

iOS の pf について実 macOS（Devin VM）で分かったこと: 起動時は Disabled・main ruleset 空で、
`pfctl -E` は main ruleset を読まないため `com.apple/…` anchor は親参照が無いと評価されない。最終版は
この状態に限り `anchor "com.apple/meeshogi-netcut"` 1 行の一時 main を読み、復旧で空に戻す。
`pfctl -E` の `Token :` は stderr に出る。実行前後で `pfctl -s info`（Disabled）と `-s rules`（空）が
一致することを確認した。main ruleset が空でなく参照も無いホストでは、既存ルールを変えずに SKIPPED にする。

遮断中の画面は両OSとも「Cloud解析中」のままで、通信断を示す表示は出ない（エラーは attempt の
`last_error` に記録され、復帰後に自動で受信を再開する）。完了条件は満たすが、利用者への通信断表示は
改善候補として残す。

## 最終候補での扱い（両OS共通）

最終候補 `7d35caa` と前回 run（Android `bd0788b`、iOS `905a907`/`c94f88b`）の製品差分は Cloud の
4xx 拒否処理・日本語メッセージ・iOS keychain entitlement のみ。最終確認では新規 build で既存全フロー・
cloud phase A・修正箇所（403 画面と通常削除）を再実行し（通信遮断は上記の再実施で判定）、Precision 正常系 81/81・3方式 export・
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
