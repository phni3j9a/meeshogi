import { describe, expect, it } from 'vitest';
import {
  aggregateAll,
  aggregateExport,
  phaseOfPly,
  quantile,
} from '../../src/comparison/aggregate';
import type { ComparisonExport, PlyResult } from '../../src/comparison/schema';
import {
  cand,
  cloudMethod,
  completeResult,
  cp,
  makeExport,
  mate,
  sekireiMethod,
  sfenAt,
} from './fixtures';

function summaryOf(data: ComparisonExport, source = 'fixture.json') {
  return aggregateExport(data, source);
}

function pair(data: ComparisonExport, method: 'sekirei' | 'cloud-free') {
  const comparisons = summaryOf(data).comparisons;
  const found = comparisons.find((c) => c.method === method);
  expect(found).toBeDefined();
  return found!;
}

describe('cp差・Top-1・候補包含', () => {
  const data = makeExport(4, (ply, sfen) => ({
    // ref の cp が常に 50。比較側は ply によって一致・差・mate・候補外れを混ぜる。
    sekirei:
      ply === 0
        ? completeResult(sfen, cp(100), [cand('7g7f', cp(100)), cand('2g2f', cp(80))])
        : ply === 1
          ? completeResult(sfen, cp(-20), [cand('3c3d', cp(-20)), cand('7g7f', cp(-30))])
          : ply === 2
            ? completeResult(sfen, mate(3, 'black'), [cand('7g7f', mate(3, 'black'))])
            : completeResult(sfen, cp(50), [cand('9i9h', cp(50))]),
    'cloud-precision':
      ply === 3
        ? completeResult(sfen, cp(50), [cand('5e5d', cp(50)), cand('7g7f', cp(40))])
        : completeResult(sfen, cp(50), [cand('7g7f', cp(50)), cand('2g2f', cp(40))]),
  }));
  const s = pair(data, 'sekirei');

  it('cp 差は両側が cp の ply のみ、符号差を cmp−ref で取る', () => {
    // ply0: 100−50=+50、ply1: −20−50=−70、ply2 は mate で除外、ply3: 50−50=0
    expect(s.cpDiff.count).toBe(3);
    expect(s.cpDiff.min).toBe(-70);
    expect(s.cpDiff.max).toBe(50);
    expect(s.cpDiff.median).toBe(0);
    expect(s.cpAbsDiff.median).toBe(50);
    expect(s.cpAbsDiff.max).toBe(70);
  });

  it('Top-1 一致率は complete な両側を分母にする', () => {
    // ply0 一致、ply1 不一致（3c3d vs 7g7f）、ply2 一致、ply3 不一致（9i9h vs 5e5d）
    expect(s.top1Agreement).toEqual({ numerator: 2, denominator: 4, rate: 0.5 });
  });

  it('reference 最善手が比較側の実候補列に含まれるかを数える', () => {
    // ply0 含む(先頭)、ply1 含む(2番目)、ply2 含む、ply3 含まない
    expect(s.refBestMoveInclusion).toEqual({ numerator: 3, denominator: 4, rate: 0.75 });
    expect(s.candidateCounts.requested).toBe(2);
    expect(s.candidateCounts.effective.count).toBe(4);
  });

  it('評価種別の組合せを数える', () => {
    expect(s.scoreKind).toEqual({ bothCp: 3, bothMate: 0, refCpCmpMate: 1, refMateCmpCp: 0 });
  });
});

describe('mate・terminal の一致', () => {
  it('mate×mate の勝者一致と生距離の完全一致を別に数える', () => {
    // ply4 は cp にして mate 分母に混ぜない
    const cmpScores = [
      mate(3, 'black'),
      mate(-5, 'white'),
      mate(7, 'black'),
      mate(0, 'unknown'),
      cp(10),
    ];
    const refScores = [
      mate(3, 'black'),
      mate(-9, 'white'),
      mate(0, 'unknown'),
      mate(0, 'unknown'),
      cp(10),
    ];
    const data = makeExport(5, (ply, sfen) => ({
      sekirei: completeResult(sfen, cmpScores[ply], [cand('7g7f', cmpScores[ply])]),
      'cloud-precision': completeResult(sfen, refScores[ply], [cand('7g7f', refScores[ply])]),
    }));
    const s = pair(data, 'sekirei');
    expect(s.mateWinner.pairs).toBe(4);
    // ply0 一致、ply1 一致(white×white・距離違い)、ply2 black vs unknown 不一致、ply3 unknown×unknown 一致
    expect(s.mateWinner.agree).toBe(3);
    expect(s.mateWinner.disagree).toBe(1);
    expect(s.mateWinner.distanceExact).toBe(2); // ply0 と ply3
    expect(s.mateWinner.refUnknown).toBe(2);
    expect(s.mateWinner.cmpUnknown).toBe(1);
  });

  it('terminal×terminal の種別・勝者一致と片側のみ terminal を数える', () => {
    const data = makeExport(5, (ply, sfen) => ({
      sekirei:
        ply === 0
          ? { status: 'terminal', terminal: { kind: 'checkmate', winner: 'black' } }
          : ply === 1
            ? { status: 'terminal', terminal: { kind: 'checkmate', winner: 'black' } }
            : ply === 2
              ? { status: 'terminal', terminal: { kind: 'no-legal-moves', winner: null } }
              : ply === 3
                ? { status: 'terminal', terminal: { kind: 'checkmate', winner: 'white' } }
                : completeResult(sfen, cp(10), [cand('7g7f', cp(10))]),
      'cloud-precision':
        ply === 0
          ? { status: 'terminal', terminal: { kind: 'checkmate', winner: 'black' } }
          : ply === 1
            ? { status: 'terminal', terminal: { kind: 'no-legal-moves', winner: null } }
            : ply === 2
              ? { status: 'terminal', terminal: { kind: 'no-legal-moves', winner: null } }
              : ply === 3
                ? completeResult(sfen, cp(-900), [cand('3c3d', cp(-900))])
                : completeResult(sfen, cp(10), [cand('7g7f', cp(10))]),
    }));
    const s = pair(data, 'sekirei');
    expect(s.terminal.pairs).toBe(3);
    expect(s.terminal.kindAgree).toBe(2); // ply0, ply2
    expect(s.terminal.kindDisagree).toBe(1); // ply1
    expect(s.terminal.winnerAgree).toBe(2); // ply0 (black×black), ply2 (null×null)
    expect(s.terminal.winnerDisagree).toBe(1);
    expect(s.terminal.oneSidedPairs).toBe(1); // ply3
    expect(s.coverage.terminalMismatchPairs).toBe(1);
  });
});

describe('missing・incomplete・SFEN不一致の分母', () => {
  const data = makeExport(6, (ply, sfen) => ({
    sekirei:
      ply === 0
        ? { status: 'missing' }
        : ply === 1
          ? { status: 'missing' }
          : ply === 2
            ? { status: 'incomplete', sfen }
            : ply === 3
              ? completeResult(sfen, cp(10), [cand('7g7f', cp(10))])
              : ply === 4
                ? // 結果ソースが行 sfen と異なる局面を報告したケース
                  completeResult('lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 99', cp(10), [cand('7g7f', cp(10))])
                : completeResult(sfen, cp(10), [cand('7g7f', cp(10))]),
    'cloud-precision':
      ply === 0
        ? { status: 'missing' }
        : ply === 2
          ? { status: 'incomplete', sfen }
          : ply === 5
            ? { status: 'missing' }
            : completeResult(sfen, cp(50), [cand('7g7f', cp(50))]),
  }));
  const s = pair(data, 'sekirei');

  it('双方・比較側・reference側それぞれの missing を数え分母から外す', () => {
    expect(s.coverage.missingBoth).toBe(1); // ply0
    expect(s.coverage.missingCompared).toBe(1); // ply1
    expect(s.coverage.missingReference).toBe(1); // ply5
    expect(s.coverage.incompleteCompared).toBe(1); // ply2
    expect(s.coverage.incompleteReference).toBe(1); // ply2
    expect(s.coverage.sfenMismatch).toBe(1); // ply4（結果sfenが行sfenと不一致）
    expect(s.coverage.plies).toBe(6);
    expect(s.coverage.completePairs).toBe(1); // ply3 のみ
    expect(s.top1Agreement.denominator).toBe(1);
  });

  it('全 ply が欠測側だけなら比率は rate: null（N/A）', () => {
    const empty = makeExport(3, () => ({
      sekirei: { status: 'missing' },
      'cloud-precision': { status: 'missing' },
    }));
    const es = pair(empty, 'sekirei');
    expect(es.top1Agreement).toEqual({ numerator: 0, denominator: 0, rate: null });
    expect(es.refBestMoveInclusion.rate).toBeNull();
    expect(es.cpDiff.count).toBe(0);
    expect(es.cpDiff.median).toBeNull();
  });
});

describe('ply 境界の便宜区分', () => {
  it('0/40 → 序盤、41/90 → 中盤、91+ → 終盤', () => {
    expect(phaseOfPly(0)).toBe('opening');
    expect(phaseOfPly(40)).toBe('opening');
    expect(phaseOfPly(41)).toBe('middlegame');
    expect(phaseOfPly(90)).toBe('middlegame');
    expect(phaseOfPly(91)).toBe('endgame');
    expect(phaseOfPly(200)).toBe('endgame');
  });

  it('境界 ply が正しい bucket に入り、空 bucket は rate: null', () => {
    // ply 0..91（92行）で全方式 complete。評価差は ply 番号にする。
    const data = makeExport(92, (ply, sfen) => ({
      sekirei: completeResult(sfen, cp(ply), [cand('7g7f', cp(ply))]),
      'cloud-precision': completeResult(sfen, cp(0), [cand('7g7f', cp(0))]),
    }));
    const s = pair(data, 'sekirei');
    expect(s.byPhase.opening.plies).toBe(41); // 0..40
    expect(s.byPhase.middlegame.plies).toBe(50); // 41..90
    expect(s.byPhase.endgame.plies).toBe(1); // 91
    expect(s.byPhase.endgame.cpDiff.median).toBe(91);
    expect(s.byPhase.opening.comparablePairs).toBe(41);
    expect(s.byPhase.opening.top1.rate).toBe(1);

    // 3 ply の短い export では middlegame/endgame が空
    const short = pair(
      makeExport(3, (ply, sfen) => ({
        sekirei: completeResult(sfen, cp(ply), [cand('7g7f', cp(ply))]),
        'cloud-precision': completeResult(sfen, cp(0), [cand('7g7f', cp(0))]),
      })),
      'sekirei',
    );
    expect(short.byPhase.middlegame.plies).toBe(0);
    expect(short.byPhase.middlegame.top1.rate).toBeNull();
    expect(short.byPhase.endgame.plies).toBe(0);
  });
});

describe('表示値の変動（±1500 clip・欠測非橋接）', () => {
  it('clip・mate/terminal 写像・null ギャップの非橋接を行う', () => {
    const data = makeExport(6, (ply, sfen) => ({
      // ply0: cp 2000 → 1500, ply1: mate(3,black) → +1500（差0）,
      // ply2: missing（ギャップ）, ply3: terminal black → +1500（橋接しない）,
      // ply4: cp −2000 → −1500（差3000）, ply5: cp −1400（差100）
      sekirei:
        ply === 0
          ? completeResult(sfen, cp(2000), [cand('7g7f', cp(2000))])
          : ply === 1
            ? completeResult(sfen, mate(3, 'black'), [cand('7g7f', mate(3, 'black'))])
            : ply === 2
              ? { status: 'missing' }
              : ply === 3
                ? { status: 'terminal', terminal: { kind: 'checkmate', winner: 'black' } }
                : ply === 4
                  ? completeResult(sfen, cp(-2000), [cand('7g7f', cp(-2000))])
                  : completeResult(sfen, cp(-1400), [cand('7g7f', cp(-1400))]),
    }));
    const v = summaryOf(data).volatility.find((x) => x.method === 'sekirei')!;
    expect(v.validPlies).toBe(5);
    // 有効な隣接差は (ply0→1)=0・(ply3→4)=3000・(ply4→5)=100 の3本。ply1→3 は橋接しない。
    expect(v.adjacentAbsDiff.count).toBe(3);
    expect(v.adjacentAbsDiff.max).toBe(3000);
    expect(v.adjacentAbsDiff.median).toBe(100);
  });
});

describe('計測の分類と provenance', () => {
  it('Sekirei の runKind を completion/cache/resume/interrupt から分類する', () => {
    const withTiming = (timing: Parameters<typeof sekireiMethod>[0]) =>
      summaryOf(
        makeExport(2, (ply, sfen) => ({ sekirei: completeResult(sfen, cp(0), [cand('7g7f', cp(0))], { timing: { kind: 'app-call', elapsedMs: 10 } }) }), {
          methods: { sekirei: sekireiMethod(timing) },
        }),
      ).timing.find((t) => t.method === 'sekirei')!;

    expect(withTiming({ completion: 'completed', cacheReuseCount: 0, resumed: false }).runKind).toBe(
      'fresh-complete',
    );
    expect(withTiming({ completion: 'completed', cacheReuseCount: 3 }).runKind).toBe(
      'completed-with-cache-reuse',
    );
    expect(withTiming({ completion: 'completed', resumed: true }).runKind).toBe('resumed');
    expect(withTiming({ completion: 'partial' }).runKind).toBe('partial');
    expect(withTiming({ completion: 'completed', interrupted: true }).runKind).toBe('interrupted');
    expect(withTiming({ completion: 'unknown' }).runKind).toBe('unknown');
  });

  it('Cloud は server job 時刻から全局壁時計を引き、不明なら null のままにする', () => {
    const data = makeExport(2, (ply, sfen) => ({
      'cloud-free': completeResult(sfen, cp(0), [cand('7g7f', cp(0))], {
        timing: { kind: 'server-search', elapsedMs: 1000 },
      }),
    }));
    const t = summaryOf(data).timing.find((x) => x.method === 'cloud-free')!;
    expect(t.boundary).toBe('server-job');
    expect(t.runKind).toBe('server-job');
    expect(t.wholeGameWallMs).toBe(20_000); // 00:00:00 → 00:00:20
    expect(t.perPosition.median).toBe(1000);
    expect(t.perPositionKind).toBe('server-search');
    expect(t.cacheReuseCount).toBeNull();

    const unfinished = structuredClone(data);
    (unfinished.methods['cloud-free'] as CloudMethodExportForTest).timing = {
      createdAt: '2026-09-26T00:00:00.000Z',
      finishedAt: null,
      completion: 'running',
    };
    const t2 = summaryOf(unfinished).timing.find((x) => x.method === 'cloud-free')!;
    expect(t2.wholeGameWallMs).toBeNull();
    expect(t2.serverWindow).toBeNull();
    expect(t2.completion).toBe('running');
  });

  it('Sekirei の未計測値は null のまま保持する', () => {
    const data = makeExport(2, (ply, sfen) => ({
      sekirei: completeResult(sfen, cp(0), [cand('7g7f', cp(0))]),
    }), {
      methods: {
        sekirei: sekireiMethod({ wholeGameWallMs: null, cacheReuseCount: null, completion: 'unknown' }),
      },
    });
    const t = summaryOf(data).timing.find((x) => x.method === 'sekirei')!;
    expect(t.wholeGameWallMs).toBeNull();
    expect(t.cacheReuseCount).toBeNull();
    expect(t.runKind).toBe('unknown');
  });
});

type CloudMethodExportForTest = { timing: { createdAt: string | null; finishedAt: string | null; completion: string } };

describe('review fixes FP-007/008/009', () => {
  it('FP-007: 局面ごとの比較行を summary の plyRows に残す', () => {
    const data = makeExport(2, (ply, sfen) => ({
      sekirei: completeResult(sfen, cp(123 + ply), [cand('7g7f', cp(123 + ply))]),
      'cloud-precision': completeResult(sfen, cp(100), [cand('7g7f', cp(100))]),
    }));
    const s = pair(data, 'sekirei');
    expect(s.plyRows).toHaveLength(2);
    expect(s.plyRows[0]).toEqual({
      ply: 0,
      sfen: 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1',
      compared: {
        status: 'complete',
        sfen: 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1',
        evaluation: { kind: 'cp', value: 123 },
      },
      reference: {
        status: 'complete',
        sfen: 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1',
        evaluation: { kind: 'cp', value: 100 },
      },
      cpDiff: 23,
      cpAbsDiff: 23,
      exclusion: null,
    });
    expect(s.plyRows[1].cpDiff).toBe(24);

    // missing・incomplete・SFEN不一致・absent も理由付きで行を残す
    const mixed = makeExport(4, (ply, sfen) => ({
      ...(ply === 3 ? {} : { sekirei: completeResult(sfen, cp(10), [cand('7g7f', cp(10))]) }),
      'cloud-precision':
        ply === 0
          ? { status: 'missing' }
          : ply === 1
            ? { status: 'incomplete', sfen }
            : completeResult(sfen, cp(0), [cand('7g7f', cp(0))]),
    }));
    // ply2 の比較側 sfen を別局面へ
    const row = mixed.plies[2].results.sekirei;
    if (row) row.sfen = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 99';
    const rows = pair(mixed, 'sekirei').plyRows;
    expect(rows.map((r) => r.exclusion)).toEqual([
      'missing-reference',
      'incomplete-reference',
      'sfen-mismatch',
      'missing-compared',
    ]);
    expect(rows[3].compared.status).toBe('absent');
    expect(rows[3].cpDiff).toBeNull();
    // 合算 summary には plyRows を付けない（別棋譜の ply が衝突するため）
    const pooled = aggregateAll([
      { source: 'a.json', data },
      { source: 'b.json', data: structuredClone(data) },
    ]);
    expect(pooled.overall.comparisons.find((c) => c.method === 'sekirei')!.plyRows).toEqual([]);
  });

  it('FP-008: SFEN不一致の行を表示値系列でも欠測にして件数を残す', () => {
    const data = makeExport(2, (ply, sfen) => ({
      sekirei: completeResult(sfen, cp(ply * 100), [cand('7g7f', cp(ply * 100))]),
      'cloud-precision': completeResult(sfen, cp(0), [cand('7g7f', cp(0))]),
    }));
    const row = data.plies[1].results.sekirei;
    if (row) row.sfen = data.plies[0].sfen; // ply1 の結果が ply0 の局面を報告
    const summary = summaryOf(data);
    const v = summary.volatility.find((x) => x.method === 'sekirei')!;
    // 旧実装は不一致行を有効値として使い validPlies=2・隣接差1件だった
    expect(v.sfenMismatchRows).toBe(1);
    expect(v.validPlies).toBe(1);
    expect(v.adjacentAbsDiff.count).toBe(0);
    // pair 比較側はこれまでどおり除外として数える
    expect(summary.comparisons[0].coverage.sfenMismatch).toBe(1);
    // 合算側でも同じ規則
    const pooled = aggregateAll([
      { source: 'a.json', data },
      { source: 'b.json', data: structuredClone(data) },
    ]).overall;
    const pv = pooled.volatility.find((x) => x.method === 'sekirei')!;
    expect(pv.sfenMismatchRows).toBe(2);
    expect(pv.adjacentAbsDiff.count).toBe(0);
  });

  it('FP-009: 結果行なしを missing（内訳 absent）に数え、方式表の合計を局面数にする', () => {
    const data = makeExport(3, (ply, sfen) => ({
      'cloud-precision': completeResult(sfen, cp(0), [cand('7g7f', cp(0))]),
      ...(ply === 0 ? { sekirei: completeResult(sfen, cp(5), [cand('7g7f', cp(5))]) } : {}),
      ...(ply === 1 ? { sekirei: { status: 'missing' as const } } : {}),
    }));
    const counts = summaryOf(data).methods.sekirei.statusCounts;
    // 旧実装は行なしを捨てて missing=1、合計が局面数に届かなかった
    expect(counts.complete).toBe(1);
    expect(counts.missing).toBe(2); // 明示missing 1 + 行なし 1
    expect(counts.absent).toBe(1); // 「行なし」の内訳を区別できる
    expect(counts.complete + counts.incomplete + counts.terminal + counts.missing).toBe(3);
  });
});

describe('複数 export の合算', () => {
  it('pair を export 間で pool し、reference 不在の export は比較しない', () => {
    const a = makeExport(3, (ply, sfen) => ({
      sekirei: completeResult(sfen, cp(10), [cand('7g7f', cp(10))]),
      'cloud-precision': completeResult(sfen, cp(0), [cand('7g7f', cp(0))]),
    }));
    const b = makeExport(2, (ply, sfen) => ({
      sekirei: completeResult(sfen, cp(20), [cand('7g7f', cp(20))]),
      'cloud-precision': completeResult(sfen, cp(0), [cand('7g7f', cp(0))]),
    }));
    const noRef = makeExport(2, (ply, sfen) => ({
      sekirei: completeResult(sfen, cp(99), [cand('7g7f', cp(99))]),
    }), {
      methods: { sekirei: sekireiMethod() },
    });
    const all = aggregateAll([
      { source: 'a.json', data: a },
      { source: 'b.json', data: b },
      { source: 'noRef.json', data: noRef },
    ]);
    expect(all.exports).toHaveLength(3);
    expect(all.exports[2].comparisons).toHaveLength(0);
    expect(all.overall.exportsWithReference).toBe(2);
    const pooled = all.overall.comparisons.find((c) => c.method === 'sekirei')!;
    expect(pooled.coverage.plies).toBe(5); // 3 + 2（noRef は pool しない）
    expect(pooled.cpDiff.median).toBe(10); // [10,10,10,20,20]
    expect(pooled.top1Agreement).toEqual({ numerator: 5, denominator: 5, rate: 1 });
  });

  it('quantile は cloud/bench と同じ線形補間をする', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.9)).toBeCloseTo(3.7);
    expect(quantile([5], 0.9)).toBe(5);
    expect(quantile([], 0.5)).toBeNull();
  });
});
