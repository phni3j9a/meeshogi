# Issue #48 staging job measurements

実施日: 2026-10-04。候補 `5d874dc` をstagingへdeployして計測した。1局面jobはjobごとにコールドスタートし、profileごとに60件を逐次実行。生JSONL/logはscratchpadに置き、ここには集計のみを記録する。

## 1局面job

| Profile | 件数 | POST→最初の結果 p50 / p90 / 最大 | 終端→停止確認 p50 / 最大 | 停止確認 |
| --- | ---: | ---: | ---: | ---: |
| Free | 60 | 6.1 / 7.1 / 10.6秒 | 0.49 / 0.75秒 | 60/60 |
| Precision | 60 | 8.3 / 9.1 / 12.9秒 | 0.46 / 0.55秒 | 60/60 |

## 複数局面job

| 条件 | POST→最初の結果 | POST→完了 | 備考 |
| --- | --- | --- | --- |
| Free 92手 + Precision 92手を同時投入 | Free 6.0秒、Precision 9.0秒 | Free 53秒、Precision 236秒 | 互いを待たず並行。#46の温まったContainerでの値（約50秒、3分55秒）とほぼ同じ。 |
| Free 92手 ×6（上限3） | 7.9 / 62 / 72 / 116 / 125 / 131秒 | 56 / 110 / 120 / 164 / 173 / 178秒 | 全jobのContainer停止を確認。 |
| Free 92手 ×3（上限ちょうど） | delivery開始 T+0 / 54 / 65秒 | 59 / 113 / 123秒 | 全件attempt 1、503 retry 0回。 |

Queue consumerが一局の処理を終えるまで同じprofile内の次jobが始まらず、上限ちょうどの3件もほぼ順番に開始した。Queuesはbatch処理後にconsumerの自動スケールを判断する（[Cloudflare Queues consumer concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/)）。この制約はDO主導の即時開始（[#49](https://github.com/phni3j9a/meeshogi/issues/49)）で解消し、Issue #24のproduction切り替えの前提条件とする。

コールドjobの初回結果はFreeでp50 6.1秒、Precisionでp50 8.3秒だったため、Issue #48の判断としてwarm poolは不要。#20の記録では起動待ちがstandard-2約17秒、standard-3約25秒だった。最終的なContainer上限はIssue #24で確定する。現在のFree 3 / Precision 2はDO主導の即時開始が入るまでの暫定値。

5d874dcの再deploy後もFreeの完了・取消とPrecisionのsmokeが成功し、数分後も3つのjob Containerがstoppedであることを確認した。
