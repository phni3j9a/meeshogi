# 端末内解析エンジン

meeshogi の無料版は、棋譜と解析結果を端末内で扱う。UI からは
`src/analysis/native-engine.ts` の `analyzeNative` / `cancelNative` だけを呼び、盤面・TT・Rust のポインタを JavaScript に渡さない。iOS と Android は同じ `native/sekirei` Rust bridge と同じ評価・成立条件を使う。

## 固定した runtime、評価方式、model

今回の runtime は Sekirei v0.3.37 の公開 commit に固定する。

| 項目 | 値 |
| --- | --- |
| upstream | <https://github.com/kent-tokyo/sekirei> |
| tag | `v0.3.37` |
| tag commit | `7fd1d9b42a85fbc5aeb222f8aa453d3e08f3c0ac` |
| tag object | `62cb8f14c4e521d6d66ace92b0cb630359d525e9`（annotated tag） |
| crate license | `MIT OR Apache-2.0` |
| enabled feature | なし（`king_relative_b_small` は有効化しない） |
| app engine ID | `sekirei-v0.3.37@7fd1d9b42a85fbc5aeb222f8aa453d3e08f3c0ac+meeshogi-analysis-v2+eval-material1-nnue1-bias0-clip0` |

`native/sekirei/Cargo.toml` は upstream commit を直接 pin し、`Cargo.lock` も同じ commit を記録する。Rayon は依存として残し、bridge 側では一つの worker と `SpecTopN=0` 相当で検索を直列化する。

Rust の model 初期化では、weight を process-global にロードする直前に次を一度だけ設定する。

```text
NnueOutputMode::ResidualMaterial
material coefficient = 1
NNUE coefficient = 1
bias = 0 cp
combined clip = 0 (disabled)
```

したがって、weight の raw integer NNUE 出力を `N`、Sekirei の material score を `M` とすると、葉評価は `M + N` である。JavaScript 側で material を後から加算しない。解析中に mode を切り替えず、weight のサイズ、`SEKIRW01` magic、SHA-256、Sekirei parser の全てを検証してからロードする。検証・ロードに失敗した場合は model state を有効化せず、解析を fail-closed にする。

同梱 model は `assets/model/c-leaf-wrm-seed42.bin` である。

| 項目 | 値 |
| --- | --- |
| candidate | `c-leaf-wrm-seed42` |
| format | flat `SEKIRW01` |
| size | `1,305,356` bytes |
| SHA-256 | `807c18da03521414a8c75dfe51dd4de2caf8e9ec4909320826eac12b66852eab` |
| architecture | `INPUT=2420`, `L1=256`, `L2=32` |
| app model ID | `c-leaf-wrm-seed42@807c18da03521414a8c75dfe51dd4de2caf8e9ec4909320826eac12b66852eab` |

この model は `sekirei-weight` で作成された別の data artifact であり、Sekirei の MIT/Apache-2.0 が自動的に適用されるわけではない。model の provenance と利用条件は `assets/model/NOTICE.txt` に分離して記録する。教師 executable、教師 weight、元の `nn.bin`、GPL の teacher source は app に含めない。

## Native contract

ネイティブ実装は次の順で呼ぶ。

```text
initializeAsync()
  -> model path を native bundle から解決
  -> Rust が SEKIRW01 / size / SHA-256 / parser を検証
  -> ResidualMaterial を設定して Rust の process-global weight をロード

prepareRequest()
  -> Rust が単調増加する requestId を返す

analyzeAsync(sfen, nodes, multiPV, requestId)
  -> SFEN を Board に変換
  -> 合法手ゼロなら terminal を確定
  -> それ以外は node_limit と MultiPV を設定して反復深化
  -> 完成した候補集合と診断 meta を JSON で返す

cancelAsync(requestId)
  -> requestId をキャンセル済みとして記録し、active なら AtomicBool も立てる
```

Rust 側は一つの検索を `Mutex` で直列化する。requestId は active flag の登録前にキャンセルされても記録され、Mutex 待機中・active 登録直後・探索中・短手数詰み証明中の処理を無効化する。キャンセルされた解析は有効な保存結果に変換しない。

SFEN は TypeScript と Rust の両境界で検証する。盤面は9段×9筋で、先手・後手の玉をそれぞれ1つ含む必要がある。`candidates[].pv` は最初の指し手だけでなく TT から追える各指し手を合法性確認しながら返す。

### 成功結果の形

成功時は従来の `status`, `sfen`, `engineId`, `modelId`, `nodes`, `depth`, `candidates`, `terminal`, `mateProof` に加えて、次の `meta` を必ず持つ。エラー時は従来どおり `{ "error": "..." }` を返し、成功結果の `meta` を省略しない。

```json
{
  "status": "complete",
  "sfen": "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
  "engineId": "sekirei-v0.3.37@7fd1d9b42a85fbc5aeb222f8aa453d3e08f3c0ac+meeshogi-analysis-v2+eval-material1-nnue1-bias0-clip0",
  "modelId": "c-leaf-wrm-seed42@807c18da03521414a8c75dfe51dd4de2caf8e9ec4909320826eac12b66852eab",
  "meta": {
    "requestedNodes": 10000,
    "nodes": 10001,
    "completedDepth": 1,
    "fallback": false,
    "budgetReached": true
  },
  "nodes": 10001,
  "depth": 1,
  "candidates": [
    {
      "usi": "7g7f",
      "pv": ["7g7f"],
      "scoreCp": -35,
      "mate": null,
      "depth": 1
    }
  ],
  "terminal": null,
  "mateProof": null
}
```

`meta` の値は次の意味に固定する。

| field | 意味 |
| --- | --- |
| `requestedNodes` | bridge が `SearchConfig::node_limit` に渡した要求値 |
| `nodes` | Sekirei の `SpecSearchInfo.nodes` から得た実訪問ノード数。トップレベル `nodes` と同じ値。停止チェックの粒度により `requestedNodes` を超えることがあり、超過幅に上限を設けない |
| `completedDepth` | Sekirei が最後に完了した反復深化深度。トップレベル `depth` と同じ値 |
| `fallback` | 非終局で完成深度が0のとき、合法手を診断用に返したこと。terminal の depth 0 では `false` |
| `budgetReached` | 検索の実ノード数が要求値以上（`nodes >= requestedNodes`）になったこと。単なる浅い深度やmate scoreから停止理由を推測しない |

`SpecSearchInfo` の実ノード数・完成深度・候補集合以外の停止理由は、bridge 側で作らない。キャンセルは `error` で無効化し、proof budget は `meta.nodes` に混ぜない。

### `complete` / `incomplete`

- 非終局では、要求した MultiPV と合法手数の小さい方と同数の候補を持つ、最後の完全な MultiPV 反復だけを `complete` とする。
- 最初の MultiPV 反復が node budget で完了しなければ `incomplete`。合法な `bestMove` を候補に含めることはあるが、`fallback: true` として診断に限定し、JavaScript は有効な `PositionAnalysis` として保存・グラフ反映しない。
- 完了済みの反復が一つでもあれば、その候補集合・score・depth を一組で保持する。後続の深い反復が node budget で止まっても、完成済み結果を返して `complete` とし、`budgetReached: true` になり得る。この場合は完了済み結果を保存・表示に使う。
- `candidates` の `scoreCp` と `mate` は排他的。通常探索のmate sentinelを1手／3手詰め証明の根拠にせず、`mateProof` は別の全応手検証の結果だけを示す。

全局解析で扱う予算不足

JavaScriptのnative境界は、`status: "incomplete"` を無条件に回復可能とは扱わない。SFEN、identity、要求条件、top-level値と`meta`、合法手、fallback候補のPVと重複、`mateProof`を全て検証したうえで、非終局・合法手あり・`completedDepth: 0`・`fallback: true`・`budgetReached: true`を満たす場合だけ`AnalysisBudgetIncompleteError`へ変換する。この型は`PositionAnalysis`ではなく、候補・PV・payloadを保存や表示へ渡さない。

全局解析のstoreはこの型だけを局面単位で一度スキップし、後続局面を直列に処理する。通常のnativeエラー、不正payload、キャンセル、保存失敗は従来どおり処理を停止する。全走査後に不足が残る場合は今回実行だけの`partial`状態とし、保存済みの有効結果の件数と不足件数を分けて表示する。`partial`の詳細や不足理由は永続化せず、再起動後は保存済み結果と欠測だけを正直に表示する。予算の自動増加・自動再試行・不完全結果の保存は行わない。

終局は反復深化の成立とは別に扱う。合法手が0で手番側が王手中なら `terminal: "checkmate"`、王手でなければ `terminal: "no-legal-moves"`。候補は空で、depth 0 でも `status: "complete"`、`fallback: false` とする。通常局面で `terminal` を候補の空集合から推測しない。

## 先手視点への変換

Sekirei の score は手番側視点である。SFEN の手番が先手ならそのまま、後手なら符号を反転して先手視点にする。

```text
side=b: scoreBlack = engineScore
side=w: scoreBlack = -engineScore
```

PV内のmate距離を符号反転する場合も同じ規則を使う。盤面の表示方向では符号を変えない。通常探索のmateは表示用の候補値であり、証明済みの1手／3手詰めバッジとは別である。

## 1手・3手詰め

通常探索のmate scoreや一本のPVは詰みの証明に使わない。Rust bridge はSekireiの合法手生成と `is_in_check` で別予算の全数検証を行う。

- 1手詰めは、現在の手番の各指し手について、相手が王手中かつ合法応手0か確認する。
- 3手詰めは、最初の手が王手で、相手の全合法応手それぞれに次の王手詰みがあるか確認する。
- 成り、持駒、二歩、打ち歩詰め、王手回避は共通エンジンの合法手生成に委ねる。
- proof budget または cancel flag に達した場合は `mateProof.status: "incomplete"`。`not-found` と予算切れを同じ結果にしない。

代表PVは表示用であり、唯一解とは表示しない。

## Identity と cache invalidation

`ENGINE_ID` は upstream revision だけでなく、meeshogi の bridge 契約版と評価方式を含む。今後、次のいずれかを変更した場合は同じ upstreamでも必ず identity の版またはsuffixを上げる。

- JSON payload、`status` / `meta` / terminal / candidate の意味、PV検証などのbridge契約。
- Rust bridgeの探索・終局・詰み証明のpatch。
- 評価モード、material/NNUE係数、bias、clip、または同じweightの解釈。
- upstream Sekirei commit、探索設定の意味、候補集合の成立条件。

解析結果は `engineId`, `modelId`, 局面、node条件、候補数の完全一致で表示・保存対象を判定する。identityまたはmodel hashが変わった結果、条件が異なる結果、成立していない `incomplete` 結果は現在の評価・候補・グラフ・詰みバッジ・完了件数へ流用しない。旧棋譜と旧解析JSON自体は保持できるが、新しいidentityの結果であるかのように補完しない。旧結果を利用可能な解析として扱う仕様を変える場合は、先にidentityと文書を更新する。

## Static-eval cross-check

研究側の公開Sekirei v0.3.4系基底と `sekirei-weight/patches/sekirei-v0.3.4-*.patch` から作った隔離参照で、同じweightの固定SFENを比較した。参照側は material、raw integer NNUE、`material + NNUE`、先手視点値を別々に出し、統合runtimeは `scripts/engine/static-eval-cross-check.sh` で同じ整数値を照合する。許容差は全列0 cpである。

| fixture | material | raw NNUE | combined | sente |
| --- | ---: | ---: | ---: | ---: |
| `startpos` | 0 | -35 | -35 | -35 |
| `single-reply` | -3850 | 461 | -3389 | 3389 |
| `sequence-start` | 3850 | -184 | 3666 | 3666 |
| `sequence-after-reply` | 3850 | -184 | 3666 | 3666 |

この一致は静的評価の整数実装と符号変換を検証するもので、v0.3.4研究runtimeとv0.3.37 app runtimeの探索全体、TT容量、探索強さ、モバイル性能の完全一致を意味しない。研究側のTTは64 MiB、app bridgeは16 MiBであり、研究runnerは過去の対局履歴をnativeへ渡さない。評価の丸め・蓄積順序に根拠なく許容差を設けない。

## Build と検証

```bash
# model hash / size / magic
node scripts/engine/verify-model.mjs

# Rust bridgeの回帰テスト
cargo test --locked --manifest-path native/sekirei/Cargo.toml

# model verification + 上記Rustテスト
bash scripts/engine/test.sh

# static-eval の整数cross-check（test-only exampleを使用）
bash scripts/engine/static-eval-cross-check.sh

# Android / iOS native buildは各OSのtoolchainが必要
bash scripts/engine/build-android.sh
bash scripts/engine/build-ios.sh
```

`static_eval_probe` は診断専用のCargo exampleで、アプリのライブラリ・iOS framework・Android libraryへ含めない。Linuxでの `cargo test` や静的cross-checkは、iOS/Androidのビルド・起動・実機操作の証拠ではない。両OSの受入結果は `docs/DEVELOPMENT.md` と実際のスクリーンショット・ログで別に報告する。

## Supporting upstream evidence

- Sekirei v0.3.37 の固定ソース（`eval.rs`）:
  <https://github.com/kent-tokyo/sekirei/blob/7fd1d9b42a85fbc5aeb222f8aa453d3e08f3c0ac/crates/sekirei-core/src/eval.rs>
- Sekirei v0.3.37 の固定ソース（`search.rs`）:
  <https://github.com/kent-tokyo/sekirei/blob/7fd1d9b42a85fbc5aeb222f8aa453d3e08f3c0ac/crates/sekirei-core/src/search.rs>
- upstream mobile integration:
  <https://github.com/kent-tokyo/sekirei/blob/7fd1d9b42a85fbc5aeb222f8aa453d3e08f3c0ac/docs/mobile_integration.md>
- model format/licensing boundary:
  <https://github.com/kent-tokyo/sekirei/blob/7fd1d9b42a85fbc5aeb222f8aa453d3e08f3c0ac/docs/nnue_weights.md>
- model provenance and artifact boundary: `assets/model/NOTICE.txt`
