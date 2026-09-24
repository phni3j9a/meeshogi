# staging 解析サービス

## 構成と状態

過去のstaging記録に固定SFEN smoke、benchmark、W3-fix backendのlive確認があります。Worker `c041494a` とimage `sha256:3908907a…` は引き続きdeployedで、remote D1 migration `0001`–`0005` が適用済みです。今回のR3/R4/R5修正はlocal workerd向けの未deploy変更で、`0006_driver_lifetime_restart_identity.sql` もremote未適用です。再build・migration適用・修正後staging検証は未実施です。Worker構成は `free-v1` 用の `AnalysisContainer` (`standard-2`, 1 vCPU) と `precision-v1` 用の `AnalysisContainerPrecision` (`standard-3`, 2 vCPU) を同時にbindし、各々 `max_instances: 1` です。`JobCoordinator` のD1 leaseが両containerを通じて実解析を一件にfenceします。production resourceはありません。fault fixtureは既定で無効 (`ANALYSIS_FAULT_FIXTURES_ENABLED=0`) です。

Workerは `POST /v1/internal/analyze`、`POST /v1/internal/bench/analyze`、`GET /v1/internal/health` と、後続の明示停止用 `POST /v1/internal/stop` をBearer認証で保護します。解析入力はSFEN・movetime・MultiPVと、benchmark routeでのみThreads / Hashの限定値を受け付け、未知fieldや任意USI optionを拒否します。これらの内部routeは任意で `profile: "free-v1" | "precision-v1"` を受け付け、省略時は `free-v1` (`standard-2` container) です。healthは `?profile=` query、stopはbodyの `{"profile": ...}` で選択します。profile名の列挙はserver側allowlistに固定され、他のcontainer選択や任意engine parameterは渡せません。WorkerはtokenをContainerへ転送しません。公開model IDは `analysis-model-staging-v1` です。benchmark routeは管理者向け内部計測専用であり、公開app APIや将来のpublic job APIへ含めません。

## Async job API

`POST /v1/jobs` は `{ idempotency_key, profile, initialSfen, moves }` を受け取り、最大256 KiBのbodyと初期局面込み512 position（moves最大511手）に制限します。未知fieldや`label`は拒否します。初期局面は位置0、その後各手の直後の局面を追加します。`moves: []` は単一局面です。`tsshogi@2.3.4` で合法性を検証し、不正手はHTTP 400と0始まりの`moveIndex`を返します。公開入力の`positions[]`は拒否します。同じowner/key/正規化payloadは元jobを返し、同じkeyで別payloadを送ると409です。`GET /v1/analysis-profiles` はversion2両profileの公開identity component/hash、entitlement、block状態を返します。jobと各result envelopeも`executionIdentityHash`を含み、contract v3 result bodyは変更しません。

`free-v1` は `standard-2` / 1 vCPU / 1000ms / MultiPV2 / Threads1 / Hash256MiB、`precision-v1` は `standard-3` / 2 vCPU / 2000ms / MultiPV3 / Threads2 / Hash256MiBです。identity hashはCPU、検索option、engine binary digest label、weight/options/helper/driverのSHA-256、modelとparser/helper/proof/contract/history revisionを含みます。dispatch前・cache参照前・commit前にdriver healthの完全なartifact provenanceと照合し、不一致や不足時はfail closedします。cache keyもidentity hashを使うため、異なるprofile・実行環境の局面結果は共有しません。stagingは再build後に`ANALYSIS_WEIGHT_SHA256`、`ANALYSIS_ENGINE_OPTIONS_SHA256`、`ANALYSIS_HELPER_SHA256`、`ANALYSIS_DRIVER_SHA256`を実物digestへ更新するまでjob admissionが利用不可です。`GET /v1/jobs/{id}/results?cursor=&limit=` は `result_seq` cursorで漏れ・重複なくpageし、表示はposition index順です。末尾でも`resumeCursor`を返し、空pageは入力cursorをechoします。

Admission gateは順に、同じkey再送を除くprincipal POST 6回/分、kill/profile-block/daily cost cap、global queued/running上限10、owner active job上限1、UTC日次quotaです。free quotaは5 job / 1024 position、precisionは2 / 512、1 jobは初期局面を含め最大512 position。GET系は120回/分、cancelは30回/分で、429は`Retry-After`を返します。未完了jobの予約は作成UTC日に関係なく当日のcapへ加算し、実行attemptと未知状態から確認破棄したattemptは日別のidempotent ledgerへ記録します。jobの`costs`はadmission estimateとsettled attempt estimateを分け、実測エンジン請求額は未取得 (`observedEngineCostUsd: null`) と示します。予約は最大2 attempt、期限、proof、readiness/cold start、idleを含むcontainer-resource boundです。Workers、D1、Queue、DO等の追加料金はこのbound外で、invoiceではありません。warningは$0.50、daily capは$1.00です。

D1は全chunkのoutboxを保存して先頭だけQueue送信します。fenced commit後に次chunkを送信し、Queue send回数の`delivery_count`とengine dispatch回数の`attempts` (最大2)を分離します。jobs Queueの`max_retries`は5とし、ひとつのchunk内でjobのfailure thresholdに届く前にDLQへ移ることを防ぎます。claimとglobal slot acquireは1つのD1 batchで更新します。scheduled triggerは毎分outbox/lease/no-progressを回復し、期限切れleaseは該当Containerの`destroy()`確認前に再付与しません。DLQとcancelの中間状態は識別してQueue redelivery / scheduled recoveryで再開し、reservationを一度だけ解放します。`/stop`へjob/epoch/position/attempt/leaseのfenceを渡し、driverはactive search fenceと完全一致するときだけ停止します。未知transport結果はslotを保持し、Containerの破棄確認後だけ次attemptへ進めます。DLQ current epochはjobを`partial`/`failed`で終端化し、古いmessageはackします。`incomplete`と`resign`はevaluation missingで実failure閾値を増やしません。timeout/exit/restartだけ一度retryし、protocol/integrity errorは以前commitしたresultを保ったままjobを`failed`にし、profile admissionをadmin解除までblockします。verified terminalの`none`/`no_legal_moves`/`win`は処理済み`done`ですが評価成功・cache対象ではありません。

cancelはまずD1へ`cancelling`を記録し、fence付きで該当profile Containerへ`stop`を要求します。5秒以内にquiesceしない場合はそのContainerをdestroyし、破棄確認後に`cancelled`へ進めます。評価成功positionではengine terminalが`ok`でもboundedなContainer内helper `/prove`を3-ply/10,000操作budgetで独立して呼びます。保存するproof schemaはbudget version/result/actual plies/nodes/合法な代表USI lineを検証します。1-ply mateは`plies: 1`、3-plyは`plies: 3`、budget超過は`unknown`、詰みでない場合は`not-mate`です。予想読み筋はengine PVから作らず、scoreだけでbadgeにしません。

Fault fixtureは既定で無効です。明示的に有効化した検証環境だけで、designated principal所有のjob/epoch/position/attemptへ10分TTL付きでarmできます。`destroy-during`はfence一致の実search開始をhealthで確認してからContainerを破棄します。`sigstop`はarmを一度だけD1で消費してからContainerを再起動し、`startAndWaitForPorts({ports, startOptions:{envVars}})`にfence付きのtest-only envを渡します。driverは一致するsearchだけを一度SIGSTOPし、通常のtimeout/reap/restartを通します。admin DELETEはarm cleanupに使えます。現在のstaging configはflag=0で、live注入や修正後deployは未確認です。

`0001_init.sql` は既存schema、`0002_async_jobs_hardening.sql` はrowsを保持する追加migration、`0003_recovery_cost_identity_faults.sql` はexecution identity JSONとscoped/expiring fault armを追加するmigrationです。旧jobs/positions/cache内容は移行し、旧cacheは`quarantined=1`で保持しつつ読みません。既存terminal jobは履歴として残し、identityを持たない旧queued/running jobは`pre_identity_migration`理由で`failed`/`partial`へ閉じ、未完了positionsもterminalizeして旧Queue messageが新identityで再開しないようにします。`0004`と`0005`はchunk cost ledgerとterminal finalizer/runtime budgetを追加し、stagingへ適用済みです。今回の`0006_driver_lifetime_restart_identity.sql`はrestart deduplication keyを`(profile_id, driver_epoch, restart_count)`へ変更し、旧eventは`legacy:<engine_epoch>` markerで保持します。stagingでは`0001`–`0005`が適用済み、`0006`は未適用です。`v3` Durable Object migrationは `AnalysisContainerPrecision` を追加し、既存 `v1`/`v2` は残します。

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

`legal` は `legalMoveCount` と完全な `legalMoves`、王手状態、盤面だけから確認できる入玉宣言条件を返します。`pv-legal` はSFENから指し手列を合法再生します。`mate-proof` は `sekirei-proof-ops-v2` の操作budgetを使い、1手/3手の証明では実pliesと合法な代表USI lineを返します。`not-mate` / `budget-exceeded` / `in-check-invalid` はpliesとlineを持ちません。Workerはresult enum、budget版、要求budget、node上限、lineを共有schemaで検証し、budget超過を `unknown` として保存します。budgetはdriver APIで1〜10,000です。SFENに持ち時間は含まれないため、入玉宣言の時間条件はhelperでは判定しません。

## 依存とローカル検証

`cloud/package.json` は `wrangler@4.137.0`、`@cloudflare/containers@0.3.7`、`tsshogi@2.3.4`、TypeScript、Vitestをpinします。Expoのroot packageは変更しません。

Workerは `../../src/cloud/analysis-contract` を相対importします。cloud側の `tsconfig.json` はこの純粋な共有ファイルを明示的に含め、root Expoの `tsconfig.json` は `cloud/` packageを除外します。そのためCloudflare runtimeの依存がroot mobile bundleへ入りません。

```sh
cd cloud
npm install
npm run typecheck
npx vitest run
```

Vitestは`@cloudflare/vitest-pool-workers@0.22.0`でWorkerをlocal workerd内に起動し、`wrangler.test.jsonc`のephemeral D1/Queuesと合成service bindingを使います。staging resourceへ接続しません。Worker runtime型は`src/worker-platform.d.ts`でこのpackageが使うAPI surfaceだけを宣言し、実runtimeの動作はこの統合suiteで検証します。

Python driver testはfake USI executable/helperと合成weightを使い、health/analysis計測に加えてbounded `/prove` validation と `MEESHOGI_TEST_SIGSTOP_ENGINE=1` のtimeout/reap/restart経路を確認します。

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

scriptはworker名が正確に `meeshogi-analysis-staging` で `-staging` 終端であること、environment overrideがないこと、`AnalysisContainer=standard-2` と `AnalysisContainerPrecision=standard-3` が各々 `max_instances: 1` でbindされていることを確認します。1回のdeployで両containerが同時に利用可能になり、再deployなしに `standard-2` / `standard-3` を切り替えられます。scriptは `wrangler.staging.jsonc` 以外のconfig名を拒否し、production名や`--env`を追加する構成にはしません。

benchmark runner、合成合法SFEN fixture、直列実行順、標準価格、出力形式は [docs/CLOUD.md の Benchmark section](../docs/CLOUD.md#benchmark) を参照してください。

## Security / 今回含めない範囲

- Workerの全routeにBearer認証を要求し、Bearer tokenをcontainerへ転送したりログへ出したりしません。
- engine stdoutはUSI parserだけが読み、stderrは破棄します。公開のimage/model read、download、shell、debug route、汎用proxyはありません。
- 非公開artifact、image archive、Cloudflare token、staging secretをGitまたは公開artifactへ含めません。
- W3 backend repairとprofile listingはこのcheckoutにあります。R2、アプリ統合、production resourceは対象外です。Worker `c041494a` とremote migrations `0001`–`0005` は既に適用済みです。今回のR3/R4/R5修正にはdriver image rebuild、`0006` remote apply、staging deployと故障境界のlive再検証が残っています。

過去のlive async job verificationは記録された当時のbuildに対するものです。今回のR3/R4/R5修正後コード、`0006`適用後のmigration状態、再build imageでのdriver identity照合と故障境界は未検証です。package内の合成workerd testsはCloudflare上の確認を代替しません。
