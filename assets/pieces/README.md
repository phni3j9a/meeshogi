# ChatGPT Imageで生成した駒

2026-09-22に組み込みのChatGPT Imageで15種類を個別生成した。駒の木地・五角形・文字を含めて生成し、他アプリの画像やOSフォントを重ねた素材は使用していない。

| 画像 | 文字 | 駒 |
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

通常駒の字は墨色、成駒は朱色。字形を目視確認した。先手／後手の王・玉は表示上の規約で、駒のルールは同じ。盤反転で王・玉の種類を入れ替えない。

全画像は透過PNG。生成出力は1254×1254pxで、透明余白のトリミング、224×256px以内への縮小、8pxの透明余白追加、PNGパレット最適化だけを行った。輪郭・文字・色の描き直しは行っていない。15枚の合計は約0.53MiB。静的requireでMetroに同梱し、実行時の通信は不要。

個別の正確なプロンプト、生成元と同梱版のSHA-256は [prompts.json](prompts.json) に記録する。共通の指示は「真上から見た淡い蜂蜜色のツゲの一文字駒、細かな縦木目、薄い面取り、読みやすい楷書、透過背景」。画像は盤上・持駒・詰み手順で共有する。
