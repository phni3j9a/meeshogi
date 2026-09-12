# 端末内解析エンジン

meeshogi の無料版は、棋譜と解析結果を端末内で扱う。UI からは `src/analysis/native-engine.ts` の `analyzeNative` / `cancelNative` だけを呼び、盤面・TT・Rust のポインタを JavaScript に渡さない。

## 固定した runtime と model

今回の runtime は Sekirei の `v0.3.36` に固定する。

| 項目 | 値 |
| --- | --- |
| upstream | <https://github.com/kent-tokyo/sekirei> |
| tag | `v0.3.36` |
| tag commit | `aeb6ea30d58f93cad84ffe98bc13441feb807fa8` |
| tag object | `68cb0a6d896098dccb9b6ecdc34e206dcef9b7ae`（annotated tag） |
| crate license | `MIT OR Apache-2.0` |
| app engine ID | `sekirei-v0.3.36@aeb6ea30d58f93cad84ffe98bc13441feb807fa8` |

The native source retains Sekirei's attribution at
`native/sekirei/NOTICE` with the complete `native/sekirei/LICENSE-MIT` and
`native/sekirei/LICENSE-APACHE` texts. These software notices do not license
the model artifact; see `assets/model/NOTICE.txt`.

`v0.3.36` には `SearchConfig::node_limit` があるため、研究時の固定ノード条件を app 側でも明示できる。`sekirei-weight` の研究時評価は v0.3.4 と実験パッチ系列で行われているため、runtime を v0.3.36 に変更したこと自体を engine ID に含める。強さ・評価値の完全一致を主張せず、実機で再測定する。

同梱 model は `assets/model/c-leaf-wrm-seed42.bin` である。

| 項目 | 値 |
| --- | --- |
| candidate | `c-leaf-wrm-seed42` |
| format | flat `SEKIRW01` |
| size | `1,305,356` bytes |
| SHA-256 | `807c18da03521414a8c75dfe51dd4de2caf8e9ec4909320826eac12b66852eab` |
| architecture | `INPUT=2420`, `L1=256`, `L2=32` |
| app model ID | `c-leaf-wrm-seed42@807c18da03521414a8c75dfe51dd4de2caf8e9ec4909320826eac12b66852eab` |

Rust 初期化時にサイズ、`SEKIRW01` magic、SHA-256、Sekirei の weight parser の全てを検証する。別のファイルを指定した場合、または process 内で別 model を再ロードしようとした場合は失敗させる。Sekirei の NNUE weight は process-global `OnceLock` であり、解析中の差し替えを許可しない。

この model は `sekirei-weight` で教師出力から学習したプロジェクト固有のデータ artifact である。Sekirei の MIT/Apache-2.0 は source code の条件であり、model に自動的に適用しない。教師の Suisho5 / YaneuraOu、元の `nn.bin`、GPL の teacher binary は app に含めない。model の provenance と hash は追跡し、商用リリース時には model 自体の利用条件を別途 review する。

## Native contract

ネイティブ実装は次の順で呼ぶ。

```text
initializeAsync()
  -> model path を native bundle から解決
  -> Rust が SEKIRW01 / size / SHA-256 / parser を検証

analyzeAsync(sfen, nodes, multiPV)
  -> SFEN を Board に変換
  -> node_limit と MultiPV を設定
  -> score と候補手を JSON で返す

cancelAsync()
  -> 現在の AtomicBool を立てる
```

Rust 側は一つの検索を `Mutex` で直列化し、Rayon を一 worker、`SpecTopN=0` 相当で動かす。これにより、端末で複数局面を同時に探索して CPU と TT を奪い合うことを防ぐ。キャンセルは現在実行中の検索へ伝播し、検索後の mate proof にも同じ flag を使う。`Mutex` の取得を待っている呼び出しは、待機後にその解析専用の状態を初期化するため、先行する解析へのキャンセル要求を引き継がない。キャンセルされた解析は有効な保存結果に変換しない。

Sekirei の score は side-to-move 視点なので、結果に入れる前に次で先手視点へ変換する。

```text
SFEN side=b: scoreBlack = engineScore
SFEN side=w: scoreBlack = -engineScore
```

mate sentinel は centipawn として返さず、`mate` に分ける。候補 `pv` は TT から合法手を確認しながら取り出す。代表 PV が得られない場合も候補の第一手は必ず USI 形式で返す。
終局局面は `candidates: []` と `terminal: "checkmate"` または `"no-legal-moves"` を返す。JavaScript 側でも合法手ゼロを再確認してから保存する。

## 1手・3手詰め

通常探索の mate score や一本の PV は詰みの証明に使わない。Rust bridge は Sekirei の合法手生成と `is_in_check` を用いて、別予算で次を全数検証する。

- 1手詰め: 現在の手番の指し手ごとに、相手が王手中かつ合法応手ゼロか確認する。
- 3手詰め: 最初の手が王手であり、相手の全合法応手それぞれに対して、次の手で王手詰みがあるか確認する。
- 合法手生成側の成り、持駒、二歩、打ち歩詰め、王手回避の判定を共通エンジンへ委ねる。
- proof budget または cancel flag に達した場合は `incomplete`。`not-found` と「予算切れ」を同じ結果にしない。

返す代表 PV は表示用であり、`proven` status が全応手の検証結果を表す。唯一解とは表示しない。

## Build

Rust bridge の manifest は `native/sekirei/Cargo.toml`。

```bash
# Linux smoke test (model artifact present)
cargo test --locked --manifest-path native/sekirei/Cargo.toml

# The same smoke test used by CI
bash scripts/engine/test.sh

# Android arm64-v8a (CI installs NDK target/toolchain)
bash scripts/engine/build-android.sh

# iOS device and simulator (macOS/Xcode runner only)
bash scripts/engine/build-ios.sh
```

Upstream Sekirei has `target-cpu=native` in its own workspace config. The bridge has a local `.cargo/config.toml` with empty `rustflags` so cross builds remain portable. iOS builds require macOS/Xcode; a Linux Rust test is not evidence that an iOS module links or launches.

## Supporting upstream evidence

- Sekirei v0.3.36 release and current mobile limitation: <https://github.com/kent-tokyo/sekirei/releases>
- Official mobile integration surface: <https://github.com/kent-tokyo/sekirei/blob/main/docs/mobile_integration.md>
- Official weight format/licensing distinction: <https://github.com/kent-tokyo/sekirei/blob/main/docs/nnue_weights.md>
- Model selection and hash: `sekirei-weight/results/suisho5-stage2/final-summary.json`
- Model manifest: `sekirei-weight/results/suisho5-stage2/final-summary.json` at commit `7d909707c605cf8d8829f1eaa07097878cf49562` (the original binary path is `/mnt/storage/NAS/projects/sekirei-weight/processed/stage2/models/c-leaf-wrm-seed42.bin`; only the verified binary is app input)
