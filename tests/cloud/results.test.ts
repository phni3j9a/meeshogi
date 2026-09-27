import { describe, expect, it } from 'vitest';
import { legalMoves } from '../../src/domain';
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
    // Cloud results never produce a mate proof — badges stay Sekirei-only.
    expect(display).not.toHaveProperty('mateProof');
  });

  it('後手番の局面でもサーバー正規化済みの値を再反転しない', () => {
    const result = makeSuccessResult(GOTE_POS, 'free', {
      scores: [
        { kind: 'cp', value: -120 },
        { kind: 'mate', value: -3, winningSide: 'gote' },
      ],
    });
    const row = validateCloudResult(wire(GOTE_POS, result, 1), GOTE_POS, 'free');
    expect(row).not.toBeNull();
    const display = toCloudPositionResult(row!);
    expect(display.candidates[0].scoreCp).toBe(-120);
    expect(display.candidates[1].mate).toBe(-3);
  });

  it('mate=0・勝者不明は値なしとして保持し、詰みにはしない', () => {
    const result = makeSuccessResult(STARTPOS, 'free', {
      scores: [
        { kind: 'mate', value: 0, winningSide: 'unknown' },
        { kind: 'mate', value: 7, winningSide: 'sente' },
      ],
    });
    const row = validateCloudResult(wire(STARTPOS, result), STARTPOS, 'free');
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

  it('terminal種別と実局面が合わない行を拒否する', () => {
    expect(
      validateCloudResult(
        wire(TERMINAL_MATE, makeTerminalResult(TERMINAL_MATE, 'no-legal-moves')),
        TERMINAL_MATE,
        'free',
      ),
    ).toBeNull();
    expect(
      validateCloudResult(
        wire(TERMINAL_NO_MOVES, makeTerminalResult(TERMINAL_NO_MOVES, 'checkmate')),
        TERMINAL_NO_MOVES,
        'free',
      ),
    ).toBeNull();
    // terminal だが合法手が残っている
    expect(
      validateCloudResult(
        wire(STARTPOS, makeTerminalResult(STARTPOS, 'checkmate')),
        STARTPOS,
        'free',
      ),
    ).toBeNull();
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

  it('要求数より少ない候補のsuccess行を拒否する', () => {
    // free=multiPV2、合法手は十分あるのに1候補しかない
    const result = makeSuccessResult(STARTPOS, 'free', { candidateCount: 1 });
    expect(validateCloudResult(wire(STARTPOS, result), STARTPOS, 'free')).toBeNull();
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

  it('非合法手・不正PV・重複手の候補を拒否する', () => {
    const notLegal = makeSuccessResult(STARTPOS, 'free', { moves: ['9i9i', '7g7f'] });
    expect(validateCloudResult(wire(STARTPOS, notLegal), STARTPOS, 'free')).toBeNull();

    const badPv = makeSuccessResult(STARTPOS, 'free', {
      pvOverride: (move) => [move, '9i9i'],
    });
    expect(validateCloudResult(wire(STARTPOS, badPv), STARTPOS, 'free')).toBeNull();

    const dup = makeSuccessResult(STARTPOS, 'free', { moves: ['7g7f', '7g7f'] });
    expect(validateCloudResult(wire(STARTPOS, dup), STARTPOS, 'free')).toBeNull();

    // pv[0] が move と一致しない
    const shifted = makeSuccessResult(STARTPOS, 'free', {
      pvOverride: (move, index) => (index === 0 ? ['3g3f', move] : [move]),
    });
    expect(validateCloudResult(wire(STARTPOS, shifted), STARTPOS, 'free')).toBeNull();
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
