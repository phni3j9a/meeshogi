# モックの素材

## ミーアキャット

`meerkat-shogi.webp` と `meerkat-shogi-dark.webp` は、2026-09-09にこのモックのために組み込みImageGenで生成したものです。ユーザー指定のmeetermを参考にし、同リポジトリの `docs/mock/assets/meerkat-companion.webp` をキャラクターと画風の参照にしました。モデルを指定する引数はないため、特定モデル名での生成を主張しません。

- ライト: 1254×1254のRGB生成結果を800×800のWebPへ縮小。白背景をライト画面にmultiplyで馴染ませています。
- ダーク: ライト版の生成結果を参照し、背景をアプリのダーク色へ変更する専用画像を生成。1254×1254から800×800の可逆圧縮WebPへ縮小。
- **どちらもRGBの画像で、透過PNGではありません。** ダーク用画像を用意することで、白背景の除去フィルターに起因していた枠と粗さを解消しました。縮小・圧縮以外の画像編集はImageGenで行っています。
- 元絵の筆致を残すため、アウトラインのベクター化や生成画像からの架空のロゴ抽出はしていません。

ライト版の生成プロンプト（原文）:

> Use case: illustration-story. Asset type: original mascot spot illustration for meeshogi, a refined Japanese shogi journal mobile app, sister app to meeterm. Use the attached image as CHARACTER AND STYLE REFERENCE. Create the same naturally slender friendly meerkat, same small face, dark eye markings, sand tan fur, ivory belly and fine warm dark brown hand-ink contours. Whole body standing upright, tail curving along ground, quietly looking to the upper right. Change its pose so it gently holds ONE small wooden pentagonal Japanese shogi piece in both paws against its chest. The piece has a single elegantly inked Japanese character 王. Keep the paws anatomically coherent. Mature beautiful Japanese stationery illustration with understated pen hatching, not childish, not 3D, not clip art. Clean isolated silhouette with lots of negative space, near-square composition, animal at center, full body and tail inside frame. Palette natural sand, warm sepia, ivory. Background is perfectly flat pure white #FFFFFF, no checkerboard, no vignette, no paper texture, no cast shadow. Tiny hand-inked ground stroke allowed. No other objects, text, logo or watermark. Highest quality crisp final bitmap intended to read clearly as a small 120px companion in a polished app.

ダーク版の編集プロンプト（原文）:

> Edit target: attached meerkat holding 王 shogi piece. Preserve EXACTLY the same character, pose, anatomy, warm sepia line art, sand tan fur, ivory belly, tiny ground line, piece and its 王 character, proportions and composition. CHANGE ONLY THE BACKGROUND from white to perfectly solid uniform dark warm brown #28231E (RGB 40,35,30), edge to edge, every background pixel the same color. This is a production illustration asset for the dark theme of the same Japanese mobile app. No texture in the background, no vignette, no glow, no drop shadow, no checkerboard, no frame. Keep the entire character, paws and tail within the square canvas. Highest quality crisp illustration. Exact #28231E background is critical to compositing this into the app.

上の色は生成時の指定です。実際のRGB背景は微小な色差を含みます。テーマ背景と組み合わせた最終表示をブラウザのスクリーンショットで確認しました。

## フォント

配布元の一次資料とOFLを確認し、元フォントからFontToolsでこのモックの文字を含むWOFF2を作成しています。ライセンス全文はこのフォルダーと配布HTML内に同梱しています。

| 同梱ファイル | 用途 | 元データ |
| --- | --- | --- |
| zen-kaku-regular.woff2 | 日本語UI、ラベル、数値 | Zen Kaku Gothic New Regular |
| zen-kaku-bold.woff2 | UIの見出し・強調 | Zen Kaku Gothic New Bold |
| noto-serif-shogi.woff2 | 将棋の駒・PCのコピー | Noto Serif JP、可変フォントのウェイト500を固定 |

- [Zen Kaku Gothic New: Google Fonts配布元](https://github.com/google/fonts/tree/main/ofl/zenkakugothicnew)。Copyright 2022 The Zen Kaku Gothic Project Authors。[OFL全文](OFL-ZenKakuGothicNew.txt)。
- [Noto Serif JP: Google Fonts配布元](https://github.com/google/fonts/tree/main/ofl/notoserifjp)。Copyright 2012 Google Inc. All Rights Reserved。[OFL全文](OFL-NotoSerif.txt)。

取得日: 2026-09-09。実行時のGoogle Fontsへの接続はありません。追加した文字が同梱フォントにない場合、CSSに指定した日本語フォントへフォールバックします。

## アイコン・盤面・グラフ

アイコン、ヘッダーの駒のマーク、将棋盤、評価値グラフ、統計の円グラフは、このモックのためにSVG・CSSで記述したものです。Appllamaのスクリーンショットや既存アプリの画像を素材として同梱していません。
