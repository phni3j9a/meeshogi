import { describe, expect, it } from 'vitest';
import { validateComparisonExport } from '../../src/comparison/validate';
import type { ComparisonExport } from '../../src/comparison/schema';
import { cand, completeResult, cp, makeExport, sfenAt } from './fixtures';

function validFixture(): ComparisonExport {
  return makeExport(3, (ply, sfen) => ({
    sekirei: completeResult(sfen, cp(10 + ply), [cand('7g7f', cp(10 + ply))]),
    'cloud-free': completeResult(sfen, cp(20 + ply), [cand('7g7f', cp(20 + ply))]),
    'cloud-precision': completeResult(sfen, cp(ply), [cand('7g7f', cp(ply))]),
  }));
}

function errorsOf(input: unknown): string[] {
  const result = validateComparisonExport(input);
  expect(result.ok).toBe(false);
  return result.ok === false ? result.errors : [];
}

describe('比較exportのvalidation', () => {
  it('有効な fixture を受理する', () => {
    const result = validateComparisonExport(validFixture());
    expect(result).toEqual({ ok: true, value: expect.anything() });
  });

  it('schema・version・必須キーの欠落と未知キーを拒否する', () => {
    const base = JSON.parse(JSON.stringify(validFixture())) as Record<string, unknown>;
    expect(errorsOf({ ...base, schema: 'other' }).join('\n')).toContain('$.schema');
    expect(errorsOf({ ...base, schemaVersion: 2 }).join('\n')).toContain('$.schemaVersion');
    expect(errorsOf({ ...base, unknownField: 1 }).join('\n')).toContain("unknown key 'unknownField'");
    const noPly = { ...base } as Record<string, unknown>;
    delete noPly.plies;
    expect(errorsOf(noPly).join('\n')).toContain('$.plies');
  });

  it('ply の連続性・moveCount・初期局面の一致を検証する', () => {
    const base = validFixture();
    const badPly = structuredClone(base);
    (badPly.plies[1] as { ply: number }).ply = 5;
    expect(errorsOf(badPly).join('\n')).toContain('$.plies[1].ply');

    const short = structuredClone(base);
    short.plies.pop();
    expect(errorsOf(short).join('\n')).toContain('moveCount + 1');

    const wrongInitial = structuredClone(base);
    wrongInitial.plies[0].sfen = sfenAt(3);
    expect(errorsOf(wrongInitial).join('\n')).toContain('game.initialSfen');

    const badHash = structuredClone(base);
    badHash.game.moveListHash = 'xyz';
    expect(errorsOf(badHash).join('\n')).toContain('moveListHash');

    const badMoves = structuredClone(base);
    badMoves.game.moves = ['7g7f', 'not-a-move'];
    expect(errorsOf(badMoves).join('\n')).toContain('$.game.moves[1]');
  });

  it('status とフィールドの整合を要求する', () => {
    const base = validFixture();
    const row = (patch: Record<string, unknown>) => {
      const copy = structuredClone(base);
      copy.plies[0].results.sekirei = patch as never;
      return copy;
    };
    // complete に evaluation/candidates が無い
    expect(errorsOf(row({ status: 'complete', candidates: [cand('7g7f', cp(1))] })).join('\n')).toContain(
      'evaluation',
    );
    // mate の winner と符号の不一致
    expect(
      errorsOf(
        row({
          status: 'complete',
          evaluation: { kind: 'mate', value: 5, winner: 'white' },
          candidates: [cand('7g7f', { kind: 'mate', value: 5, winner: 'white' })],
        }),
      ).join('\n'),
    ).toContain('inconsistent with signed mate value');
    // evaluation は candidates[0] と一致しなければならない
    expect(
      errorsOf(
        row({
          status: 'complete',
          evaluation: cp(9),
          candidates: [cand('7g7f', cp(1))],
        }),
      ).join('\n'),
    ).toContain('must equal candidates[0].score');
    // terminal で evaluation を持たせない
    expect(
      errorsOf(row({ status: 'terminal', terminal: { kind: 'checkmate', winner: 'black' }, evaluation: cp(1) }))
        .join('\n'),
    ).toContain('terminal rows');
    // checkmate に winner が必要・no-legal-moves は winner null
    expect(
      errorsOf(row({ status: 'terminal', terminal: { kind: 'checkmate', winner: null } })).join('\n'),
    ).toContain('checkmate requires winner');
    expect(
      errorsOf(row({ status: 'terminal', terminal: { kind: 'no-legal-moves', winner: 'black' } })).join('\n'),
    ).toContain('no-legal-moves requires winner null');
    // incomplete は評価を持たない・missing は何も持たない
    expect(errorsOf(row({ status: 'incomplete', evaluation: cp(1) })).join('\n')).toContain('incomplete rows');
    expect(errorsOf(row({ status: 'missing', sfen: sfenAt(0) })).join('\n')).toContain("'missing'");
    // sekirei に server-search の時間種別は付けられない
    expect(
      errorsOf(
        row({
          status: 'complete',
          evaluation: cp(1),
          candidates: [cand('7g7f', cp(1))],
          timing: { kind: 'server-search', elapsedMs: 1 },
        }),
      ).join('\n'),
    ).toContain("'app-call' for sekirei");
  });

  it('method キーと profileId の対応・cloud 時間の前後関係を検証する', () => {
    const base = validFixture();
    const wrongProfile = structuredClone(base);
    (wrongProfile.methods['cloud-free'] as { profileId: string }).profileId = 'precision';
    expect(errorsOf(wrongProfile).join('\n')).toContain('profileId');

    const wrongTiming = structuredClone(base);
    (
      wrongTiming.methods['cloud-precision'] as {
        timing: { createdAt: string; finishedAt: string; completion: string };
      }
    ).timing = {
      createdAt: '2026-09-26T01:00:00.000Z',
      finishedAt: '2026-09-26T00:00:00.000Z',
      completion: 'completed',
    };
    expect(errorsOf(wrongTiming).join('\n')).toContain('must not precede createdAt');

    const unknownMethod = structuredClone(base);
    (unknownMethod.methods as Record<string, unknown>)['cloud-ultra'] = {};
    expect(errorsOf(unknownMethod).join('\n')).toContain("unknown method 'cloud-ultra'");
  });

  it('credential 形状・Bearer 形状の文字列をどの深さでも拒否する', () => {
    const base = validFixture();
    const cred = `mcd1_${'x'.repeat(43)}`;

    const inJobId = structuredClone(base);
    (inJobId.methods['cloud-free'] as { jobId: string }).jobId = cred;
    expect(errorsOf(inJobId).join('\n')).toContain('cloud credential');

    const inLabel = structuredClone(base);
    inLabel.game.label = `note ${cred}`;
    expect(errorsOf(inLabel).join('\n')).toContain('cloud credential');

    const inMove = structuredClone(base);
    inMove.game.moves[0] = 'Bearer abcdef1234567890';
    expect(errorsOf(inMove).join('\n')).toContain('bearer token');

    const inKey = structuredClone(base);
    (inKey as unknown as Record<string, unknown>)[`mcd1_${'y'.repeat(43)}`] = 'v';
    expect(errorsOf(inKey).join('\n')).toContain('cloud credential');
  });
});
