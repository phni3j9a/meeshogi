import { describe, expect, it } from 'vitest';
import { applyUsi, legalMoves } from '../../src/domain';
import {
  CLOUD_EXPECTED_IDENTITY,
  CLOUD_PROFILES,
} from '../../src/cloud/contract';
import { toCloudPositionResult, validateCloudResult } from '../../src/cloud/results';
import {
  STARTPOS,
  TERMINAL_MATE,
  TERMINAL_NO_MOVES,
  makeIncompleteResult,
  makeSuccessResult,
  makeTerminalResult,
} from './helpers';

const GOTE_POS = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL w - 1';

function wire(sfen: string, result: unknown, ply = 0) {
  return { ply, sfen, engineLaunch: 1, result };
}

describe('Cloud結果の検証', () => {
  it('有効なsuccess行を受理し、先手視点の評価値をそのまま保持する', () => {
    const result = makeSuccessResult(STARTPOS, 'free', {
      scores: [
        { kind: 'cp', value: 35 },
        { kind: 'cp', value: 20 },
      ],
    });
    const row = validateCloudResult(wire(STARTPOS, result), STARTPOS, 'free');
    expect(row).not.toBeNull();
    expect(row!.status).toBe('success');
    const display = toCloudPositionResult(row!);
    expect(display.candidates[0].scoreCp).toBe(35);
    expect(display.candidates[0].mate).toBeNull();
    expect(display.meta.completedDepth).toBe(12);
    expect(display.engineLaunch).toBe(1);
    // Engine scores never become a mate proof; only the server's proof does.
    expect(display).not.toHaveProperty('mateProof');
  });

  it('サーバーが証明した1手／3手詰めを手番側の証明として受理する', () => {
    const sente = {
      ...makeSuccessResult(STARTPOS, 'free'),
      mateProof: { version: 1, status: 'proven', plies: 3, side: 'sente', pv: ['2g2f', '8c8d', '2f2e'] },
    };
    const row = validateCloudResult(wire(STARTPOS, sente), STARTPOS, 'free');
    expect(toCloudPositionResult(row!).mateProof).toEqual({
      status: 'proven', plies: 3, side: 'black', pv: ['2g2f', '8c8d', '2f2e'],
    });
    const gote = {
      ...makeSuccessResult(GOTE_POS, 'free'),
      mateProof: { version: 1, status: 'proven', plies: 1, side: 'gote', pv: ['G*5h'] },
    };
    const goteRow = validateCloudResult(wire(GOTE_POS, gote), GOTE_POS, 'free');
    expect(toCloudPositionResult(goteRow!).mateProof).toMatchObject({ plies: 1, side: 'white' });
  });

  it('未証明・予算切れ・未知versionの証明はバッジにせず、行は受理する', () => {
    for (const mateProof of [
      { version: 1, status: 'not-found' },
      { version: 1, status: 'incomplete' },
      { version: 2, status: 'proven', plies: 5, side: 'sente', pv: ['2g2f'] },
    ]) {
      const row = validateCloudResult(
        wire(STARTPOS, { ...makeSuccessResult(STARTPOS, 'free'), mateProof }),
        STARTPOS,
        'free',
      );
      expect(row).not.toBeNull();
      expect(toCloudPositionResult(row!)).not.toHaveProperty('mateProof');
    }
  });

  it('形式不正なversion 1の詰み証明を含む行を拒否する', () => {
    for (const mateProof of [
      null,
      { version: 1, status: 'proven', plies: 1, side: 'gote', pv: ['2g2f'] },
      { version: 1, status: 'proven', plies: 3, side: 'sente', pv: ['2g2f'] },
      { version: 1, status: 'proven', plies: 2, side: 'sente', pv: ['2g2f', '8c8d'] },
      { version: 1, status: 'proven', plies: 1, side: 'sente', pv: ['bad'] },
      { version: 1, status: 'maybe' },
    ]) {
      const result = { ...makeSuccessResult(STARTPOS, 'free'), mateProof };
      expect(validateCloudResult(wire(STARTPOS, result), STARTPOS, 'free')).toBeNull();
    }
  });

  it('後手番の局面でもサーバー正規化済みの値を再反転しない', () => {
    const result = makeSuccessResult(GOTE_POS, 'precision', {
      scores: [
        { kind: 'cp', value: -120 },
        { kind: 'mate', value: -3, winningSide: 'gote' },
      ],
    });
    const row = validateCloudResult(wire(GOTE_POS, result, 1), GOTE_POS, 'precision');
    expect(row).not.toBeNull();
    const display = toCloudPositionResult(row!);
    expect(display.candidates[0].scoreCp).toBe(-120);
    expect(display.candidates[1].mate).toBe(-3);
  });

  it('mate=0・勝者不明は値なしとして保持し、詰みにはしない', () => {
    const result = makeSuccessResult(STARTPOS, 'precision', {
      scores: [
        { kind: 'mate', value: 0, winningSide: 'unknown' },
        { kind: 'mate', value: 7, winningSide: 'sente' },
      ],
    });
    const row = validateCloudResult(wire(STARTPOS, result), STARTPOS, 'precision');
    expect(row).not.toBeNull();
    const display = toCloudPositionResult(row!);
    expect(display.candidates[0].scoreCp).toBeNull();
    expect(display.candidates[0].mate).toBeNull();
    expect(display.candidates[1].mate).toBe(7);
  });

  it('winningSideと符号が矛盾するmate行を拒否する', () => {
    const result = makeSuccessResult(STARTPOS, 'free', {
      scores: [{ kind: 'mate', value: -5, winningSide: 'sente' }, { kind: 'cp', value: 0 }],
    });
    expect(validateCloudResult(wire(STARTPOS, result), STARTPOS, 'free')).toBeNull();
  });

  it('詰み終局のterminal行を受理して変換する', () => {
    const row = validateCloudResult(
      wire(TERMINAL_MATE, makeTerminalResult(TERMINAL_MATE, 'checkmate')),
      TERMINAL_MATE,
      'free',
    );
    expect(row).not.toBeNull();
    expect(row!.status).toBe('terminal');
    const display = toCloudPositionResult(row!);
    expect(display.terminal).toBe('checkmate');
    expect(display.candidates).toEqual([]);
  });

  it('合法手なし（非詰み）のterminal行を受理する', () => {
    const row = validateCloudResult(
      wire(TERMINAL_NO_MOVES, makeTerminalResult(TERMINAL_NO_MOVES, 'no-legal-moves')),
      TERMINAL_NO_MOVES,
      'free',
    );
    expect(row).not.toBeNull();
    expect(toCloudPositionResult(row!).terminal).toBe('no-legal-moves');
  });

  it('終局判定はサーバーを信頼し、端末では再判定しない', () => {
    // Deliberately inconsistent with the board: only the server adjudicates
    // terminal positions. The client still requires a well-formed result.
    const result = makeTerminalResult(STARTPOS, 'checkmate');
    expect(validateCloudResult(wire(STARTPOS, result), STARTPOS, 'free')).not.toBeNull();
  });

  it('terminalの種別不正・候補混入・探索条件やmetaの混入を拒否する', () => {
    const valid = makeTerminalResult(TERMINAL_MATE, 'checkmate');
    for (const result of [
      { ...valid, terminal: 'unknown' },
      { ...valid, candidates: [{ move: '7g7f' }] },
      { ...valid, conditions: { ...valid.conditions, actual: CLOUD_PROFILES.free } },
      { ...valid, meta: { ...valid.meta, completedDepth: 1 } },
    ]) {
      expect(validateCloudResult(wire(TERMINAL_MATE, result), TERMINAL_MATE, 'free')).toBeNull();
    }
  });

  it('incomplete行を受理し、欠測として保持する', () => {
    const row = validateCloudResult(
      wire(STARTPOS, makeIncompleteResult(STARTPOS), 2),
      STARTPOS,
      'free',
    );
    expect(row).not.toBeNull();
    expect(row!.status).toBe('incomplete');
    const display = toCloudPositionResult(row!);
    expect(display.candidates).toEqual([]);
    expect(display.meta.nodes).toBe(1234);
    expect(display.meta.completedDepth).toBeNull();
  });

  it('実効MultiPVと候補数が一致しないsuccess行を拒否する', () => {
    // The server declared actual.multiPV=3, but only one candidate arrived.
    const result = makeSuccessResult(STARTPOS, 'precision', { candidateCount: 1 });
    expect(validateCloudResult(wire(STARTPOS, result), STARTPOS, 'precision')).toBeNull();
  });

  it('サーバーが確定した実効MultiPVを受け入れ、合法手数を再計算しない', () => {
    const result = makeSuccessResult(STARTPOS, 'precision', { candidateCount: 1 });
    result.conditions.actual.multiPV = 1;
    expect(validateCloudResult(wire(STARTPOS, result), STARTPOS, 'precision')).not.toBeNull();
  });

  it.each([0, -1, 1.5, 4, null, undefined, '3'])('不正な実効MultiPV %s を拒否する', (multiPV) => {
    const valid = makeSuccessResult(STARTPOS, 'precision');
    const result = {
      ...valid,
      conditions: { ...valid.conditions, actual: { ...valid.conditions.actual, multiPV } },
    };
    expect(validateCloudResult(wire(STARTPOS, result), STARTPOS, 'precision')).toBeNull();
  });

  it('局面末端で要求数未満の候補を受理する', () => {
    // 王手を回避しうる手が1つだけの局面
    const sfen = '4k4/4R4/9/9/9/9/9/9/4K4 w - 1';
    const legal = legalMoves(sfen);
    expect(legal.length).toBeGreaterThan(0);
    const count = Math.min(CLOUD_PROFILES.precision.multiPV, legal.length);
    const result = makeSuccessResult(sfen, 'precision', { candidateCount: count });
    const row = validateCloudResult(wire(sfen, result), sfen, 'precision');
    expect(row).not.toBeNull();
  });

  it('SFEN不一致・identity不一致・条件不一致を拒否する', () => {
    const ok = makeSuccessResult(STARTPOS, 'free');
    expect(validateCloudResult(wire(STARTPOS, ok), GOTE_POS, 'free')).toBeNull();
    const wrongSfen = { ...ok, sfen: GOTE_POS };
    expect(validateCloudResult(wire(STARTPOS, wrongSfen), STARTPOS, 'free')).toBeNull();
    const wrongIdentity = {
      ...ok,
      identity: { ...CLOUD_EXPECTED_IDENTITY, modelId: 'other-model' },
    };
    expect(validateCloudResult(wire(STARTPOS, wrongIdentity), STARTPOS, 'free')).toBeNull();
    const wrongConditions = {
      ...ok,
      conditions: {
        requested: { ...CLOUD_PROFILES.free, moveTimeMs: 9999 },
        actual: { ...CLOUD_PROFILES.free, multiPV: 2 },
      },
    };
    expect(validateCloudResult(wire(STARTPOS, wrongConditions), STARTPOS, 'free')).toBeNull();
    // freeプロファイルの結果をprecision行としても受理しない
    expect(validateCloudResult(wire(STARTPOS, ok), STARTPOS, 'precision')).toBeNull();
  });

  it('重複候補・候補とPVの先頭不一致を拒否する', () => {
    const dup = makeSuccessResult(STARTPOS, 'free', { moves: ['7g7f', '7g7f'] });
    expect(validateCloudResult(wire(STARTPOS, dup), STARTPOS, 'free')).toBeNull();

    // pv[0] が move と一致しない
    const shifted = makeSuccessResult(STARTPOS, 'free', {
      pvOverride: (move, index) => (index === 0 ? ['3g3f', move] : [move]),
    });
    expect(validateCloudResult(wire(STARTPOS, shifted), STARTPOS, 'free')).toBeNull();
  });

  it('受信時はPVの合法性を再検証せず、実際に指すときは非合法手を拒否する', () => {
    const result = makeSuccessResult(STARTPOS, 'precision', {
      pvOverride: (move) => [move, ...Array<string>(255).fill('7g7f')],
    });
    // Syntactically valid but intentionally illegal continuations make the
    // server/client responsibility split explicit, even for maximum-size PVs.
    const row = validateCloudResult(wire(STARTPOS, result), STARTPOS, 'precision');
    expect(row).not.toBeNull();
    expect(toCloudPositionResult(row!).candidates).toHaveLength(3);
    expect(toCloudPositionResult(row!).candidates[0].pv).toHaveLength(256);
    const after = applyUsi(STARTPOS, result.candidates[0].move);
    expect(() => applyUsi(after, '7g7f')).toThrow(/合法手/u);
  });

  it.each(['', '7g0f', '7g7j', '7g7f++', 'K*5b', 'P*5b+', '7g7f\n', 'resign', 42, null])(
    '候補・PV中の不正なUSI形式 %s を拒否する',
    (move) => {
      const badCandidate = makeSuccessResult(STARTPOS, 'free');
      badCandidate.candidates[0].move = move as string;
      badCandidate.candidates[0].pv = [move as string];
      expect(validateCloudResult(wire(STARTPOS, badCandidate), STARTPOS, 'free')).toBeNull();
      const badPv = makeSuccessResult(STARTPOS, 'free', {
        pvOverride: (root) => [root, move as string],
      });
      expect(validateCloudResult(wire(STARTPOS, badPv), STARTPOS, 'free')).toBeNull();
    },
  );

  it('成り・駒打ちのUSI形式を受理し、空や上限超過のPVを拒否する', () => {
    const result = makeSuccessResult(STARTPOS, 'free', {
      pvOverride: (move) => [move, '2b3c+', 'P*5b'],
    });
    expect(validateCloudResult(wire(STARTPOS, result), STARTPOS, 'free')).not.toBeNull();
    for (const pv of [[], Array<string>(257).fill(result.candidates[0].move)]) {
      result.candidates[0].pv = pv;
      expect(validateCloudResult(wire(STARTPOS, result), STARTPOS, 'free')).toBeNull();
    }
  });

  it('successのmeta欠測・incompleteの候補混入を拒否する', () => {
    const noDepth = makeSuccessResult(STARTPOS, 'free');
    noDepth.meta.completedDepth = null as never;
    expect(validateCloudResult(wire(STARTPOS, noDepth), STARTPOS, 'free')).toBeNull();

    const badIncomplete = {
      ...makeIncompleteResult(STARTPOS),
      candidates: [{ move: '7g7f', pv: ['7g7f'], score: { kind: 'cp', value: 0 } }],
    };
    expect(
      validateCloudResult(wire(STARTPOS, badIncomplete), STARTPOS, 'free'),
    ).toBeNull();
  });
});
