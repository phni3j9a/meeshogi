# 解析方式の比較検討（2026-09、実戦3局）

アプリの3つの解析方式（端末内 Sekirei、Cloud Free、Cloud Precision）で同じ実戦3局を解析し、評価値と最善手の違いを比べた記録。あわせて、探索時間をそろえたときにエンジン自体の差がどれだけ残るかを調べた。

- 対象: ユーザーが提供した実戦3局（96手・101手・125手、終局を含め計325局面）。持ち時間10分+30秒の対局。棋譜・対局者名・局面 SFEN はこの文書に含めない。
- 基準: Cloud Precision（5000ms・Threads 2・MultiPV 3）。深い参照であって正解ではない。一致率は「Precision との差」を示す。
- 評価値は先手視点。指標の定義は [解析方式の比較レポート](ANALYSIS-COMPARISON.md) と同じ（`npm run analysis-compare` で集計）。
- 実施日: 2026-09-28。Cloud は staging の公開 `/v1` job API（production service ではない）。

## 比べた条件

| 系列 | 実行場所 | 条件 |
|---|---|---|
| Sekirei 長め | ホスト（Linux x86_64、Core i5-8500B） | 設定画面の最大「長め」= 50,000 nodes・MultiPV 2 |
| Sekirei 5秒相当 | 同上 | 2,800,000 nodes・MultiPV 2。ホストで約5秒/局面になるよう実測で決めた値（設定画面では選べない） |
| Cloud Free | staging | 1000ms・Threads 1・Hash 64MiB・MultiPV 2 |
| Free エンジン 80ms | ホスト | Cloud Free と同じエンジン・モデル・driver で 80ms/局面。Sekirei 長めと同程度の時間 |
| Free エンジン 80ms（PvInterval 0） | ホスト | 上に加えてエンジンの PvInterval を 0 に設定 |
| Cloud Precision | staging | 5000ms・Threads 2・Hash 64MiB・MultiPV 3（基準） |

### 実行方法

- アプリのストア実装（`makeAppStore`）を vitest から Node 上で動かし、棋譜の保存・解析・比較 export（`meeshogi-comparison-export` v1）までアプリと同じコードを通した。保存は `LocalRepository` を `node:sqlite` で開いたもの。
- Sekirei は `native/sekirei` をホスト向けにビルドし、iOS module と同じ C ABI（`meeshogi_sekirei_*`）で呼んだ。`expo-modules-core` だけを差し替え、結果の検証・変換は `src/analysis/native-engine.ts` をそのまま使った。モデルは同梱の `c-leaf-wrm-seed42`（SHA-256 一致）。node 上限で打ち切るため評価値は端末でも同じになる想定だが、実機では確認していない。
- Cloud Free / Precision はアプリと同じ `makeCloudClient` で staging の job API を呼んだ。
- Free エンジンの短時間条件は Cloud にない条件のため、`cloud/container/driver.py` のコピーをホストで動かした。エンジン・モデル・オプションはコンテナと同じファイルで、driver 起動時の SHA-256 照合を通っている。変更は EvalDir のパス1行、コンテナ用の実行環境チェック（CPU数・メモリ量）の無効化、探索時間（1000→80ms）、PvInterval 条件の1行だけ。結果は Worker の `validateDriverResult` とアプリの `validateCloudResult` / `buildComparisonExport` に通した。
- 実行用のスクリプトと解析結果は、私的な棋譜を含むためリポジトリに入れていない。

## 結果

### 全体（3局合算、Precision との比較）

| 系列 | 評価あり | 最善手一致 | Precision 最善手の包含 | 差の中央値 | 差の90%点 | 符号付き差の中央値 | 向きの逆転 | 大変動15手の追従 | 深さ中央値 | 1局の時間 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Sekirei 長め | 316/325 | 26.8% | 42.2% | 336 | 1531 | −144 | 25 | 8/15 | 4 | 11.2〜15.9秒 |
| Sekirei 5秒相当 | 325/325 | 41.3% | 55.6% | 297 | 1309 | −145 | 20 | 9/15 | 9 | 7分04秒〜9分46秒 |
| Free エンジン 80ms | 153/325 | 56.0% | 78.0% | 206 | 983 | −169 | 0 | 1/15 | 13 | 13.2〜17.0秒 |
| Free エンジン 80ms（PvInterval 0） | 325/325 | 59.3% | 76.1% | 98 | 730 | −51 | 2 | 13/15 | 13 | 13.2〜16.9秒 |
| Cloud Free | 319/325 | 65.2% | 85.1% | 52 | 265 | −26 | 0 | 15/15 | 18 | 1分45秒〜2分11秒 |

- 評価あり: complete または terminal の局面数。
- 差: 両側が cp の局面の評価値差（比較側 − Precision）。
- 向きの逆転: どちらかが ±300 以上で符号が逆、かつ差が600以上の局面数。グラフ表示値（±1500で頭打ち、詰みは±1500）で数えた。
- 大変動15手の追従: Precision の評価が指した側に不利へ700以上動いた15手のうち、同じ向きに350以上動いた手の数。
- Cloud Precision の1局の時間は 8分05秒〜10分03秒、深さ中央値は20〜21。
- 欠測の多い系列の一致率・差は評価が出た局面だけの値で、母数が違う。

全系列に評価がある139局面だけで比べた結果は次のとおり。

| 系列 | 最善手一致 | 差の中央値 |
|---|---:|---:|
| Sekirei 長め | 26.6% | 684 |
| Sekirei 5秒相当 | 43.9% | 530 |
| Free エンジン 80ms | 55.4% | 205 |
| Cloud Free | 64.7% | 92 |

### 所見

- 同じ時間・同程度のノード数（約5万）で比べても、Free エンジンは Sekirei より Precision に近い。80ms の Free エンジンは深さ13まで読み、5秒の Sekirei（深さ9）も上回った。Sekirei と Cloud の差は探索時間より、エンジンと評価関数の差によるところが大きい。
- Sekirei の探索量を約56倍（50,000→2,800,000 nodes）にすると、最善手一致は27%→41%、Precision 最善手の包含は42%→56%に上がり、探索量不足の欠測は9→0になった。一方、評価値差の中央値は336→297とほとんど縮まず、先手を低く見る偏り（−144 → −145）も変わらなかった。
- Sekirei は形勢の向きを取り違える区間がある。第2局の41〜55手目は、5秒相当でも15局面中13局面で逆のままだった。Precision が先手+400〜+1300と見る局面を後手有利と見ている。読みの深さではなく評価関数の見方の違いと考えられる。
- Cloud Free（1秒）は Precision とほぼ同じ判断で、向きの逆転は0、Precision の大変動15手はすべて追従した。所要時間は Precision の約5分の1。
- 詰み局面の勝者判定は、評価が出たすべての系列で Precision と一致した。
- 既定の「標準」（10,000 nodes）では、Sekirei は各局43・36・44局面が探索量不足で欠けた（「長め」では9局面）。

### 短時間の Free エンジンで評価が欠ける理由（#36）

| 80ms の条件 | incomplete |
|---|---:|
| MultiPV 2・PvInterval 既定（300ms） | 172 / 325（53%） |
| MultiPV 1・PvInterval 既定（300ms） | 114 / 325（35%） |
| MultiPV 2・PvInterval 0 | 0 / 325 |
| MultiPV 1・PvInterval 0 | 0 / 325 |

- YaneuraOu は PvInterval（既定300ms）より短い探索では途中の `info ... pv` を出さず、打ち切り時の最終行だけを出す。
- 打ち切りが再探索中に当たると最終行が `upperbound` / `lowerbound` になり、driver の `MultiPvCollector` は確定値でないため採用しない。それより前の確定値は出力されずに捨てられる。採否は打ち切りのタイミングで変わる。
- MultiPV 1 では、そろえる候補が減る分だけ欠測は減るが、仕組みは同じなので35%残る。
- PvInterval を 0 にすると深さごとに確定値が出力され、欠測は0になった。所要時間は変わらない。
- 現行の Cloud Free（1000ms）の incomplete 6局面が同じ原因かは未確認。driver への反映と Precision での負荷確認は #36 で扱う。
- 追記（2026-09-28）: #36 で driver に PvInterval 0 を反映した後、同じ3局の Cloud Free は incomplete 0/322 になった（[Issue #29/#36レポート](CLOUD-SESSION-AND-PVINTERVAL.md)）。上の表の Cloud Free は変更前の値である。

## 実行中に見つかった staging の問題

- Precision job が2回、途中で `retry_exhausted` になった（28/97局面目、12/102局面目）。Worker ログでは、Precision 用 Container の alarm と停止状態の更新で Cloudflare 側の internal error が出たあと session が例外で終わった。その後の再試行の `/session` はすべて 409（busy）で、間を置かない再試行が数秒で上限に達していた。後続の job も同じ409で開始直後に失敗した。Container のアイドル停止を待って再投入すると完走した。409 busy と再試行間隔の問題は #29（取消直後の次の Free job の失敗）と同じ系統と考えられる。#29 で、取り残された session の停止と再配送の遅延を追加した。
- 別の試行で、server 側の job が完了しているのに、クライアントが「Cloudサーバーへ接続できませんでした」を繰り返して結果を受信できなくなった。GET job は200で server に届いていたが、結果取得は server に届いていなかった。原因は特定できず、fetch の失敗理由を記録した再実行では再現しなかった（fetch 失敗0件）。
- ホストで Free エンジンを起動すると `info string Warning : nn.bin hash mismatch.` が出る。エンジン内部の照合値との差で、ファイルは driver の SHA-256 照合を通っている。コンテナでも同じ表示かは確認していない。

## 制約

- ホストの計測で、スマホの速度ではない。Sekirei は1スレッド、Precision は2 vCPU・2スレッドで、同じ時間でも計算資源は同じではない。
- 3局・325局面の結果で、戦型・棋力の偏りは評価していない。
- Sekirei の解析時間・品質の製品設定は #6 で扱う。
