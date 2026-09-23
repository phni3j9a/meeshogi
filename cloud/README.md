# staging 解析サービス

## 構成と状態

このpackageは固定SFEN gate用の最小構成です。Worker `meeshogi-analysis-staging` と、SQLite Durable Objectを使う `AnalysisContainer` を一つだけ定義します。Containerは `standard-2`、最大instance数1、アイドル約30秒でsleepします。設定にproduction/default environment、D1、Queue、R2はありません。

Workerは `POST /v1/internal/analyze`、`GET /v1/internal/health` と、後続の明示停止用 `POST /v1/internal/stop` をBearer認証で保護します。解析入力はSFEN・movetime・MultiPVだけを受け付け、未知fieldや任意USI optionを拒否します。WorkerはtokenをContainerへ転送しません。公開model IDは `analysis-model-staging-v1` です。

USI driverはPython 3標準ライブラリだけで動き、起動時にengine・weightのSHA-256、USI handshake、対応option、`isready`を検証します。1 processを排他実行し、局面ごとに `usinewgame` を送ります。`info`をdepth / MultiPVごとに保持し、要求した全候補にexact scoreとPVが揃った最も深い反復だけを返します。lowerbound / upperboundを含む反復は選びません。cp / mate scoreはSFENの手番から先手視点へ変換します。

`engine_options.txt` の実内容は1行の `FV_SCALE 40` です。driverはこの行を固定allowlistとして読み、USI option `FV_SCALE` がエンジンから通知された場合だけ `setoption name FV_SCALE value 40` を送ります。`EvalDir` は同じimage内の `/opt/engine` に固定し、`Threads=1`、`USI_Hash=256`、`USI_Ponder=false`、`USI_OwnBook=false` と `BookFile=no_book` を設定します。HTTP入力からoption名・パス・USI commandは受け取りません。

## 依存とローカル検証

`cloud/package.json` は `wrangler@4.137.0`、`@cloudflare/containers@0.3.7`、TypeScript、Vitestを個別にpinします。Expoのroot packageは変更しません。

Workerは `../../src/cloud/analysis-contract` を相対importします。cloud側の `tsconfig.json` はこの純粋な共有ファイルを明示的に含め、root Expoの `tsconfig.json` は `cloud/` packageを除外します。そのためCloudflare runtimeの依存がroot mobile bundleへ入りません。

```sh
cd cloud
npm install
npm run typecheck
npm test
```

Python driver testはfake USI executableと合成weightを使います。

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

scriptはworker名が正確に `meeshogi-analysis-staging` で `-staging` 終端であること、environment overrideがないことを確認してから `wrangler deploy -c wrangler.staging.jsonc` を呼びます。production名や`--env`を追加する構成にはしません。

## Security / 今回含めない範囲

- Workerの全routeにBearer認証を要求し、Bearer tokenをcontainerへ転送したりログへ出したりしません。
- engine stdoutはUSI parserだけが読み、stderrは破棄します。公開のimage/model read、download、shell、debug route、汎用proxyはありません。
- 非公開artifact、image archive、Cloudflare token、staging secretをGitまたは公開artifactへ含めません。
- D1、Queue、R2、profile listing、job API、アプリ統合、production resourceはこのstepの対象外です。固定SFEN smokeが成功するまで後続実装へ進みません。

デプロイ前のAVX2実行互換性、Cloudflare accountの`standard-2`利用可否、外部private contextを使ったWrangler image buildの挙動は未確認です。Mainがdeploy / health / 固定SFEN smokeを行い、binary identityとCPU flagsを確認する必要があります。
