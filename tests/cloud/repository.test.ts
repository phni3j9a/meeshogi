import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalRepository } from '../../src/storage/repository';
import { type GameRecord } from '../../src/domain/model';
import { parseKif } from '../../src/domain';
import { readFileSync } from 'node:fs';
import { ENDPOINT, makeSuccessResult, sqliteDb } from './helpers';
import type { CloudAttempt } from '../../src/cloud/contract';

function attempt(overrides: Partial<CloudAttempt> = {}): CloudAttempt {
  return {
    attemptId: 'attempt-1',
    gameId: 'game-1',
    gameIdentity: 'identity-1',
    profileId: 'free',
    endpoint: ENDPOINT,
    installId: 'install-1',
    ownerId: 'own_1',
    idempotencyKey: 'mk.key-1',
    initialSfen: 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1',
    moves: ['7g7f', '3c3d'],
    totalPlies: 3,
    jobId: null,
    status: 'requesting',
    receiveAfterPly: -1,
    serverNextPly: 0,
    resultCounts: null,
    receivedCount: 0,
    validCount: 0,
    failureCode: null,
    failureMessage: null,
    lastError: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

async function setup() {
  const { db, adapter } = sqliteDb();
  const repository = new LocalRepository(adapter);
  await repository.initialize();
  const game: GameRecord = {
    ...parseKif(readFileSync('fixtures/kif/shogiwars.kif', 'utf8')),
    id: 'game-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    favorite: false,
    lastViewedPly: 0,
    mySide: null,
    attribution: 'none',
    analysis: {},
  };
  await repository.insert(game);
  return { db, repository, game };
}

describe('Cloud保存', () => {
  it('attemptを作成・読み戻し、jobId/cursorを更新する', async () => {
    const { repository } = await setup();
    const a = attempt();
    await repository.cloud.createAttempt(a);
    const loaded = await repository.cloud.attempts();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      attemptId: 'attempt-1',
      profileId: 'free',
      ownerId: 'own_1',
      idempotencyKey: 'mk.key-1',
      status: 'requesting',
      receiveAfterPly: -1,
    });
    expect(loaded[0].moves).toEqual(['7g7f', '3c3d']);

    await repository.cloud.updateAttempt('attempt-1', {
      jobId: 'job_1',
      status: 'running',
      serverNextPly: 2,
      updatedAt: '2026-01-01T00:00:01.000Z',
    });
    const updated = await repository.cloud.attempts();
    expect(updated[0].jobId).toBe('job_1');
    expect(updated[0].status).toBe('running');
    expect(updated[0].serverNextPly).toBe(2);
  });

  it('結果とcursorを同一トランザクションでコミットし、欠測を欠測のまま保持する', async () => {
    const { repository } = await setup();
    await repository.cloud.createAttempt(attempt());
    const positions = [
      'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1',
      'lnsgkgsnl/1r5b1/ppppppppp/9/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL w - 1',
      'lnsgkgsnl/1r5b1/pppppp1pp/9/6p2/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL b - 1',
    ];
    const committed = await repository.cloud.commitResults(
      'attempt-1',
      [
        { ply: 0, sfen: positions[0], status: 'success', engineLaunch: 1, result: makeSuccessResult(positions[0]) },
        { ply: 1, sfen: positions[1], status: 'incomplete', engineLaunch: 1, result: { schemaVersion: 1, sfen: positions[1], perspective: 'sente', status: 'incomplete', terminal: null, candidates: [], meta: { nodes: 10, completedDepth: null, elapsedMs: 5 }, conditions: { requested: {}, actual: {} }, identity: {} } },
      ],
      { receiveAfterPly: 1, serverNextPly: 2, updatedAt: 'x' },
    );
    expect(committed.receiveAfterPly).toBe(1);
    expect(committed.receivedCount).toBe(2);
    expect(committed.validCount).toBe(1); // incomplete は欠測のまま

    const rows = await repository.cloud.results('attempt-1');
    expect(rows.map((r) => r.ply)).toEqual([0, 1]);
    expect(rows[1].status).toBe('incomplete');

    // 同じ行を再送してもカウントは増えない（INSERT OR IGNORE）
    const again = await repository.cloud.commitResults(
      'attempt-1',
      [{ ply: 1, sfen: positions[1], status: 'incomplete', engineLaunch: 1, result: {} }],
      { serverNextPly: 2, updatedAt: 'y' },
    );
    expect(again.receivedCount).toBe(2);
  });

  it('commitの途中失敗でcursorが進まない', async () => {
    const { repository } = await setup();
    await repository.cloud.createAttempt(attempt());
    const bad = repository.cloud;
    // 結果INSERT自体は成功するが、patchの後にまとめて失敗させるため致命的な行を渡す
    await expect(
      bad.commitResults(
        'attempt-1',
        [
          { ply: 0, sfen: 'x', status: 'success', engineLaunch: 1, result: {} },
          { ply: 99, sfen: 'x', status: 'bogus' as never, engineLaunch: 1, result: {} },
        ],
        { receiveAfterPly: 99, serverNextPly: 1, updatedAt: 'x' },
      ),
    ).rejects.toThrow();
    const after = await repository.cloud.attempts();
    expect(after[0].receiveAfterPly).toBe(-1);
    expect(await repository.cloud.results('attempt-1')).toHaveLength(0);
  });

  it('freeとprecisionのattemptは別identityとして保持される', async () => {
    const { repository } = await setup();
    await repository.cloud.createAttempt(attempt({ attemptId: 'a-free', profileId: 'free', idempotencyKey: 'mk.key-free' }));
    await repository.cloud.createAttempt(
      attempt({ attemptId: 'a-precision', profileId: 'precision', idempotencyKey: 'mk.key-prec' }),
    );
    const loaded = await repository.cloud.attempts();
    expect(loaded.map((a) => a.profileId).sort()).toEqual(['free', 'precision']);
  });

  it('同一owner+同一idempotencyKeyの重複INSERTを拒否する', async () => {
    const { repository } = await setup();
    await repository.cloud.createAttempt(attempt());
    await expect(repository.cloud.createAttempt(attempt({ attemptId: 'attempt-2' }))).rejects.toThrow();
  });

  it('installIdを一度だけ発行する', async () => {
    const { repository } = await setup();
    const first = await repository.cloud.installId(() => 'install-x');
    const second = await repository.cloud.installId(() => 'install-y');
    expect(first).toBe('install-x');
    expect(second).toBe('install-x');
  });

  it('棋譜削除でattemptと結果がカスケード消去される', async () => {
    const { db, repository } = await setup();
    await repository.cloud.createAttempt(attempt({ status: 'completed' }));
    await repository.cloud.commitResults(
      'attempt-1',
      [{ ply: 0, sfen: 's', status: 'success', engineLaunch: 1, result: {} }],
      { receiveAfterPly: 0, updatedAt: 'x' },
    );
    await repository.delete('game-1');
    const attempts = db.prepare('SELECT COUNT(*) AS n FROM cloud_attempts').get() as { n: number };
    const results = db.prepare('SELECT COUNT(*) AS n FROM cloud_results').get() as { n: number };
    expect(attempts.n).toBe(0);
    expect(results.n).toBe(0);
  });

  it('user_version=1のまま・旧テーブルだけのDBを壊さず拡張する', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'meeshogi-cloud-'));
    try {
      const path = join(dir, 'test.db');
      const { adapter } = sqliteDb(path);
      const repository = new LocalRepository(adapter);
      await repository.initialize();
      const version = adapter
        ? ((await adapter.getAllAsync<{ user_version: number }>('PRAGMA user_version'))[0]
            ?.user_version ?? 0)
        : -1;
      expect(version).toBe(1);
      // 旧形式settings（analysisMethodなし）はsekirei既定として読める
      await adapter.runAsync('INSERT INTO settings (id, payload) VALUES (1, ?)', JSON.stringify({ autoAnalyze: false, analysisNodes: 5000 }));
      const loaded = await repository.load();
      expect(loaded.settings.analysisMethod).toBe('sekirei');
      expect(loaded.settings.analysisNodes).toBe(5000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('別endpointのattemptはendpoint列で区別される', async () => {
    const { repository } = await setup();
    await repository.cloud.createAttempt(
      attempt({ endpoint: 'https://a.example', idempotencyKey: 'mk.same-key' }),
    );
    await repository.cloud.createAttempt(
      attempt({
        attemptId: 'attempt-2',
        endpoint: 'https://b.example',
        idempotencyKey: 'mk.same-key',
      }),
    );
    const loaded = await repository.cloud.attempts();
    expect(loaded.map((a) => a.endpoint).sort()).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });
});
