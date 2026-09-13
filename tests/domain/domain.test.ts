import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applyUsi,
  boardView,
  formationForOpening,
  gameFormation,
  getStatistics,
  inferAttribution,
  legalMoves,
  localDateKey,
  moveLabel,
  parseKif,
} from '../../src/domain';
import {
  DEFAULT_SETTINGS,
  type GameRecord,
  type Opening,
  type Settings,
} from '../../src/domain/model';
import { InitialPositionSFEN, Move as TsshogiMove, Position, formatKIFMove } from 'tsshogi';

const fixture = (name: string): string => readFileSync(`fixtures/kif/${name}`, 'utf8');

function prefixFixture(
  name: string,
  lastPly: number,
  replacements: Record<number, string>,
): string {
  const lines = fixture(name).split(/\r?\n/u);
  const output: string[] = [];
  for (const line of lines) {
    const row = /^\s*(\d+)\s/u.exec(line);
    if (row) {
      if (Number(row[1]) > lastPly) continue;
      output.push(replacements[Number(row[1])] ?? line);
    } else if (!line.trim().startsWith('まで') && line.trim() !== '') {
      output.push(line);
    }
  }
  output.push(`${lastPly + 1} 投了`);
  return output.join('\n');
}

function generatedKif(
  usiMoves: readonly string[],
  shortNotation?: { long: string; short: string },
): string {
  const position = Position.newBySFEN(InitialPositionSFEN.STANDARD);
  if (!position) {
    throw new Error('failed to create the standard starting position');
  }
  let previous: TsshogiMove | undefined;
  const rows = usiMoves.map((usi, index) => {
    const move = position.createMoveByUSI(usi);
    if (!move || !position.isValidMove(move)) {
      throw new Error(`invalid test move at ply ${index + 1}: ${usi}`);
    }
    let notation = formatKIFMove(move, { prev: previous });
    if (shortNotation) {
      notation = notation.replace(shortNotation.long, shortNotation.short);
    }
    if (!position.doMove(move)) {
      throw new Error(`failed to apply test move at ply ${index + 1}: ${usi}`);
    }
    previous = move;
    return `${String(index + 1).padStart(4, ' ')} ${notation}`;
  });
  return [
    '開始日時：2026/09/13 00:00:00',
    '手合割：平手',
    '手数----指手---------消費時間--',
    ...rows,
    `${usiMoves.length + 1} 投了`,
    `まで${usiMoves.length}手で先手の勝ち`,
  ].join('\n');
}

const PROMOTED_MOVE_CASES = [
  {
    long: '成香',
    short: '杏',
    usiMoves: [
      '1i1h',
      '3c3d',
      '9i9h',
      '5a4b',
      '7g7f',
      '2b4d',
      '8g8f',
      '8b7b',
      '6i7h',
      '4a3b',
      '5i6h',
      '4d1g+',
      '1h1g',
      '7a6b',
      '1g1c+',
      '7b9b',
      '1c1d',
    ],
  },
  {
    long: '成桂',
    short: '圭',
    usiMoves: ['9g9f', '5a5b', '8i9g', '8c8d', '9g8e', '7a7b', '8e9c+', '3c3d', '9c9d'],
  },
  {
    long: '成銀',
    short: '全',
    usiMoves: [
      '7i7h',
      '7c7d',
      '3i3h',
      '8a7c',
      '6g6f',
      '7c8e',
      '7h6g',
      '8e9g',
      '6g7f',
      '3a3b',
      '7f6e',
      '3c3d',
      '6e7d',
      '3b3c',
      '7d8c+',
      '4a3a',
      '8c7c',
    ],
  },
] as const;

function recordFromKif(
  name: string,
  id: string,
  mySide: 'black' | 'white' | null = 'black',
): GameRecord {
  const parsed = parseKif(fixture(name));
  return {
    ...parsed,
    id,
    createdAt: '2026-09-12T00:00:00.000Z',
    favorite: false,
    lastViewedPly: 0,
    mySide,
    attribution: mySide ? 'manual' : 'none',
    analysis: {},
  };
}

describe('parseKif', () => {
  it('全角時間とサービスに記載された累計を原文のまま保持する', () => {
    const raw = fixture('shogiwars.kif').replace(
      '( 0:01/00:00:01)',
      '( ０：０１/００：００：０１)',
    );
    const game = parseKif(raw);
    expect(game.rawKif).toBe(raw);
    expect(() => parseKif(raw.replace('００：００：０１', '００：００'))).toThrow('消費時間');
    expect(game.moves[0]).toMatchObject({ elapsedMs: 1000, totalElapsedMs: 1000 });
    const adjusted = parseKif(raw.replace('００：００：０１', '０９：０９：０９'));
    expect(adjusted.moves[0].totalElapsedMs).toBe((9 * 3600 + 9 * 60 + 9) * 1000);
    expect(() => parseKif(raw.replace('０：０１/', '０：６０/'))).toThrow('消費時間');
  });
  it('imports the two documented fixtures, validates every move, and preserves source text', () => {
    const wars = parseKif(fixture('shogiwars.kif'));
    const kiou = parseKif(fixture('kiou.kif'));

    expect(wars.rawKif).toBe(fixture('shogiwars.kif'));
    expect(wars.blackName).toBe('KeroPona');
    expect(wars.whiteName).toBe('asitaka_y');
    expect(wars.blackRank).toBe('9級');
    expect(wars.whiteRank).toBe('30級');
    expect(wars.service).toBe('shogiwars');
    expect(wars.result).toBe('white-win');
    expect(wars.moves).toHaveLength(80);
    expect(wars.positions).toHaveLength(81);
    expect(wars.timeControl).toBe('0分+10秒');

    expect(kiou.service).toBe('unknown');
    expect(kiou.result).toBe('black-win');
    expect(kiou.moves).toHaveLength(77);
    expect(kiou.positions).toHaveLength(78);
    expect(kiou.openings.black.automatic).toBe('unknown');
    expect(kiou.openings.white.automatic).toBe('central');
    expect(wars.openings.black.automatic).toBe('static');
    expect(wars.openings.white.automatic).toBe('unknown');
  });

  it('accepts short and long names for promoted lance, knight, and silver', () => {
    for (const testCase of PROMOTED_MOVE_CASES) {
      const longKif = generatedKif(testCase.usiMoves);
      const shortKif = generatedKif(testCase.usiMoves, {
        long: testCase.long,
        short: testCase.short,
      });
      expect(longKif).toContain(testCase.long);
      expect(shortKif).toContain(testCase.short);

      const longGame = parseKif(longKif);
      const shortGame = parseKif(shortKif);
      expect(longGame.rawKif).toBe(longKif);
      expect(shortGame.rawKif).toBe(shortKif);
      expect(shortGame.moves.map((move) => move.usi)).toEqual(
        longGame.moves.map((move) => move.usi),
      );
      expect(shortGame.positions).toEqual(longGame.positions);
      expect(shortGame.result).toBe(longGame.result);
      expect(shortGame.identity).toBe(longGame.identity);
    }
  });

  it('rejects a notation that tsshogi would otherwise accept with ignoreValidation', () => {
    const source = fixture('shogiwars.kif').replace('1 ７六歩(77)', '1 ７六香(77)');
    expect(() => parseKif(source)).toThrow(/駒表記と局面上の指し手が一致/);
  });

  it('rejects branches and non-hirate records without returning partial data', () => {
    const branch = `${fixture('shogiwars.kif')}\n変化：1手\n   1 ２六歩(27)`;
    expect(() => parseKif(branch)).toThrow(/分岐/);
    expect(() =>
      parseKif(fixture('shogiwars.kif').replace('手合割：平手', '手合割：香落ち')),
    ).toThrow(/平手以外/);
  });

  it('rejects oversized input and contradictory terminal summaries', () => {
    expect(() => parseKif('x'.repeat(2 * 1024 * 1024 + 1))).toThrow(/2MB以下/);
    const contradictory = `${fixture('kiou.kif').replace('まで77手で先手の勝ち', 'まで76手で先手の勝ち')}`;
    expect(() => parseKif(contradictory)).toThrow(/終局手数/);
  });

  it('rejects missing and duplicate numbered rows', () => {
    const source = fixture('shogiwars.kif');
    const second = /^2 .*$/mu.exec(source)?.[0];
    expect(second).toBeTruthy();
    expect(() => parseKif(source.replace(`${second}\n`, ''))).toThrow(/件数|手数|合法手/);
    expect(() => parseKif(source.replace(second as string, `${second}\n${second}`))).toThrow(
      /件数|手数|分岐/,
    );
  });

  it('uses the documented 32-ply prefix and correct side-specific file mapping', () => {
    const blackFourth = parseKif(prefixFixture('kiou.kif', 15, { 15: '  15 ６八飛(28)' }));
    const whiteFourth = parseKif(prefixFixture('kiou.kif', 9, { 6: '   6 ４二飛(82)' }));
    const whiteThird = parseKif(prefixFixture('kiou.kif', 9, { 6: '   6 ３二飛(82)' }));
    expect(blackFourth.openings.black.automatic).toBe('fourth-file');
    expect(whiteFourth.openings.white.automatic).toBe('fourth-file');
    expect(whiteThird.openings.white.automatic).toBe('third-file');
  });

  it('classifies third-file only on the correct side-specific file and reflects it in stats', () => {
    const blackThird = parseKif(prefixFixture('kiou.kif', 1, { 1: '   1 ７八飛(28)' }));
    const blackNotThird = parseKif(prefixFixture('kiou.kif', 1, { 1: '   1 ３八飛(28)' }));
    const whiteThird = parseKif(prefixFixture('kiou.kif', 2, { 2: '   2 ３二飛(82)' }));
    expect(blackThird.openings.black.automatic).toBe('third-file');
    expect(blackNotThird.openings.black.automatic).toBe('unknown');
    expect(whiteThird.openings.white.automatic).toBe('third-file');

    const bothSides = parseKif(
      prefixFixture('kiou.kif', 2, {
        1: '   1 ７八飛(28)',
        2: '   2 ５二飛(82)',
      }),
    );
    expect(bothSides.openings.black.automatic).toBe('third-file');
    expect(bothSides.openings.white.automatic).toBe('central');
    const game: GameRecord = {
      ...bothSides,
      id: 'side-specific-third-file',
      createdAt: '2026-09-13T00:00:00.000Z',
      favorite: false,
      lastViewedPly: 0,
      mySide: 'black',
      attribution: 'manual',
      analysis: {},
    };
    expect(getStatistics([game], { opening: 'third-file', openingSide: 'self' }).total).toBe(1);
    expect(getStatistics([game], { opening: 'central', openingSide: 'opponent' }).total).toBe(1);
    expect(gameFormation(game)).toBe('double-ranging');
    expect(
      getStatistics([game]).formations.find(({ formation }) => formation === 'double-ranging')
        ?.tally.total,
    ).toBe(1);
  });
});

describe('記載日時と累計戦績', () => {
  it('区切りや桁数が混在してもローカル日時順に並ぶ', () => {
    const september = {
      ...recordFromKif('shogiwars.kif', 'sep', 'white'),
      startedAt: '2026/9/30 9:2:1',
    };
    const october = {
      ...recordFromKif('shogiwars.kif', 'oct', 'black'),
      startedAt: '2026-10-01 08:00:00',
    };
    expect(getStatistics([october, september]).trend).toEqual([
      { gameId: 'sep', winRate: 1 },
      { gameId: 'oct', winRate: 0.5 },
    ]);
    expect(localDateKey(september.startedAt)).toBe('2026-09-30 09:02:01');
    expect(localDateKey('2026/02/29')).toBe('');
    expect(localDateKey('2028/02/29')).toBe('2028-02-29 00:00:00');
  });
});

describe('position helpers', () => {
  it('applies legal USI and rejects illegal moves', () => {
    const start = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
    expect(applyUsi(start, '7g7f')).toBe(
      'lnsgkgsnl/1r5b1/ppppppppp/9/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL w - 1',
    );
    expect(() => applyUsi(start, '7g7e')).toThrow(/合法手/);
    expect(legalMoves(start)).toContain('7g7f');
    expect(legalMoves(start)).not.toContain('7g7e');
    expect(moveLabel(start, '7g7f')).toBe('▲７六歩');
  });

  it('enforces nifu, forced promotion, self-check, pawn-drop mate, and captures into hand', () => {
    const nifu = '4k4/9/9/9/9/9/9/4P4/4K4 b P 1';
    expect(legalMoves(nifu)).not.toContain('P*5b');

    const forcedPromotion = '8k/4P4/9/9/9/9/9/9/K8 b - 1';
    expect(legalMoves(forcedPromotion)).toContain('5b5a+');
    expect(legalMoves(forcedPromotion)).not.toContain('5b5a');
    expect(() => applyUsi(forcedPromotion, '5b5a')).toThrow(/合法手/);

    const inCheck = '4r3k/9/9/9/9/9/8P/9/4K4 b - 1';
    expect(() => applyUsi(inCheck, '1g1f')).toThrow(/合法手/);

    const pawnDropMate = '4k3R/8R/3R5/9/9/9/9/9/K8 b P 1';
    expect(legalMoves(pawnDropMate)).not.toContain('P*5b');
    expect(() => applyUsi(pawnDropMate, 'P*5b')).toThrow(/合法手/);

    const capture = '8k/4p4/9/9/9/9/9/4R4/K8 b - 1';
    const captured = applyUsi(capture, '5h5b');
    expect(boardView(captured).hands.black).toContainEqual({
      piece: 'pawn',
      label: '歩',
      count: 1,
    });
  });

  it('exposes occupied cells and hand counts, including promoted pieces', () => {
    const view = boardView('4k4/9/9/9/9/9/9/9/4K4 b 2R2p 1');
    expect(view.turn).toBe('black');
    expect(view.cells).toEqual(
      expect.arrayContaining([
        { file: 5, rank: 1, side: 'white', piece: 'king', label: '玉' },
        { file: 5, rank: 9, side: 'black', piece: 'king', label: '玉' },
      ]),
    );
    expect(view.hands.black).toContainEqual({ piece: 'rook', label: '飛', count: 2 });
    expect(view.hands.white).toContainEqual({ piece: 'pawn', label: '歩', count: 2 });
  });
});

describe('attribution and statistics', () => {
  it('classifies formations symmetrically and derives filtered tallies from manual corrections', () => {
    expect(formationForOpening('static', 'static')).toBe('double-static');
    expect(formationForOpening('static', 'fourth-file')).toBe('static-ranging');
    expect(formationForOpening('central', 'static')).toBe('static-ranging');
    expect(formationForOpening('third-file', 'opposing')).toBe('double-ranging');
    expect(formationForOpening('unknown', 'static')).toBe('unknown');
    expect(formationForOpening('central', 'unknown')).toBe('unknown');
    const base = recordFromKif('shogiwars.kif', 'base', 'white');
    const make = (id: string, black: Opening, white: Opening): GameRecord => ({
      ...base,
      id,
      openings: {
        ruleVersion: base.openings.ruleVersion,
        black: { automatic: black, manual: null },
        white: { automatic: white, manual: null },
      },
    });
    const games = [
      make('static', 'static', 'static'),
      make('ranging', 'third-file', 'central'),
      make('opposed', 'static', 'fourth-file'),
      make('unknown', 'unknown', 'static'),
    ];
    games[0].openings.white.manual = 'opposing';
    games[1].manualResult = 'draw';
    expect(gameFormation(games[0])).toBe('static-ranging');
    const stats = getStatistics([...games, { ...games[0], id: 'spectator', mySide: null }]);
    expect(stats.formations.map(({ formation, tally }) => [formation, tally.total])).toEqual([
      ['double-static', 0],
      ['static-ranging', 2],
      ['double-ranging', 1],
      ['unknown', 1],
    ]);
    expect(
      stats.formations.find(({ formation }) => formation === 'double-ranging')?.tally,
    ).toMatchObject({ draws: 1, wins: 0, winRate: null });
    expect(stats.formations.reduce((total, { tally }) => total + tally.total, 0)).toBe(stats.total);
    const filtered = getStatistics(games, {
      opening: 'opposing',
      openingSide: 'self',
      side: 'white',
      service: 'shogiwars',
    });
    expect(filtered.total).toBe(1);
    expect(
      filtered.formations.find(({ formation }) => formation === 'static-ranging')?.tally.wins,
    ).toBe(1);
    games[0].openings.white.manual = null;
    expect(gameFormation(games[0])).toBe('double-static');
  });
  it('matches configured names only for the game service', () => {
    const game = parseKif(fixture('shogiwars.kif'));
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      playerNames: { ...DEFAULT_SETTINGS.playerNames, shogiwars: ['KeroPona'] },
    };
    expect(inferAttribution(game, settings)).toEqual({ mySide: 'black', attribution: 'automatic' });
    expect(
      inferAttribution(game, {
        ...settings,
        playerNames: { ...settings.playerNames, shogiwars: ['KeroPona', 'asitaka_y'] },
      }),
    ).toEqual({ mySide: null, attribution: 'ambiguous' });
  });

  it('counts only attributed games and computes wins, losses, draws, interruptions, and trend', () => {
    const first = recordFromKif('shogiwars.kif', 'one', 'black');
    const second = { ...recordFromKif('kiou.kif', 'two', 'black'), result: 'draw' as const };
    const third = {
      ...recordFromKif('shogiwars.kif', 'three', null),
      result: 'black-win' as const,
    };
    const stats = getStatistics([first, second, third]);
    expect(stats.total).toBe(2);
    expect(stats.wins).toBe(0);
    expect(stats.losses).toBe(1);
    expect(stats.draws).toBe(1);
    expect(stats.winRate).toBe(0);
    expect(stats.games.map((game) => game.id)).toEqual(['one', 'two']);
    expect(stats.trend).toEqual([
      { gameId: 'two', winRate: null },
      { gameId: 'one', winRate: 0 },
    ]);
    expect(stats.services.shogiwars.total).toBe(1);
    expect(stats.services.unknown.total).toBe(1);
    expect(getStatistics([{ ...first, startedAt: '2026/13/01 00:00:00' }]).months).toEqual([]);

    const twoWins = [
      {
        ...recordFromKif('shogiwars.kif', 'wars-win', 'white'),
        openings: {
          ...first.openings,
          white: { automatic: 'central' as const, manual: 'third-file' as const },
        },
      },
      {
        ...recordFromKif('kiou.kif', 'kiou-win', 'black'),
        openings: {
          ...recordFromKif('kiou.kif', 'kiou-win', 'black').openings,
          black: { automatic: 'third-file' as const, manual: 'static' as const },
        },
      },
    ];
    const winStats = getStatistics(twoWins);
    expect(winStats.wins).toBe(2);
    expect(winStats.losses).toBe(0);
    expect(winStats.winRate).toBe(1);
    expect(
      getStatistics(twoWins, { opening: 'third-file', openingSide: 'self' }).games.map(
        (game) => game.id,
      ),
    ).toEqual(['wars-win']);
  });
});
