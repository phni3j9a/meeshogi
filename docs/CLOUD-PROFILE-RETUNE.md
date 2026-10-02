# Cloud解析 Free / Precision の探索条件の見直し（Issue #46）

2026-10-02に、stagingの実際のjob API（Queue → session → engine再利用、`PvInterval 0`）で、Free / Precisionを短くする4条件を測った。目的は待ち時間とサーバーコストを下げることと、FreeとPrecisionの差を分かりやすくすること。**2026-10-02にユーザーが Free 500ms / MultiPV 1、Precision 2500ms / MultiPV 3 を採用した。** 測定後のstagingはいったん旧profile（Free 1000ms / MultiPV 2、Precision 5000ms / MultiPV 3）へ戻した。

## 結果

物差しは #20 の基準解析（standard-3 / Threads 2 / 10000ms / MultiPV 3、60局面の1回目）。engine・weight・optionsのartifact manifestは #20 から変わっていない。CP差は先手視点の評価値の絶対差（中央値 / p90）。「基準の最善手が候補内」は、条件が返した候補（MultiPV 1なら1手、3なら3手）に基準のTop-1が入る率。

| 条件 | 完了率 | Top-1一致 | 基準の最善手が候補内 | CP差 全体 | 序盤 | 中盤 | 終盤 | 92手1局job |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 基準解析の2回目（ばらつきの目安） | 60/60 | 63% | 95% | 23 / 114 | 14 / 50 | 18 / 69 | 67 / 126 | – |
| 基準解析の3回目（ばらつきの目安） | 60/60 | 68% | 97% | 19 / 158 | 13 / 53 | 18 / 122 | 64 / 325 | – |
| 現行Free（#20経路の値）1000ms / MPV2 | 60/60 | 60% | 82% | 50 / 324 | 30 / 55 | 58 / 200 | 237 / 1279 | 未計測 |
| **Free 250ms / MPV1** | 60/60 | 47% | 47% | 58 / 454 | 24 / 49 | 79 / 270 | 311 / 914 | **31秒** |
| **Free 500ms / MPV1** | 60/60 | 57% | 57% | 46 / 368 | 20 / 45 | 64 / 244 | 220 / 938 | **50秒** |
| **Precision 2500ms / MPV3** | 60/60 | 63% | 97% | 26 / 126 | 20 / 43 | 20 / 88 | 50 / 344 | **3分55秒** |
| **Precision 5000ms / MPV3（現行）** | 60/60 | 67% | 93% | 28 / 114 | 18 / 41 | 33 / 102 | 65 / 347 | **7分43秒** |

- 4条件とも、240局面・8局のjobで`incomplete`・失敗は0件だった。#20で250msの大半が`incomplete`になった問題は、`PvInterval 0`（#36）以降の経路では起きていない。
- 92手1局jobは、投入から完了までのクライアント側の実測（各2回、ほぼ同値）。Containerが起きている状態で測った。止まっている場合は、#20の実測で standard-2 が約17秒、standard-3 が約25秒の起動待ちが加わる。
- 全体表（1局面jobの所要時間を含む）は [`cloud/bench/results/issue-46/compare.md`](../cloud/bench/results/issue-46/compare.md)。測定の生データ（局面ごとの結果）はリポジトリに入れていない。

## 分かったこと

1. **Precisionは2500msに半減しても、基準との差が測れるほど変わらない。**
   - CP差（26/126 と 28/114）、Top-1（63%と67%）、候補内率（97%と93%）は、基準解析同士のばらつき（23/114、19/158、Top-1 63〜68%）の範囲に収まっている。
   - 所要時間とContainer稼働時間は約半分になる。
2. **Freeは250msと500msで品質の差がある。**
   - 500msはTop-1 57%で、現行Free（60%）に近い。250msは47%に下がる。
   - 終盤のCP差p90は両条件とも約900で、現行Free（1279）より小さい。終盤の大きな外れは、時間よりも局面の難しさの影響が大きいと見られる。
3. **FreeとPrecisionの差は、現行より分かりやすくなる。**
   - 候補の数（1手と3手）、基準の最善手が候補に入る率（47〜57%と97%）、CP差p90（368〜454と126）に差が出る。
   - 現行は、基準の最善手がTop-2内に入る率がFreeで82%、Precision（Top-3）で97%、CP差p90が324と139で、差が小さかった。

## 費用の目安（1局あたり、gross）

#20と同じ公開料率で、92手jobの所要時間 × 確保したvCPUとメモリで概算した上限。ディスク、Worker / D1 / Queue、idle待機は含まない。idle待機（`sleepAfter = 5m`）を1回分含めると、standard-2で約$0.0048、standard-3で約$0.0063が加わる。

| 条件 | 1局の概算 |
|---|---:|
| Free 250ms | 約$0.0011 |
| Free 500ms | 約$0.0018 |
| Precision 2500ms | 約$0.014 |
| Precision 5000ms | 約$0.028 |

## 採用した条件

| profile | 条件 |
|---|---|
| Free | standard-2 / Threads 1 / Hash 64 MiB / 500ms / MultiPV 1 |
| Precision | standard-3 / Threads 2 / Hash 64 MiB / 2500ms / MultiPV 3 |

- **Precision：2500ms / MultiPV 3。** 品質は5000msと見分けられず、待ち時間と費用が半分になる。
- **Free：500ms / MultiPV 1。** 旧Freeに近い最善手の一致を保ったまま、92手1局を約50秒で返せる。250ms（約31秒）は最善手の一致が10ポイント下がるため採らなかった。
- 探索条件が変わるため、旧条件で保存したCloud結果は新しい条件の結果として表示しない（既存の「条件一致の結果だけを使う」規則のまま）。
- アプリは候補を数で固定していないので、Freeでは候補が1手だけ表示される。

## 残る不確実性

- 60局面・各1回の測定で、Threads 2のPrecisionは同じ局面でも結果が揺れる（#20）。2500msと5000msの差が小さいという結論は、この標本の範囲のもの。
- 局面はコンピュータ将棋大会（WCSC36）の棋譜から抽出した。人間の実戦（将棋ウォーズなど）で同じ傾向になるかは確かめていない。
- 基準解析は「正解」ではなく、より深く読んだ解析との差の物差し。棋力や評価値の正しさは測っていない。
- MultiPV 1のFreeは、実機の画面で候補1手の表示を確認していない。
- 現行Freeの92手1局job時間は今回測っていない（#20の値は、局面ごとにengineを起動し直していた旧経路のもの）。

## 測定方法

- スクリプト：[`cloud/bench/job_study.py`](../cloud/bench/job_study.py)。`run`は匿名credentialを発行し、60局面を1局面1jobで順に解析し、92手の棋譜（`bench/dataset/game.json`の局面列から合法手で復元した`game-moves.json`）を1jobで2回解析する。最初にwarm-up jobで、stagingが期待した条件を返すことを確かめる。`compare`は #20 のraw（`raw-issue20.jsonl.xz`）の基準解析と比べる。
- 1局面1jobの所要時間（約3〜8秒）には、Queueの配送とsessionの開始が含まれるので、局面あたりの解析時間としては読まない。
- stagingの切り替え：`config/job-profiles.json`を一時的に書き換えてimageを作り、Workerと一緒にdeployした（ラウンドA：Free 250ms / Precision 2500ms、ラウンドB：Free 500ms / Precision 5000ms、いずれも`git 8411854`＋profileの変更のみ）。deploy直後の数分は旧imageが応答し、warm-upが`driver_rejected`になった（#30などで記録済みの事象）。切り替わるまでwarm-upを1分おきに再試行した。
- 測定後は、元のimage（`sha256:876f0ab9…`）とmainの設定でstagingを再deployした。internal tokenのsecretは変更していない。
