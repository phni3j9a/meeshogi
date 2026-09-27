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
