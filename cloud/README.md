# staging 解析サービス

## 構成と状態

Mainのstaging記録では固定SFEN smoke、単一合法手、`middlegame-150` gate、およびpost-fix benchmarkを確認済みです。このcheckoutはW3 backend修正と追加migration `0002` を含みますが、stagingには未適用・未deployです。Worker `meeshogi-analysis-staging` は `free-v1` 用の `AnalysisContainer` (`standard-2`, 1 vCPU) と `precision-v1` 用の `AnalysisContainerPrecision` (`standard-3`, 2 vCPU) を同時にbindし、各々 `max_instances: 1` です。`JobCoordinator` のD1 leaseが両containerを通じて実解析を一件にfenceします。production resourceはありません。remote migration、principal seed、deploy、live fault injectionはMainのstaging作業として残っています。

Workerは `POST /v1/internal/analyze`、`POST /v1/internal/bench/analyze`、`GET /v1/internal/health` と、後続の明示停止用 `POST /v1/internal/stop` をBearer認証で保護します。解析入力はSFEN・movetime・MultiPVと、benchmark routeでのみThreads / Hashの限定値を受け付け、未知fieldや任意USI optionを拒否します。これらの内部routeは任意で `profile: "free-v1" | "precision-v1"` を受け付け、省略時は `free-v1` (`standard-2` container) です。healthは `?profile=` query、stopはbodyの `{"profile": ...}` で選択します。profile名の列挙はserver側allowlistに固定され、他のcontainer選択や任意engine parameterは渡せません。WorkerはtokenをContainerへ転送しません。公開model IDは `analysis-model-staging-v1` です。benchmark routeは管理者向け内部計測専用であり、公開app APIや将来のpublic job APIへ含めません。

## Async job API

`POST /v1/jobs` は `{ idempotency_key, profile, initialSfen, moves, label? }` を受け取り、初期局面に加えてUSI指し手を最大512手まで再生します。初期局面は位置0、その後各手の直後の局面を追加します。`moves: []` は単一局面です。`tsshogi@2.3.4` で合法性を検証し、不正手はHTTP 400と0始まりの`moveIndex`を返します。公開入力の`positions[]`は拒否します。同じowner/key/正規化payloadは元jobを返し、同じkeyで別payloadを送ると409です。`GET /v1/analysis-profiles` はversion2両profileの公開identity component/hash、entitlement、block状態を返します。jobと各result envelopeも`executionIdentityHash`を含み、contract v3 result bodyは変更しません。

`free-v1` は `standard-2` / 1 vCPU / 1000ms / MultiPV2 / Threads1 / Hash256MiB、`precision-v1` は `standard-3` / 2 vCPU / 2000ms / MultiPV3 / Threads2 / Hash256MiBです。identity hashはCPU、検索option、engine binary digest label、modelとparser/helper/proof/contract/history revisionを含みます。cache keyもidentity hashを使うため、異なるprofile・実行環境の局面結果は共有しません。`GET /v1/jobs/{id}/results?cursor=&limit=` は `result_seq` cursorで漏れ・重複なくpageし、表示はposition index順です。末尾でも`resumeCursor`を返し、空pageは入力cursorをechoします。

Admission gateは順に、同じkey再送を除くprincipal POST 6回/分、kill/profile-block/daily cost cap、global queued/running上限10、owner active job上限1、UTC日次quotaです。free quotaは5 job / 1024 position、precisionは2 / 512、1 jobは初期局面を含め最大513 position。GET系は120回/分、cancelは30回/分で、429は`Retry-After`を返します。admission成功後のowner quotaは消費扱いですが、別管理の日次cost reservationは完了positionまたは未dispatch分のcancel/failで戻し、実際のengine attempt costはidempotent ledgerに残します。warningは$0.50、daily capは$1.00で、見積りはinvoiceではありません。

D1は全chunkのoutboxを保存して先頭だけQueue送信します。fenced commit後に次chunkを送信し、Queue send回数の`delivery_count`とengine dispatch回数の`attempts` (最大2)を分離します。scheduled triggerは毎分outbox/lease/no-progressを回復し、期限切れleaseは該当Containerの`destroy()`確認前に再付与しません。DLQ current epochはjobを`partial`/`failed`で終端化し、古いmessageはackします。`incomplete`はretryしないfailed positionで、cacheしません。timeout/exit/restartだけ一度retryし、protocol/integrity errorはposition/jobを停止してprofile admissionをadmin解除までblockします。verified terminalの`none`/`no_legal_moves`/`win`は処理済みですが評価成功・cache対象ではありません。`resign`はevaluation missingに集計します。

cancelはまずD1へ`cancelling`を記録し、該当profile Containerへ`stop`を要求します。5秒以内にquiesceしない場合はそのContainerをdestroyし、破棄確認後に`cancelled`へ進めます。Mate結果はContainer内helperの`POST /prove`を3-ply/10,000操作budgetで呼び、proof revision/result/costをenvelopeに保存します。proofできなければ`null`で、engine mate scoreだけからbadgeを作りません。

Fault fixtureは `ANALYSIS_FAULT_FIXTURES_ENABLED=1` の時だけadmin routeでarm可能です。`destroy`はjobの1 dispatchを止め、`throw`はclaim前に指定回数 (1–4) throwしてQueue→DLQを検証します。driverの`MEESHOGI_TEST_SIGSTOP_ENGINE=1` はsearch後にchildを一度SIGSTOPし、通常のtimeout/reap/restartを通すtest-only hookです。いずれもstaging configで無効です。

`0001_init.sql` は既存schema、`0002_async_jobs_hardening.sql` はrowsを保持する追加migrationです。旧jobs/positions/cache内容は移行し、旧cacheは`quarantined=1`で保持しつつ読みません。既存terminal jobは履歴として残し、identityを持たない旧queued/running jobは`pre_identity_migration`理由で`failed`/`partial`へ閉じ、未完了positionsもterminalizeして旧Queue messageが新identityで再開しないようにします。Worker側ではstaging D1を参照していないため、Mainはapply前にactive jobがないことを確認してください。`0002`はローカルSQLiteで既存quota/cache/costとactive jobの保持・terminal化まで確認済みですが、staging D1には未適用です。`v3` Durable Object migrationは `AnalysisContainerPrecision` を追加し、既存 `v1`/`v2` は残します。principalはMainがtoken SHA-256 digestで別途seedします。

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
- W3 backend repairとprofile listingはこのcheckoutにあります。R2、アプリ統合、production resourceは対象外です。remote `0002` apply、v3 DO migration/deploy、principal seed確認、live dual-container routing/cancel/DLQ fault-injection、full-game cost観測はMainのstaging作業として残っています。

Mainのstaging記録にあるlive async job verificationは修正前buildに対するものです。現在のW3実装修正はlocal workerd suite対象で、remote D1 migration/seed/deploy、dual-container profile routing、async fault injection、5秒比較の再確認、full-game cost観測は未検証です。package内の合成workerd testsはCloudflare上の確認を代替しません。
