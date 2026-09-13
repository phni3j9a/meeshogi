# meeshogi

ミーアキャットをマスコットにした、iOS・Android向け棋譜解析・戦績管理アプリ。

無料の端末内棋譜解析を土台に、将来は有料のLLM解説・助言を追加します。

## 状態

無料版の機能実装と、今回合意した受入検証を完了しました。[PR #5](https://github.com/phni3j9a/meeshogi/pull/5)で統合前レビュー中です。KIFの取り込み・合法手検証、SQLite保存、戦績集計、Sekireiの端末内解析と分岐検討を利用できます。ログイン・通信・課金は利用条件に含めません。

Androidは実機での主要操作とCIの全14フローを確認しました。iOSはRelease Simulatorで各ページを撮影して目視し、詳細操作・全テーマ・文字拡大・実機性能の未検証分は継続検証として区別しています。画面は[採用モックとデザイン基準](docs/design/README.md)を踏襲します。検証の証拠と残る制約は[開発状況](docs/DEVELOPMENT.md)を参照してください。

## 開発

Node.js 22.23.2、Rust 1.96.0を使用します。JavaScript依存は `package-lock.json`、Rust依存は `native/sekirei/Cargo.lock` で固定しています。

```sh
npm ci
npm run check
cargo test --manifest-path native/sekirei/Cargo.toml --locked
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

解析にはsekirei-weightの現行候補 `c-leaf-wrm-seed42` を同梱し、読み込み時にSHA-256を確認します。固定したruntime・モデルの来歴と利用条件は[解析エンジン](docs/ENGINE.md)、戦型の判定条件は[分類ルール](docs/OPENINGS.md)を参照してください。

## 初期版の体験

1. 将棋ウォーズ・棋桜でコピーした棋譜を貼り付ける。
2. 端末内に保存し、一局全体を自動解析する。解析中も棋譜を操作できる。
3. 盤面・評価値グラフ・候補手から振り返り、自由に駒を動かして分岐を検討する。
4. 確定した1手詰め・3手詰めのバッジをタップして、答えを盤上で確認する。
5. 棋譜を蓄積し、勝敗・勝率や戦型別の戦績を確認する。

棋譜は端末内に保存し、KIFとして書き出せます。初期版ではアカウント登録や同期を必要としません。LLM解説・助言と課金は将来の機能です。

## 開発方針

- iOS・Androidを同時に進め、GitHub Actionsで両OSのビルド・起動・主要操作を検証する。
- `sekirei-weight`は実用的なweightの開発、本リポジトリはモバイル統合とアプリ体験を担当する。
- モックや固定の解析結果による画面検証と、実エンジンによる解析を区別する。
- まず無料版の一巡する体験を作る。LLM機能のためのサーバーや課金基盤を先行実装しない。

## 文書

- [初期版の製品仕様](docs/PRODUCT.md)
- [採用した9画面とデザイン基準](docs/design/README.md)
- [構成方針と未決事項](docs/ARCHITECTURE.md)
- [実装順序と両OSの検証](docs/DEVELOPMENT.md)
- [棋譜サンプルと取り込み期待値](fixtures/kif/README.md)
- [Codex向け作業指示](AGENTS.md)

## 関連プロジェクト

- [sekirei-weight](https://github.com/phni3j9a/sekirei-weight): 棋譜解析に使うweightの開発・評価。
- [meeterm](https://github.com/phni3j9a/meeterm): マスコットのシリーズと、両OSを並行検証する開発運用の参考。
