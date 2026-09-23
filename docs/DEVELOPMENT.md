# 開発の進め方

## 現在地

2026年9月23日現在、無料版M1〜M3をまとめた[PR #5](https://github.com/phni3j9a/meeshogi/pull/5)と関連する#9/#11はマージ済みである。Issue #7の解析正しさ修正はPR #13で統合済み。現在はPR #12の画面刷新を最新mainへ追従させ、両OSの受入検証を進めている。Expo SDK 57 / React Native 0.86.3、tsshogi 2.3.4、SQLiteとRustの解析経路を採用し、モバイル受入はDevin Cloud常駐セッションへ移行済み（Issue #8）である。GitHub Actionsの`ci.yml`は共通ロジック・型検査・Rustテストを検証し、モバイル受入の代わりにはしない。

### PR #12: 解析画面と駒セット

盤面・評価グラフ・候補手・手送りを再構成し、グラフの横ドラッグで局面を確認できる。設定では黄楊・白木・桜木・青磁を比較して選択でき、SQLite保存後に盤上・持駒・詰み手順へ共通反映する。生成済み23PNGは約0.55MiB。仕様と以前のWeb検証は[画面の改善](design/analysis-refresh.md)・[駒セット](design/piece-sets.md)を参照。

最新mainの詰み終局・探索量不足の部分終了・旧解析cache除外を新画面へ統合する。駒セットの旧設定互換・保存失敗・再起動後の復元と、進行中の解析を止めない動作も回帰検証する。ネイティブ受入結果は実行後に記録する。

### PR #13: 解析正しさの検証履歴

Issue #7の実装状態は、Sekirei v0.3.37（`7fd1d9b42a85fbc5aeb222f8aa453d3e08f3c0ac`）固定、既存weight `c-leaf-wrm-seed42`（SHA-256 `807c18da03521414a8c75dfe51dd4de2caf8e9ec4909320826eac12b66852eab`）の維持、探索内でのResidualMaterial（material 1 + NNUE 1、bias 0、clip 0）、成功payloadの`meta`、未完成探索の`incomplete`、checkmate/no-legal-movesの終局区別、engine/model identityによる旧cache除外までを含む。今回の継続修正では、native境界で整合性を確認できた初回反復の予算不足だけを局面単位でスキップし、後続局面を処理する`partial`終了と正直な再起動後表示を追加する。payloadとidentityは変更しない。

この作業でホスト上確認したのは、公開fixture `fixtures/analysis/positions.json`に対する診断専用A/B/C/D比較である。Threads 1、`SpecTopN=0`、局面ごとに新規16 MiB TT、`max_depth=8`、1/10,000 nodes（連続王手局面は100,000/1,000,000 nodes）を揃え、v0.3.36 NNUE-only、単一合法手だけを直した隔離版、v0.3.37 Absolute、candidate worktreeのbridgeを初期化したResidualMaterialを比較した。結果は[エンジン診断記録](ENGINE-DIAGNOSTICS.md)とハーネスのREADMEに保存する。

診断で、単一合法手の製品baselineは実nodes 0のまま完了扱いになる一方、修正版・v0.3.37では同じ局面が実探索（代表値164 nodes）へ入ること、連続王手でbaselineのmate→CP→mate往復を再現できることを確認した。これはホスト上のcore/bridge初期化診断であり、アプリのビルド・起動・操作・画面受入や棋力向上の証拠ではない。診断用Bは製品へ切り替えない。

このcandidateでIssue #7の受入検証として完了したものは、製品コード`6a54ff5`からのAndroid/iOS新規ビルド、インストール・起動、公開fixtureの再解析、予算不足を挟む後続局面までの停止・再開・旧cache更新、部分終了/終局表示、分岐復帰、両OSのスクリーンショット目視である。Devin CloudのAndroid emulatorでMaestro 15フロー成功・失敗0（`evidence/android-20260922` run `20260922T203618Z-74028`）、iOS Simulatorでも15フロー成功・失敗0（`evidence/ios-20260922` run `20260922T204527Z-37636`）を確認した。iOSでは一部フローにhelperと条件分岐を使い、最後の書き出しKIF比較はapp-cache内のコピー `exported-shogiwars.kifu` でfixtureとのバイト一致を確認した。実機での検証とユーザー報告の150手棋譜は残る。

全局解析の予算不足制御

`incomplete` payloadは、SFEN・identity・条件・`meta`・合法fallback・詰み証明をnative境界で検証し、初回反復の予算不足として成立した場合だけ専用エラーにする。storeはその局面を保存せず一度だけスキップし、後続局面を直列に解析する。走査完了時に不足があれば今回のjobを`partial`にして、解析済み件数と探索量不足件数を表示する。jobの不足履歴やfallbackはSQLiteへ保存しないため、再起動後は保存済みの現行結果件数と欠測だけを表示する。設定変更、停止、棋譜削除、別棋譜開始、通常エラー、保存失敗は既存のgeneration/cancellation/write guardで処理を停止し、不足スキップへ変換しない。

このcandidateでは`npm run check`（typecheckとVitest 106 tests）、`npm ci`、`git diff --check`、製品nativeの`cargo test`、`scripts/engine/test.sh`（モデルSHA-256検証とRust 24 tests）を実行して通過した。GitHub Actionsの`ci.yml`も候補SHAで成功している。native検査とCI通過・host目視・emulator／Simulator・物理端末は分けて報告する。

## 継続する検証と対象外

Issue #7では、iOS Simulator／Android emulatorまたは実機で各ページを撮影し、実際に目視することを受入条件にする。次の未検証分は残す。

- 実iPhone・実Android端末での動作・応答時間、署名配布・TestFlight。Issue #7のモバイル受入はエミュレーター／Simulatorまでで、実機は未検証として残す。
- 両OSの一定フレームレート、長時間使用時の発熱・消費電力、大量の実棋譜を持つ物理端末での性能。合成1,000局の過去確認は機能検証と参考測定に限る。
- 研究側のSekirei v0.3.4系runtimeとアプリv0.3.37、研究TT 64 MiBとapp bridge 16 MiB、nativeへ過去の対局履歴を渡さない条件差。静的評価の整数一致は探索全体の再現や棋力向上を主張する根拠にしない。
- ユーザーから報告された150手の対局データは未取得であり、その棋譜の原因確定とは区別する。

AIチャット・LLM解説、ログイン、クラウド同期、課金、分岐の永続保存は今回の無料版の対象外であり、次の独立した開発段階とする。

## 実装のまとまり

機能を細かい骨組みだけに分割せず、ユーザーが使える一巡を単位に進める。各まとまりでiOS・Androidを同時に開発する。M1〜M3のiOS検証は今回合意したページごとの目視確認を受入基準とし、下記の詳細操作の自動化は継続検証用として保持する。

### M1: 両OSで棋譜を取り込み、保存して振り返る

- 技術選定を具体化し、依存バージョンを固定する。
- 採用済みのモックを3タブと各詳細画面に反映し、両OSで盤面・文字・タップ操作を確認する。静止画にない空状態・エラー・解析中や、文字サイズ変更・キーボード表示時も確認する。
- 両OSのアプリ土台と、共通ロジックを確認するGitHub Actionsを作る。
- 2サービスの貼り付けとKIFファイル取り込み、局面再生・手送り、自分の名前設定、勝敗判定を実装する。
- 棋譜一覧、検索・お気に入り・前回の続き、端末内保存、再起動後の読み込み、KIF書き出しをつなげる。
- Devin CloudのAndroid／iOS受入セッションで取り込み・盤面遷移・保存後の再起動を確認する。`ci.yml`はこのモバイル操作の代わりにしない。

完了条件: サンプルを取り込んで手送りでき、アプリを開き直しても本譜と対局情報が残る。書き出したKIFを再読込して同じ本譜・結果になる。解析表示が固定データなら、その旨を開発画面と成果報告で明示する。

### M2: 実エンジンで解析・自由検討・短手数詰み

- 採用するSekireiとweightを固定し、両OSで読み込みと実探索を確認する。
- 自動全局解析、段階的なグラフ更新、保存、停止・再開、選択局面の深掘りを実装する。
- 候補手の再生、合法手による分岐検討、「本譜に戻る」をつなげる。
- 1手詰め・3手詰めを確定判定し、バッジから答えを再生できるようにする。

完了条件: 両OSで実際の局面に対する解析結果が返り、操作を継続できる。分岐の結果が本譜へ混入せず、詰みは全応手への検証を通る。シミュレーターだけで判断せず、端末性能・発熱などの製品検証を別途行う。

### M3: 戦績・代表戦型と無料版の仕上げ

- 通算・月別・先後別・サービス別の集計を実装する。
- 代表戦法と対戦構図の分類、未分類、手動修正、自分／相手別の集計を実装する。
- 重複取り込み、他人の棋譜、結果不明などで戦績が壊れないことを確認する。
- 取り込みから解析・検討・保存・書き出し・戦績まで一巡して確認する。

M1〜M3で無料の初期版を構成する。LLM・課金は次の独立した開発段階とする。

## 検証方針

meetermの両OSを継続的に検証する運用を参考にし、meeshogiの機能に合わせて検証する。2026年9月から、エミュレーター／Simulatorを使う受入検証はDevin Cloudの常駐セッションで実行する。GitHub Actionsの `ci.yml` は共通ロジック・型検査・Rustテストの高速チェックのみを担い、モバイル実機相当の受入はブロックするstatus checkにはしない。

## Devin Cloudのモバイル検証

受入検証は次の常駐セッションで実行する。

| セッション | 環境 | 用途 |
| --- | --- | --- |
| [`a1f26864422748319e24fcab5b2b0e85`](https://app.devin.ai/sessions/a1f26864422748319e24fcab5b2b0e85) | Devin Cloud macOS (Apple Silicon) | iOS Simulator受入（visual / full） |
| [`43b7a4407f3b4965a5bafba70b089b7d`](https://app.devin.ai/sessions/43b7a4407f3b4965a5bafba70b089b7d) | Devin Cloud Linux (KVM) | Android ビルド・エミュレーター・Maestro受入 |

実行の流れ:

1. 検証したいコミットとスイートをMain（このCLI）へ依頼する。Mainは `scripts/ci/devin-cloud.py` で対象セッションへ指示を送り、`status` で完了を確認する（下記「セッションの駆動」）。
2. セッションは `git fetch && git reset --hard <SHA>` で正確なコミットへ合わせ、`npm install`・prebuild・ビルド・受入スクリプトを実行する。永続VMのツールチェーンは再利用するが、VMの状態をソースの正本として扱わない。
3. 結果は `artifacts/<OS>/` ごと `evidence/<platform>-<yyyymmdd>` のorphanブランチへpushされる。Mainがブランチをfetchしてスクリーンショットを実際に開き、証拠つきで報告する。最終判定は人間が行う。
4. 失敗時は同じセッションでその場調査できる（liveのadb/xcrun、エミュレーター状態の観察）。これがホスト型ランナーのログだけの運用に対する利点。

上の2セッションはDevin Web UIで作成したもので、暖機済みのVMと同一セッション内の成果物再利用のため引き続き既定の送信先とする。汚染・コンテキスト圧迫で作り直す場合は、Web UIを使わずに `devin-cloud.py new` で新しいSWE-2セッションを立て、上の表のIDを更新する。

### セッションの駆動

```sh
python3 scripts/ci/devin-cloud.py list                    # --all でアーカイブ済みも表示
python3 scripts/ci/devin-cloud.py new --platform macos --prompt-file prompt.md --wait 60
python3 scripts/ci/devin-cloud.py send <session-id> --prompt-file prompt.md --wait 60
python3 scripts/ci/devin-cloud.py status <session-id> --messages 3
```

ヘルパーはDevin CLIの `devin acp --cloud`（ACPのcloud relay）を使い、CLIの `devin auth login` の資格情報で動く。`DEVIN_API_KEY` は使わない。

- `new` は既定で `--repo phni3j9a/meeshogi --version devin-swe-2-max` とする。relayが提示しない値は拒否し、作成後のセッションが要求したversionを報告しなければ失敗にする。
- `--wait` を過ぎても続くターンは失敗ではなく「detached」と表示する。Cloud側の作業は継続するので、長い受入は短い `--wait` で送り、`status` で結果を確認する。
- `status` は直近のDevinメッセージを再生し、状態・platform・`devinVersionOverride`・URLを出力する。
- Cloud側からのローカル操作要求（ファイル参照や許可確認）には応じない。受入実行にはローカルのツールを使わない。

ACPを使う理由と制約:

- REST APIの `POST /v3/organizations/{org}/sessions` は `devin_mode`（`normal/fast/lite/ultra/fusion`）しか受け付けず、SWE-2を選べない。
- ACP relayの `session/new` が返す `configOptions` には次がある。いずれも最初のプロンプト前に `session/set_config_option` で設定する。
  - `devin_version`：`devin-swe-2-low/high/max` とpriority版
  - `platform`：`linux/macos/windows`
- CLIの文書ではcloud ACPはinsiders向けと表記されており、`devin_version` の値も公開APIではない内部識別子である。確認はCLI 3000.11.1、2026-09-23。
- 値が提示されなくなった場合 `new` は失敗する。そのときはWeb UIでSWE-2セッションを作成し、`send`/`status` で駆動する。別モデルで受入を実行しない。

2026-09-23に `new` で作成した新規セッションの実測（読み取りのみ）:

- Linux：blueprintの暖機状態があった。
  - Node 22.23.2、Rust 1.96.0（Android targets）、cargo-ndk 4.1.2、OpenJDK 17.0.19
  - Android SDK：build-tools 35/36、NDK 27.1.12297006、`system-images;android-36;google_apis`
  - AVD `acceptance`、Maestro 2.10.0、`~/.gradle/init.gradle`、`/dev/kvm`
  - 8 vCPU / 31 GiB、`~/repos/meeshogi`（`node_modules` 含む）
- macOS：blueprintのmacOS文書に相当する状態が起動時から入っており、下の手動ブートストラップは不要だった。
  - Apple M4 Pro (Virtual)、16 GiB
  - `~/.cargo/bin` のrustup proxy、Rust 1.96.0（iOS targets）
  - Homebrewの `node@22` 22.23.2と `cocoapods` 1.17.0
  - Maestro 2.10.0（`~/maestro-2.10.0`）、OpenJDK 17.0.20.1、blueprintの `ENVRC` PATH行
  - Xcode 26.6（17F113）、iOS 26.5/27.0 Simulator runtime
  - 初回応答の前に、Cloud側が「`phni3j9a/meeshogi` のpull commandsに5分30秒かかった」と警告した。

以下は、これらのツールが欠けたmacOSセッションへ送る予備手順として残す:

```bash
mkdir -p ~/.cargo/bin
RUSTUP_BIN="$(brew --prefix rustup)/libexec/bin/rustup"
for t in cargo rustc rustdoc rustfmt cargo-clippy clippy-driver cargo-fmt; do
  ln -sf "$RUSTUP_BIN" "$HOME/.cargo/bin/$t"
done
export PATH="$HOME/.cargo/bin:$PATH"
rustup default 1.96.0
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
HOMEBREW_NO_AUTO_UPDATE=1 brew install cocoapods node@22
brew link --overwrite node@22 || true
bash scripts/ci/install-maestro.sh  # RUNNER_TEMP未設定時は/tmp配下
echo 'export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/node@22/bin:$PATH"' >> ~/.zprofile
```

`/opt/homebrew/bin/rustup` はargv\[0]を落とすbrewのラッパーなので、proxyはlibexecの実バイナリへリンクする。

| 検証           | 必要な証拠                                                                           |
| -------------- | ------------------------------------------------------------------------------------ |
| 共通ロジック   | KIF取り込み、局面再生、勝敗、保存整合性。実装後は詰みと分類も追加                    |
| Android        | ビルド、エミュレーターへのインストール・起動、対象操作、クラッシュ検出               |
| iOS            | ビルド、Simulatorへのインストール・起動、各ページのスクリーンショットと目視確認       |
| UI             | 両OSのスクリーンショットを保存し、実際に目視確認                                     |
| 実エンジン統合 | ネイティブ経路で実局面の探索完了と有効な結果。モジュールの存在確認だけでは代替しない |

- SDKのインストール確認やビルド成功だけを、アプリの操作確認として扱わない。
- 初期のiOS CIは署名不要のSimulatorを使う設計とする。実機配布・TestFlightは別の段階。
- 失敗時もログ・スクリーンショットなど取得できた診断情報を保存する。取得できなかった場合は理由を記録する。
- 依存更新は両OSで検証する。生成物を使う方式を採用する場合は、クリーンなチェックアウトから再現する。
- エミュレーター／Simulatorの成功と、実機の性能・発熱・バックグラウンド動作の成功を区別する。
- 起動だけのスモークから始め、実装した機能に合わせて受入検証を増やす。未実装機能の成功マーカーを作らない。

## 操作検証の実行

`.maestro/` にライセンス・取り込み・対局者名・全局解析・候補手・分岐・詰み・ファイル・戦績修正・表示・KIF出力・背景停止・文字拡大・検索・削除のフローを置く。受入実行では次のスクリプトがOSのクリップボード、ファイル入力、録画、実行結果をまとめる。いずれもDevin Cloudの該当セッション内で実行される。

```sh
# ビルド済みAPKと接続済みAndroid emulator/deviceを使用
bash scripts/ci/android-acceptance.sh
# インストール済みの同じアプリを検証する場合
bash scripts/ci/android-acceptance.sh --installed
# macOS: RUNNER_TEMP配下のSimulator向けRelease appで各ページを撮影
bash scripts/ci/ios-acceptance.sh
# iOSの詳細な操作検証を追加で実行する場合
IOS_ACCEPTANCE_MODE=full bash scripts/ci/ios-acceptance.sh
```

受入フローはアプリのデータを消去して固定サンプルを取り込む。AndroidとiOSのfullモードは、最後にサンプル1局を削除する。両OSで最初にライセンス原文と対象パッケージ一覧を撮影する。iOSの既定visualモードは、その後の取り込みと基本解析を通して、主要9画面と対局情報・ライセンスを撮影する。個人の棋譜を保存したアプリでは実行しない。クリップボード・ファイル共有を確認する補助アプリはCI専用で、製品アプリへ同梱しない。AndroidとiOSのfullモードでは、出力KIFを共有先から回収し、原本とバイト単位で比較する。各回の証拠は `artifacts/<OS>/runs/` の個別ディレクトリへ保存し、実行後にevidenceブランチへpushする。

常駐セッションではビルド済みの `.app` がVM上に残るため、操作フロー（`.maestro/`・受入スクリプト・文書）だけを修正した場合は `scripts/ci/ios-app-artifact.sh` の package / verify / restore で同じアプリを再利用して再検証できる。再利用は製品ソース（`app`・`src`・`modules`・`native`・`assets`・`scripts/engine`・`ci.yml` 等）のフィンガープリント一致とSHA-256を検査した場合に限る。製品・ネイティブ・モデル・設定が変わった場合は通常ビルドが必要。再検証だけの実行は両OSを含む受入の代わりにはしない。

## 取り込み・将棋ロジックの重点確認

`fixtures/kif/README.md`の期待値を実装時の回帰検証に使う。追加で「同」、成り・不成・持駒・打ち歩詰め、引き分け・中断、重複取り込み、曖昧な自分の名前を扱う。

詰みの検証には、1手詰め、1手では詰まない3手詰め、逃れのある見かけの詰み、王手中の局面、禁止される打ち歩詰め、探索中断を含める。ユーザー提供の通常対局2局だけで詰み判定を検証済みとしない。

## PRで伝えること

変更により可能になった操作、両OSの検証結果、スクリーンショットの確認結果、残る制約を記載する。文書のみの変更では実行していないアプリテストやCI成功を主張しない。
