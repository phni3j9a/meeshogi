# Issue #7 A/B/C/D診断ハーネス

`compare.sh` は製品へ同梱しない診断専用ハーネスである。公開・合成の
`fixtures/analysis/positions.json`だけを読み、同じweight、Threads 1、
`SpecTopN=0`、局面ごとに新規16 MiB TT、`max_depth=8`で次を分離する。

| variant | 内容 | 製品に採用するか |
| --- | --- | --- |
| A | Sekirei v0.3.36、NNUE-only、変更前root shortcut | しない（比較基準） |
| B | Aへ単一合法手root_search修正だけを適用した隔離版 | しない（診断専用） |
| C | Sekirei v0.3.37、既定のAbsolute評価 | しない（診断専用） |
| D | v0.3.37、ResidualMaterial、candidate worktreeの`native/sekirei/src/lib.rs`を初期化する統合版 | 採用候補 |

B/Cのソースと全Cargo targetは`/tmp`のscratchへ展開する。Cargoは
`CARGO_NET_OFFLINE=true`で動かし、v0.3.36/v0.3.37のcommit objectが既存の
Cargo git cacheにない場合は、ネットワークを有効化せずエラーにする。
Directorが検証した隔離source treeを使う場合は、次のように明示する。

```sh
MEESHOGI_DIAGNOSTIC_V037_SOURCE=/path/to/sekirei-v037/crates/sekirei-core \
  MEESHOGI_DIAGNOSTIC_OUTPUT_DIR=/tmp/meeshogi-issue7-run \
  bash scripts/diagnostics/compare.sh
```

## 実行

```sh
bash scripts/diagnostics/compare.sh

# 結果を残す場所を指定する場合
MEESHOGI_DIAGNOSTIC_OUTPUT_DIR=/tmp/meeshogi-issue7-run \
  bash scripts/diagnostics/compare.sh
```

通常予算は1/10,000 nodes、`sequence-*`には100,000/1,000,000 nodesも追加する。
各行は実訪問nodes、完了depth、候補と合法PV、手番・王手・合法手数、先手視点の
score kind/value、終局、fallback、予算到達、cancel、engine/model identityを
含む。`raw/{A,B,C,D}.jsonl`、`{A,B,C,D}.{json,tsv}`、`combined.{json,tsv}`が
出力される。`combined`の寄与列はA→B、B→C、C→Dを別々に持つ。

Dはcandidate worktreeのbridge sourceを一時runnerへ`include!`し、model初期化と
ResidualMaterial選択を実行してから、同一coreの制御済み`max_depth=8` probeを行う。
製品bridge本体の受入試験・Android/iOS試験を代替しない。bridgeの製品実装は
現在`max_depth=64`を上限にしているが、有限node予算で観測されるdepthをこの
診断条件へ固定するため、Dのcore probeは別の診断runnerから呼ぶ。実際のnative
payload/proof契約は`cargo test --locked --manifest-path native/sekirei/Cargo.toml`
で別に確認する。

出力には私的棋譜・対局者名・teacher weightを含めない。数値は固定CPU・lockfile・
探索条件に依存し得るため、結果を棋力向上や研究runtime全体の再現とは解釈しない。
