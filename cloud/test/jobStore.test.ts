/**
 * Job persistence integration tests against a real SQLite database through
 * the same RawDb/batch surface used with D1.
 */
import { describe, expect, it } from 'vitest';
import { JobStore, type AdmitJobParams, type JobStore as JobStoreType } from '../src/jobStore';
import { createTestDb } from './testDb';

const STARTPOS = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
const AFTER_2G2F = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/7P1/PPPPPPP1P/1B5R1/LNSGKGSNL w - 1';
const ISO = '2026-09-26T12:00:00.000Z';
const DAY = '2026-09-26';
const NOW_MS = Date.parse(ISO);

function setup(): JobStoreType {
  const { d1 } = createTestDb();
  return new JobStore(d1.rawDb);
}

async function owner(store: JobStoreType, id = 'own_test'): Promise<string> {
  await store.createOwner(id, `hash-${id}`, ISO);
  return id;
}

function admitParams(overrides: Partial<AdmitJobParams> = {}): AdmitJobParams {
  return {
    jobId: `job_${'0'.repeat(20)}aaaa`,
    ownerId: 'own_test',
    idempotencyKey: 'key-1',
    inputHash: 'input-1',
    profileId: 'free',
    initialSfen: STARTPOS,
    movesJson: '["2g2f"]',
    totalPlies: 2,
    createdMs: NOW_MS,
    jstDay: DAY,
    isoNow: ISO,
    positions: [
      { ply: 0, sfen: STARTPOS, terminal: null },
      { ply: 1, sfen: AFTER_2G2F, terminal: null },
    ],
    maxActiveJobs: 1,
    freeDailyJobs: 5,
    freeRateMaxJobs: 5,
    freeRateWindowMs: 60_000,
    ...overrides,
  };
}

describe('jobStore schema and owners', () => {
  it('applies the migration and enforces owner uniqueness', async () => {
    const store = setup();
    await store.createOwner('own_a', 'hash-a', ISO);
    await store.createOwner('own_b', 'hash-b', ISO);
    await expect(store.createOwner('own_a', 'hash-c', ISO)).rejects.toThrow();
    await expect(store.createOwner('own_c', 'hash-a', ISO)).rejects.toThrow();
    expect((await store.ownerByCredentialHash('hash-a'))?.owner_id).toBe('own_a');
    expect((await store.ownerById('own_b'))?.precision_allowed).toBe(0);
  });
});

describe('admitJob atomic admission', () => {
  it('inserts the job and all positions in one batch', async () => {
    const store = setup();
    await owner(store);
    expect(await store.admitJob(admitParams())).toBe('inserted');
    const job = await store.jobById(`job_${'0'.repeat(20)}aaaa`);
    expect(job?.status).toBe('queued');
    expect(job?.total_plies).toBe(2);
    expect((await store.positionAt(job!.job_id, 0))?.sfen).toBe(STARTPOS);
    expect((await store.positionAt(job!.job_id, 1))?.sfen).toBe(AFTER_2G2F);
    expect(await store.positionsFrom(job!.job_id, 1)).toHaveLength(1);
  });

  it('denies admission once the active limit is reached, and admits after completion', async () => {
    const store = setup();
    await owner(store);
    expect(await store.admitJob(admitParams())).toBe('inserted');
    expect(await store.admitJob(admitParams({ jobId: 'job_second_second_second_', idempotencyKey: 'key-2' }))).toBe('skipped');
    // Cancelling the first job frees the active slot but keeps the quota usage.
    expect(await store.cancelJob(`job_${'0'.repeat(20)}aaaa`, 'own_test', ISO)).toBe(true);
    expect(await store.admitJob(admitParams({ jobId: 'job_second_second_second_', idempotencyKey: 'key-2' }))).toBe('inserted');
  });

  it('counts cancelled jobs toward the daily quota', async () => {
    const store = setup();
    await owner(store);
    for (let index = 0; index < 5; index += 1) {
      const jobId = `job_quota_${index.toString().padStart(2, '0')}`;
      expect(await store.admitJob(admitParams({ jobId, idempotencyKey: `key-${index}` }))).toBe('inserted');
      expect(await store.cancelJob(jobId, 'own_test', ISO)).toBe(true);
    }
    const counts = await store.admissionCounts('own_test', DAY, NOW_MS - 60_000);
    expect(counts.freeToday).toBe(5);
    expect(counts.active).toBe(0);
    expect(await store.admitJob(admitParams({ jobId: 'job_quota_sixth', idempotencyKey: 'key-6' }))).toBe('skipped');
  });

  it('excludes jobs older than the trailing window from the rate count', async () => {
    const store = setup();
    await owner(store);
    const limits = { freeDailyJobs: 10, freeRateMaxJobs: 2 };
    // One job outside the window, two inside; none remain active.
    const older = admitParams({
      jobId: 'job_rate_older',
      idempotencyKey: 'older',
      createdMs: NOW_MS - 120_000,
      ...limits,
    });
    expect(await store.admitJob(older)).toBe('inserted');
    expect(await store.cancelJob('job_rate_older', 'own_test', ISO)).toBe(true);
    for (let index = 0; index < 2; index += 1) {
      const jobId = `job_rate_in_${index}`;
      expect(await store.admitJob(admitParams({ jobId, idempotencyKey: `in-${index}`, ...limits }))).toBe('inserted');
      expect(await store.cancelJob(jobId, 'own_test', ISO)).toBe(true);
    }
    const counts = await store.admissionCounts('own_test', DAY, NOW_MS - 60_000);
    expect(counts.freeInWindow).toBe(2);
    expect(counts.freeToday).toBe(3);
    // Window is full even though the day has headroom.
    expect(await store.admitJob(admitParams({ jobId: 'job_rate_denied', idempotencyKey: 'denied', ...limits }))).toBe('skipped');
    // The candidate's own window is relative to its createdMs: a request whose
    // 60-second window no longer contains the earlier jobs is admitted.
    expect(await store.admitJob(admitParams({
      jobId: 'job_rate_next_window',
      idempotencyKey: 'next-window',
      createdMs: NOW_MS + 61_000,
      ...limits,
    }))).toBe('inserted');
  });

  it('propagates a duplicate idempotency key as an error without partial writes', async () => {
    const store = setup();
    await owner(store);
    const params = admitParams({ jobId: 'job_idem_first_aaaaaa', idempotencyKey: 'same-key' });
    expect(await store.admitJob(params)).toBe('inserted');
    // While the first job is still active the admission limits deny the
    // insert before the unique constraint is reached; the API treats this as
    // an idempotency replay via the owner+key lookup.
    expect(await store.admitJob(admitParams({ jobId: 'job_idem_second_bbbbb', idempotencyKey: 'same-key' }))).toBe('skipped');
    // Once the first job leaves the active set the unique constraint itself
    // rejects the duplicate and rolls the whole batch back.
    expect(await store.cancelJob('job_idem_first_aaaaaa', 'own_test', ISO)).toBe(true);
    await expect(store.admitJob(admitParams({ jobId: 'job_idem_second_bbbbb', idempotencyKey: 'same-key' }))).rejects.toThrow();
    expect(await store.jobById('job_idem_second_bbbbb')).toBeNull();
    expect(await store.jobByIdempotency('own_test', 'same-key')).not.toBeNull();
  });

  it('rolls back the job row when a position insert fails', async () => {
    const store = setup();
    await owner(store);
    const params = admitParams({
      jobId: 'job_atomic_rollback_a',
      positions: [
        { ply: 0, sfen: STARTPOS, terminal: null },
        { ply: 0, sfen: STARTPOS, terminal: null }, // duplicate primary key
      ],
    });
    await expect(store.admitJob(params)).rejects.toThrow();
    expect(await store.jobById('job_atomic_rollback_a')).toBeNull();
  });

  it('keeps repeated SFEN values as distinct plies', async () => {
    const store = setup();
    await owner(store);
    expect(await store.admitJob(admitParams({
      jobId: 'job_repeated_sfen_aab',
      totalPlies: 3,
      positions: [
        { ply: 0, sfen: STARTPOS, terminal: null },
        { ply: 1, sfen: AFTER_2G2F, terminal: null },
        { ply: 2, sfen: STARTPOS, terminal: null },
      ],
    }))).toBe('inserted');
    const rows = await store.positionsFrom('job_repeated_sfen_aab', 0);
    expect(rows.map((row) => row.ply)).toEqual([0, 1, 2]);
    expect(rows[0].sfen).toBe(rows[2].sfen);
  });
});

describe('result commit guard and cancellation', () => {
  async function admitted(store: JobStoreType, jobId = 'job_guard_0000000000'): Promise<string> {
    await owner(store);
    expect(await store.admitJob(admitParams({
      jobId,
      totalPlies: 3,
      positions: [
        { ply: 0, sfen: STARTPOS, terminal: null },
        { ply: 1, sfen: AFTER_2G2F, terminal: null },
        { ply: 2, sfen: STARTPOS, terminal: null },
      ],
    }))).toBe('inserted');
    return jobId;
  }

  it('commits results only at the persisted cursor', async () => {
    const store = setup();
    const jobId = await admitted(store);
    expect(await store.commitResult(jobId, 2, STARTPOS, 'success', 1, '{}', ISO)).toBe(false);
    expect(await store.commitResult(jobId, 0, STARTPOS, 'success', 1, '{"a":1}', ISO)).toBe(true);
    expect((await store.jobById(jobId))?.next_ply).toBe(1);
    // A redelivered/duplicate line commits nothing.
    expect(await store.commitResult(jobId, 0, STARTPOS, 'success', 1, '{"a":1}', ISO)).toBe(false);
    expect(await store.commitResult(jobId, 1, AFTER_2G2F, 'incomplete', 1, '{"b":2}', ISO)).toBe(true);
    expect((await store.jobById(jobId))?.next_ply).toBe(2);
    const rows = await store.resultsPage(jobId, -1, 10);
    expect(rows.map((row) => [row.ply, row.status])).toEqual([[0, 'success'], [1, 'incomplete']]);
  });

  it('rejects every result committed after cancellation', async () => {
    const store = setup();
    const jobId = await admitted(store);
    expect(await store.commitResult(jobId, 0, STARTPOS, 'success', 1, '{}', ISO)).toBe(true);
    expect(await store.cancelJob(jobId, 'own_test', ISO)).toBe(true);
    expect(await store.commitResult(jobId, 1, AFTER_2G2F, 'success', 1, '{}', ISO)).toBe(false);
    expect(await store.resultsPage(jobId, -1, 10)).toHaveLength(1);
    // A second cancel is a no-op.
    expect(await store.cancelJob(jobId, 'own_test', ISO)).toBe(false);
  });

  it('scopes cancellation to the owner', async () => {
    const store = setup();
    const jobId = await admitted(store);
    expect(await store.cancelJob(jobId, 'own_other', ISO)).toBe(false);
    expect((await store.jobById(jobId))?.status).toBe('queued');
    expect(await store.cancelJob(jobId, 'own_test', ISO)).toBe(true);
  });

  it('marks completed only when every ply is committed', async () => {
    const store = setup();
    const jobId = await admitted(store);
    expect(await store.markCompleted(jobId, ISO)).toBe(false);
    for (const ply of [0, 1, 2]) {
      const sfen = ply === 1 ? AFTER_2G2F : STARTPOS;
      expect(await store.commitResult(jobId, ply, sfen, 'success', 1, '{}', ISO)).toBe(true);
    }
    expect(await store.markCompleted(jobId, ISO)).toBe(true);
    expect((await store.jobById(jobId))?.status).toBe('completed');
  });

  it('paginates results after a ply cursor', async () => {
    const store = setup();
    const jobId = await admitted(store);
    for (const ply of [0, 1, 2]) {
      const sfen = ply === 1 ? AFTER_2G2F : STARTPOS;
      await store.commitResult(jobId, ply, sfen, 'success', 1, `{"ply":${ply}}`, ISO);
    }
    expect((await store.resultsPage(jobId, -1, 2)).map((row) => row.ply)).toEqual([0, 1]);
    expect((await store.resultsPage(jobId, 1, 2)).map((row) => row.ply)).toEqual([2]);
    expect(await store.resultsPage(jobId, 2, 2)).toHaveLength(0);
  });

  it('counts persisted results by status', async () => {
    const store = setup();
    const jobId = await admitted(store);
    await store.commitResult(jobId, 0, STARTPOS, 'success', 1, '{}', ISO);
    await store.commitResult(jobId, 1, AFTER_2G2F, 'failure', 1, '{}', ISO);
    const counts = await store.resultCounts(jobId);
    expect(counts).toEqual({ success: 1, failure: 1 });
  });
});
