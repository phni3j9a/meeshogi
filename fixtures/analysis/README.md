# 解析エンジン回帰fixture

このディレクトリは、meeshogi のネイティブ解析境界を検証するための公開・合成SFENだけを収録する。個人の棋譜、対局者名、サービスの認証情報は含めない。

`positions.json` の `provenance` と各局面の `purpose` が、用途と作成方法の正本である。`sequence-start` からは公開の3手詰め用合成局面を、Sekireiの合法手生成で次の指し手を適用して作った。

```text
3b4a+ 5a6a 7h7a+
```

この列の4局面は、通常探索のmate scoreを短手数詰み証明の代用にせず、連続王手中に `mate` と `scoreCp` が不正に交互変化しないことを確認する。終局局面は先手番・後手番の両方を含む。

## 収録ケース

| id | 目的 |
| --- | --- |
| `single-reply` | 合法手が1つだけの局面でも静的評価shortcutを使わず、実探索する |
| `sequence-start`, `sequence-after-first`, `sequence-after-reply`, `sequence-terminal` | 公開合成の連続王手、終局判定、mate/CPの不整合を検証する |
| `checkmate-white`, `checkmate-black`, `no-legal-moves` | 手番が異なるcheckmateと、王手ではない合法手ゼロを検証する |
| `non-mate-startpos` | 通常の非終局解析を検証する |
| `multipv-remaining-two` | 合法手2つにMultiPV 3を要求し、残り2候補を保持する |
| `tiny-budget` | 初回MultiPV反復が完了しないとき `incomplete` と合法fallbackを返す |

数値の探索結果はCPU・lockfile・予算の変更で変わり得るため、fixture自体は局面と成立条件を固定する。runtimeの固定値は `docs/ENGINE.md` とRust回帰テストを参照する。

## 出典とライセンス境界

- 将棋局面は上記の合成手順で作成したテストデータであり、私的な対局記録から抽出していない。
- 合法性の確認には、`native/sekirei` が固定する Sekirei v0.3.37 の公開合法手生成を使う。
- Sekireiのソースコード・ライセンス表示は `native/sekirei/NOTICE`、同梱weightの来歴と条件は `assets/model/NOTICE.txt` に分離して記載する。
- このfixtureの利用・再配布は、リポジトリのソースコードとデータartifactそれぞれの条件を混同しない。
