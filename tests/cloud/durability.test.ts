import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeAppStore } from '../../src/store/create-app-store';
import {
  type AnalysisConditions,
  type ParsedGame,
  type PositionAnalysis,
} from '../../src/domain/model';
import { legalMoves, parseKif } from '../../src/domain';
import { CURRENT_ANALYSIS_IDENTITY } from '../../src/analysis/identity';
import { LocalRepository } from '../../src/storage/repository';
import { CloudApiError } from '../../src/cloud/client';
import {
  attemptBlocksDelete,
  cloudAttemptLabel,
  type CloudAttempt,
} from '../../src/cloud/contract';
import { memoryCredentialStore, type CredentialStore } from '../../src/cloud/credentials';
import type { CloudCredential } from '../../src/cloud/client';
import { buildComparisonExport } from '../../src/comparison/export';
import type { CloudMethodExport } from '../../src/comparison/schema';
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

type Store = ReturnType<typeof makeAppStore>;

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

async function setup(
  options: FakeCloudOptions = {},
  depsOverrides: Partial<CloudDeps> = {},
  analyze: (sfen: string, conditions: AnalysisConditions) => Promise<PositionAnalysis> = async () => {
    throw new Error('unused');
  },
) {
  const { db, adapter } = sqliteDb();
  const repository = new LocalRepository(adapter);
  await repository.initialize();
  const fake = fakeCloud(options);
  const credentials = memoryCredentialStore();
  let idSeq = 0;
  const store = makeAppStore({
    openRepository: async () => repository,
    analyze,
    cancel: () => {},
    createId: () => `id-${++idSeq}`,
    cloud: makeCloudDeps(fake.client, credentials, depsOverrides),
  });
  await store.getState().initialize();
  await store.getState().updateSettings({ analysisMethod: 'cloud-free' });
  const game = await store
    .getState()
    .saveImport(smallParsed(), { service: 'shogiwars', autoAnalyze: false });
  return { store, repository, db, fake, credentials, game };
}

const attempt = (store: Store) => store.getState().cloudAttempts[0];
const flush = async (turns = 50) => {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
};
/** memoryCredentialStore exposes a mutable test seam behind a readonly type. */
const setCredential = (store: CredentialStore, next: CloudCredential | null) => {
  (store as unknown as { value: CloudCredential | null }).value = next;
};

describe('Cloud永続化の回帰（FP-001…006）', () => {
  it('FP-001: 終端replay後の保存失敗でもresumeが残りの結果をdrainする', async () => {
    const { store, fake, repository, game } = await setup();
    const original = fake.client.createJob;
    // Same-key replay of an already completed job: HTTP 200 + terminal view.
    fake.client.createJob = async (credential, body) => {
      const view = await original(credential, body);
      fake.jobList()[0].advance(3);
      return {
        ...view,
        status: 'completed',
        nextPly: 3,
        resultCounts: { success: 3 },
        finishedAt: '2026-01-01T00:01:00.000Z',
        idempotentReplay: true,
      };
    };
    const commit = repository.cloud.commitResults.bind(repository.cloud);
    let failures = 0;
    repository.cloud.commitResults = async (...args) => {
      if (failures++ === 0) throw new Error('temporary storage failure');
      return commit(...args);
    };
    await store.getState().startCloudAnalysis(game.id);
    // The commit failure must not strand the attempt: terminal was confirmed
    // server-side but rows were undrained, so the pump keeps the attempt
    // resumable and a later iteration finishes draining.
    await vi.waitFor(() => expect(attempt(store).status).toBe('completed'), { timeout: 3000 });
    expect(failures).toBe(2); // first commit threw, the retry succeeded
    expect(attempt(store).receiveAfterPly).toBe(2);
    expect(attempt(store).validCount).toBe(3);
    expect(attempt(store).serverStatus).toBe('completed');
    expect(fake.counts.getResults).toBeGreaterThan(1);
    store.getState().pauseCloudJobs();
  });

  it('FP-002: startの二重実行（credential発行が遅い場合）は1 attempt / 1 POST / 1発行になる', async () => {
    const { store, fake, game } = await setup({ perPollAdvance: 3 });
    const original = fake.client.createCredential;
    let issuance = 0;
    fake.client.createCredential = async () => {
      issuance += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return original();
    };
    await Promise.all([
      store.getState().startCloudAnalysis(game.id),
      store.getState().startCloudAnalysis(game.id),
    ]);
    await vi.waitFor(() => expect(attempt(store).jobId).toBe('job_1'), { timeout: 3000 });
    await vi.waitFor(() => expect(attempt(store).status).toBe('completed'), { timeout: 3000 });
    expect(store.getState().cloudAttempts).toHaveLength(1);
    expect(fake.counts.createJob).toBe(1);
    expect(issuance).toBe(1);
    store.getState().pauseCloudJobs();
  });

  it('FP-002b: credential既存でも二重startは1 attempt / 1 POSTになる', async () => {
    const { store, fake, credentials, game } = await setup({ perPollAdvance: 3 });
    setCredential(credentials, {
      credential: 'cred-existing',
      ownerId: 'own_existing',
      installId: 'install-1',
      endpoint: ENDPOINT,
      issuedAt: '2026-01-01T00:00:00.000Z',
    });
    let issuance = 0;
    const original = fake.client.createCredential;
    fake.client.createCredential = async () => {
      issuance += 1;
      return original();
    };
    await Promise.all([
      store.getState().startCloudAnalysis(game.id),
      store.getState().startCloudAnalysis(game.id),
    ]);
    await vi.waitFor(() => expect(attempt(store).status).toBe('completed'), { timeout: 3000 });
    expect(store.getState().cloudAttempts).toHaveLength(1);
    expect(fake.counts.createJob).toBe(1);
    expect(issuance).toBe(0);
    store.getState().pauseCloudJobs();
  });

  it('FP-003: 起きた旧sleepが新しいsleepのresolverを消さずcancelが再試行される', async () => {
    const wakes: (() => void)[] = [];
    const { store, fake, game } = await setup(
      {},
      { sleep: () => new Promise((resolve) => wakes.push(resolve)) },
    );
    const original = fake.client.cancelJob;
    let cancelCalls = 0;
    fake.client.cancelJob = async (credential, jobId) => {
      cancelCalls += 1;
      if (cancelCalls === 1) throw new CloudApiError(0, 'network', 'network');
      return original(credential, jobId);
    };
    await store.getState().startCloudAnalysis(game.id);
    await vi.waitFor(() => expect(wakes.length).toBe(1));
    await store.getState().cancelCloudAnalysis(attempt(store).attemptId);
    // Cancel POST failed transiently → pump backed off into a second sleep.
    await vi.waitFor(() => expect(wakes.length).toBe(2));
    // The stale first timer resolves late: it must not eat the second
    // registration, so resolving sleep② still wakes the pump for a retry.
    wakes[0]();
    await flush();
    wakes[1]();
    await flush();
    await vi.waitFor(() => expect(cancelCalls).toBe(2), { timeout: 3000 });
    await vi.waitFor(() => expect(attempt(store).status).toBe('cancelled'), { timeout: 3000 });
    expect(fake.jobList()[0].status).toBe('cancelled');
    store.getState().pauseCloudJobs();
  });

  it('FP-004: POST応答ロスト＋credential喪失のattemptは削除をブロックし、forgetCloudでのみ消せる', async () => {
    const wakes: (() => void)[] = [];
    const { store, fake, credentials, game } = await setup(
      { createJobFailAfterCreate: 1 },
      { sleep: () => new Promise((resolve) => wakes.push(resolve)) },
    );
    await store.getState().startCloudAnalysis(game.id);
    await vi.waitFor(() => expect(wakes.length).toBe(1));
    // Response lost: the server job exists but jobId stayed null.
    setCredential(credentials, null);
    wakes[0]();
    await vi.waitFor(() => expect(attempt(store).status).toBe('error'), { timeout: 3000 });
    expect(attempt(store).jobId).toBeNull();
    expect(attempt(store).submitAttempted).toBe(true);
    // The server job may be live: deletion must stay blocked.
    expect(attemptBlocksDelete(attempt(store))).toBe(true);
    await expect(store.getState().deleteGame(game.id)).rejects.toThrow(/Cloud/u);
    expect(store.getState().games.some((g) => g.id === game.id)).toBe(true);
    // The explicit escape removes only the local records.
    await store.getState().deleteGame(game.id, { forgetCloud: true });
    expect(store.getState().games.some((g) => g.id === game.id)).toBe(false);
    expect(store.getState().cloudAttempts).toHaveLength(0);
    expect(fake.jobList()[0].status).toBe('queued'); // server job untouched
    store.getState().pauseCloudJobs();
  });

  it('FP-004b: submitAttemptedなerror attemptは取消を再試行してから削除できる', async () => {
    const wakes: (() => void)[] = [];
    const { store, fake, credentials, game } = await setup(
      { createJobFailAfterCreate: 1 },
      { sleep: () => new Promise((resolve) => wakes.push(resolve)) },
    );
    await store.getState().startCloudAnalysis(game.id);
    await vi.waitFor(() => expect(wakes.length).toBe(1));
    setCredential(credentials, null);
    wakes[0]();
    await vi.waitFor(() => expect(attempt(store).status).toBe('error'), { timeout: 3000 });
    // Restore the credential and ask for cancellation: the pump must re-POST
    // under the same idempotency key to learn jobId, then cancel it.
    setCredential(credentials, {
      credential: 'cred-1',
      ownerId: attempt(store).ownerId,
      installId: 'install-1',
      endpoint: ENDPOINT,
      issuedAt: '2026-01-01T00:00:00.000Z',
    });
    await store.getState().cancelCloudAnalysis(attempt(store).attemptId);
    while (wakes.length) {
      const pending = wakes.splice(0);
      pending.forEach((resolve) => resolve());
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (attempt(store).status === 'cancelled') break;
    }
    await vi.waitFor(() => expect(attempt(store).status).toBe('cancelled'), { timeout: 3000 });
    expect(attempt(store).jobId).toBe('job_1');
    expect(fake.jobList()[0].status).toBe('cancelled');
    expect(attemptBlocksDelete(attempt(store))).toBe(false);
    await store.getState().deleteGame(game.id);
    store.getState().pauseCloudJobs();
  });

  it('FP-005: 取消確定後の不正行でerrorになっても削除はブロックされず有効行は残る', async () => {
    const { store, fake, game } = await setup();
    await store.getState().startCloudAnalysis(game.id);
    await vi.waitFor(() => expect(attempt(store).jobId).toBe('job_1'));
    // Server-side row 0 violates the current contract → drain throws while
    // committed rows stay saved.
    const job = fake.jobList()[0];
    (job.results[0].result as { identity: { engineName: string } }).identity.engineName =
      'unexpected-version';
    job.advance(1);
    await store.getState().cancelCloudAnalysis(attempt(store).attemptId);
    await vi.waitFor(() => expect(attempt(store).status).toBe('error'), { timeout: 3000 });
    expect(job.status).toBe('cancelled');
    // Confirmed server cancel is durable: deletion is unblocked even though
    // the local lifecycle is error.
    expect(attempt(store).serverStatus).toBe('cancelled');
    expect(attemptBlocksDelete(attempt(store))).toBe(false);
    await store.getState().deleteGame(game.id);
    store.getState().pauseCloudJobs();
  });

  it('FP-006: 契約更新で全行が無効になったattemptは解析済みと表示されず件数が再計算される', async () => {
    const { store, db, game } = await setup({ perPollAdvance: 3 });
    await store.getState().startCloudAnalysis(game.id);
    await vi.waitFor(() => expect(attempt(store).status).toBe('completed'), { timeout: 3000 });
    expect(attempt(store).validCount).toBe(3);
    // Simulate a contract bump: every stored row now carries an old engine
    // identity and is rejected by the current validator on reload.
    for (const row of db.prepare('SELECT ply, result FROM cloud_results').all() as {
      ply: number;
      result: string;
    }[]) {
      const result = JSON.parse(row.result) as { identity: { engineName: string } };
      result.identity.engineName = 'previous-version';
      db.prepare('UPDATE cloud_results SET result = ? WHERE ply = ?').run(
        JSON.stringify(result),
        row.ply,
      );
    }
    await store.getState().loadCloudResults(game.id);
    expect(store.getState().cloudResults[attempt(store).attemptId]).toHaveLength(0);
    await vi.waitFor(() => expect(attempt(store).validCount).toBe(0));
    expect(cloudAttemptLabel(attempt(store))).not.toBe('解析済み');
    store.getState().pauseCloudJobs();
  });

  it('FP-010: 途中取消のjobは生成済み結果を回収し終えたらpollを止める', async () => {
    const wakes: (() => void)[] = [];
    const { store, fake, game } = await setup(
      {},
      { sleep: () => new Promise((resolve) => wakes.push(resolve)) },
    );
    await store.getState().startCloudAnalysis(game.id);
    await vi.waitFor(() => expect(attempt(store).jobId).toBe('job_1'));
    // Server processed only ply 0 when the cancel lands.
    const job = fake.jobList()[0];
    job.advance(1);
    await store.getState().cancelCloudAnalysis(attempt(store).attemptId);
    await vi.waitFor(() => expect(attempt(store).status).toBe('cancelled'), { timeout: 3000 });
    // Every server-produced row (ply 0) is committed; no reason to poll again.
    expect(attempt(store).receiveAfterPly).toBe(0);
    expect(attempt(store).serverNextPly).toBe(1);
    const getJobs = fake.counts.getJob;
    while (wakes.length) {
      wakes.splice(0).forEach((resolve) => resolve());
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    store.getState().resumeCloudJobs();
    await flush();
    expect(fake.counts.getJob).toBe(getJobs);
    store.getState().pauseCloudJobs();
  });

  it('FP-011: serverの時刻はattemptへ保存され、exportはlocal時刻を使わない', async () => {
    const { store, game } = await setup({ perPollAdvance: 3 });
    await store.getState().startCloudAnalysis(game.id);
    await vi.waitFor(() => expect(attempt(store).status).toBe('completed'), { timeout: 3000 });
    // Fake server clock: 00:00:00 → 00:01:00. Local deps.nowIso is 2026-01-02.
    expect(attempt(store).serverCreatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(attempt(store).serverFinishedAt).toBe('2026-01-01T00:01:00.000Z');
    expect(attempt(store).createdAt).toBe('2026-01-02T00:00:00.000Z');
    const doc = await buildComparisonExport(
      {
        game,
        attempts: store.getState().cloudAttempts,
        results: {},
        generator: {
          platform: 'unknown',
          osVersion: null,
          deviceModel: null,
          appVersion: null,
          buildId: null,
        },
        exportedAt: '2026-01-03T00:00:00.000Z',
      },
      async () => 'hash',
    );
    const method = doc.methods['cloud-free'] as CloudMethodExport;
    // Export carries only server times → 60000ms, never local-clock deltas.
    expect(method.timing.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(method.timing.finishedAt).toBe('2026-01-01T00:01:00.000Z');
    store.getState().pauseCloudJobs();
  });

  it('FP-011b: server viewを一度も得ていないerror attemptのserver時刻はnull・unknown', async () => {
    // createJob rejects before the server sees the request: no server view is
    // ever received, so no server timestamps exist to export.
    const { store, game } = await setup({
      createJobError: () => {
        throw new CloudApiError(400, 'bad_request', 'broken');
      },
    });
    await store.getState().startCloudAnalysis(game.id);
    await vi.waitFor(() => expect(attempt(store).status).toBe('error'), { timeout: 3000 });
    expect(attempt(store).serverCreatedAt).toBeNull();
    expect(attempt(store).serverFinishedAt).toBeNull();
    const doc = await buildComparisonExport(
      {
        game,
        attempts: store.getState().cloudAttempts,
        results: {},
        generator: {
          platform: 'unknown',
          osVersion: null,
          deviceModel: null,
          appVersion: null,
          buildId: null,
        },
        exportedAt: '2026-01-03T00:00:00.000Z',
      },
      async () => 'hash',
    );
    const method = doc.methods['cloud-free'] as CloudMethodExport;
    // Local error time must never fill the server window.
    expect(method.timing.createdAt).toBeNull();
    expect(method.timing.finishedAt).toBeNull();
    expect(method.timing.completion).toBe('unknown');
    store.getState().pauseCloudJobs();
  });

  it('FP-005: serverStatus確定値がlabelとexport completionに使われる', async () => {
    const { store, fake, game } = await setup();
    await store.getState().startCloudAnalysis(game.id);
    await vi.waitFor(() => expect(attempt(store).jobId).toBe('job_1'));
    const job = fake.jobList()[0];
    job.advance(1);
    await store.getState().cancelCloudAnalysis(attempt(store).attemptId);
    await vi.waitFor(() => expect(attempt(store).status).toBe('cancelled'), { timeout: 3000 });
    expect(attempt(store).validCount).toBe(1);
    // A cancelled attempt with a saved row must not read 再開できます.
    const label = cloudAttemptLabel({
      ...attempt(store),
      status: 'error',
    });
    expect(label).toBe('取消済み・有効 1/3');
    const doc = await buildComparisonExport(
      {
        game,
        attempts: [{ ...attempt(store), status: 'error' }],
        results: {},
        generator: {
          platform: 'unknown',
          osVersion: null,
          deviceModel: null,
          appVersion: null,
          buildId: null,
        },
        exportedAt: '2026-01-03T00:00:00.000Z',
      },
      async () => 'hash',
    );
    const method = doc.methods['cloud-free'] as CloudMethodExport;
    // serverStatus='cancelled' wins over local 'error' → not 'unknown'.
    expect(method.timing.completion).toBe('cancelled');
    store.getState().pauseCloudJobs();
  });

  it('FP-012: 完了済み再実行のcache再利用はresumedにならない', async () => {
    const { store, game } = await setup(
      {},
      {},
      async (sfen, conditions) => sekireiResult(sfen, conditions),
    );
    await store.getState().updateSettings({ analysisMethod: 'sekirei' });
    await store.getState().startAnalysis(game.id);
    await vi.waitFor(() => expect(store.getState().analysisJob).toBeNull(), { timeout: 3000 });
    const first = store.getState().games.find((g) => g.id === game.id)?.analysisRun;
    expect(first?.completion).toBe('completed');
    expect(first?.cacheReuseCount).toBe(0);
    // Immediate rerun over the same conditions reuses all three rows.
    await store.getState().startAnalysis(game.id);
    await vi.waitFor(() => expect(store.getState().analysisJob).toBeNull(), { timeout: 3000 });
    const second = store.getState().games.find((g) => g.id === game.id)?.analysisRun;
    expect(second?.completion).toBe('completed');
    expect(second?.cacheReuseCount).toBe(3);
    expect(second?.resumed).toBe(false);
  });

  it('FP-012b: 中断runの続きとしてcacheを再利用した場合のみresumed=true', async () => {
    const blocked: { release?: () => void } = {};
    let call = 0;
    const analyze = async (sfen: string, conditions: AnalysisConditions) => {
      call += 1;
      if (call === 2) {
        await new Promise<void>((resolve) => {
          blocked.release = resolve;
        });
      }
      return sekireiResult(sfen, conditions);
    };
    const { store, game } = await setup({}, {}, analyze);
    await store.getState().updateSettings({ analysisMethod: 'sekirei' });
    void store.getState().startAnalysis(game.id);
    await vi.waitFor(() => expect(call).toBe(2), { timeout: 3000 });
    // Interrupt mid-run (one row already saved), then let the stale call end.
    store.getState().stopAnalysis();
    blocked.release?.();
    await vi.waitFor(
      () =>
        expect(store.getState().games.find((g) => g.id === game.id)?.analysisRun?.completion).toBe(
          'interrupted',
        ),
      { timeout: 3000 },
    );
    await store.getState().startAnalysis(game.id);
    await vi.waitFor(() => expect(store.getState().analysisJob).toBeNull(), { timeout: 3000 });
    const run = store.getState().games.find((g) => g.id === game.id)?.analysisRun;
    expect(run?.completion).toBe('completed');
    expect(run?.cacheReuseCount).toBe(1);
    expect(run?.resumed).toBe(true);
  });

  it('FP-013: 古いrunのfinallyが新しいrunのanalysisRunを上書きしない', async () => {
    const blocked: { release?: () => void } = {};
    const analyze = async (sfen: string, conditions: AnalysisConditions) => {
      if (conditions.nodes === 20000) {
        await new Promise<void>((resolve) => {
          blocked.release = resolve;
        });
      }
      return sekireiResult(sfen, conditions);
    };
    const { store, game } = await setup({}, {}, analyze);
    await store.getState().updateSettings({ analysisMethod: 'sekirei' });
    // First pass at 10000 nodes completes and saves all three rows.
    await store.getState().startAnalysis(game.id);
    await vi.waitFor(() => expect(store.getState().analysisJob).toBeNull(), { timeout: 3000 });
    // Second pass at 20000 nodes: the native call stays pending.
    await store.getState().updateSettings({ analysisNodes: 20000 });
    void store.getState().startAnalysis(game.id);
    await vi.waitFor(() => expect(blocked.release).not.toBeUndefined(), { timeout: 3000 });
    // Back to 10000: a new all-cache run completes before the old call returns.
    await store.getState().updateSettings({ analysisNodes: 10000 });
    await store.getState().startAnalysis(game.id);
    await vi.waitFor(() => expect(store.getState().analysisJob).toBeNull(), { timeout: 3000 });
    const newer = store.getState().games.find((g) => g.id === game.id)?.analysisRun;
    expect(newer?.completion).toBe('completed');
    expect(newer?.conditions.nodes).toBe(10000);
    // The stale 20000 response arrives late: its record must not replace the
    // newer run's record, and the saved rows keep their own run linkage.
    blocked.release?.();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const after = store.getState().games.find((g) => g.id === game.id)?.analysisRun;
    expect(after?.completion).toBe('completed');
    expect(after?.conditions.nodes).toBe(10000);
    expect(
      Object.values(store.getState().games.find((g) => g.id === game.id)?.analysis ?? {}),
    ).toHaveLength(3);
  });
});
