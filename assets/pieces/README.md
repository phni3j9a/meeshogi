# ChatGPT Imageで生成した駒

現行の駒は、ChatGPT Imageで生成した4セット分の地の素材8枚と、共通の字形15枚を組み合わせて表示する。同じセット・同じ側の全種類が同じ地の素材を使うため、駒種ごとの色のばらつきがない。各セットとも後手を少し濃くし、色は現在の持ち主に従う。設定から見本を比較して選べる。

| セット | 先手／後手の素材 | 生成プロンプト |
| --- | --- | --- |
| 黄楊（既定） | shared/wood-sente.png / wood-gote.png | [生成記録](shared/prompts.json) |
| 白木 | sets/shiraki/sente.png / gote.png | [生成記録](sets/shiraki/prompts.json) |
| 桜木 | sets/sakura/sente.png / gote.png | [生成記録](sets/sakura/prompts.json) |
| 青磁 | sets/seiji/sente.png / gote.png | [生成記録](sets/seiji/prompts.json) |

新セットの地の素材6枚は、既存の空木地をChatGPT Imageで編集生成した。白木は淡い生成り、桜木は桃茶色、青磁は青緑の磁器。五角形の形状・真上視点・細い面取りを保ち、それぞれ先手の生成結果を後手の参照に使用した。生成後は透明余白のトリミング、220×256pxへの正規化、8pxの透明余白、PNG最適化のみ。各素材は236×272pxで、プログラムによる再着色はしていない。

## 字形

各画像は文字だけの透過PNG。通常駒は墨色、成駒は朱色。先後で同じ字形を使い、王・玉のみ先手／後手で分ける。

| 字形画像（glyphs/） | 文字 | 駒 |
| --- | --- | --- |
| pawn.png | 歩 | 歩兵 |
| lance.png | 香 | 香車 |
| knight.png | 桂 | 桂馬 |
| silver.png | 銀 | 銀将 |
| gold.png | 金 | 金将 |
| bishop.png | 角 | 角行 |
| rook.png | 飛 | 飛車 |
| king.png | 王 | 先手の王 |
| jewel.png | 玉 | 後手の玉 |
| promoted-pawn.png | と | と金 |
| promoted-lance.png | 杏 | 成香 |
| promoted-knight.png | 圭 | 成桂 |
| promoted-silver.png | 全 | 成銀 |
| horse.png | 馬 | 龍馬 |
| dragon.png | 龍 | 龍王 |

先手／後手の王・玉は表示上の規約で、駒のルールは同じ。盤反転で王・玉の種類を入れ替えない。

## 表示と同梱素材

`PieceImage`は選択セット・持ち主に合う地の素材と駒種に合う字形の2画像を合成する。色重ね・tint・OSフォントによる文字描画は行わない。盤上・持駒・詰み手順で同じ表示を使い、盤反転では向きだけを変える。捕獲・駒打ちの後は現在の持ち主の木地になる。

現行素材は23枚の透過PNG、合計572,619 bytes（約0.55MiB）。全セットを静的requireで同梱し、実行時の通信は不要。地の素材のプロンプトと画像ハッシュは上表、共用する15字形は[字形の生成記録](glyphs/prompts.json)に記録する。[設定と表示の仕様](../../docs/design/piece-sets.md)も参照。

## 生成履歴

2026-09-22に最初に生成した木地と文字が一体の15画像、および後手用に個別生成した`gote/`の14画像は履歴として保持する。これら29画像は現行アプリのバンドルに含めない。旧プロンプトは[初回生成](prompts.json)と[旧後手画像](gote/prompts.json)を参照。
