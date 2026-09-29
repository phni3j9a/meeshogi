# Android 開発版APK

[GitHub Releases](https://github.com/phni3j9a/meeshogi/releases) の対象Pre-releaseから **Assets → meeshogi.apk** をダウンロードする。arm64実機とx86_64に対応し、JS・Rustを同梱するためMetroは不要。

## 自動配布の条件

mainへのpushで共通CIが成功し、**そのpush全体にアプリのビルド入力の差分があるときだけ**APKを作る。PR、文書、テスト、Cloudサーバーだけの変更では配布しない。

対象は`app/`・`src/`・`modules/`・`native/`・`assets/`・エンジンビルドスクリプト、package／lockfile、Expo／Metroなどの設定と配布workflow。追加・変更・削除を判定する。一覧は`scripts/ci/android-release.py`の`BUILD_PATHS`を正本とする。

`ci.yml`の`logic`ジョブがpush前後の差分を判定し、成功後に再利用workflowの`android-release.yml`を呼ぶ。Actionsでは同じCI run内にAndroidのbuild／publishが表示される。PRは共通チェックだけで終了する。

checkoutは対象コミットとその祖先だけを取得し、evidenceブランチや全タグを取得しない。versionCode計算のためコミット履歴は取得するが、過去の不要なblobは遅延取得する。

## 更新・成果物

- コミットごとに`android-<versionCode>-<SHA>`のPre-releaseを作る。同じコミットの再実行は同じタグへ再掲載する。
- 添付はAPK、`SHA256SUMS`、`build.json`（ソースSHA・versionCode・ABI・署名指紋）。Actions artifactは7日保持。
- ビルド失敗時は対象runの失敗ジョブを再実行する。全テストや両OS受入のやり直しを配布条件に追加しない。
- 同じ署名の既存アプリへ上書き更新できる。データ保持のため、更新時にアンインストールする必要はない。

versionCodeは従来どおり`100000 + git rev-list --first-parent --count HEAD`。mainを前進させれば増加し、CIの再実行では不変。APKを作らないコミットは欠番になる。履歴の書き換えやoffsetの引き下げはしない。

署名は既存評価版と共通のExpo開発用署名で、ストア向けではない。SHA-256指紋は`fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`。ビルド後に署名、package ID、versionCode、Release属性、JS bundleと両ABIのライブラリを検査する。署名が異なる版や新しいversionCodeへの上書きはできない。

## 検証・Cloud設定

APK生成の成功はReleaseビルドと構造検査の結果。操作確認・実機性能は対象PRに別途記載する。正式配布前の確認は [DEVELOPMENT.md](DEVELOPMENT.md) を参照。

Actions Secret `EXPO_PUBLIC_CLOUD_ENDPOINT`に既存stagingの接続先を設定する。未設定ならビルドを止める。この値はAPKに組み込まれる公開設定なので、API tokenや管理用credentialを入れない。既存の匿名認証とサーバーの設定は変えない。
