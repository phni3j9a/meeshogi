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
import { secureStoreCredentials } from '../../src/cloud/secure-store';
import type { CloudCredential } from '../../src/cloud/client';
import { buildComparisonExport } from '../../src/comparison/export';
import { aggregateExport } from '../../src/comparison/aggregate';
import type { CloudMethodExport } from '../../src/comparison/schema';
import type { CloudDeps } from '../../src/store/cloud-controller';
import { ENDPOINT, makeCloudDeps, fakeCloud, sqliteDb, type FakeCloudOptions } from './helpers';

// expo-secure-store is a native module: the whole module is mocked and the
// raw key/value backing is driven by the test to simulate absent / empty /
// corrupt records.
const secureValues = vi.hoisted(() => new Map<string, string>());
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => secureValues.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    secureValues.set(key, value);
  },
}));

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
/** Export the game's Sekirei section and return its aggregate runKind. */
const sekireiRunKindOf = async (store: Store, gameId: string) => {
  const g = store.getState().games.find((x) => x.id === gameId)!;
  const doc = await buildComparisonExport(
    {
      game: g,
      attempts: [],
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
  return aggregateExport(doc, 't.json').timing.find((t) => t.method === 'sekirei')?.runKind;
};
const flush = async (turns = 50) => {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
};
/** Resolve pump sleeps until `done` holds; fails via waitFor if none arrive. */
const drainWakes = async (wakes: (() => void)[], done: () => boolean) => {
  for (let i = 0; i < 200 && !done(); i += 1) {
    await vi.waitFor(() => expect(wakes.length).toBeGreaterThan(0), { timeout: 3000 });
    wakes.splice(0).forEach((resolve) => resolve());
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
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
    expect(attempt(store).failureCode).toBe('credential_absent');
    // The server job may be live: deletion must stay blocked.
    expect(attemptBlocksDelete(attempt(store))).toBe(true);
    await expect(store.getState().deleteGame(game.id)).rejects.toThrow(/Cloud/u);
    expect(store.getState().games.some((g) => g.id === game.id)).toBe(true);
    // Confirmed key absence makes the limited local-forget exception eligible.
    await expect(store.getState().canForgetCloudGame(game.id)).resolves.toBe(true);
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

  it('FP-004c: backend 401のattemptはcredential_rejectedでlocal-forget可能', async () => {
    const { store, game } = await setup({
      createJobError: () => {
        throw new CloudApiError(401, 'unauthorized', 'auth failed');
      },
    });
    await store.getState().startCloudAnalysis(game.id);
    await vi.waitFor(() => expect(attempt(store).status).toBe('error'), { timeout: 3000 });
    expect(attempt(store).failureCode).toBe('credential_rejected');
    // The same rejected credential is still stored → confirmed unreachable.
    await expect(store.getState().canForgetCloudGame(game.id)).resolves.toBe(true);
    await store.getState().deleteGame(game.id, { forgetCloud: true });
    expect(store.getState().games.some((g) => g.id === game.id)).toBe(false);
    store.getState().pauseCloudJobs();
  });

  it('FP-004d: 一時/一般エラー・credential復帰・複数blockerではforgetCloudを拒否する', async () => {
    // (i) generic non-auth server error: never forgettable even with the flag.
    const s1 = await setup({
      createJobError: () => {
        throw new CloudApiError(400, 'bad_request', 'broken');
      },
    });
    await s1.store.getState().startCloudAnalysis(s1.game.id);
    await vi.waitFor(() => expect(attempt(s1.store).status).toBe('error'), { timeout: 3000 });
    expect(attempt(s1.store).failureCode).toBe('bad_request');
    await expect(s1.store.getState().canForgetCloudGame(s1.game.id)).resolves.toBe(false);
    await expect(
      s1.store.getState().deleteGame(s1.game.id, { forgetCloud: true }),
    ).rejects.toThrow(/Cloud/u);
    s1.store.getState().pauseCloudJobs();

    // (ii) transient credential-store read failure mid-flight: the attempt
    // keeps retrying (never 'error') and forgetCloud stays refused.
    const locked: CredentialStore = {
      load: async () => {
        throw new Error('keystore locked');
      },
      save: async () => {},
      probe: async () => {
        throw new Error('keystore locked');
      },
    };
    const wakes2: (() => void)[] = [];
    const holder: { store?: CredentialStore } = {};
    const s2 = await setup(
      {},
      {
        credentialsFor: () => holder.store ?? locked,
        sleep: () => new Promise((resolve) => wakes2.push(resolve)),
      },
    );
    holder.store = s2.credentials; // normal store until the attempt exists
    await s2.store.getState().startCloudAnalysis(s2.game.id);
    await vi.waitFor(() => expect(attempt(s2.store).jobId).toBe('job_1'), { timeout: 3000 });
    holder.store = locked; // SecureStore read starts failing here
    wakes2.splice(0).forEach((resolve) => resolve());
    await vi.waitFor(() =>
      expect(attempt(s2.store).lastError).toBe('Cloudの認証情報を読み込めませんでした。'),
    );
    expect(attempt(s2.store).status).not.toBe('error');
    expect(attemptBlocksDelete(attempt(s2.store))).toBe(true);
    await expect(s2.store.getState().canForgetCloudGame(s2.game.id)).resolves.toBe(false);
    await expect(
      s2.store.getState().deleteGame(s2.game.id, { forgetCloud: true }),
    ).rejects.toThrow(/Cloud/u);
    s2.store.getState().pauseCloudJobs();

    // (iii) eligibility re-evaluated live: credential returns after the
    // confirmed-absent error → the request is recoverable → refuse.
    const wakes3: (() => void)[] = [];
    const s3 = await setup(
      { createJobFailAfterCreate: 1 },
      { sleep: () => new Promise((resolve) => wakes3.push(resolve)) },
    );
    await s3.store.getState().startCloudAnalysis(s3.game.id);
    await vi.waitFor(() => expect(wakes3.length).toBe(1));
    setCredential(s3.credentials, null);
    wakes3[0]();
    await vi.waitFor(() => expect(attempt(s3.store).status).toBe('error'), { timeout: 3000 });
    expect(attempt(s3.store).failureCode).toBe('credential_absent');
    setCredential(s3.credentials, {
      credential: 'cred-back',
      ownerId: attempt(s3.store).ownerId,
      installId: 'install-1',
      endpoint: ENDPOINT,
      issuedAt: '2026-01-01T00:00:00.000Z',
    });
    await expect(s3.store.getState().canForgetCloudGame(s3.game.id)).resolves.toBe(false);
    await expect(
      s3.store.getState().deleteGame(s3.game.id, { forgetCloud: true }),
    ).rejects.toThrow(/Cloud/u);
    // The recoverable attempt can still be settled through the same key.
    await s3.store.getState().cancelCloudAnalysis(attempt(s3.store).attemptId);
    while (attempt(s3.store).status !== 'cancelled' && wakes3.length) {
      wakes3.splice(0).forEach((resolve) => resolve());
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await vi.waitFor(() => expect(attempt(s3.store).status).toBe('cancelled'), { timeout: 3000 });
    expect(attempt(s3.store).jobId).toBe('job_1');
    s3.store.getState().pauseCloudJobs();
  });

  it('FP-004e: owner不一致はcredential喪失と断定せずlocal-forget不可', async () => {
    const wakes: (() => void)[] = [];
    const { store, credentials, game } = await setup(
      {},
      { sleep: () => new Promise((resolve) => wakes.push(resolve)) },
    );
    await store.getState().startCloudAnalysis(game.id);
    await vi.waitFor(() => expect(wakes.length).toBe(1));
    // A credential for a DIFFERENT owner exists: do not conclude loss.
    setCredential(credentials, {
      credential: 'cred-other',
      ownerId: 'own_other',
      installId: 'install-2',
      endpoint: ENDPOINT,
      issuedAt: '2026-01-01T00:00:00.000Z',
    });
    wakes[0]();
    await vi.waitFor(() => expect(attempt(store).status).toBe('error'), { timeout: 3000 });
    expect(attempt(store).failureCode).toBe('credential_owner_mismatch');
    await expect(store.getState().canForgetCloudGame(game.id)).resolves.toBe(false);
    await expect(
      store.getState().deleteGame(game.id, { forgetCloud: true }),
    ).rejects.toThrow(/Cloud/u);
    store.getState().pauseCloudJobs();
  });

  it('FP-004f: 複数blockerのうち1件でも非適格ならforgetCloudを拒否する', async () => {
    const wakes: (() => void)[] = [];
    const { store, credentials, game } = await setup(
      {
        // Attempt 1 fails generically while the credential is still valid.
        createJobError: (call) => {
          if (call === 1) throw new CloudApiError(400, 'bad_request', 'broken');
        },
        // Attempt 2's POST reaches the server (job exists) but the response
        // is lost; the credential then disappears → credential_absent.
        createJobFailAfterCreate: 2,
      },
      { sleep: () => new Promise((resolve) => wakes.push(resolve)) },
    );
    await store.getState().startCloudAnalysis(game.id);
    await vi.waitFor(() => expect(attempt(store).failureCode).toBe('bad_request'), {
      timeout: 3000,
    });
    // Second attempt (precision) fails with confirmed credential absence →
    // eligible alone, but blocker 1 is not → the game stays unforgettabble.
    await store.getState().updateSettings({ analysisMethod: 'cloud-precision' });
    await store.getState().startCloudAnalysis(game.id);
    await vi.waitFor(() => expect(store.getState().cloudAttempts).toHaveLength(2));
    await vi.waitFor(() => expect(wakes.length).toBe(1), { timeout: 3000 });
    setCredential(credentials, null);
    wakes.splice(0).forEach((resolve) => resolve());
    await vi.waitFor(
      () =>
        expect(
          store.getState().cloudAttempts.find((a) => a.profileId === 'precision')?.status,
        ).toBe('error'),
      { timeout: 3000 },
    );
    expect(
      store.getState().cloudAttempts.find((a) => a.profileId === 'precision')?.failureCode,
    ).toBe('credential_absent');
    await expect(store.getState().canForgetCloudGame(game.id)).resolves.toBe(false);
    await expect(
      store.getState().deleteGame(game.id, { forgetCloud: true }),
    ).rejects.toThrow(/Cloud/u);
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

  it('FP-012: 完了済み再実行のcache再利用はcompleted-with-cache-reuse', async () => {
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
    // A run that measured everything itself classifies as fresh-complete.
    expect(await sekireiRunKindOf(store, game.id)).toBe('fresh-complete');
    // Immediate rerun over the same conditions reuses all three rows.
    await store.getState().startAnalysis(game.id);
    await vi.waitFor(() => expect(store.getState().analysisJob).toBeNull(), { timeout: 3000 });
    const second = store.getState().games.find((g) => g.id === game.id)?.analysisRun;
    expect(second?.completion).toBe('completed');
    expect(second?.cacheReuseCount).toBe(3);
    // `resumed` is no longer inferred: the record keeps only measured facts,
    // and the reuse-inclusive completion is classified the same regardless of
    // whether the reused rows came from a completed run.
    expect('resumed' in second!).toBe(false);
    expect(await sekireiRunKindOf(store, game.id)).toBe('completed-with-cache-reuse');
  });

  it('FP-012b: 中断後の継続としてcacheを再利用して完了しても同じ分類', async () => {
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
    // Continuation after an interrupted run is classified the same as reuse of
    // a completed pass: the origin of reused rows is not tracked.
    expect(await sekireiRunKindOf(store, game.id)).toBe('completed-with-cache-reuse');
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

  it('FP-004g: 存在する空文字/破損credentialキーはabsentでなくunusable', async () => {
    // keyFor is private; replicate its sanitization for ENDPOINT.
    const key = `cloudCredential.${ENDPOINT.replace(/[^A-Za-z0-9.\-_]/gu, '_').slice(0, 96)}`;
    const secure = secureStoreCredentials(ENDPOINT);
    secureValues.clear();
    expect((await secure.probe()).state).toBe('absent'); // null: key missing
    for (const raw of ['', '{', '{}']) {
      secureValues.set(key, raw);
      expect((await secure.probe()).state).toBe('unusable'); // present but unreadable
    }
    // Delete path: a present-but-empty credential record must not qualify for
    // the local-forget exception — loss was never confirmed.
    secureValues.delete(key);
    const wakes: (() => void)[] = [];
    const { store, game } = await setup(
      { createJobFailAfterCreate: 1 },
      {
        credentialsFor: () => secure,
        sleep: () => new Promise((resolve) => wakes.push(resolve)),
      },
    );
    await store.getState().startCloudAnalysis(game.id);
    await vi.waitFor(() => expect(wakes.length).toBe(1));
    secureValues.set(key, ''); // corrupted record: key present, value invalid
    wakes[0]();
    await vi.waitFor(() => expect(attempt(store).status).toBe('error'), { timeout: 3000 });
    expect(attempt(store).failureCode).toBe('credential_unusable');
    await expect(store.getState().canForgetCloudGame(game.id)).resolves.toBe(false);
    await expect(
      store.getState().deleteGame(game.id, { forgetCloud: true }),
    ).rejects.toThrow(/Cloud/u);
    store.getState().pauseCloudJobs();
  });

  it('FP-011c: GETで観測したserver終了時刻はdrain失敗でも保持されexportされる', async () => {
    const { store, fake, game } = await setup({});
    await store.getState().startCloudAnalysis(game.id);
    await vi.waitFor(() => expect(attempt(store).jobId).toBe('job_1'));
    // Server completes the whole game; the first fetched row then violates
    // the contract so the drain throws after the terminal view arrived.
    const job = fake.jobList()[0];
    job.advance(3);
    (job.results[0].result as { identity: { engineName: string } }).identity.engineName =
      'unexpected-version';
    await vi.waitFor(() => expect(attempt(store).status).toBe('error'), { timeout: 3000 });
    // The observed server clock is durable independently of the failed drain.
    expect(attempt(store).serverStatus).toBe('completed');
    expect(attempt(store).serverCreatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(attempt(store).serverFinishedAt).toBe('2026-01-01T00:01:00.000Z');
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
    expect(method.timing.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(method.timing.finishedAt).toBe('2026-01-01T00:01:00.000Z');
    expect(method.timing.completion).toBe('completed');
    store.getState().pauseCloudJobs();
  });

  it('FP-012c: 完了済みA→別条件で中断したXを挟んだcache再利用も同じ分類', async () => {
    const analyze = async (sfen: string, conditions: AnalysisConditions) => {
      if (conditions.nodes === 20000) throw new Error('engine failed');
      return sekireiResult(sfen, conditions);
    };
    const { store, game } = await setup({}, {}, analyze);
    await store.getState().updateSettings({ analysisMethod: 'sekirei' });
    // 10000 nodes: full pass completes (all 3 rows written by run A).
    await store.getState().startAnalysis(game.id);
    await vi.waitFor(() => expect(store.getState().analysisJob).toBeNull(), { timeout: 3000 });
    expect(
      store.getState().games.find((g) => g.id === game.id)?.analysisRun?.completion,
    ).toBe('completed');
    // 20000 nodes: the first call fails → run B interrupted with 0 saved rows.
    await store.getState().updateSettings({ analysisNodes: 20000 });
    await store.getState().startAnalysis(game.id);
    await vi.waitFor(
      () =>
        expect(store.getState().games.find((g) => g.id === game.id)?.analysisRun?.completion).toBe(
          'interrupted',
        ),
      { timeout: 3000 },
    );
    // Back to 10000: every reused row belongs to run A, not to the
    // interrupted run B. A completed-then-interrupted history and an
    // interrupted-then-interrupted history classify identically: the export
    // only knows this run's own reuse count.
    await store.getState().updateSettings({ analysisNodes: 10000 });
    await store.getState().startAnalysis(game.id);
    await vi.waitFor(() => expect(store.getState().analysisJob).toBeNull(), { timeout: 3000 });
    const run = store.getState().games.find((g) => g.id === game.id)?.analysisRun;
    expect(run?.completion).toBe('completed');
    expect(run?.cacheReuseCount).toBe(3);
    expect(await sekireiRunKindOf(store, game.id)).toBe('completed-with-cache-reuse');
  });

  it('FP-012d: A中断→別条件X中断→Aの行を再利用して完了も同じ分類', async () => {
    const blocked: { release?: () => void } = {};
    let call = 0;
    const analyze = async (sfen: string, conditions: AnalysisConditions) => {
      if (conditions.nodes === 20000) throw new Error('engine failed');
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
    // Run A at 10000 nodes: interrupted after ply 0 is persisted.
    void store.getState().startAnalysis(game.id);
    await vi.waitFor(() => expect(call).toBe(2), { timeout: 3000 });
    store.getState().stopAnalysis();
    blocked.release?.();
    await vi.waitFor(
      () =>
        expect(store.getState().games.find((g) => g.id === game.id)?.analysisRun?.completion).toBe(
          'interrupted',
        ),
      { timeout: 3000 },
    );
    // Run X at 20000 nodes: fails immediately → interrupted, no saved rows.
    await store.getState().updateSettings({ analysisNodes: 20000 });
    await store.getState().startAnalysis(game.id);
    await vi.waitFor(
      () =>
        expect(store.getState().games.find((g) => g.id === game.id)?.analysisRun?.completion).toBe(
          'interrupted',
        ),
      { timeout: 3000 },
    );
    // Back to 10000: run C reuses A's ply-0 row across two interruptions.
    await store.getState().updateSettings({ analysisNodes: 10000 });
    await store.getState().startAnalysis(game.id);
    await vi.waitFor(() => expect(store.getState().analysisJob).toBeNull(), { timeout: 3000 });
    const run = store.getState().games.find((g) => g.id === game.id)?.analysisRun;
    expect(run?.completion).toBe('completed');
    expect(run?.cacheReuseCount).toBe(1);
    expect(await sekireiRunKindOf(store, game.id)).toBe('completed-with-cache-reuse');
  });

  it('FP-014: 未確認errorへの再試行は同一key・同一ownerで復帰し新発行しない', async () => {
    const wakes: (() => void)[] = [];
    const { store, fake, credentials, game } = await setup(
      { createJobFailAfterCreate: 1, perPollAdvance: 3 },
      { sleep: () => new Promise((resolve) => wakes.push(resolve)) },
    );
    await store.getState().startCloudAnalysis(game.id);
    await vi.waitFor(() => expect(wakes.length).toBe(1));
    const key = attempt(store).idempotencyKey;
    // POST reached the server (job exists) but the response was lost, then
    // the credential key disappeared → error with an unconfirmed job.
    setCredential(credentials, null);
    wakes[0]();
    await vi.waitFor(() => expect(attempt(store).status).toBe('error'), { timeout: 3000 });
    expect(attempt(store).failureCode).toBe('credential_absent');
    expect(attempt(store).jobId).toBeNull();
    // The SAME owner's credential is back: retry re-activates the original
    // attempt — same key, same input — and the server replays the job.
    setCredential(credentials, {
      credential: 'cred-1',
      ownerId: attempt(store).ownerId,
      installId: 'install-1',
      endpoint: ENDPOINT,
      issuedAt: '2026-01-01T00:00:00.000Z',
    });
    await store.getState().startCloudAnalysis(game.id);
    await drainWakes(wakes, () => attempt(store).status === 'completed');
    expect(store.getState().cloudAttempts).toHaveLength(1);
    expect(attempt(store).idempotencyKey).toBe(key);
    expect(attempt(store).jobId).toBe('job_1');
    expect(fake.jobList()).toHaveLength(1); // server job count stayed 1
    expect(fake.counts.createJob).toBe(2); // original POST + same-key replay
    expect(fake.calls.filter((c) => c.method === 'createCredential')).toHaveLength(1);
    store.getState().pauseCloudJobs();
  });

  it('FP-014b: credential喪失のままの再試行・新規開始は発行を拒否する', async () => {
    const wakes: (() => void)[] = [];
    const { store, fake, credentials, game } = await setup(
      { createJobFailAfterCreate: 1 },
      { sleep: () => new Promise((resolve) => wakes.push(resolve)) },
    );
    await store.getState().startCloudAnalysis(game.id);
    await vi.waitFor(() => expect(wakes.length).toBe(1));
    const key = attempt(store).idempotencyKey;
    setCredential(credentials, null);
    wakes[0]();
    await vi.waitFor(() => expect(attempt(store).status).toBe('error'), { timeout: 3000 });
    expect(attempt(store).failureCode).toBe('credential_absent');
    // Retry on the same game: 復帰できません — no new attempt, key, or owner.
    await expect(store.getState().startCloudAnalysis(game.id)).rejects.toThrow(
      /復帰できません/u,
    );
    expect(store.getState().cloudAttempts).toHaveLength(1);
    expect(attempt(store).idempotencyKey).toBe(key);
    expect(attempt(store).status).toBe('error');
    // A DIFFERENT game's fresh start must not silently issue a replacement
    // credential either while an unconfirmed request references the old owner.
    const parsed = fixture();
    const game2 = await store.getState().saveImport(
      {
        ...parsed,
        moves: parsed.moves.slice(0, 1),
        positions: parsed.positions.slice(0, 2),
        blackName: '別の先手',
        whiteName: '別の後手',
        startedAt: '2026-01-05T00:00:00.000Z',
        identity: `${parsed.identity}|other`,
      },
      { service: 'shogiwars', autoAnalyze: false },
    );
    await expect(store.getState().startCloudAnalysis(game2.id)).rejects.toThrow(
      /認証情報が失われ/u,
    );
    expect(store.getState().cloudAttempts).toHaveLength(1);
    expect(fake.calls.filter((c) => c.method === 'createCredential')).toHaveLength(1);
    expect(fake.jobList()).toHaveLength(1);
    store.getState().pauseCloudJobs();
  });

  it('FP-014c: server終端が確認済みのerror attemptには新規解析を許可する', async () => {
    const wakes: (() => void)[] = [];
    const { store, fake, game } = await setup(
      { perPollAdvance: 3 },
      { sleep: () => new Promise((resolve) => wakes.push(resolve)) },
    );
    await store.getState().startCloudAnalysis(game.id);
    await vi.waitFor(() => expect(attempt(store).jobId).toBe('job_1'));
    // One row produced, then cancel lands; the drain hits a contract
    // violation → local error but serverStatus='cancelled' is confirmed.
    const job = fake.jobList()[0];
    job.advance(1);
    (job.results[0].result as { identity: { engineName: string } }).identity.engineName =
      'unexpected-version';
    await store.getState().cancelCloudAnalysis(attempt(store).attemptId);
    await drainWakes(wakes, () => attempt(store).status === 'error');
    expect(attempt(store).serverStatus).toBe('cancelled');
    const firstKey = attempt(store).idempotencyKey;
    // Explicit re-analysis after a server-confirmed terminal state creates a
    // new attempt with a new key.
    await store.getState().startCloudAnalysis(game.id);
    await vi.waitFor(() => expect(store.getState().cloudAttempts).toHaveLength(2));
    const second = () => store.getState().cloudAttempts[1];
    expect(second().idempotencyKey).not.toBe(firstKey);
    await drainWakes(wakes, () => second().status === 'completed');
    expect(fake.jobList()).toHaveLength(2);
    store.getState().pauseCloudJobs();
  });

  it('FP-015: credential復帰でrecoveryStateがrecoverableに戻り同一keyで完了する', async () => {
    const wakes: (() => void)[] = [];
    const { store, fake, credentials, game } = await setup(
      { createJobFailAfterCreate: 1, perPollAdvance: 3 },
      { sleep: () => new Promise((resolve) => wakes.push(resolve)) },
    );
    await store.getState().startCloudAnalysis(game.id);
    await vi.waitFor(() => expect(wakes.length).toBe(1));
    const key = attempt(store).idempotencyKey;
    setCredential(credentials, null);
    wakes[0]();
    await vi.waitFor(() => expect(attempt(store).status).toBe('error'), { timeout: 3000 });
    expect(attempt(store).failureCode).toBe('credential_absent');
    // While the key is confirmed absent: only the local-forget path applies.
    await expect(store.getState().cloudRecoveryState(game.id)).resolves.toBe(
      'unrecoverable-forget',
    );
    // The credential returns — the persisted failureCode must NOT keep the
    // attempt marked unrecoverable; the live check re-enables recovery.
    setCredential(credentials, {
      credential: 'cred-1',
      ownerId: attempt(store).ownerId,
      installId: 'install-1',
      endpoint: ENDPOINT,
      issuedAt: '2026-01-01T00:00:00.000Z',
    });
    await expect(store.getState().cloudRecoveryState(game.id)).resolves.toBe('recoverable');
    await store.getState().startCloudAnalysis(game.id);
    await drainWakes(wakes, () => attempt(store).status === 'completed');
    expect(store.getState().cloudAttempts).toHaveLength(1);
    expect(attempt(store).idempotencyKey).toBe(key);
    expect(attempt(store).jobId).toBe('job_1');
    expect(fake.jobList()).toHaveLength(1);
    store.getState().pauseCloudJobs();
  });

  it('FP-015b: unusable/owner不一致はunrecoverableでforget案内なし、読取失敗はtransient', async () => {
    // (i) corrupt credential record (present but unreadable): unrecoverable,
    // and NOT eligible for the local-forget exception.
    const key = `cloudCredential.${ENDPOINT.replace(/[^A-Za-z0-9.\-_]/gu, '_').slice(0, 96)}`;
    secureValues.clear();
    const secure = secureStoreCredentials(ENDPOINT);
    const wakes1: (() => void)[] = [];
    const s1 = await setup(
      { createJobFailAfterCreate: 1 },
      {
        credentialsFor: () => secure,
        sleep: () => new Promise((resolve) => wakes1.push(resolve)),
      },
    );
    await s1.store.getState().startCloudAnalysis(s1.game.id);
    await vi.waitFor(() => expect(wakes1.length).toBe(1));
    secureValues.set(key, '{'); // corrupt record, key still present
    wakes1[0]();
    await vi.waitFor(() => expect(attempt(s1.store).status).toBe('error'), { timeout: 3000 });
    expect(attempt(s1.store).failureCode).toBe('credential_unusable');
    await expect(s1.store.getState().cloudRecoveryState(s1.game.id)).resolves.toBe(
      'unrecoverable',
    );
    await expect(s1.store.getState().canForgetCloudGame(s1.game.id)).resolves.toBe(false);
    s1.store.getState().pauseCloudJobs();

    // (ii) owner mismatch: a different owner's credential exists — neither
    // recoverable nor forget-eligible.
    const wakes2: (() => void)[] = [];
    const s2 = await setup(
      {},
      { sleep: () => new Promise((resolve) => wakes2.push(resolve)) },
    );
    await s2.store.getState().startCloudAnalysis(s2.game.id);
    await vi.waitFor(() => expect(wakes2.length).toBe(1));
    setCredential(s2.credentials, {
      credential: 'cred-other',
      ownerId: 'own_other',
      installId: 'install-2',
      endpoint: ENDPOINT,
      issuedAt: '2026-01-01T00:00:00.000Z',
    });
    wakes2[0]();
    await vi.waitFor(() => expect(attempt(s2.store).status).toBe('error'), { timeout: 3000 });
    expect(attempt(s2.store).failureCode).toBe('credential_owner_mismatch');
    await expect(s2.store.getState().cloudRecoveryState(s2.game.id)).resolves.toBe(
      'unrecoverable',
    );
    s2.store.getState().pauseCloudJobs();

    // (iii) transient credential-store read failure → 'transient', not a
    // conclusion about loss.
    const wakes3: (() => void)[] = [];
    const holder: { store?: CredentialStore } = {};
    const locked: CredentialStore = {
      load: async () => {
        throw new Error('keystore locked');
      },
      save: async () => {},
      probe: async () => {
        throw new Error('keystore locked');
      },
    };
    const s3 = await setup(
      { createJobFailAfterCreate: 1 },
      {
        credentialsFor: () => holder.store ?? locked,
        sleep: () => new Promise((resolve) => wakes3.push(resolve)),
      },
    );
    holder.store = s3.credentials;
    await s3.store.getState().startCloudAnalysis(s3.game.id);
    await vi.waitFor(() => expect(wakes3.length).toBe(1));
    setCredential(s3.credentials, null);
    wakes3[0]();
    await vi.waitFor(() => expect(attempt(s3.store).status).toBe('error'), { timeout: 3000 });
    holder.store = locked; // reads start failing now
    await expect(s3.store.getState().cloudRecoveryState(s3.game.id)).resolves.toBe('transient');
    s3.store.getState().pauseCloudJobs();
  });
});
