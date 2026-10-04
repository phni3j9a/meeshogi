# Issue #30: 解析後のContainer停止

対象は既存staging Worker `meeshogi-analysis-mvp-staging`。2026-09-27に、job終了後もFree / Precisionが稼働し続ける不具合を修正した。Cloudのみへ移行する方針は合意済みだが、深掘り・分岐の仕様や構成最適化は今回決めない。`sleepAfter = '5m'`、解析条件、利用制限、QueueとContainerの構成を維持する。

## 原因と修正

停止前の09-27 05:00–06:00 UTCは、対象Workerへの要求・active jobがなくても、Free / Precisionが約5.71 / 8.12 GiB-hのメモリ使用量を積算していた。両ContainerのDurable Object（DO）は各36回のalarmと約3,600秒のactive timeを記録した。使用量はadaptive集計なので、割当量と完全には一致しない。

互換性日付`2026-09-25`では、Cloudflareの[isolated PID namespace](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#use-an-isolated-pid-namespace-for-containers)が既定で有効。Python entrypointはPID 1になり、停止用のSIGTERMハンドラがなかった。同じ旧imageのローカルDockerではSIGTERMを2回送っても終了せず、`--init`を付けた対照実験では約0.336秒で終了した。インストール済みSDK 0.3.7はidle時にSIGTERMを送るが、SIGKILLへ切り替えない。実環境のalarm周期も、SDKでSIGTERMが効かない場合の再現結果に一致した。修正前の実VMで信号受信を直接観測したわけではない。

修正は次の2点に限定した。

- Python driver: SIGTERM/SIGINTを終了通知として受け取り、HTTP受付と開いたソケットを閉じ、探索待ちを中断する。既存の`finally`で子エンジンを回収し、最大10秒でdriverを終了する。この10秒は停止信号を受けた後の上限であり、通常解析の制限ではない。
- Queue consumer: AbortControllerで通信を中断し、レスポンス本文とreaderを解放する。ヘッダー待ちtimeout後に届く応答も`waitUntil`に結び付けて回収する。完了した処理のdeadline timerも消す。

後者は別の再発経路への対処である。旧consumerは後着応答を残し、SDKの処理中件数が1のままになることをworkerdで再現した。さらに実HTTPで、本文の`cancel()`だけではSDK内の上流readが止まらない場合を確認し、通信のabortも併用した。独自のidle監視や定期強制終了は追加していない。

## 検証対象

| 項目 | 値 |
| --- | --- |
| 製品コード | `ff5d544fa8711a788f0b6bc7a3cccc2ff8a0400f` |
| Container image digest | `sha256:227fd064a5b976f37efd1d2e79e54b19cccc65ec35d64ddd00bd86c2fe0146fd` |
| Worker version（通常コードへ復帰後） | `fea53c08-51fe-4867-a5e3-72751f25fcae` |
| Image build ID | `2e01f7f16caf46a98701cef50f437108` |
| 解決されたUbuntu 24.04 base digest | `sha256:224a1869083a311ef3f13648a154ba79832fbef6364d31493642ca03082da254` |
| SDK / Wrangler | `@cloudflare/containers` 0.3.7 / 4.139.0 |
| Free | standard-2、Threads 1、Hash 64 MiB、1000ms、MultiPV 2 |
| Precision | standard-3、Threads 2、Hash 64 MiB、5000ms、MultiPV 3 |

新imageをローカルDockerのPID 1として起動し、SIGTERMから約0.390秒でexit 0、`engineReaped: true`を確認した。実HTTPのkeepalive・未完了request body・応答しない合成エンジンを含む終了テストも成功した。

ローカル検証は`npm run check`（アプリ264 tests）と`npm run check --prefix cloud`（TypeScript 90 tests、Python 93 tests）が成功。Cloudの10件のworkerd試験は、実consumerとインストール済みSDKを使い、正常完了・HTTP EOFより前のend・後着ヘッダー・中断・本文停止・不正ヘッダー・通信例外・非200応答を扱う。うち2件は実HTTPソケットの切断まで確認する。Cloudflare本体の障害注入E2E試験とは区別する。

## デプロイ時の確認

通常deploy直後、管理APIのimage欄は新digestでも、Freeの`/internal/health`は旧build `57faf101…`を返した。[Cloudflare公式のdeploy仕様](https://developers.cloudflare.com/containers/guides/deploy/)でも、Wranglerは全instanceの置換完了まで待たない。管理APIの`inactive`表示だけでも停止の実証にはならない。

D1のqueued/runningとQueue backlogが0であることを確認し、既存の内部tokenで認証した一時的なoperator routeから、Free / Precisionの既存instanceを一度だけ`destroy()`した。app、DO namespace、D1は削除していない。通常コードを再deployし、一時routeが404になることと、Freeの実応答が上記build ID / commitへ変わったことを確認してから受入を始めた。この一回の旧instance停止を、自動停止の検証回数には含めない。

## Staging受入（2026-09-27、UTC）

公開fixture `fixtures/kif/shogiwars.kif`の指し手を使い、短いケースは冒頭4手（5局面）、長いケースは80手（81局面）を送信した。検証用の匿名ownerを作成し、このownerだけPrecisionをallowlistした。条件を下げたり、テスト用のsleep時間へ変更したりしていない。

| ケース | 確認結果 |
| --- | --- |
| Free正常終了 | 12:26:36に5/5局面がsuccess |
| Free取消 | 12:26:48、7/81局面で取消。20秒後もcursorと結果件数が不変 |
| Precisionの5分超解析 | 12:27:08〜12:32:51、約342秒。302秒時点でもrunning / 61局面、最後は80 success + 1 terminalで81/81局面 |
| Precision取消 | 12:33:04、1/81局面で取消。20秒後もcursorと結果件数が不変 |
| 停止後のFree再要求 | 12:41:05に作成し、12:41:16に5/5局面がsuccess |
| 停止後のPrecision再要求 | 12:41:16に作成し、12:41:51に5/5局面がsuccess |

再要求分を含む全104行の保存結果について、profileのrequested値と、終局以外のactualのThreads / Hash / movetime、一部局面で合法手数に応じて減るMultiPVの範囲も再確認した。取消後の件数も不変だった。

最初の停止は、管理APIの状態更新時刻でFreeが12:32:01、Precisionが12:38:21。取消完了からそれぞれ約312秒・317秒だった。アプリからの取消確定と、内部通信の終了・platformの状態更新には差があるため、「300秒ちょうど」の保証とは扱わない。

12:39〜12:41は両Containerへ要求を送らず、その後に上表の再要求を行った。Freeのhealthは最初の`driverBootId: abb2afcc…`から`64f95c35…`へ変わり、同じ修正buildでの新しい起動を確認した。Precisionはjob経路にboot IDの永続記録がないため、停止状態・使用量・再要求成功を照合した。管理APIの`started_at`は停止直後の時刻を返す場合があり、実際のdriver起動時刻やcold start時間の測定には使用しない。

再要求後の正常終了からも自動停止した。管理APIの状態更新時刻はFreeが12:46:28、Precisionが12:47:02（Precision完了から約310秒）。Freeは12:41:16の完了直後に一度healthを読み、その後は追加要求を送っていない。12:47の最終確認で、両instanceがinactive、queued/running jobとQueue/DLQ backlogが0だった。

時刻・状態・結果件数・GraphQL集計の抜粋は[JSON証跡](evidence/issue-30-lifecycle.json)に保存する。認証情報、接続先hostname、private artifact本体は含めない。

## 停止と使用量の確認方法

`/internal/health`はContainerを起動・延命するため、idle観測中は呼ばない。管理APIのinstance状態と状態更新時刻、D1のjob状態、Queue backlog、GraphQL Analyticsを照合する。GETによるjob進捗・結果取得はD1を読み、Containerを延命しない。

- `containersUsageAdaptiveGroups`: `allocatedMemory` / `allocatedDisk`（byte-seconds）と`cpuTimeSec`。プロセスの使用メモリではなく、micro VMを含む課金見積もり用の使用量を確認する。
- `durableObjectsPeriodicGroups`: 対象namespaceの`activeTime`（microseconds）と`duration`（GB-s）。
- `durableObjectsInvocationsAdaptiveGroups`: 対象namespaceのalarm回数・処理時間。

minute bucketと取得時刻を保存し、直近の未到着データを0と判定しない。停止表示の後に要求を送らない区間を設け、さらに後から同じ区間を取得する。[使用量APIの定義](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-container-metrics/)

| 観測区間（UTC） | Container使用量 | DO active time / duration |
| --- | --- | --- |
| 12:33〜12:35、Free停止後 | Freeは追加行なし、集計0。Precisionには記録あり | Freeは集計0、Precisionは約120秒 / 15.36 GB-s |
| 12:39〜12:41、両方停止中 | 両方とも追加行なし、集計0 | 両方とも集計0、alarm呼び出しも追加なし |
| 12:41〜12:43、再要求後 | 両方に使用量の記録が再開 | 両方にactive time / durationの記録が再開 |

両方が停止した区間は12:42・12:43・12:46に取得し、いずれも同じ集計だった。停止区間の行がないことだけで結論を出さず、同じ取得で後の再稼働区間に記録があることと、繰り返し取得しても停止区間の集計が変わらないことを照合した。これはこの受入区間での使用量収束の証拠であり、長期運用の監視や請求確定額の確認とは区別する。

## 費用見積もりへの引き継ぎ

5分のidle待機は引き続きある。[2026-09-27参照のContainer単価](https://developers.cloudflare.com/containers/platform/pricing/)と構成上の割当量による単純計算では、1回の起動後に丸5分待機したときのメモリ・ディスク分はFreeが約$0.00475、Precisionが約$0.00634となる。同じinstanceに次のjobが来れば待機時間は共有・延長されるため、これを無条件に1局ごとに足さない。

2台が24時間止まらない場合の同費目は約$3.19/日だった。正常停止後の見積もりは、起動・解析・実際のidle待機を積算する形へ戻す。CPU、DO、D1、Queues、通信、月間付属枠、基本料金、税はこの概算に含まない。Analyticsは請求確定額ではない。起動待ち・実ジョブの所要時間・利用頻度を含めたproduction見積もりは[Issue #24](https://github.com/phni3j9a/meeshogi/issues/24)で行う。

検証用ownerのPrecision allowlistを解除し、credentialを失効させた。旧credentialが401になることを確認してローカルのcredentialファイルを削除した。6件の検証jobと結果は証跡としてD1に残す。

## 検証の境界

モバイルコード、native Sekirei統合、production資源は変更していない。今回の両OSビルド・画面操作・実機受入は実行していない。Queue→DLQ、12分を超えるcontinuation、実環境へのネットワーク障害注入は今回の受入に含まない。旧staging Workerのcron整理も別作業である。

## Issue #48: jobごとのContainerと終端停止

Issue #48で、job処理を同期解析用singletonおよびbenchmarkクラスから分離した。Freeは `FreeJobContainer` / standard-2、Precisionは `PrecisionJobContainer` / standard-3を使い、DO名はD1に保存された `jobId` とする。profile設定 `cloud/config/job-profiles.json` のFree 3 / Precision 2はContainer `max_instances` にだけ反映する安全上限である。Queueの `max_concurrency` は省略し、自動スケールに任せる。上限値はstaging用で、production値はIssue #24で決める。現在のDO主導開始と挙動は[Issue #49](#issue-49-do-driven-start)を参照。既存の `AnalysisContainer`、benchmark 2クラス、`/internal/analyze` の経路は維持する。

Queueは `meeshogi-jobs-free-staging` / `meeshogi-jobs-free-staging-dlq` と `meeshogi-jobs-precision-staging` / `meeshogi-jobs-precision-staging-dlq` の4本。producerはjob idだけをprofile別Queueへ送る。consumerは `batch.queue` とD1 profileの一致を確認した後、jobのDOへ有限期限の開始RPCを渡す。不一致は `queue_profile_mismatch` として終端化する。開始メッセージのQueue retryが枯渇した場合はDLQへ入り、active jobをfailedにはしない。5分ごとのcronが古いD1 active rowを再投入する。旧 `meeshogi-jobs-staging` bindingは外す。staging deploy前に旧Queue backlogがないことを確認する。

完了・失敗・retry枯渇・取消がD1に確定した後、同じjobIdのContainer RPC `terminateJob()` を呼ぶ。DO storageへ終端フラグを永続化してから `destroy()` し、終端後の `/session` と `/session/cancel` fetchはHTTP 410で拒否するため、DO再起動後もContainerを起動しない。停止RPCと `getState()` の確認全体に6秒の期限を設け、pollは100ms間隔とする。期限切れ・RPC失敗は構造化ログに残すが、Queue ack/retry結果は変えない。consumerが410を受けたらD1を再読し、終端なら停止を冪等に再試行してackし、activeなら契約違反として失敗させる。session cleanup前にもD1を読み直し、終端jobへ起動fetchを送らない。`markRunning` が0行を更新した場合もD1を読み直して、終端jobではsessionを開始しない。次のDO slice予約や通常retryの前には停止しない。jobクラスの `sleepAfter = '1m'` は保険で、設定されている最大retry待ち30秒（10/20/30秒）より長く、同期解析・benchmarkの5分設定には影響しない。

`GET /internal/jobs/:jobId/container` はinternal tokenを要求し、D1からprofileを読み、jobId名stubの `getState()` だけを返す。Container `fetch()` は呼ばないため、停止確認のpollingはアプリを起動・延命しない。計測ログにはdelivery開始、開始RPCの受理、DO slice開始、Container fetch開始、session header受信、最初の結果commit、停止結果がjobId/profileと共に記録される。HTTP 503時は最大1KiBの本文を記録し、従来どおりretryする。

**staging実測（2026-10-04、候補 `5d874dc`）:** 1局面jobはjobごとにコールドスタートし、profileごとに60件を逐次実行した。

| Profile | 件数 | POST→最初の結果 p50 / p90 / 最大 | 終端→停止確認 p50 / 最大 | 停止確認 |
| --- | ---: | ---: | ---: | ---: |
| Free | 60 | 6.1 / 7.1 / 10.6秒 | 0.49 / 0.75秒 | 60/60 |
| Precision | 60 | 8.3 / 9.1 / 12.9秒 | 0.46 / 0.55秒 | 60/60 |

長いjobと同時投入では次の結果だった。

| 条件 | POST→最初の結果 | POST→完了 | 補足 |
| --- | --- | --- | --- |
| Free 92手 + Precision 92手を同時投入 | Free 6.0秒、Precision 9.0秒 | Free 53秒、Precision 236秒 | 並行して進み、profile間の待ちはなかった。#46の温まったContainerでの値（約50秒、3分55秒）とほぼ同じ。 |
| Free 92手 ×6（上限3） | 7.9 / 62 / 72 / 116 / 125 / 131秒 | 56 / 110 / 120 / 164 / 173 / 178秒 | 全jobでContainer停止を確認。 |
| Free 92手 ×3（上限ちょうど） | delivery開始 T+0 / 54 / 65秒 | 59 / 113 / 123秒 | すべてattempt 1、503 retryなし。ほぼ順番に開始。 |

この表はDO主導開始へ移行する前のIssue #48の履歴である。Queueはbatch処理後にconsumerの自動スケールを判断するため、上限ちょうどでも同一profileの開始が順番になった（[Cloudflare Queues consumer concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/)）。現在の開始方式と更新後のstaging実測は[Issue #49](#issue-49-do-driven-start)に記録する。Issue #48の実測ではコールドjobの初回結果までFree 6〜7秒、Precision 8〜9秒（p50/p90）で、warm poolは不要と判断した。#20記録のコールド起動待ちはstandard-2約17秒、standard-3約25秒だった。

5d874dcの再deploy後もFreeの完了・取消とPrecisionのsmokeが成功し、数分後も3つのjob Containerはstoppedのままだった。生データはscratchpadに保管し、リポジトリには上表の集計のみを記録する。

<a id="issue-49-do-driven-start"></a>
## Issue #49: DO 主導の即時開始

Issue #49では、Queue deliveryが解析全体を抱える方式から、Queueをjob開始の受け渡しに使い、各jobのDOがscheduleで実行する方式へ移行した。

| 部品 | 責務 |
| --- | --- |
| D1 | job状態・cursor・結果の正本。Queue consumerとDOは処理前後に読み直し、cursor guard付きで結果を保存する。 |
| Queue consumer | profile別QueueからjobIdを受信しD1を読む。DOの `startJob` RPCを5秒で打ち切り、DOが制御情報とSDK `schedule()` 予約を永続化して受理した後にackする。 |
| Job DO | `jobId` 名の `FreeJobContainer` / `PrecisionJobContainer`。DO storageへ `generation`、`runId`、`attempt`、`notBefore`、task IDなどの制御情報を保存し、schedule callbackからrunnerをawaitする。1スライスのbudgetは600,000 ms、書き込み用tail marginは20,000 ms。進捗時は次のsliceをDO内で予約し、Queue continuationは使わない。 |
| Cron | 5分ごとにD1の `queued` / `running` を走査し、`updated_at` が15分以上古いjobをprofile別Queueへ再投入する。公平なbounded scanのため `last_recovery_at` を更新する。この列とindexはmigration `0002_jobs_updated_status.sql` で追加する。 |

Queueはprofileごとにbatch size 1、`max_retries: 3`、DLQを使う。`cloud/config/job-profiles.json` のFree 3 / Precision 2の `maxInstances` はContainer `max_instances` にだけ適用する。Queue `max_concurrency` は省略して自動スケールに任せ（[Cloudflare Queues consumer concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/)）、`visibility_timeout_ms` も設定しない。開始RPCのQueue retryが枯渇してDLQへ送られても、active jobはfailedにせずcronで回復する。profile上限はstagingの安全上限で、production値は[Issue #24](https://github.com/phni3j9a/meeshogi/issues/24)、利用制限は[Issue #45](https://github.com/phni3j9a/meeshogi/issues/45)の範囲とする。

| 実行経路 | 動作 |
| --- | --- |
| 通常の一時失敗 | 初回実行に加え最大3回retry。待機は10 / 20 / 30秒。 |
| Container容量到達 | 実環境では `Maximum number of running container instances exceeded. Try again later, or try configuring a higher value for max_instances` が返る（SDKローカルの文言とは異なる）。この例外・本文を容量待ちと判定し、5〜30秒のjitter付きbackoffを使う。attemptは消費しない。 |
| 終端 | D1にcompleted / failed / cancelledを確定してから終端flagを保存し、DOからContainerを停止。 |

取消・停止はIssue #48の性質を維持する。終端flagを先に保存し、停止RPCと `getState()` 確認を合計6秒で打ち切る。driverの `/session/cancel` は5秒以内、解析POSTのAbortSignalはresponse header後も本文EOFまで有効にする。

Containers SDK 0.3.7では、予約時刻は秒単位へ切り捨てられ、1 alarm内のdue callbackは逐次awaitされる。一回限りの予約行はcallback return後に削除され、callback例外もSDKが捕捉してから削除するため、その例外自体ではplatform alarmのretryにならない。DO側では秒境界へ整列し、`generation` / `runId` guard、実行中の予約行を除外した予約照合、独立した回復予約を使う。再起動後、同じrun callbackが永続 `running` 制御に届き、対応するin-memory `activeRun` がない場合は `job_run_resumed_after_restart` を記録し、既存 `callback_recovery` と同じattempt方針で10秒後に再予約する。次のsliceはD1 cursorから再開する。

Cloudflareの公式上限はalarmのwall timeが15分、DOのCPU timeが既定30秒（I/O待ちは含まない。詳細は[Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)）。このjobの600秒budgetは15分以内で、92局面の行処理CPUはローカル概算約37msだった。

## Staging実測（2026-10-04 UTC）

同一image `sha256:51462a14…`、92手game、Free 500 ms / Precision 2500 msで計測した。

開始内訳（Free単独jobのtailログ）:

| 区間 | 所要 |
| --- | ---: |
| POST応答 → Queue delivery | 0.9秒 |
| start RPC → 受理/ack | 0.5秒 |
| schedule予約 → alarm callback | 0.95秒 |
| callback → Container fetch | 0.7秒 |
| fetch → session header | 2.4秒 |
| header → 最初のcommit | 2.0秒 |

POSTから最初のcommitまでは8.7秒。Issue #48と比べ、開始の受け渡しとalarm起動で約1.5秒増えた。終端からContainer停止確認までは概ね1秒前後。

| 条件 | 候補 | 結果 |
| --- | --- | --- |
| 単独（各profile 3本を逐次） | `838157d` | 初回結果 p50 / 最大: Free 11.5 / 13.7秒、Precision 10.8 / 12.1秒。完了: Free 58.9 / 60.9秒、Precision 238.9 / 239.8秒。 |
| 同一profile同時投入（Free 3本×2回、Precision 2本×2回、投入時刻差0ms） | `838157d` | 初回結果 p50 / 最大: Free 10.2 / 17.4秒、Precision 11.5 / 12.9秒。完了: Free 58.2 / 64.8秒、Precision 239.0 / 242.6秒。全jobがすぐ開始。#48のFree×3は59 / 113 / 123秒。 |
| 上限+1（Free 4本、Precision 3本） | `838157d` | Precision 3本目の上限到達例外を一時失敗と誤分類し、`retry_exhausted`（結果0件）。修正 `c5bac30` の対象。 |
| 上限+1（同上） | `c5bac30` | 7本すべて完了、欠落・重複なし。容量待ち10回、一時失敗retry 0回。Free 4本目は初回結果85.0秒・完了132.8秒。Precision 3本目は初回結果261.7秒・完了491.9秒で、先行jobの完了後に開始。 |
| 解析中に再deploy（Precision、投入から約100〜120秒後） | `c5bac30` | 92/92件は正しいが完了723.8秒。約620秒の回復予約まで停止した計算と一致。これを `ceb7eaa` で修正。 |
| 同じ再deploy条件 | `ceb7eaa` | 92/92件、欠落・重複なし、完了280.0秒。 |
| 取消（Free、数局面後） | `838157d` | 取消後20秒間cursorと結果件数に変化なし。Container停止を確認。 |

`ceb7eaa` の再deploy試験は2回行い、完了は280.0秒と258.7秒（通常約240秒）だった。2回目は解析中に `wrangler tail` で `Durable Object reset because its code was updated.` を観測し、実行中DOのリセットを確認した。tailの接続はdeployで切れるため、再開時の `job_run_resumed_after_restart` ログ自体は取得できていない。再開経路はworkerd試験と独立レビューのprobeで確認した。

調査時、stagingは `observability.head_sampling_rate: 0` のため `wrangler tail` でlive logを確認する。関連するstaging証跡は各Issue / PRに置き、READMEには現在の構成・制約を記載する。
