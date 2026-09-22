// Verify two synthetic KIF sequences end in real checkmate (tsshogi) and emit the KIF text.
const {
  Position, InitialPositionSFEN, formatKIFMove, importKIF,
} = require('tsshogi');

const FILES = '123456789';
const RANKS = 'abcdefghi';

// 先手勝ち: sente horse lands on 4一 (capturing gote gold) adjacent-checking king
// at 5一; defended by sente pawn at 4二; escapes 5二/6二 covered by gold 5三,
// corner 6一 blocked by gote's own gold, 4二 pawn defended by the horse itself.
// 後手勝ち: gote rook captures sente gold on 4九 adjacent-checking king 5九;
// rook defended by dropped bishop 5八; escapes 4八/6八/5八 covered by gold 5七,
// 6九 blocked by sente gold, 3九 by sente silver.
const GAMES = {
  'mate-sente-win': {
    summary: 'まで29手で先手の勝ち',
    usi: [
      '7g7f', '3c3d', '4g4f', '8b7b', '8h2b+', '7b8b', '4i4h', '8b7b',
      '4h4g', '7b8b', '4g5f', '8b7b', '5f5e', '7b8b', '5e5d', '8b7b',
      '5d5c', '7b8b', '4f4e', '8b7b', '4e4d', '7b8b', '4d4c', '8b7b',
      '4c4b', '7b8b', '2b3b', '8b7b', '3b4a',
    ],
  },
  'mate-gote-win': {
    summary: 'まで34手で後手の勝ち',
    usi: [
      '7g7f', '3c3d', '8h2b+', '3a2b', '2h3h', '8c8d', '3h2h', '8d8e',
      '2h3h', '6c6d', '3h2h', '6d6e', '2h3h', '6a6b', '3h2h', '6b6c',
      '2h3h', '6c6d', '3h2h', '6d5e', '2h3h', '5e5f', '3h2h', '5f5g',
      '2h3h', '8b8d', '3h2h', '8d4d', '2h3h', '4d4g', '3h2h', 'B*5h',
      '2h3h', '4g4i',
    ],
  },
};

const DESTS = [];
for (const f of FILES) for (const r of RANKS) DESTS.push(f + r);

function* candidateUsis(pos) {
  for (const f of FILES) for (const r of RANKS) {
    const from = f + r;
    for (const to of DESTS) {
      if (to === from) continue;
      yield from + to;
      yield from + to + '+';
    }
  }
  const hand = pos.color === 'black' ? pos.blackHand : pos.whiteHand;
  for (const p of ['P', 'L', 'N', 'S', 'G', 'B', 'R']) {
    for (const to of DESTS) yield `${p}*${to}`;
  }
}

function firstLegalMove(pos) {
  for (const usi of candidateUsis(pos)) {
    const mv = pos.createMoveByUSI(usi);
    if (mv && pos.isValidMove(mv)) return usi;
  }
  return null;
}

for (const [name, game] of Object.entries(GAMES)) {
  const pos = Position.newBySFEN(InitialPositionSFEN.STANDARD);
  if (!pos) throw new Error('no standard position');
  const rows = [];
  let prev;
  game.usi.forEach((usi, i) => {
    const mv = pos.createMoveByUSI(usi);
    if (!mv) throw new Error(`${name} ply ${i + 1}: cannot create move ${usi}`);
    if (!pos.isValidMove(mv)) throw new Error(`${name} ply ${i + 1}: ILLEGAL move ${usi}`);
    rows.push(`${i + 1} ${formatKIFMove(mv, { prev })}   ( 0:01/00:00:${String(i + 1).padStart(2, '0')})`);
    pos.doMove(mv);
    prev = mv;
  });
  const checked = pos.checked;
  const escape = firstLegalMove(pos);
  console.log(`=== ${name} ===`);
  console.log(`plies=${game.usi.length} sideToMove=${pos.color === 'black' ? 'black' : 'white'} checked=${checked} legalMoveFound=${escape ?? 'none'}`);
  console.log(`sfen=${pos.sfen}`);
  if (!checked || escape) {
    console.log('NOT A MATE — rejecting');
    process.exitCode = 1;
  } else {
    console.log('CHECKMATE CONFIRMED');
  }
  const kif = [
    '開始日時：2026/09/22 00:00:00',
    '終了日時：2026/09/22 00:10:00',
    '場所：その他',
    '持ち時間：0分',
    '秒読み：10秒',
    '手合割：平手',
    '先手：検証先手',
    '後手：検証後手',
    '手数----指手---------消費時間--',
    ...rows,
    game.summary,
    '',
  ].join('\n');
  require('fs').writeFileSync(`${__dirname}/${name}.kif`, kif, 'utf8');
  try {
    const rec = importKIF(kif);
    const usiMoves = rec.position?.record?.moves?.length ?? 'n/a';
    console.log(`importKIF ok, errors=${(rec.errors ?? []).length}`);
  } catch (e) {
    console.log(`importKIF threw: ${e.message}`);
    process.exitCode = 1;
  }
}
