# meeshogi

ミーアキャットをマスコットにした、iOS・Android向け棋譜解析・戦績管理アプリ。

無料の端末内棋譜解析を土台に、将来は有料のLLM解説・助言を追加します。

## 状態

無料版M1〜M3をまとめた[PR #5](https://github.com/phni3j9a/meeshogi/pull/5)はマージ済みです。Issue #7の解析正しさ修正は[PR #13](https://github.com/phni3j9a/meeshogi/pull/13)で統合済みです。Sekirei v0.3.37を固定し、ResidualMaterial評価、単一合法手の実探索、`meta`/`incomplete`契約、終局表示、identityによる旧キャッシュ除外を追加しています。ログイン・通信・課金は利用条件に含めません。

PR #12では、[棋譜解析画面の改善](docs/design/analysis-refresh.md)と[4種類の駒セット](docs/design/piece-sets.md)を追加しました。解析正しさ修正を取り込み、Android emulatorとiOS Simulatorの両方で実エンジンのReleaseビルド・起動・主要操作・画面を確認済みです。初回受入で見つかったiOSのグラフ操作と最大文字の表示も修正し、両OSで再受入しました。結果・証拠・未確認事項は[開発状況](docs/DEVELOPMENT.md#pr-12-解析画面と駒セット)に記録しています。

Issue #7の修正では、公開fixtureを使うA/B/C/Dのhost診断に加え、製品コード`6a54ff5`でAndroid emulator・iOS Simulatorの新規ビルド・起動・受入フロー・両OSスクリーンショット目視まで検証済みです（両OSともMaestro 15フロー成功・失敗0。iOSは別検査として書き出しKIFとfixtureのバイト一致も確認）。証拠は `evidence/android-20260922`（run `20260922T203618Z-74028`）と `evidence/ios-20260922`（run `20260922T204527Z-37636`）に保存しています。実機での動作・性能は未検証です。画面は[採用モックとデザイン基準](docs/design/README.md)を踏襲します。検証の証拠と残る制約は[開発状況](docs/DEVELOPMENT.md)を参照してください。

Issue #19では、モバイル製品から独立した認証付きCloudflare staging解析ゲートを構築し、private image build・4 fixture smoke・timeout/recoveryを実環境で検証済みです。初期版アプリは引き続き端末内で解析し、このWorkerへの接続やログインを利用条件にしません。このゲートはproduction serviceではありません。検証結果と手順は[cloud README](cloud/README.md)を参照してください。

Issue #20では、このstagingゲートで同じengine/modelの探索条件48種を実戦由来60局面で比較し、Free / 精密解析の初期候補と代替候補を[profile比較レポート](docs/CLOUD-PROFILE-BENCHMARK.md)にまとめました。2026-09-26に初期候補が承認されました。承認済みのprofileは、Freeがstandard-2 / Threads 1 / 1000ms / MultiPV 2、精密解析がstandard-3 / Threads 2 / 5000ms / MultiPV 3です（Hashはどちらも64 MiB）。アプリへの組み込みは、#21以降で行います。

全局解析では、native境界で検証済みの初回反復の予算不足だけをその局面の欠測として扱い、後続局面の解析を続けます。処理が最後まで走っても不足が残る場合は解析済み件数と探索量不足の件数を分けて表示し、全局面の有効結果が揃った場合だけ全局解析完了と表示します。不完全な候補は保存せず、再起動後は保存済み結果と欠測だけを表示します。

## 開発

Node.js 22.23.2、Rust 1.96.0を使用します。JavaScript依存は `package-lock.json`、Rust依存は `native/sekirei/Cargo.lock` で固定しています。

```sh
npm ci
npm run check
cargo test --manifest-path native/sekirei/Cargo.toml --locked
bash scripts/engine/static-eval-cross-check.sh
```

ネイティブ解析を含むため、開発用アプリをビルドします。AndroidはJDK 17 / SDK 36 / NDK 27.1.12297006、iOSはmacOS / Xcodeが必要です。`android/` と `ios/` はExpo CNGの生成物として扱います。

```sh
rustup target add aarch64-linux-android x86_64-linux-android
cargo install cargo-ndk --version 4.1.2 --locked
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/27.1.12297006"
npx expo prebuild --platform android --no-install
npm run android
# macOS:
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
npx expo prebuild --platform ios --no-install
bash scripts/engine/build-ios.sh
pod install --project-directory=ios
npm run ios
```

iOSはRustのXCFrameworkと同梱モデルを生成してからPodをインストールします。CIの操作検証と、ビルド済みSimulatorアプリを使う再検証の手順は[開発状況](docs/DEVELOPMENT.md#操作検証の実行)を参照してください。

解析にはsekirei-weightの現行候補 `c-leaf-wrm-seed42` を同梱し、読み込み時にSHA-256を確認します。固定したruntime・モデルの来歴と利用条件は[解析エンジン](docs/ENGINE.md)、戦型の判定条件は[分類ルール](docs/OPENINGS.md)を参照してください。Issue #7のvariant比較は診断専用の[ハーネス](scripts/diagnostics/README.md)を参照してください。

## 初期版の体験

1. 将棋ウォーズ・棋桜でコピーした棋譜を貼り付ける。
2. 端末内に保存し、一局全体を自動解析する。解析中も棋譜を操作できる。
3. 盤面・評価値グラフ・候補手から振り返り、自由に駒を動かして分岐を検討する。
4. 確定した1手詰め・3手詰めのバッジをタップして、答えを盤上で確認する。
5. 棋譜を蓄積し、勝敗・勝率や戦型別の戦績を確認する。

棋譜は端末内に保存し、KIFとして書き出せます。初期版ではアカウント登録や同期を必要としません。LLM解説・助言と課金は将来の機能です。

## 開発方針

- iOS・Androidを同時に進める。GitHub Actionsの`ci.yml`は共通ロジック・型検査・Rustテストを確認し、モバイルのビルド・起動・主要操作はDevin Cloudの各OS受入セッションで別に検証する。
- `sekirei-weight`は実用的なweightの開発、本リポジトリはモバイル統合とアプリ体験を担当する。
- モックや固定の解析結果による画面検証と、実エンジンによる解析を区別する。
- まず無料版の一巡する体験を作る。LLM機能のためのサーバーや課金基盤を先行実装しない。

## 文書

- [初期版の製品仕様](docs/PRODUCT.md)
- [採用した9画面とデザイン基準](docs/design/README.md)
- [構成方針と未決事項](docs/ARCHITECTURE.md)
- [実装順序と両OSの検証](docs/DEVELOPMENT.md)
- [Issue #7エンジン診断ハーネス](scripts/diagnostics/README.md)
- [棋譜サンプルと取り込み期待値](fixtures/kif/README.md)
- [Codex向け作業指示](AGENTS.md)

## 関連プロジェクト

- [sekirei-weight](https://github.com/phni3j9a/sekirei-weight): 棋譜解析に使うweightの開発・評価。
- [meeterm](https://github.com/phni3j9a/meeterm): マスコットのシリーズと、両OSを並行検証する開発運用の参考。
