import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applyUsi,
  boardView,
  getStatistics,
  inferAttribution,
  legalMoves,
  localDateKey,
  moveLabel,
  parseKif,
} from '../../src/domain';
import { DEFAULT_SETTINGS, type GameRecord, type Settings } from '../../src/domain/model';

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
    expect(kiou.openings.black.automatic).toBe('third-file');
    expect(kiou.openings.white.automatic).toBe('central');
    expect(wars.openings.black.automatic).toBe('static');
    expect(wars.openings.white.automatic).toBe('unknown');
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
