# Issue #29 / #36: 取消直後のjob失敗とPvInterval

対象はstaging Worker `meeshogi-analysis-mvp-staging`（production serviceではない）。2026-09-28に、取消直後の次jobが`retry_exhausted`になる問題（#29）と、短時間探索でエンジンの最終行がboundになり`incomplete`になる問題（#36）を修正した。Free / Precisionの探索条件、利用制限、Queue・Containerの構成は変えていない。

## #29 取消直後の次jobの失敗

### 原因

- Free / Precisionの各Containerはsingletonで、driverは1件のbusy guardを持つ。consumerがjobの取消を知るのは次の結果commitが失敗したときで、その後fetchをabortして終了する。
- 本番経路では、consumerがabortしてもdriverの`/session`は止まらなかった。driverが切断に気付くのは結果の書き込みに失敗したときだけで、Cloudflareのproxyがcontainer側の接続を保ったままでは失敗しない。取り残されたsessionはsessionの期限まで解析を続け、busy guardを持ち続ける。
- 次のjobの`/session`は409 busyになり、consumerは待ち時間なしで`message.retry()`していた。最大4回の配送が数秒で尽き、0手目のまま`retry_exhausted`になった。
- 根拠は、D1の時系列（#29本文：取消から30秒後に作ったjobが12〜19秒で失敗）と、#37の検討中に起きたPrecisionの事象である。Precisionでは、Cloudflare側の内部エラーでconsumerのsessionが例外終了した後、再試行と後続jobの`/session`がすべて409になった。Containerのアイドル停止を待つと回復した。後者は#30のabort修正後に起きており、abortだけではdriverが止まらないと判断した。proxyが接続を保つ仕組みそのものは確認していない。

### 修正

- driver: sessionごとに`sessionId`を発行し、session headerに入れる。`POST /session/cancel {"sessionId"}`は、一致する実行中のsessionの探索を中断してエンジンを回収し、応答ソケットを閉じる。
- driver: 新しい`/session`が来たときにsessionが残っていれば、そのsessionを取り残されたものとして中断し、busyの解放を最大10秒待ってから開始する（supersede）。Queue consumerは`max_concurrency: 1`なので、consumerが新しいsessionを開くときに残っているsessionの持ち主はもう動いていない。`/analyze`・`/benchmark`がbusyを持つ場合は中断せず、従来どおり409を返す。
- consumer: driverの`end`行を受け取らずにsessionを離れるとき（取消検知、期限、例外、契約違反）は、headerの`sessionId`で`/session/cancel`を送る。この送信は最大5秒で打ち切り、失敗してもjobの結果は変えない。応答は#30の規則どおり必ず解放する。
- consumer: Queueの再配送に遅延を入れる（`retryDelaySeconds` 10秒 × 配送回数。10・20・30秒）。回数は従来どおり最大3回。
- driverの`/health`に`sessions`（active・started・cancelled・preempted）を追加した。
- `sessionId`がない旧imageのheaderも受け付ける。新imageで旧Workerを動かす場合、追加されたheaderの項目は無視される。

### Staging受入（2026-09-28 UTC）

commit `8e46077`、image `sha256:876f0ab9…4c541791`（build `a8274854…`）。デプロイ直前はD1のactive jobが0件、両instanceがinactiveだった。デプロイ直後の`/internal/health`は旧build `2e01f7f1…`を返した。instanceは破棄せず、要求を送らずに約6分待つと新buildに変わった。#30で記録した「デプロイ直後の旧image」と同じ事象である。

取消APIが`cancelled`を返した直後（0.1ms未満）に、同じownerで次jobのPOSTを送った。作成応答はPOST送信の約0.6秒後に返った。

| 試行 | 取消したjob（取消時の完了局面） | 次job | 次jobの作成から完了まで |
| --- | --- | --- | --- |
| Free 1 | 43局面中3 | 27/27 success | 31.6秒 |
| Free 2 | 43局面中3 | 27/27 success | 30.9秒 |
| Free 3 | 43局面中3 | 27/27 success | 30.4秒 |
| Precision | 43局面中1 | 5/5 success | 32.4秒 |

- Freeの各試行で、driverの`sessions.cancelled`は1ずつ増え、`preempted`は0のままだった。取消後のsessionは、consumerの`/session/cancel`で次jobより前に止まっていた。
- Precisionには`/health`の経路がないため、カウンタは見ていない。次jobは32秒（5局面×5秒＋起動）で終わり、再配送の遅延を挟んだ形跡はない。取消したsessionが次jobより前に止まったと判断した。
- supersedeは実環境では発動していない。driverの実HTTPテストと、consumerのテスト（busyのfake driverに対する取消後の次job）で検証した。
- 試行後、約6分間要求を送らずにおくと両instanceがinactiveになり、D1のactive jobは0件になった。

### Quota

利用制限を有効にした場合、FreeのJST日次上限は、状態（完了・取消・失敗）にかかわらず作成したjobを数える（`jobs.jst_day`の件数）。今回の修正で、取消直後の次jobが失敗して枠を消費する事象は起きなくなる。サーバー起因の失敗を枠から除くかどうかは本番の利用条件（#34）で決める。開発stagingは現在上限を無効にしている。

## #36 PvInterval 0

### 変更

driverはエンジン起動時に`PvInterval`を必須optionとして確認し、`setoption name PvInterval value 0`を送る。`/session`・`/analyze`・`/benchmark`のすべてに適用する。image build時のUSI smokeにも同じ設定を加えた。Issue #20のbenchmark結果は既定値（300ms）で測ったものである。

### ホストでの比較（出力量・driver負荷）

非公開の同じエンジン・モデルをホスト（Core i5-8500B）で直接動かし、driverと同じoptionで`cloud/bench/dataset/positions.json`の公開20局面を比べた。1局面あたりの値で、`MultiPvCollector`の処理時間だけを測った。

| 条件 | PvInterval | incomplete | info行（中央値/最大） | バイト（最大） | 解析処理ms（最大） | 完了深さ中央値 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Free 1000ms・MultiPV 2 | 300 | 1/20 | 6 / 8 | 1,517 | 0.23 | 17 |
| Free 1000ms・MultiPV 2 | 0 | 0/20 | 36 / 60 | 10,104 | 1.6 | 16.5 |
| Precision 5000ms・Threads 2・MultiPV 3 | 300 | 0/20 | 21 / 33 | 6,649 | 0.81 | 20.5 |
| Precision 5000ms・Threads 2・MultiPV 3 | 0 | 0/20 | 66 / 123 | 18,257 | 2.8 | 20.5 |

- Precisionのinfo行は約3倍になるが、1局面18KB以下、処理3ms以下で、探索時間（5秒）に対して無視できる。再計測で、打ち切り時のnodes中央値は6,574,572（300）と6,574,274（0）で変わらなかった。
- info行はdriverの中だけで処理する。Workerに届くのは局面ごとの結果1行で、Workerの処理量は変わらない。

### Staging（同じ実戦3局、変更前2回・変更後1回）

棋譜は[解析方式の比較検討](ANALYSIS-METHOD-STUDY.md)と同じ非公開の3局で、D1に保存済みの入力を別の検証ownerで再投入した。値は終局以外の局面について集計した。

| profile | 期間 | job数 | 局面数 | incomplete | elapsedMs 中央値/最大 | 完了深さ中央値 | nodes中央値 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Free | 変更前 | 6 | 644 | 10 | 1051 / 1055 | 18 | 784,186 |
| Free | 変更後 | 3 | 322 | 0 | 1051 / 1052 | 18 | 804,400 |
| Precision | 変更前 | 4 | 418 | 0 | 5051 / 5054 | 21 | 7,535,934 |
| Precision | 変更後 | 3 | 322 | 0 | 5051 / 5053 | 20 | 6,622,978 |

- Freeで変更前にincompleteだった9局面は、変更後すべてsuccessになった。
- 同じ局面の最善手一致率は、変更前どうしがFree 66〜72%・Precision 75%（1組）、変更前と変更後がFree 62〜75%・Precision 63〜72%だった。movetime制限の探索は毎回結果が揺れるため、この程度の差は実行ごとの差の範囲と見ている。
- Precisionの変更後はnodes中央値が約12%低く、完了深さの中央値も1浅かった。所要時間とincompleteは変わらない。ホストの比較ではPvInterval 0でnodesは減っていない。Precisionよりinfo行が多いFree（1 vCPU・1 thread）でもnodesは減っていない。このため出力増加が原因とは考えにくいが、staging上で原因（VMの配置など）は確認していない。

### driverVersionを上げない判断

`driverVersion`（`usi-driver-v1`）は据え置いた。

- 結果JSONの形、検証規則、「確定値がそろった最も深いMultiPVブロックを採用する」規則は変わらない。変わるのは、エンジンが途中の深さも出力することだけである。
- 変更前の`success`は同じ規則で採用した結果であり、今回の変更で無効になるものはない。変更前の`incomplete`は、今回からsuccessになり得るだけである。movetime制限の探索は同じ条件でも結果が揺れるため、versionを分けても再現性は得られない。
- versionを上げると、Worker・アプリの固定identityと`cloudContractEpoch`が変わり、保存済みのCloud結果がすべて表示対象外になる。両OSアプリの更新も必要になる。
- #23の共有cacheは、この判断を前提にPvInterval変更の前後の結果を同じidentityとして扱える。cacheの鍵にdriverの設定を含めるかどうかは#23で決める。

## 検証

- `npm run check --prefix cloud`：TypeScript、Vitest 111 tests（workerdで`/session/cancel`の応答解放を確認するものを含む）、Python 107 tests。
- ルートの`npm run check`：アプリ264 tests。
- 時刻・job ID・集計値は[JSON証跡](evidence/issue-29-36-acceptance.json)に保存した。認証情報、接続先hostname、棋譜・局面は含めない。
- モバイルコードは変更していない。両OSのビルドと画面の受入は実施していない。
