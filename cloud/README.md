# staging 解析サービス

## 構成と状態

Mainのstaging記録では固定SFEN smoke、単一合法手、`middlegame-150` gate、およびpost-fix benchmarkを確認済みです。W3では非同期job APIを実装しました。Worker `meeshogi-analysis-staging` は解析用 `AnalysisContainer` とglobal admission用 `JobCoordinator` の2つのSQLite Durable Objectを使います。通常設定は `standard-2`、最大instance数1、アイドル約30秒でsleepします。`wrangler.staging-2vcpu.jsonc` は同じstaging workerで `standard-3` を選ぶ比較用設定です。両configはすでに作成済みのstaging D1とQueuesへbindします。production resourceはありません。remote migration、principal seed、deployとlive async fault-injectionはMainのstaging作業として残っています。

Workerは `POST /v1/internal/analyze`、`POST /v1/internal/bench/analyze`、`GET /v1/internal/health` と、後続の明示停止用 `POST /v1/internal/stop` をBearer認証で保護します。解析入力はSFEN・movetime・MultiPVと、benchmark routeでのみThreads / Hashの限定値を受け付け、未知fieldや任意USI optionを拒否します。WorkerはtokenをContainerへ転送しません。公開model IDは `analysis-model-staging-v1` です。benchmark routeは管理者向け内部計測専用であり、公開app APIや将来のpublic job APIへ含めません。

## Async job API

`POST /v1/jobs` は `{ idempotency_key, profile, positions, label? }` を受け取り、1–512個のstrict SFEN局面を非同期解析します。raw engine parameterは受け付けません。同じowner/key/payloadは元jobを返し、同じkeyで別payloadを送ると409です。`GET /v1/jobs/{id}` は状態・件数・profile/model identity・costを、`GET /v1/jobs/{id}/results?cursor=&limit=` は位置index順の確定結果を返します。`POST /v1/jobs/{id}/cancel` のみが明示キャンセルで、アプリのbackground移行ではキャンセルしません。ownerはD1 `principals` のtoken SHA-256で照合し、他ownerのjobは404、revoked tokenは401、free principalのprecision要求は403です。Mainがsecretを含まないprincipal rowをdeploy後にseedします。

Profileはserver固定です。`free-v1` は1000ms/MultiPV2/Threads1/Hash256MiB、`precision-v1` は2000ms/MultiPV3/Threads2/Hash256MiBです。現行staging deployで選ばれている1種類のContainer instanceが両profileに使われます。日次UTC quotaはfree 5 jobs/1024 positions、precision 2 jobs/512 positions、jobあたり最大512 positionsです。全体でactive jobは1件、POSTは6回/分、ownerごとの他操作は10回/分に制限します。取消・失敗でもadmission時のreservationは戻しません。

Admissionはjob、positions、idempotency、quota、size-8 outbox chunksをD1 batchで保存し、その後Queueへ送信します。同じidempotency keyの再送で未送信outboxを再試行します。Queue consumerは一度に1 messageを処理し、各position結果をcommitしてからackします。Queueはat-least-onceなので、完了済みpositionは重複dispatch/課金しません。各engine timeout/exit/protocol errorは一度再試行し、3回連続または計5回failed positionが出ると`failed`（commitなし）または`partial`（commitあり）で停止します。cancelは`cancelled`、全件成功は`completed`です。DLQ redrive endpointは未実装です。retry上限後にDLQへ移ったchunkは、Mainがredrive手順を用意するまでjobをactiveのまま残す場合があります。

Cache keyはcontract v3、engine ID、model ID、profile ID/version、exact SFENです。cache hitは解析費用0として記録し、job statusにはcache件数と回避container cost見積りを含めます。成功・terminal failureとも位置ごとに一度だけcost ledgerへ記録します。global costWarningは$0.50、admission/dispatch capは$1.00です。estimateは既存benchmarkのrateとinstance specsを使い、profile movetimeとrequest overhead、failed retryはdriverの5秒deadline、さらにpositionごとに30秒のContainer sleep windowを足す保守見積りです。Worker/DO/Queue/D1などの費用は含みません。`POST /v1/internal/kill` `{ "mode": "admission" | "all" }` でstaging admissionまたは全dispatchを止められ、DELETEで解除します。

Mainはremote migrationとdeployの前にstaging database/Queueを再確認します。D1 migrationは`migrations/0001_init.sql`です。Workerの`v2` Durable Object migrationはdeploy時に適用します。principalはMainがsecret tokenのSHA-256 digestを使って別途seedします。

USI driverはPython 3標準ライブラリだけで動き、engine・weight・optionsのdigest、USI handshake、対応option、`isready`を起動ごとに検証します。1 processを排他実行し、局面ごとに `usinewgame` を送ります。Rust helperからroot合法手を列挙し、`effectiveMultiPv=min(requestedMultiPv, rootLegalMoveCount)` をengineへ設定します。連続した出力ブロックの中でrank 1..effectiveMultiPvが同一depth・exact score・異なる合法初手・合法PVで揃った最後のものだけをcompleteとします。同一(depth,rank)の再出力は正常な更新です。lowerbound / upperbound、欠落rank、重複初手を含むブロックはcompleteにしません。engineのbestmoveは合法手ならrank1と異なっても`engineBestmove`として保持します。cp / mate scoreはSFENの手番から先手視点へ一度だけ変換します。契約はv3で、centipawnの共有JSON上限はsafe integer ±1,000,000、固定engine adapterの許容範囲は±35,281です。clampやcp-to-mate変換はしません。

`engine_options.txt` の実内容は1行の `FV_SCALE 40` です。driverはこの行を固定allowlistとして読み、USI option `FV_SCALE` がエンジンから通知された場合だけ `setoption name FV_SCALE value 40` を送ります。`EvalDir` は同じimage内の `/opt/engine` に固定し、通常の `Threads=1`、`USI_Hash=256`、`GenerateAllLegalMoves=true`、`USI_Ponder=false`、`USI_OwnBook=false` と `BookFile=no_book` を設定します。管理者向けbenchmark routeのみThreads 1–2、Hash 16–512 MiBを指定できます。HTTP入力からoption名・パス・USI commandは受け取りません。

healthと解析応答にはengine epoch、process ID、restart countを含めます。healthは最後のrestart理由とoptions digestも返します。検索期限はmovetime + 5秒です。期限超過ではstopを送り1秒だけ待ち、SIGTERM / SIGKILLで古いprocessをreapしてfresh processを再検証します。restartは最大3回です。timeoutは `position_failed:engine_timeout` として返し、`incomplete` は初回反復が揃わなかった結果でretry指示ではありません。benchmark応答にはbest-effortのengine RSS / peak RSS / CPU時間とcgroup memoryを含めます。計測値が読めない環境でも解析は継続し、その値を省略します。

## Rules helper

`helper-sekirei` は `sekirei-core` revision `7fd1d9b42a85fbc5aeb222f8aa453d3e08f3c0ac` を使う小さなRust CLIです。合法手・PV検証・mate proofにengineやweightのロードは必要ありません。

```sh
cargo run --manifest-path cloud/helper-sekirei/Cargo.toml -- legal \
  --sfen 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1'
cargo run --manifest-path cloud/helper-sekirei/Cargo.toml -- mate-proof \
  --sfen '4k4/9/4G4/9/9/9/9/9/K8 b G 1' --plies 1 --budget 10000
cargo test --manifest-path cloud/helper-sekirei/Cargo.toml --locked
```

`legal` は `legalMoveCount` と完全な `legalMoves`、王手状態、盤面だけから確認できる入玉宣言条件を返します。`pv-legal` はSFENから指し手列を合法再生します。`mate-proof` は必須 `--budget` を `sekirei-proof-ops-v1` 単位で消費し、`proven` / `not-mate` / `budget-exceeded` / `in-check-invalid` を返します。budgetは0〜10,000,000です。SFENに持ち時間は含まれないため、入玉宣言の時間条件はhelperでは判定しません。

## 依存とローカル検証

`cloud/package.json` は `wrangler@4.137.0`、`@cloudflare/containers@0.3.7`、TypeScript、Vitestを個別にpinします。Expoのroot packageは変更しません。

Workerは `../../src/cloud/analysis-contract` を相対importします。cloud側の `tsconfig.json` はこの純粋な共有ファイルを明示的に含め、root Expoの `tsconfig.json` は `cloud/` packageを除外します。そのためCloudflare runtimeの依存がroot mobile bundleへ入りません。

```sh
cd cloud
npm install
npm run typecheck
npx vitest run
```

Vitestは`@cloudflare/vitest-pool-workers@0.22.0`でWorkerをlocal workerd内に起動し、`wrangler.test.jsonc`のephemeral D1/Queuesと合成service bindingを使います。staging resourceへ接続しません。Worker runtime型は`src/worker-platform.d.ts`でこのpackageが使うAPI surfaceだけを宣言し、実runtimeの動作はこの統合suiteで検証します。

Python driver testはfake USI executableと合成weightを使い、合成された計測値がhealth / analysis応答に含まれることも確認します。

```sh
cd cloud
python3 -m unittest discover -s test -p 'test_*.py' -v
```

## 非公開artifactのbuild

実engineやweightはworktreeへ置きません。Mainの許可済み環境だけで、次のscriptが3つのauthoritative manifestを読み、engine・weight・options fileのdigestを検証してから `/tmp` 配下に3ファイルだけをmode 0700の一時contextへコピーします。

```sh
cd cloud
bash scripts/prepare-private-context.sh
```

成功時の標準出力は次のkeyを持つ単一JSONです: `contextPath`、`engineSha256`、`weightSha256`、`engineOptionsSha256`。digestが一致しない、manifest間の参照が一致しない、optionsがallowlist内容でない場合は失敗して一時contextを削除します。

Dockerfileのbuild contextには `engine`、`nn.bin`、`engine_options.txt`、`driver.py` と公開helper crateを `helper-src/` 以下に用意します。Rust builder stageがhelperをlinux/amd64向けにrelease buildし、runtimeはMainがdigest pinしたUbuntu 24.04です。Mainはprivate contextとは別の `/tmp` 一時directoryへ必要な公開・非公開入力だけをallowlist copyします。`EXPECTED_ENGINE_SHA256` と `EXPECTED_WEIGHT_SHA256` はartifact digestをbuild ARGからENVへ渡します。image内にはAPI tokenを入れません。build後にprivate contextと一時build contextを消してください。

Wranglerが外部一時build contextをどう参照するかは、Mainの許可済みdeploy環境で初回deploy前に確認してください。現在のconfigは `./container/Dockerfile` を指定しています。external contextを使えない場合でもprivate artifactをworktree内へコピーせず、Mainが許可済みの外部build / registry経路を用意してからstaging configを更新します。

## staging deploy

Mainが `STAGING_ADMIN_TOKEN` をWrangler secretとして設定した後に実行します。secretを `vars`、`.env`、Git、build argへ入れないでください。

```sh
cd cloud
npm run deploy:staging
```

scriptはworker名が正確に `meeshogi-analysis-staging` で `-staging` 終端であること、environment overrideがないことを確認します。既定の `wrangler.staging.jsonc` に加え、`npm run deploy:staging -- --config wrangler.staging-2vcpu.jsonc` で同じstaging workerへ2 vCPU / 8 GiB / 16 GBの `standard-3` 設定を適用できます。scriptはこの2ファイル以外のconfig名を拒否します。benchmark後は必ず `wrangler.staging.jsonc` を再deployして `standard-2` に戻してください。production名や`--env`を追加する構成にはしません。

benchmark runner、合成合法SFEN fixture、直列実行順、標準価格、出力形式は [docs/CLOUD.md の Benchmark section](../docs/CLOUD.md#benchmark) を参照してください。

## Security / 今回含めない範囲

- Workerの全routeにBearer認証を要求し、Bearer tokenをcontainerへ転送したりログへ出したりしません。
- engine stdoutはUSI parserだけが読み、stderrは破棄します。公開のimage/model read、download、shell、debug route、汎用proxyはありません。
- 非公開artifact、image archive、Cloudflare token、staging secretをGitまたは公開artifactへ含めません。
- D1/Queueのjob orchestrationはW3 scopeとして実装済みです。R2、profile listing、アプリ統合、production resourceは対象外です。D1 schema、principal seed、deploy、live queue fault-injectionはMainのstaging作業として残っています。

Mainのstaging記録ではhealth、実engineの固定SFEN解析、AVX2、post-fixの両profile benchmarkを確認済みです。W3ではlive D1 migration/seed/deploy、async fault injection、5秒比較、full-game cost観測は未確認です。package内の合成workerd testsはこれらCloudflare上の確認を代替しません。
