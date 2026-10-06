# meeshogi

ミーアキャットがマスコットの、iOS・Android向け棋譜解析・戦績管理アプリです。

将棋ウォーズ・棋桜のKIFを貼り付け／ファイルから取り込み、端末に保存して、盤面・評価値グラフ・候補手で振り返れます。KIF共有、自由な分岐検討、戦績・代表戦型の集計、4種類の駒セットに対応します。

## 現在の状態

- 端末内Sekirei（既定）、Cloud Free、Cloud Precisionを選択できます。分岐は評価値なしで盤上の合法手を試す機能で、局面単位の追加解析（深掘り）はありません。証明済み1手／3手詰めは、SekireiではSekireiの全局解析、Cloudではサーバーの証明から作ります。
- Cloudは開発用stagingです。匿名認証で利用し、現在は回数制限・Precisionの個別許可を無効化しています。同時active 1局・512手上限は維持します。
- 今後はCloudへ一本化します。Sekirei撤去後の解析仕様（サーバー詰み判定・オフライン・利用条件）は [Issue #45](https://github.com/phni3j9a/meeshogi/issues/45) で実装中、本番切替とSekirei撤去は [Issue #24](https://github.com/phni3j9a/meeshogi/issues/24) です。LLM解説・課金・同期は未実装です。
- M1〜M3（棋譜管理・解析・戦績）は実装済みです。両OSの過去の受入は [PR #12](https://github.com/phni3j9a/meeshogi/pull/12)・[PR #13](https://github.com/phni3j9a/meeshogi/pull/13)・[Issue #22の記録](docs/ISSUE-22-ACCEPTANCE.md) を参照できます。
- 最新のCloud結果処理の軽量化は共通テストまで確認済みです。Fold7での改善効果や両OSでの操作、実機の性能・発熱は未確認です。

## 開発

Node.js 22.23.2、Rust 1.96.0を使用します。採用バージョンはpackage／Cargoのlockfileを正本にします。

```sh
npm ci
npm start
# 変更したロジックの確認例
npm test -- tests/storage/repository.test.ts
# アプリ共通チェック
npm run check
```

ネイティブ解析を含むので、初回は開発ビルドが必要です。以後のJS・UI変更は同じ開発ビルドで確認します。毎回の両OSビルド・全フロー受入は不要です。[開発・検証手順](docs/DEVELOPMENT.md) を参照してください。

Androidの開発版は [GitHub Releases](https://github.com/phni3j9a/meeshogi/releases) から取得できます。[配布条件・上書き更新](docs/ANDROID_RELEASES.md)。

## 必要なときに読む文書

- [製品仕様](docs/PRODUCT.md)：現在の機能・守る挙動・対象外
- [構成](docs/ARCHITECTURE.md)：コードの配置と解析・保存の境界
- [開発手順](docs/DEVELOPMENT.md)：変更別の検証、ネイティブ初回ビルド、任意の操作検証
- [Cloudの運用](cloud/README.md)：staging設定・deploy・smoke
- [解析エンジン](docs/ENGINE.md)／[戦型分類](docs/OPENINGS.md)／[デザイン](docs/design/README.md)
- [解析方式の比較](docs/ANALYSIS-METHOD-STUDY.md)：Cloud移行の判断材料
- [探索条件の見直し](docs/CLOUD-PROFILE-RETUNE.md)：Free / Precisionを短くする候補の実測（Issue #46）
- [エージェントの作業指示](AGENTS.md)

変更の経緯と検証はIssue・PRに残し、ここへ作業ログを追記しません。
