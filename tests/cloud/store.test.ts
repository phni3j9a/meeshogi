import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeAppStore } from '../../src/store/create-app-store';
import {
  DEFAULT_SETTINGS,
  type AnalysisConditions,
  type ParsedGame,
  type PositionAnalysis,
} from '../../src/domain/model';
import { legalMoves, parseKif } from '../../src/domain';
import { LocalRepository } from '../../src/storage/repository';
import { CloudRepository } from '../../src/storage/cloud-repository';
import { CURRENT_ANALYSIS_IDENTITY } from '../../src/analysis/identity';
import { CloudApiError } from '../../src/cloud/client';
import { memoryCredentialStore } from '../../src/cloud/credentials';
import type { CloudDeps } from '../../src/store/cloud-controller';
import { ENDPOINT, makeCloudDeps, fakeCloud, sqliteDb, type FakeCloudOptions } from './helpers';

const fixture = () => parseKif(readFileSync('fixtures/kif/shogiwars.kif', 'utf8'));

/** A 2-move prefix of the fixture: cheap but fully valid. */
function smallParsed(): ParsedGame {
  const parsed = fixture();
  return {
    ...parsed,
    moves: parsed.moves.slice(0, 2),
    positions: parsed.positions.slice(0, 3),
  };
}

function sekireiResult(sfen: string, conditions: AnalysisConditions): PositionAnalysis {
  const legal = legalMoves(sfen);
  return {
    sfen,
    ...CURRENT_ANALYSIS_IDENTITY,
    status: 'complete',
    meta: {
      requestedNodes: conditions.nodes,
      nodes: conditions.nodes,
      completedDepth: 5,
      fallback: false,
      budgetReached: true,
    },
    conditions,
    candidates: legal
      .slice(0, Math.min(conditions.multiPV, legal.length))
      .map((usi) => ({ usi, pv: [usi], depth: 5, scoreCp: 10, mate: null })),
    mateProof: null,
    completedAt: '2026-01-02T00:00:00.000Z',
  };
}

type Store = ReturnType<typeof makeAppStore>;

async function setup(options: FakeCloudOptions = {}, depsOverrides: Partial<CloudDeps> = {}) {
  const { adapter } = sqliteDb();
  const openRepository = async () => {
    const repository = new LocalRepository(adapter);
    await repository.initialize();
    return repository;
  };
  const fake = fakeCloud(options);
  const credentials = memoryCredentialStore();
  const analyze = vi.fn(async (sfen: string, conditions: AnalysisConditions) =>
    sekireiResult(sfen, conditions),
  );
  const cancel = vi.fn();
  let idSeq = 0;
  const cloud = makeCloudDeps(fake.client, credentials, depsOverrides);
  const store = makeAppStore({
    openRepository,
    analyze,
    cancel,
    createId: () => `game-${++idSeq}`,
    cloud,
  });
  return { store, adapter, openRepository, fake, credentials, analyze, cancel, cloud };
}

/** Stop pumps and let in-flight iterations settle (simulates backgrounding/kill). */
async function settle(store: Store, ms = 60) {
  store.getState().pauseCloudJobs();
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function saveSmallGame(store: Store) {
  return store.getState().saveImport(smallParsed(), {
    service: 'shogiwars',
    autoAnalyze: false,
  });
}

const attempt = (store: Store) => store.getState().cloudAttempts[0];

describe('Cloud解析のライフサイクル', () => {
  it('submit→poll→drain→completedまで進み、結果が表示可能になる', async () => {
    const { store, fake } = await setup({ perPollAdvance: 2 });
    await store.getState().initialize();
    await store.getState().updateSettings({ analysisMethod: 'cloud-free' });
    const game = await saveSmallGame(store);
    await store.getState().startCloudAnalysis(game.id);
    expect(attempt(store).status).toBe('requesting');
    expect(attempt(store).idempotencyKey).toMatch(/^mk\./u);
    await vi.waitFor(() => expect(attempt(store).status).toBe('completed'), {
      timeout: 3000,
    });
    const done = attempt(store);
    expect(done.jobId).toBe('job_1');
    expect(done.validCount).toBe(3);
    expect(done.receivedCount).toBe(3);
    await store.getState().loadCloudResults(game.id);
    const rows = store.getState().cloudResults[done.attemptId];
    expect(rows).toHaveLength(3);
    expect(rows[0].status).toBe('success');
    expect(rows[0].candidates[0].usi).toBeTruthy();
    await settle(store);
  });

  it('POST応答ロスト時に同じidempotencyKeyで再送してjobIdを回収する', async () => {
    const { store, fake } = await setup({
      perPollAdvance: 3,
      createJobFailAfterCreate: 1,
    });
    await store.getState().initialize();
    await store.getState().updateSettings({ analysisMethod: 'cloud-free' });
    const game = await saveSmallGame(store);
    await store.getState().startCloudAnalysis(game.id);
    await vi.waitFor(() => expect(attempt(store).status).toBe('completed'), {
      timeout: 3000,
    });
    const creates = fake.calls.filter((c) => c.method === 'createJob');
    expect(creates.length).toBe(2);
    expect(creates[0].detail).toBe(creates[1].detail);
    expect(fake.jobList()).toHaveLength(1);
    expect(attempt(store).jobId).toBe('job_1');
    await settle(store);
  });

  it('attempt保存に失敗した場合POSTは送られない', async () => {
    const { store, adapter, fake } = await setup({ perPollAdvance: 3 });
    await store.getState().initialize();
    await store.getState().updateSettings({ analysisMethod: 'cloud-free' });
    const game = await saveSmallGame(store);
    adapter.execAsync('DROP TABLE cloud_attempts');
    await expect(store.getState().startCloudAnalysis(game.id)).rejects.toThrow();
    expect(store.getState().cloudAttempts).toHaveLength(0);
    expect(fake.calls.filter((c) => c.method === 'createJob')).toHaveLength(0);
    await settle(store);
  });

  it('commit失敗時はcursorが進まず、復帰後に全件保存される', async () => {
    const { store, adapter } = await setup({ perPollAdvance: 3 });
    await store.getState().initialize();
    await store.getState().updateSettings({ analysisMethod: 'cloud-free' });
    const game = await saveSmallGame(store);
    const original = CloudRepository.prototype.commitResults;
    let failed = false;
    CloudRepository.prototype.commitResults = async function (
      this: CloudRepository,
      ...args: Parameters<CloudRepository['commitResults']>
    ) {
      if (!failed) {
        failed = true;
        throw new Error('simulated commit failure');
      }
      return original.apply(this, args);
    };
    try {
      await store.getState().startCloudAnalysis(game.id);
      await vi.waitFor(() => expect(attempt(store).status).toBe('completed'), {
        timeout: 3000,
      });
    } finally {
      CloudRepository.prototype.commitResults = original;
    }
    expect(attempt(store).validCount).toBe(3);
    const rows = await adapter.getAllAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM cloud_results',
    );
    expect(rows[0].n).toBe(3);
    await settle(store);
  });

  it('アプリ再起動相当でjobIdとcursorから復帰する', async () => {
    const { adapter, fake, credentials } = await setup({ perPollAdvance: 1 });
    const analyze = vi.fn(async (sfen: string, conditions: AnalysisConditions) =>
      sekireiResult(sfen, conditions),
    );
    const openRepository = async () => {
      const repository = new LocalRepository(adapter);
      await repository.initialize();
      return repository;
    };
    let idSeq = 0;
    const store1 = makeAppStore({
      openRepository,
      analyze,
      cancel: vi.fn(),
      createId: () => `g-${++idSeq}`,
      cloud: makeCloudDeps(fake.client, credentials),
    });
    await store1.getState().initialize();
    await store1.getState().updateSettings({ analysisMethod: 'cloud-free' });
    const game = await store1
      .getState()
      .saveImport(smallParsed(), { service: 'shogiwars', autoAnalyze: false });
    await store1.getState().startCloudAnalysis(game.id);
    await vi.waitFor(() => expect(attempt(store1).jobId).toBe('job_1'), { timeout: 3000 });
    // プロセス終了相当: pumpを止め、同じDBで新しいstoreを起動する
    store1.getState().pauseCloudJobs();
    await new Promise((r) => setTimeout(r, 50));

    const store2 = makeAppStore({
      openRepository,
      analyze,
      cancel: vi.fn(),
      createId: () => `g2-${++idSeq}`,
      cloud: makeCloudDeps(fake.client, credentials),
    });
    await store2.getState().initialize();
    expect(store2.getState().cloudAttempts[0]?.jobId).toBe('job_1');
    await vi.waitFor(
      () => expect(store2.getState().cloudAttempts[0].status).toBe('completed'),
      { timeout: 3000 },
    );
    expect(store2.getState().cloudAttempts[0].validCount).toBe(3);
    // jobId経由で復帰するため再送は行われない
    expect(fake.counts.createJob).toBe(1);
    await settle(store2);
  });

  it('方式切替は実行中のCloud解析を止めない', async () => {
    const { store } = await setup({ perPollAdvance: 0 });
    await store.getState().initialize();
    await store.getState().updateSettings({ analysisMethod: 'cloud-free' });
    const game = await saveSmallGame(store);
    await store.getState().startCloudAnalysis(game.id);
    await vi.waitFor(() => expect(attempt(store).jobId).toBe('job_1'), { timeout: 3000 });
    await store.getState().updateSettings({ analysisMethod: 'cloud-precision' });
    await store.getState().updateSettings({ analysisMethod: 'sekirei' });
    await new Promise((r) => setTimeout(r, 30));
    const current = attempt(store);
    expect(['queued', 'running']).toContain(current.status);
    expect(current.profileId).toBe('free');
    await settle(store);
  });

  it('Cloud実行中にローカル局面解析を実行しても互いに干渉しない', async () => {
    const { store } = await setup({ perPollAdvance: 0 });
    await store.getState().initialize();
    await store.getState().updateSettings({ analysisMethod: 'cloud-free' });
    const game = await saveSmallGame(store);
    await store.getState().startCloudAnalysis(game.id);
    await vi.waitFor(() => expect(attempt(store).jobId).toBe('job_1'), { timeout: 3000 });
    const focused = await store.getState().analyzePosition(game.positions[0]);
    expect(focused.sfen).toBe(game.positions[0]);
    // 局面解析は表示用の結果を返すだけで game.analysis を汚さない
    expect(store.getState().games.find((g) => g.id === game.id)!.analysis).toEqual({});
    expect(attempt(store).jobId).toBe('job_1');
    expect(['queued', 'running']).toContain(attempt(store).status);
    await settle(store);
  });

  it('取消はサーバーにcancelを送り、遅延結果を取り込んで終了する', async () => {
    const { store, fake } = await setup({ perPollAdvance: 0 });
    await store.getState().initialize();
    await store.getState().updateSettings({ analysisMethod: 'cloud-free' });
    const game = await saveSmallGame(store);
    await store.getState().startCloudAnalysis(game.id);
    await vi.waitFor(() => expect(attempt(store).jobId).toBe('job_1'), { timeout: 3000 });
    // サーバー側で一部処理済みにしてから取消
    fake.jobList()[0].advance(2);
    await store.getState().cancelCloudAnalysis(attempt(store).attemptId);
    await vi.waitFor(() => expect(attempt(store).status).toBe('cancelled'), { timeout: 3000 });
    expect(attempt(store).validCount).toBe(2);
    expect(attempt(store).receiveAfterPly).toBe(1);
    expect(fake.calls.some((c) => c.method === 'cancelJob')).toBe(true);
    await settle(store);
  });

  it('実行中の削除は拒否され、終了後は結果ごと消える', async () => {
    const { store, adapter, fake } = await setup({ perPollAdvance: 0 });
    await store.getState().initialize();
    await store.getState().updateSettings({ analysisMethod: 'cloud-free' });
    const game = await saveSmallGame(store);
    await store.getState().startCloudAnalysis(game.id);
    await vi.waitFor(() => expect(attempt(store).jobId).toBe('job_1'), { timeout: 3000 });
    await expect(store.getState().deleteGame(game.id)).rejects.toThrow(/Cloud/u);
    fake.jobList()[0].advance(3);
    await vi.waitFor(() => expect(attempt(store).status).toBe('completed'), { timeout: 3000 });
    await store.getState().deleteGame(game.id);
    expect(store.getState().games.find((g) => g.id === game.id)).toBeUndefined();
    expect(store.getState().cloudAttempts).toHaveLength(0);
    const attempts = await adapter.getAllAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM cloud_attempts',
    );
    const results = await adapter.getAllAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM cloud_results',
    );
    expect(attempts[0].n).toBe(0);
    expect(results[0].n).toBe(0);
    await settle(store);
  });

  it('512手を超える棋譜は開始前に拒否される', async () => {
    const { store, fake } = await setup();
    await store.getState().initialize();
    await store.getState().updateSettings({ analysisMethod: 'cloud-free' });
    const parsed = fixture();
    const moves = Array.from({ length: 513 }, (_, i) => parsed.moves[i % parsed.moves.length]);
    const positions = Array.from(
      { length: 514 },
      (_, i) => parsed.positions[i % parsed.positions.length],
    );
    const game = await store
      .getState()
      .saveImport({ ...parsed, moves, positions }, { service: 'shogiwars', autoAnalyze: false });
    await expect(store.getState().startCloudAnalysis(game.id)).rejects.toThrow(/512/u);
    expect(store.getState().cloudAttempts).toHaveLength(0);
    expect(fake.counts.createJob).toBe(0);
    await settle(store);
  });

  it('エラー応答(401/403/409/429)でattemptがerror終了する', async () => {
    for (const [status, code] of [
      [401, 'credential_rejected'],
      [403, 'profile_not_allowed'],
      [409, 'idempotency_key_in_use'],
      [429, 'quota_exceeded'],
    ] as const) {
      const { store } = await setup({
        createJobError: () => {
          throw new CloudApiError(status, code, `error ${status}`);
        },
      });
      await store.getState().initialize();
      await store.getState().updateSettings({ analysisMethod: 'cloud-free' });
      const game = await saveSmallGame(store);
      await store.getState().startCloudAnalysis(game.id);
      await vi.waitFor(() => expect(attempt(store).status).toBe('error'), { timeout: 3000 });
      expect(attempt(store).failureCode).toBe(code);
      await settle(store);
    }
  });

  it('5xxは一時エラーとして再試行し、回復後に完了する', async () => {
    let calls = 0;
    const { store } = await setup({
      perPollAdvance: 3,
      createJobError: () => {
        calls += 1;
        if (calls === 1) throw new CloudApiError(503, 'unavailable', 'server busy');
      },
    });
    await store.getState().initialize();
    await store.getState().updateSettings({ analysisMethod: 'cloud-free' });
    const game = await saveSmallGame(store);
    await store.getState().startCloudAnalysis(game.id);
    await vi.waitFor(() => expect(attempt(store).status).toBe('completed'), { timeout: 3000 });
    expect(calls).toBe(2);
    await settle(store);
  });

  it('endpoint未設定ではCloud解析を開始できない', async () => {
    const { store, fake } = await setup({}, { endpoint: () => null });
    await store.getState().initialize();
    await store.getState().updateSettings({ analysisMethod: 'cloud-free' });
    const game = await saveSmallGame(store);
    await expect(store.getState().startCloudAnalysis(game.id)).rejects.toThrow(/接続先/u);
    expect(store.getState().cloudAttempts).toHaveLength(0);
    expect(fake.counts.createJob).toBe(0);
    await settle(store);
  });

  it('取り込みの自動解析は選択された方式で実行される', async () => {
    const { store, fake } = await setup({ perPollAdvance: 3 });
    await store.getState().initialize();
    await store.getState().updateSettings({ analysisMethod: 'cloud-free', autoAnalyze: true });
    await store
      .getState()
      .saveImport(smallParsed(), { service: 'shogiwars' });
    await vi.waitFor(
      () => expect(store.getState().cloudAttempts[0]?.status).toBe('completed'),
      { timeout: 3000 },
    );
    expect(fake.counts.createJob).toBe(1);
    await settle(store);
  });

  it('sekirei選択時は従来のローカル解析のみ動作する', async () => {
    const { store, fake, analyze } = await setup();
    await store.getState().initialize();
    const game = await saveSmallGame(store);
    await store.getState().startAnalysis(game.id);
    await vi.waitFor(
      () => {
        const g = store.getState().games.find((item) => item.id === game.id);
        expect(Object.keys(g?.analysis ?? {}).length).toBe(3);
      },
      { timeout: 3000 },
    );
    expect(analyze).toHaveBeenCalled();
    expect(store.getState().cloudAttempts).toHaveLength(0);
    expect(fake.counts.createJob).toBe(0);
    await settle(store);
  });

  it('freeとprecisionの結果は別attemptとして分離される', async () => {
    const { store } = await setup({ perPollAdvance: 3 });
    await store.getState().initialize();
    const game = await saveSmallGame(store);
    await store.getState().updateSettings({ analysisMethod: 'cloud-free' });
    await store.getState().startCloudAnalysis(game.id);
    await vi.waitFor(() => expect(attempt(store).status).toBe('completed'), { timeout: 3000 });
    await store.getState().updateSettings({ analysisMethod: 'cloud-precision' });
    await store.getState().startCloudAnalysis(game.id);
    await vi.waitFor(
      () =>
        expect(
          store.getState().cloudAttempts.find((a) => a.profileId === 'precision')?.status,
        ).toBe('completed'),
      { timeout: 3000 },
    );
    const free = store.getState().cloudAttempts.find((a) => a.profileId === 'free')!;
    const precision = store.getState().cloudAttempts.find((a) => a.profileId === 'precision')!;
    expect(free.attemptId).not.toBe(precision.attemptId);
    expect(free.idempotencyKey).not.toBe(precision.idempotencyKey);
    await store.getState().loadCloudResults(game.id);
    expect(store.getState().cloudResults[free.attemptId]).toHaveLength(3);
    expect(store.getState().cloudResults[precision.attemptId]).toHaveLength(3);
    await settle(store);
  });
});
