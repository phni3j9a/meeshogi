# Issue #7 A/B/C/D エンジン診断

これは製品の探索設定や棋力を評価する資料ではなく、Issue #7の変更寄与を分けるための host-only 診断記録である。入力は公開・合成SFENだけの [`fixtures/analysis/positions.json`](../fixtures/analysis/positions.json)、weightは `c-leaf-wrm-seed42`（SHA-256 `807c18da03521414a8c75dfe51dd4de2caf8e9ec4909320826eac12b66852eab`）である。全variantで Threads 1、`SpecTopN=0`、局面ごとに新規TT 16 MiB、`max_depth=8`を揃えた。通常budgetは1/10,000 nodes、連続王手局面は100,000/1,000,000 nodesも実行した。

| variant | 比較対象 | engine / eval | 位置づけ |
| --- | --- | --- | --- |
| A | v0.3.36、変更前の単一合法手root shortcut | NNUE-only | 現行baseline |
| B | Aに単一合法手root_search修正だけを適用 | NNUE-only | 診断専用、製品には入れない |
| C | v0.3.37 | Absolute（既定） | 診断専用 |
| D | v0.3.37 + candidate worktreeの`native/sekirei/src/lib.rs`を初期化 | ResidualMaterial（material 1 + NNUE 1） | 製品候補 |

各セルは `actualNodes / completedDepth / candidateCount / senteScoreKind:value / status / fallback`。空のscoreは、終局で通常候補がないことを示す。

| fixture / requested nodes | A | B | C | D | A→B nodesΔ | B→C nodesΔ | C→D nodesΔ |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| `single-reply` / 1 | 0/8/1/cp:-184/complete/false | 1/0/1/cp:-461/incomplete/true | 1/0/1/cp:-461/incomplete/true | 1/0/1/cp:+3389/incomplete/true | +1 | 0 | 0 |
| `single-reply` / 10,000 | 0/8/1/cp:-184/complete/false | 164/2/1/mate:+2/complete/false | 164/2/1/mate:+2/complete/false | 164/2/1/mate:+2/complete/false | +164 | 0 | 0 |
| `sequence-start` / 10,000 | 10,000/2/1/cp:-184/complete/false | 10,000/2/1/cp:-184/complete/false | 10,000/2/1/cp:-184/complete/false | 10,000/2/1/cp:+3926/complete/false | 0 | 0 | 0 |
| `sequence-start` / 100,000 | 10,017/3/1/mate:+1/complete/false | 10,017/3/1/mate:+1/complete/false | 11,525/3/1/mate:+1/complete/false | 11,477/3/1/mate:+1/complete/false | 0 | +1,508 | -48 |
| `sequence-after-first` / 100,000 | 0/8/1/cp:-184/complete/false | 164/2/1/mate:+2/complete/false | 164/2/1/mate:+2/complete/false | 164/2/1/mate:+2/complete/false | +164 | 0 | 0 |
| `sequence-after-reply` / 100,000 | 0/1/1/mate:+1/complete/false | 0/1/1/mate:+1/complete/false | 1/1/1/mate:+1/complete/false | 1/1/1/mate:+1/complete/false | 0 | +1 | 0 |
| `checkmate-white` / 1 | 0/0/0/—/complete/false | 0/0/0/—/complete/false | 0/0/0/—/complete/false | 0/0/0/—/complete/false | 0 | 0 | 0 |
| `checkmate-black` / 1 | 0/0/0/—/complete/false | 0/0/0/—/complete/false | 0/0/0/—/complete/false | 0/0/0/—/complete/false | 0 | 0 | 0 |
| `no-legal-moves` / 1 | 0/0/0/—/complete/false | 0/0/0/—/complete/false | 0/0/0/—/complete/false | 0/0/0/—/complete/false | 0 | 0 | 0 |
| `multipv-remaining-two` / 1 | 1/0/1/cp:-130/incomplete/true | 1/0/1/cp:-130/incomplete/true | 1/0/1/cp:-130/incomplete/true | 1/0/1/cp:-1170/incomplete/true | 0 | 0 | 0 |
| `multipv-remaining-two` / 10,000 | 10,000/6/2/cp:-216/complete/false | 10,000/5/2/cp:-343/complete/false | 10,000/5/2/cp:-343/complete/false | 10,000/7/2/cp:-1487/complete/false | 0 | 0 | 0 |
| `tiny-budget` / 1 | 1/0/1/cp:-35/incomplete/true | 1/0/1/cp:-35/incomplete/true | 1/0/1/cp:-35/incomplete/true | 1/0/1/cp:-35/incomplete/true | 0 | 0 | 0 |
| `tiny-budget` / 10,000 | 10,000/4/3/cp:-60/complete/false | 10,000/4/3/cp:-60/complete/false | 10,000/4/3/cp:-60/complete/false | 10,000/4/3/cp:-55/complete/false | 0 | 0 | 0 |

## 読み取り

- `single-reply` の十分なbudgetではAだけがnodes 0のshortcutを使い、B/C/Dは164 nodesの子局面探索へ入る。1 nodeではB/C/Dも初回反復未完了の合法fallbackであり、`depth=0`を解析完了と扱わない。
- 連続王手の100,000 nodesではAが `sequence-start = mate`、`sequence-after-first = cp`、`sequence-after-reply = mate`となる。Bはroot shortcutを直す寄与、Cはv0.3.37更新による寄与、DはResidualMaterialの評価方式による寄与として別々に記録した。通常CPの変動を補間・平滑化していない。
- `checkmate-*`は王手中の合法手ゼロ、`no-legal-moves`は王手なしの合法手ゼロとして、全variantで通常候補なし・nodes 0の別terminalになった。終局のscoreをmateProofや通常mateへ流用しない。
- `multipv-remaining-two`はMultiPV 3に対して合法手2つを保持する。`tiny-budget`は1 nodeでは候補をfallbackとして返すが`incomplete`である。

完全な全30行のvariant別JSON/TSVと、A→B/B→C/C→Dを含むcombined JSON/TSVは、実行時に次へ出力した。

`/tmp/frontierplan-83lq10mm/tasks/ae1ec597296b/diagnostics-20260922-final/`

この資料のDは、candidate worktreeのbridge sourceを一時runnerへ組み込み、model初期化とResidualMaterial設定を実行した後、同じv0.3.37 coreを`max_depth=8`の制御済みprobeとして測定したもの。製品bridge本体のpayload/proof契約は別のRust test、Android/iOS build、アプリ操作で受入する。研究側のv0.3.4系runtime（TT 64 MiB）と製品app v0.3.37（TT 16 MiB）、nativeへ過去の対局履歴を渡さない条件は一致しない。静的評価の整数一致も探索全体の再現・棋力向上の主張ではない。ユーザーの150手対局は入力していない。
