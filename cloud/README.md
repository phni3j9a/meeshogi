# staging 解析サービス

## 構成と状態

Mainのstaging実行記録では固定SFEN gateは成功済みです。このpackageはその後の比較用最小構成です。Worker `meeshogi-analysis-staging` と、SQLite Durable Objectを使う `AnalysisContainer` を一つだけ定義します。通常設定は `standard-2`、最大instance数1、アイドル約30秒でsleepします。`wrangler.staging-2vcpu.jsonc` は同じstaging worker・image digestで `standard-3` を選ぶ比較用設定です。設定にproduction/default environment、D1、Queue、R2はありません。

Workerは `POST /v1/internal/analyze`、`POST /v1/internal/bench/analyze`、`GET /v1/internal/health` と、後続の明示停止用 `POST /v1/internal/stop` をBearer認証で保護します。解析入力はSFEN・movetime・MultiPVと、benchmark routeでのみThreads / Hashの限定値を受け付け、未知fieldや任意USI optionを拒否します。WorkerはtokenをContainerへ転送しません。公開model IDは `analysis-model-staging-v1` です。benchmark routeは管理者向け内部計測専用であり、公開app APIや将来のpublic job APIへ含めません。

USI driverはPython 3標準ライブラリだけで動き、起動時にengine・weightのSHA-256、USI handshake、対応option、`isready`を検証します。1 processを排他実行し、局面ごとに `usinewgame` を送ります。`info`をdepth / MultiPVごとに保持し、要求した全候補にexact scoreとPVが揃った最も深い反復だけを返します。lowerbound / upperboundを含む反復は選びません。cp / mate scoreはSFENの手番から先手視点へ変換します。

`engine_options.txt` の実内容は1行の `FV_SCALE 40` です。driverはこの行を固定allowlistとして読み、USI option `FV_SCALE` がエンジンから通知された場合だけ `setoption name FV_SCALE value 40` を送ります。`EvalDir` は同じimage内の `/opt/engine` に固定し、通常の `Threads=1`、`USI_Hash=256`、`USI_Ponder=false`、`USI_OwnBook=false` と `BookFile=no_book` を設定します。管理者向けbenchmark routeのみThreads 1–2、Hash 16–512 MiBを指定できます。HTTP入力からoption名・パス・USI commandは受け取りません。

healthとbenchmark応答にはbest-effortのengine RSS / peak RSS / CPU時間とcgroup memoryを含めます。計測値が読めない環境でも解析は継続し、その値を省略します。

## 依存とローカル検証

`cloud/package.json` は `wrangler@4.137.0`、`@cloudflare/containers@0.3.7`、TypeScript、Vitestを個別にpinします。Expoのroot packageは変更しません。

Workerは `../../src/cloud/analysis-contract` を相対importします。cloud側の `tsconfig.json` はこの純粋な共有ファイルを明示的に含め、root Expoの `tsconfig.json` は `cloud/` packageを除外します。そのためCloudflare runtimeの依存がroot mobile bundleへ入りません。

```sh
cd cloud
npm install
npm run typecheck
npm test
```

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

Dockerfileはbuild contextに `engine`、`nn.bin`、`engine_options.txt`、`driver.py` があることを前提にし、linux/amd64のUbuntu 24.04を使います。Mainはprivate contextとは別の `/tmp` 一時directoryを作り、準備済みの3 artifactと公開コード `container/driver.py` だけをそこへ配置してbuildします。`BASE_IMAGE` はMainがdigest pinし、`EXPECTED_ENGINE_SHA256` と `EXPECTED_WEIGHT_SHA256` はartifact digestをbuild ARGからENVへ渡します。image内にはAPI tokenを入れません。build後にprivate contextと一時build contextを消してください。

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
- D1、Queue、R2、profile listing、job API、アプリ統合、production resourceはこのstepの対象外です。固定SFEN smokeが成功するまで後続実装へ進みません。

Mainのstaging記録ではhealth、実engineの固定SFEN解析、AVX2を確認済みです。`standard-3`の利用可否と両instance typeのbenchmark、cost測定はこれからです。package内の合成テストはこれらCloudflare上の確認を代替しません。
