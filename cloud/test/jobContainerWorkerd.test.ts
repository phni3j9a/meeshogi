import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const STARTPOS = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
const AFTER_2G2F = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/7P1/PPPPPPP1P/1B5R1/LNSGKGSNL w - 1';
const JOB_ID = 'job-49-workerd';
const CANCEL_JOB_ID = 'job-49-cancel';

describe('DO-driven jobs in workerd with the installed Containers SDK', () => {
  let mf: Miniflare;
  let database: D1Database;
  const workerName = 'job-durable-workerd';

  beforeAll(async () => {
    const bundled = await build({
      entryPoints: [fileURLToPath(new URL('./fixtures/job-durable.worker.mjs', import.meta.url))],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      external: ['cloudflare:workers'],
      nodePaths: ['./node_modules'],
    });
    mf = new Miniflare(convertV4MiniflareOptions({
      workers: [{
        name: workerName,
        modules: true,
        script: bundled.outputFiles[0].text,
        compatibilityDate: '2026-09-25',
        durableObjects: { JOB_FREE_CONTAINER: { className: 'WorkerdFreeJobContainer', useSQLite: true } },
        d1Databases: { JOBS_DB: 'job-durable-workerd-db' },
      }],
      port: 0,
      rootPath: process.cwd(),
    }));
    database = await mf.getD1Database('JOBS_DB', workerName);
    for (const migration of ['0001_job_backend.sql', '0002_jobs_updated_status.sql']) {
      const sql = readFileSync(new URL('../migrations/' + migration, import.meta.url), 'utf8').replace(/^--.*$/gmu, '');
      for (const statement of sql.split(';').map((entry) => entry.trim()).filter(Boolean)) {
        await database.prepare(statement).run();
      }
    }
  });

  afterAll(async () => {
    await mf?.dispose();
  });

  async function seedJob(jobId: string): Promise<void> {
    await database.prepare('INSERT OR IGNORE INTO owners (owner_id, credential_hash, precision_allowed, created_at) VALUES (?, ?, 0, ?)')
      .bind('own_workerd', 'hash-workerd', '2026-10-04T00:00:00.000Z').run();
    await database.prepare(`INSERT INTO jobs (
      job_id, owner_id, idempotency_key, input_hash, profile_id, initial_sfen, moves_json,
      total_plies, status, next_ply, jst_day, created_ms, created_at, updated_at
    ) VALUES (?, 'own_workerd', ?, 'input', 'free', ?, '["2g2f"]', 2, 'queued', 0, '2026-10-04', ?, ?, ?)`)
      .bind(jobId, jobId, STARTPOS, Date.now(), '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z').run();
    await database.prepare('INSERT INTO job_positions (job_id, ply, sfen, terminal) VALUES (?, 0, ?, NULL), (?, 1, ?, NULL)')
      .bind(jobId, STARTPOS, jobId, AFTER_2G2F).run();
  }

  async function fetchJson<T>(path: string, jobId: string): Promise<T> {
    const response = await mf.dispatchFetch('http://worker.test' + path + '?job=' + encodeURIComponent(jobId));
    if (!response.ok) throw new Error('workerd probe failed: ' + response.status + ' ' + await response.text());
    return response.json() as Promise<T>;
  }

  async function waitForCursor(jobId: string, cursor: number, timeoutMs = 8_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = await fetchJson<{ next_ply: number }>('/job', jobId);
      if (job.next_ply >= cursor) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('job did not reach cursor ' + cursor);
  }

  it('resumes an evicted alarm callback from the D1 cursor and finishes the job', async () => {
    await seedJob(JOB_ID);
    const accepted = await fetchJson<{ accepted: boolean; generation: number }>('/start', JOB_ID);
    expect(accepted).toMatchObject({ accepted: true, generation: 1 });
    await waitForCursor(JOB_ID, 1);

    const settledDeadline = Date.now() + 5_000;
    type ContainerView = { control: { phase: string; generation: number; attempt: number; notBefore: number }; activeRun: unknown };
    let state: ContainerView | undefined;
    while (Date.now() < settledDeadline) {
      state = await fetchJson<ContainerView>('/inspect', JOB_ID);
      if (state.control.phase === 'scheduled' && state.activeRun === null) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(state?.control).toMatchObject({ phase: 'scheduled', generation: 2, attempt: 2 });
    expect(state?.activeRun).toBeNull();

    const ids = await mf.listDurableObjectIds('WorkerdFreeJobContainer', workerName);
    expect(ids).toHaveLength(1);
    await mf.unsafeEvictDurableObject(workerName, 'WorkerdFreeJobContainer', { id: ids[0] });
    const duplicate = await fetchJson<{ accepted: boolean; generation: number }>('/start', JOB_ID);
    expect(duplicate).toMatchObject({ accepted: true, generation: 2 });
    const duplicateState = await fetchJson<{ control: { attempt: number; notBefore: number } }>('/inspect', JOB_ID);
    expect(duplicateState.control).toMatchObject({
      attempt: state!.control.attempt,
      notBefore: state!.control.notBefore,
    });

    const deadline = Date.now() + 18_000;
    let job: { status: string; next_ply: number } | undefined;
    while (Date.now() < deadline) {
      job = await fetchJson('/job', JOB_ID);
      if (job?.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(job).toMatchObject({ status: 'completed', next_ply: 2 });
    expect(await fetchJson('/result-count', JOB_ID)).toEqual({ count: 2 });
  }, 30_000);

  it('terminates an alarm-owned stream promptly and leaves the durable terminal fence', async () => {
    await seedJob(CANCEL_JOB_ID);
    await fetchJson('/start', CANCEL_JOB_ID);
    await waitForCursor(CANCEL_JOB_ID, 1);
    const terminated = await fetchJson<{ durationMs: number; cancelCount: number }>('/terminate', CANCEL_JOB_ID);
    expect(terminated.durationMs).toBeLessThan(5_000);
    expect(terminated.cancelCount).toBe(0);
    const state = await fetchJson<{
      control: { phase: string; runId: string | null };
      terminated: boolean;
      inFlightFetches: number;
    }>('/inspect', CANCEL_JOB_ID);
    expect(state).toMatchObject({ terminated: true, inFlightFetches: 0, control: { phase: 'terminal', runId: null } });
    expect((await fetchJson<{ status: string }>('/job', CANCEL_JOB_ID)).status).toBe('cancelled');
  }, 12_000);
});
