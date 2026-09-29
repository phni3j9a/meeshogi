# 開発と検証

変更に関係する確認が通れば、その変更をPRにまとめる。毎回の両OSビルド、全Maestroフロー、全画面の撮影、Devin常駐セッションは完了条件にしない。

## 変更別の確認

| 変更 | 通常の確認 |
| --- | --- |
| 文書だけ | 差分とリンク。アプリテスト・ビルド不要 |
| 小さな文言・スタイル | 対象画面を手元の開発ビルドで確認。新規テスト・Release再ビルド不要 |
| 共通ロジック・保存・通信 | 型検査と関連テスト。不具合修正は再発を防ぐケースを追加 |
| OS連携・ネイティブ・依存 | 影響するOSでビルドと対象操作。共通のネイティブ変更は両OS |
| 正式配布・広範囲な変更 | 両OSで取り込み→解析→保存／再起動→書き出しの主要操作 |

対象を絞った操作確認を正式な検証として扱う。修正後は影響範囲を再確認し、変更していない範囲の検証を繰り返さない。使える環境がない場合は未確認を報告し、検証のためだけにVM・エージェントを自動起動しない。CI、画面の目視、実機の性能確認は別の事実として記載する。

## ローカルのチェック

Node.js 22.23.2、Rust 1.96.0。依存はlockfileで固定する。

```sh
npm ci                                  # 初回・依存変更時
npm run typecheck
npm test -- tests/storage/repository.test.ts  # 対象に合わせて選ぶ
npm run check                           # アプリ共通の一括確認
npm ci --prefix cloud
npm run check --prefix cloud             # Cloud変更時
cargo test --manifest-path native/sekirei/Cargo.toml --locked  # Rust変更時
npx expo install --check                 # Expo依存更新時
```

GitHub CIはPRとmainに対する共通チェックだけを行う。文書・任意のモバイル受入資材だけの変更は対象外。ローカルで全項目を重複実行する必要はない。配布ビルドは [ANDROID_RELEASES.md](ANDROID_RELEASES.md) を参照。

## 初回のモバイルビルド

AndroidはJDK 17 / SDK 36 / NDK 27.1.12297006、iOSはmacOS / Xcodeが必要。`android/`・`ios/`はExpo CNGの生成物でGit管理しない。

```sh
# Android
rustup target add aarch64-linux-android x86_64-linux-android
cargo install cargo-ndk --version 4.1.2 --locked
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/27.1.12297006"
npx expo prebuild --platform android --no-install
npm run android
# iOS
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
npx expo prebuild --platform ios --no-install
bash scripts/engine/build-ios.sh
pod install --project-directory=ios
npm run ios
```

以後のJS・UI変更は`npm start`で開発ビルドを再利用する。ネイティブコード・依存・app configが変わった場合に再生成／再ビルドする。Release固有の不具合調査や配布時にReleaseビルドを使う。

## 必要な場合の操作自動化

既存の`.maestro/`と`scripts/ci/*-acceptance.sh`は任意の回帰検証用。検証専用の端末／Simulatorで使う（データを消去する）。手動確認で十分な変更は自動化を追加しない。

```sh
ACCEPTANCE_FLOWS=analysis-review,candidate-review bash scripts/ci/android-acceptance.sh --installed
IOS_ACCEPTANCE_MODE=full ACCEPTANCE_FLOWS=analysis-review,candidate-review bash scripts/ci/ios-acceptance.sh
# 全体確認が必要な場合だけ、ACCEPTANCE_FLOWSを省略する
```

フローは前段のデータを使うため、必要な前段も指定する。ライセンス確認と取り込みは共通の準備として実行される。Cloudフローは接続先を組み込んだビルドとstagingが必要で、明示指定時だけ動く。iOSの既定はvisual、fullで操作フローを実行する。iOSのスクリプトは`RUNNER_TEMP/meeshogi-ios/Build/Products/Release-iphonesimulator/meeshogi.app`を利用可能なiPhone Simulatorへインストールする。Cloudを検証するRelease appはkeychain用にadhoc署名（`CODE_SIGN_IDENTITY=-`）する。

結果はローカルの`artifacts/`へ保存する。動画は`ACCEPTANCE_RECORD_VIDEO=1`を指定した場合だけ録画する。Gitへのログ・動画・APK追加やevidenceブランチ作成は行わない。共有は必要な画像・失敗ログだけをPRへ添付するか、期限付きartifactを使う。過去のevidenceブランチは整理済みで、受入結果の要約はPRと個別レポートを参照する。過去の全受入は現在の変更の完了条件にはしない。
