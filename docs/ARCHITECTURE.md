# 構成

Expo / React Nativeの共有アプリと、端末内Sekirei・Cloud解析の2経路で構成する。現在の依存はpackage／Cargoのlockfile、機能上の規則は [PRODUCT.md](PRODUCT.md) を正本とする。

## コードの配置

| 場所 | 責務 |
| --- | --- |
| `app/`・`src/ui/` | 3タブと詳細画面、盤面、グラフ、候補手 |
| `src/domain/` | tsshogiによるKIF解釈・局面再生・合法手・勝敗・戦型 |
| `src/storage/`・`src/store/` | SQLite保存・Zustand状態・解析の進行 |
| `src/analysis/`・`modules/sekirei/`・`native/sekirei/` | 端末内解析の契約・Expo Module・Rust |
| `src/cloud/`・`src/store/cloud-controller.ts` | 匿名credential・Cloud API・永続jobへの再接続 |
| `src/comparison/` | 開発用の解析方式比較export |
| `cloud/` | Worker・D1・Queue・private engine Container |

OSプロジェクトはExpo CNGで生成する。生成物をGit管理せず、変更元はapp config・local Expo Module・Rustソースとlockfile。UIの将棋処理はMITのtsshogi、保存はexpo-sqliteを使う。新しいエンジンやLLM・同期用の汎用基盤は先行実装しない。

## 端末内解析と保存

Sekirei v0.3.37と自作weightを固定し、ResidualMaterialで探索する。モデルの来歴・identity・研究条件との差は [ENGINE.md](ENGINE.md) を参照する。研究側のweight品質目標とモバイルの性能条件は分ける。

- 全局・深掘り・分岐を区別し、古い要求の結果を現在の局面に表示しない。解析は直列で行う。
- 結果はSFEN・engineId・modelId・nodes・候補数の完全一致と`status=complete`を確認して再利用する。契約・評価方式・探索patchを変えたらidentityも更新する。
- native境界で検証済みの初回反復の予算不足だけを局面単位でスキップする。不正payload・保存失敗・キャンセルは処理を停止する。今回の不足理由は保存せず、再起動後に推定しない。
- 設定変更や背景移行で端末内解析を中断する。generation／write guardで古い条件の結果保存を防ぐ。
- 元KIF、本譜、原本結果を保持し、手動結果・戦型を分離する。設定と対局の帰属更新はtransactionでまとめ、戦型の片側修正は最新行へ適用する。
- 駒セットは設定JSONに保存し、不明なIDは黄楊へ戻す。保存成功後に表示を変え、解析を再起動しない。対戦構図は両者の有効な戦型から導出する。

初期予算は10,000 nodes・2候補、深掘りは設定の5倍（上限1,000,000）。bridgeのTTは16 MiBで、過去の対局履歴は渡さない。値は端末性能の達成目標ではない。

## Cloud解析

方式は`sekirei`・`cloud-free`・`cloud-precision`。接続先はビルド時の`EXPO_PUBLIC_CLOUD_ENDPOINT`、credentialはSecureStoreに保存する。Cloud結果の合法PV・合法手数・終局はサーバーが検証し、端末は形式・局面・identity・profile・評価値・実効候補数を検証する。読み込み時の全合法手生成や全PV再生は繰り返さない。

- `cloud_attempts`・`cloud_results`・`cloud_meta`に要求・結果・契約epochを保存する。POST前にidempotency keyと送信回数を永続化し、応答ロスト後も同じjobへ復帰する。
- server確認cursorと受信cursorを分け、結果をatomic commitし、終端確認後も未回収の結果を取得してからpollを止める。
- credential喪失・不正・owner不一致・401を区別する。未確認の要求がある間は代替credentialを発行しない。
- 初回POSTへの確定的な契約4xxだけを`not_created`とする。応答不明や再送拒否では対応を保持する。棋譜削除の例外はPRODUCT.mdに従う。

サーバーは1棋譜を1 jobとしてD1へ保存し、profile別Queue consumerがjobId名の専用Containerでdriverの`/session`を読み、局面単位に検証して書き込む。条件付き書き込みで取消後の遅延結果・重複配信を排除し、完了・失敗・取消後はContainerを停止する。driverはsessionごとにengine processを再利用し、取消／取り残されたsessionを停止する。全経路で`PvInterval 0`を指定する。

2026-10-04のstaging実測では、consumerが一局を処理し終わるまで次の同一profile jobが始まらず、3件のdelivery開始はT+0 / 54 / 65秒だった。Queuesはbatch処理後にconsumerの自動スケールを判断するためであり、DO主導の即時開始を[#49](https://github.com/phni3j9a/meeshogi/issues/49)で実装してIssue #24のproduction切り替えの前提とする。現在のFree 3 / Precision 2上限はそれまでの暫定値で、最終値は#24で決める。

profile・上限は`cloud/config/job-profiles.json`に集約し、探索条件を公開APIへ露出しない。stagingの開発設定・deploy・Container構成は [cloud/README.md](../cloud/README.md)、変更理由と実測は各Issue・PRを参照する。production切替とSekirei撤去は未完了。
