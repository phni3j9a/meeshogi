import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeAppStore } from '../../src/store/create-app-store';
import { type ParsedGame } from '../../src/domain/model';
import { parseKif } from '../../src/domain';
import { LocalRepository } from '../../src/storage/repository';
import { CloudApiError } from '../../src/cloud/client';
import { attemptBlocksDelete, cloudAttemptLabel } from '../../src/cloud/contract';
import { memoryCredentialStore, type CredentialStore } from '../../src/cloud/credentials';
import type { CloudCredential } from '../../src/cloud/client';
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

async function setup(options: FakeCloudOptions = {}, depsOverrides: Partial<CloudDeps> = {}) {
  const { db, adapter } = sqliteDb();
  const repository = new LocalRepository(adapter);
  await repository.initialize();
  const fake = fakeCloud(options);
  const credentials = memoryCredentialStore();
  let idSeq = 0;
  const store = makeAppStore({
    openRepository: async () => repository,
    analyze: async () => {
      throw new Error('unused');
    },
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
});
