# デザイン参照記録

2026-09-09にメインエージェントのみで調査・実装。ユーザーの指定に従い、axiomとサブエージェントは使用していません。

## meetermとの関係

ローカルの `../meeterm/docs/mock/README.md`、同 `assets/README.md`、`previews/overview.png`、`assets/meerkat-companion.webp`、`app/ui.tsx` を確認しました。GitHub: [phni3j9a/meeterm](https://github.com/phni3j9a/meeterm)。

引き継いだのは、アイボリーの背景、茶のアクセント、温かいグレー、細い区切り線、自然な体型の手描きミーアキャットです。SSHターミナルの操作やネイティブ描画方式は持ち込みません。

キャラクターの元絵をImageGenの参照として、王将を抱えたmeeshogiの挿絵を新しく生成しました。画像を画面全体の背景にせず、一覧の導入と空の状態・設定で、読み物を邪魔しない大きさに配置しています。

## Appllama

最初に `get_credits` を確認。`search_apps`、semanticの `search_screens`、`list_app_screens` を使用しました。検索語は `chess`、`Stoic`、`Bear notes`、`warm cream minimal journal home statistics`。chess検索の結果は、この棋譜管理アプリの実画面設計に直接合わなかったため採用していません。

３アプリの**実画面36枚**をダウンロードし、８枚ずつの一覧画像と最後の４枚を目視しました。以下は閲覧したIDです。全アプリの全画面を確認したという意味ではありません。Appllamaの画像は調査用に一時保存し、製品の素材・配布HTML・Gitリポジトリには含めていません。

### stoic. journal & mental health — app_id: 1312926037

| screen_id | 画面 |
| --- | --- |
| oth_6o8cg | Home Dashboard |
| oth_ddmk6 | Home Prompt Feed |
| oth_x37yx | Mood Check-In Intro |
| oth_9y3mq | Focus Session Setup |
| oth_etcnn | Focus Session Settings |
| oth_uvc6d | Breath Calibration |
| oth_xwuj1 | Breathing Inhale |
| oth_o5fon | Breathing Exhale |
| oth_j34oa | Breathing Inhale Control |
| oth_jxyqt | Journal Prompt Detail |
| oth_vueu5 | Trends Empty State |
| oth_thdsn | Activity Trends |
| oth_zmnt4 | Emotion Trends |
| oth_y68cf | Health Trends Access |
| oth_xns4g | Activity Trend Detail |
| oth_313on | Mood Calendar |

採用: 強い一つの数字から細かな内訳へ進む統計の階層、データのない期間を無理に数値化しない空の状態、設定シートに一つの用事をまとめる構成。

不採用: ホームを大きなプロンプトカードで埋める構成、常設の複数の浮遊ボタン、アプリに不要な習慣の強制。

### 5 Minute Journal・Daily Diary — app_id: 1062945251

| screen_id | 画面 |
| --- | --- |
| oth_k7bvc | Home |
| oth_3kxys | Home Dashboard |
| oth_92ozj | Quote Share |
| oth_303r0 | Journal Entries |
| oth_p7dtc | Guides |
| oth_iaggl | Guide Articles |
| oth_stkk4 | Challenge Share |
| oth_s21zy | Mood Insights |
| oth_lis9x | Word Insights |
| oth_vimgs | Calendar Insights |

採用: 温かい紙の色、日付から記録を追う流れ、大きな見出しと静かな補助文字、分析対象の期間が分かる切り替え。

不採用: 大きな写真カードとプレミアム販促、気分の絵文字、将棋とは関係しない引用コンテンツ。

### Bear - Markdown Notes — app_id: 1016366447

| screen_id | 画面 |
| --- | --- |
| oth_zp1lk | Notes List |
| oth_z0ooy | Welcome Note Intro |
| oth_2vyj7 | Welcome Note Outline |
| oth_2ywyb | Community Section |
| oth_5vrqu | Blank Note Editor |
| oth_8cmf8 | Text Note Editor |
| oth_ikp8k | Format Keyboard |
| oth_yg5ug | Note Context Menu |
| oth_3gp32 | Sidebar Navigation |
| oth_ar5sm | Empty Trash |

採用: 本文へ直接進める一覧、区切り線と余白で整理する行、見出し・補助情報の文字階層、キャラクターを静かに添える空の状態。書き出し・手動編集は対象の対局に紐づけたメニューへまとめました。

## meeshogiとして決めたこと

- 基本タブは製品仕様どおり「棋譜」「戦績」「設定」。盤面は棋譜から入る詳細画面で、戻ると一覧へ復帰。
- 中心色はmeetermと共通の `#fbf7ef`、`#352b22`、`#926020`。成駒には視認性のための赤茶だけを使用。
- 本文はZen Kaku Gothic New、盤の駒とPCのコピーはNoto Serif JP。画像・フォントともローカルに同梱。
- カード16px、入力8〜10px、主要ボタン12px、シート28pxの角丸を基本にする。通常の棋譜一覧は区切り線で整理。
- 棋譜の一覧は１行を押すと盤面へ。取り込みは独立したシートで内容確認と保存を行う。操作の後に戻れる先を明示。
- 評価値グラフは先手視点で固定。盤の反転で評価値の符号を入れ替えない。未解析区間を評価ゼロとしてつながない。
- マスコットが長文のAI解説を話す表現や課金誘導は入れない。将来のLLM機能は今回の初期版の主面にしない。

## ブラウザの実装資料

- [MDN: dialog](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog) — `showModal()`によるモーダル、フォーカス制御、Escape、backdrop。
- [MDN: Clipboard.readText()](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/readText) — 利用可能性と読み取り失敗時の扱い。失敗時に手動貼り付けとサンプル選択へ戻れるようにした。

Appllamaの初回メディア取得は既定User-Agentで403になりましたが、通常のブラウザUser-Agentで取得できました。認証の回避や別のログインセッションの読み取りは行っていません。
