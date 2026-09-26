# 解析方式の比較レポート（開発用）

同一棋譜を Sekirei（端末内）・Cloud Free・Cloud Precision で解析した結果を、開発用に集計する仕組み。専用の比較画面は持たず、アプリが書き出した 1 棋譜あたり 1 ファイルの JSON export をオフライン CLI で集計して Markdown と機械可読 JSON を再生成する。ユーザーの棋譜・結果を外部へ送る処理は一切行わない。

## export の作成（アプリ側）

- export 形式: `meeshogi-comparison-export` version 1。スキーマと語彙は `src/comparison/schema.ts`、runtime 検証は `src/comparison/validate.ts` に定義する。
- 1 ファイル = 1 棋譜。`game.initialSfen`・`game.moves`・`game.moveCount` と、それらから計算した `game.moveListHash`（`sha256hex(initialSfen + "\n" + moves.join(" "))`）で棋譜を不変に識別する。
- `plies[i].ply === i`、ply 0 が初期局面、`plies.length === moveCount + 1`。各行に局面の `sfen` と、実行した方式ごとの結果を持つ。
- 1 方式につき選択された 1 試行（`attemptId`）だけを含める。Cloud は復帰・照合のために `jobId` も保持する。
- **credential・token・接続先 secret を export に絶対に含めない**。validator は `mcd1_…` 形式の cloud credential や `Bearer …` 形式の文字列を値・キーのどこにあっても拒否する。

## アプリからの書き出し手順（開発用）

export writer は `src/comparison/export.ts`（`buildComparisonExport`）。store 経路は `exportComparison(gameId)`（`src/store/create-app-store.ts`）で、最新の Sekirei run 記録（`GameRecord.analysisRun`）と、棋譜に紐づく `gameIdentity` が一致する Cloud attempt のうち profile ごとに最新 `createdAt` の 1 件を選び、永続化済みの結果行を再検証してから写す。**書き出し前に `validateComparisonExport` で検証し、失敗した場合は書き出さず画面にエラーを表示する**。

UI への入口は開発用のみ:

1. 棋譜詳細画面（`app/game/[id].tsx`）右上メニュー「棋譜の操作」を開く。
2. 「比較レポートを書き出す（開発用）」を選ぶ。この項目は **`__DEV__` が true** か、ビルド時に **`EXPO_PUBLIC_ENABLE_ANALYSIS_EXPORT=1`** を付けた場合にだけ表示され、通常の Release ビルドには出ない。
3. JSON が端末のキャッシュ領域へ決定的パスで書き出される:
   - パス: `<Paths.cache>/meeshogi-comparison-<gameId>.json`（`src/platform/comparison-files.ts` の `comparisonExportPath`）
   - 書き出し後に `console.log('[comparison-export] wrote <file uri>')` を出し、完了時にパスを Alert でも表示する
   - `expo-sharing` が使える環境では続けて共有シート（保存・送信）が開く
4. 受け入れスクリプト等でファイルを取得する場合は、logcat / Metro ログの `[comparison-export] wrote` 行、またはアプリのキャッシュディレクトリ配下の `meeshogi-comparison-<gameId>.json`（Android は `adb` で `cache/files` 相当、iOS シミュレータはアプリコンテナの `Library/Caches` 相当）を参照する。

## レポートの再生成

```
npm run analysis-compare -- <export.json> [<export2.json> …] \
    --markdown <out.md> --json <out.json>
```

- 引数なし・`-h/--help` で使い方を表示する。
- `--markdown` を省略すると Markdown を stdout に書く。`--json` を省略すると JSON summary を書き出さない。
- 各 export の `moveListHash` を `initialSfen` + `moves` から SHA-256 で再計算する。不一致はレポートに「hash 再計算: 不一致」と注記する（集計は続行）。
- schema 検証に失敗したファイルは読み込まず、1 件でも失敗があれば exit 1。失敗ファイル以外の集計は行わない。
- 同じ入力からは常に同じバイト列を生成する。生成時刻・実行環境の情報はレポートに含めない。

実装は Node 22.18 以降の type stripping で `scripts/analysis-compare/compare.ts` を直接実行する（tsx 等の依存は不要）。実行時に `MODULE_TYPELESS_PACKAGE_JSON` の警告が stderr に出るが、これは `.ts` を ES module として再解析する旨の性能上の注意であり動作・出力には影響しない。`package.json` に `"type": "module"` を足すと `metro.config.js`（CommonJS）が壊れるため追加しない。

## 方式の identity と条件

| 方式 | メソッドキー | identity | 要求条件 |
|---|---|---|---|
| Sekirei（端末内） | `sekirei` | `engineId`・`modelId`（`src/analysis/identity.ts` の現在 identity） | `nodes`（探索ノード上限）・`multiPV` |
| Cloud Free | `cloud-free` | `result.identity` の代表値（engine/model の名前と SHA-256、driver・contract version） | profile `free`（Threads 1・Hash 64MiB・1000ms・MultiPV 2） |
| Cloud Precision | `cloud-precision` | 同上 | profile `precision`（Threads 2・Hash 64MiB・5000ms・MultiPV 3） |

**reference は常に Cloud Precision**。深い参照であって、正解・棋力の保証ではない。Issue #20 benchmark の基準条件（standard-3 / 10000ms / MultiPV 3）とも別の条件なので混同しない。

## 指標の定義

比較は各 export 内の「方式 × cloud-precision」の pair で行い、複数 export を渡した場合は pair を合算（pool）する。reference を含まない export は比較対象にならない。評価値はすべて先手（black）視点。

- **CP 差**: 両側が `kind: 'cp'` の ply のみ。`比較側 − reference` の符号差と絶対差の n/中央値/p90/最大/平均。mate・terminal を cp へ換算しない。
- **Top-1 一致率**: 両側が complete の ply で、候補先頭の USI 指し手の一致率。
- **reference 最善手の包含率**: 両側が complete の ply で、reference の Top-1 が比較側の実候補列（要求 MultiPV までの実返却列。水増ししない）に含まれる率。実効候補数の統計も併記する。
- **評価種別の一致**: `cp×cp` / `mate×mate` / `ref=cp・比較側=mate` / `ref=mate・比較側=cp` の組合せ数。
- **mate 勝者一致**: `mate×mate` の ply で winner（'black'/'white'/'unknown'）の一致・不一致・unknown の件数。生の距離の完全一致は別途数えるが、両エンジンの距離規約は未確認のため**品質指標にしない**。
- **terminal 一致**: 両側 terminal の ply で kind（checkmate/no-legal-moves）と winner の一致。片側のみ terminal（もう片側が評価値を返した）も別に数える。
- **ply 区分別の集計**: ply 0–40 / 41–90 / 91+ の 3 区分で上記の cp 差・Top-1・包含率を出す。**手数による便宜区分であり、局面内容から実際の序盤・中盤・終盤を判定するものではない**。対象 ply が無い区分は `N/A`。
- **ply 別の評価値行**: export 内の比較 pair ごとに、全 ply の行を `comparisons[].plyRows` として JSON に残し、Markdown にも「ply 別の評価値」表を出す。各行は ply・行の SFEN（JSON は完全な文字列、表は盤面フィールドを短いキーにする）・両側の生評価（cp / mate{value,winner} / terminal kind）・両側が cp のときの符号差と絶対差・それ以外の除外・欠測理由（`missing-*` / `incomplete-*` / `sfen-mismatch` / `terminal-mismatch`）を持つ。結果行自体が無い側は `status: 'absent'`。合算（overall）の比較では別棋譜の ply が衝突するため `plyRows` は空になる。
- **欠測の内訳**: 双方欠測・比較側のみ欠測・reference 側のみ欠測・SFEN 不一致（結果ソースが行と別の局面を報告した ply は比較しない）・片側 incomplete をそれぞれ数え、品質指標の分母から外す。incomplete を「mate なし」として数えない。
- **方式別件数（missing の定義）**: 方式表は宣言済み方式の全 ply を走査し、`results` に結果行が無い ply も missing に数える。`missing` は明示 `'missing'` 行と結果行なしの合計で、その内訳を `absent`（行なし）として保持する。各方式の `complete + incomplete + terminal + missing` は常に局面数に一致する。未宣言の方式は「未実行」として件数を出さない。
- **グラフ変動（表示値の隣接差）**: アプリの評価値グラフと同じ写像（cp はそのまま、mate/詰み終局は ±1500、表示時 ±1500 clip）で表示値に変換し、隣接 ply の `|差|` を集計する。欠測をまたいだ差は計算しない（区間を橋接しない）。**画面上の変動量の指標であり、滑らかさは解析の正しさを示さない**。結果側 sfen が行 sfen と異なる行は pair 比較と同じ規則で null にし（アプリが SFEN 不一致の結果を表示対象から外すのと同じ）、その件数を `sfenMismatchRows` に残す。写像は `src/comparison/chart-value.ts` が `src/ui/evaluation.ts` と `src/ui/charts.tsx` の規則をミラーしたもので、等価性は `tests/comparison/chart-value.test.ts` が検証する。
- **実探索量**: complete 行の `observed.nodes` / `observed.completedDepth` / `observed.multiPV` / `observed.engineLaunch` の統計（報告がある行のみ）。

比率は分子/分母を JSON summary に保持し、分母 0 は `rate: null`・レポートでは `N/A`。

## 時間の計測境界（provenance）

方式ごとに計測の意味が違うため、混ぜないよう境界を明示する。

| 方式 | 全局時間 | ply 単位の時間 |
|---|---|---|
| Sekirei | `timing.wholeGameWallMs`（アプリ JS 側の壁時計） | 行の `timing.kind: 'app-call'` の `elapsedMs` |
| Cloud | `timing.createdAt → finishedAt`（server job 時刻。queue・retry 込み） | 行の `timing.kind: 'server-search'` の `elapsedMs`（`result.meta.elapsedMs`。1局面の search+drain のみ。起動・queue・network を含まない） |

- Sekirei の実行種別は今回の実行が記録した事実だけで分類する: `fresh-complete`（`completed`・`cacheReuseCount` 既知 0・非中断が確認できる — 新規全局解析時間の比較に使うのはこれだけ）/ `completed-with-cache-reuse`（`cacheReuseCount ≥ 1`。完了済み解析の再利用と中断後の継続の両方を含み、再利用元の完了履歴は追跡しない）/ `partial` / `interrupted` / `unknown`（記録不足。null を 0/false に倒さない）。`interrupted`・`cacheReuseCount` は方式レベルの `timing` に保持し、cache 再利用 ply は行 `fromCache: true` で call 時間を持たない。cache 行の過去の呼出し時間を今回の新規探索時間へ加算しない。
- Sekireiの時間は今回の実行だけを計測しています。保存結果を再利用した実行には、完了済み解析の再利用と中断後の継続の両方が含まれ、再利用元の完了履歴は追跡していません。新規全局解析時間の比較には、全局面を今回計算して完了した実行だけを用います。
- Sekirei の計測はアプリの JS 側が記録する: 全局 run 記録は `GameRecord.analysisRun`、行の call 時間は `PositionAnalysis.callElapsedMs`・生成 run は `runId` に保存する。記録方式の導入前に保存された結果にはこれらが無く、`completedAt` 等から推測もしない。旧形式の run 記録に残る `resumed` フラグは読み込み互換のため許容するだけで、分類・レポートの根拠にはしない。
- Cloud job は background・再起動をまたいで server 側で継続するため、クライアント側の中断・再開という概念は持たない（idempotency key / jobId で同一 job に復帰する）。
- 旧結果などで計測が無い値は `null` のまま保持する。**不明な時間を推定で埋めない**。

## 制限・既知の注意点

- Cloud Precision は reference であって ground truth ではない。一致・不一致は「Precision との差」であって正誤ではない。
- mate 距離の完全一致は両 engine の規約が未確認のため品質指標にしない（勝者一致のみを見る）。
- Cloud の通常探索の mate 値は証明済み詰め（`mateProof`）ではない。比較でも詰み証明の不一致としては扱わず、バッジ表示の根拠にもしない。
- phase 区分は ply 番号のみに依存する。実際の戦型・戦況とは無関係。
- Sekirei と Cloud は要求条件の意味が違う（ノード数 vs movetime/profile）。「同じ条件での比較」ではない点に注意。
- legacy 結果の未計測値・未記録の identity は `null`/`N/A` のまま表示し、捏造しない。
- `moveListHash` は棋譜の同一性を検証するためのもので、ファイル自体の改ざん検知ではない。
