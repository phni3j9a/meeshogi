import { describe, expect, it } from 'vitest';
import { Position } from 'tsshogi';
import { EXPECTED_IDENTITY, legalMoves } from '../src/contract';
import { JOB_PROFILES, type JobProfileId } from '../src/jobConfig';
import { runJobSlice, type JobRunnerDeps } from '../src/jobRunner';
import { JobStore, type JobRow } from '../src/jobStore';
import { createTestDb } from './testDb';

const STARTPOS = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
const ONE_MOVE_SFEN = 'k7r/9/9/9/9/8g/8g/9/8K b - 1';
const BASE_TIME = Date.parse('2026-10-04T00:00:00.000Z');

type PositionRow = { ply: number; sfen: string };
type SessionRequest = {
  contract: string;
  profileId: JobProfileId;
  conditions: Record<string, number>;
  positions: { ply: number; sfen: string; legalMoveCount: number }[];
  deadlineMs: number;
};

function positionsFor(moves: string[], initial = STARTPOS): PositionRow[] {
  const position = Position.newBySFEN(initial)!;
  const rows: PositionRow[] = [{ ply: 0, sfen: position.sfen }];
  for (const usi of moves) {
    const move = position.createMoveByUSI(usi);
    if (!move || !position.isValidMove(move)) throw new Error(`invalid fixture move ${usi}`);
    position.doMove(move);
    rows.push({ ply: rows.length, sfen: position.sfen });
  }
  return rows;
}

function seedJob(jobId: string, moves: string[] = ['2g2f', '8c8d'], profileId: JobProfileId = 'free', initial = STARTPOS) {
  const db = createTestDb();
  const ownerId = `own_${jobId}`;
  db.sqlite.prepare('INSERT INTO owners (owner_id, credential_hash, precision_allowed, created_at) VALUES (?, ?, 1, ?)')
    .run(ownerId, `hash_${jobId}`, '2026-10-04T00:00:00.000Z');
  const rows = positionsFor(moves, initial);
  db.sqlite.prepare(`INSERT INTO jobs (
    job_id, owner_id, idempotency_key, input_hash, profile_id, initial_sfen, moves_json,
    total_plies, status, next_ply, jst_day, created_ms, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, '2026-10-04', ?, ?, ?)`)
    .run(jobId, ownerId, `key_${jobId}`, 'input-hash', profileId, rows[0].sfen, JSON.stringify(moves), rows.length,
      BASE_TIME, '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z');
  const insertPosition = db.sqlite.prepare('INSERT INTO job_positions (job_id, ply, sfen, terminal) VALUES (?, ?, ?, NULL)');
  for (const row of rows) insertPosition.run(jobId, row.ply, row.sfen);
  return { ...db, store: new JobStore(db.d1.rawDb), rows };
}

function sessionHeader(profileId: JobProfileId, sessionId: string | null = 'a'.repeat(32)) {
  return {
    type: 'session',
    contract: 'analysis-session-v1',
    profileId,
    conditions: JOB_PROFILES[profileId].conditions,
    driverBootId: 'b'.repeat(32),
    engineLaunch: 1,
    identity: EXPECTED_IDENTITY,
    ...(sessionId === null ? {} : { sessionId }),
  };
}

function successResult(sfen: string, profileId: JobProfileId) {
  const conditions = JOB_PROFILES[profileId].conditions;
  const moves = legalMoves(sfen);
  const multiPV = Math.min(conditions.multiPV, moves.length);
  return {
    schemaVersion: 1,
    sfen,
    perspective: 'sente',
    status: 'success',
    terminal: null,
    candidates: moves.slice(0, multiPV).map((move, index) => ({
      move,
      pv: [move],
      score: { kind: 'cp', value: 12 - index },
    })),
    meta: { nodes: 1200, completedDepth: 6, elapsedMs: 200 },
    conditions: { requested: conditions, actual: { ...conditions, multiPV } },
    identity: EXPECTED_IDENTITY,
  };
}

function sessionBody(
  positions: PositionRow[],
  profileId: JobProfileId,
  options: { stopAfter?: number; end?: 'complete' | 'deadline' | 'error'; sessionId?: string | null; failure?: { ply: number; code: string } } = {},
): string {
  const lines: unknown[] = [sessionHeader(profileId, options.sessionId === undefined ? 'a'.repeat(32) : options.sessionId)];
  for (const position of positions.slice(0, options.stopAfter ?? positions.length)) {
    const result = options.failure?.ply === position.ply
      ? {
        schemaVersion: 1,
        sfen: position.sfen,
        perspective: 'sente',
        status: 'failure',
        failure: { code: options.failure.code, message: `driver reported ${options.failure.code}` },
        identity: EXPECTED_IDENTITY,
      }
      : successResult(position.sfen, profileId);
    lines.push({ type: 'result', ply: position.ply, engineLaunch: 1, result });
  }
  if (options.end !== undefined || options.stopAfter === undefined) {
    lines.push({ type: 'end', reason: options.end ?? 'complete' });
  }
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

function ndjson(text: string): Response {
  return new Response(text, { headers: { 'content-type': 'application/x-ndjson' } });
}

function runner(
  store: JobStore,
  jobId: string,
  transport: JobRunnerDeps['transport'],
  options: {
    profileId?: JobProfileId; budgetMs?: number; tailMarginMs?: number; now?: () => number; onTerminal?: () => void;
    sessionProofNodeBudget?: number;
  } = {},
) {
  const profileId = options.profileId ?? 'free';
  return runJobSlice({
    store,
    jobId,
    transport,
    signal: new AbortController().signal,
    budgetMs: options.budgetMs ?? 10_000,
    tailMarginMs: options.tailMarginMs ?? 0,
    instanceType: profileId === 'free' ? 'standard-2' : 'standard-3',
    now: options.now ?? (() => Date.now()),
    onTerminal: options.onTerminal,
    sessionProofNodeBudget: options.sessionProofNodeBudget,
  });
}

async function resultRows(sqlite: ReturnType<typeof createTestDb>['sqlite'], jobId: string) {
  return sqlite.prepare('SELECT ply, status, result_json FROM job_results WHERE job_id = ? ORDER BY ply').all(jobId) as {
    ply: number; status: string; result_json: string;
  }[];
}

describe('queue-independent job runner', () => {
  it('analyzes every position through one session and completes', async () => {
    const { store, sqlite, rows } = seedJob('runner_all_positions', ['2g2f', '8c8d']);
    const calls: { request: SessionRequest; path: string }[] = [];
    const outcome = await runner(store, 'runner_all_positions', async (request) => {
      const body = await request.json() as SessionRequest;
      calls.push({ request: body, path: new URL(request.url).pathname });
      return ndjson(sessionBody(rows, 'free'));
    });

    expect(outcome.kind).toBe('done');
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/session');
    expect(calls[0].request.contract).toBe('analysis-session-v1');
    expect(calls[0].request.profileId).toBe('free');
    expect(calls[0].request.positions.map(({ ply }) => ply)).toEqual([0, 1, 2]);
    expect(calls[0].request.positions.map(({ sfen, legalMoveCount }) => legalMoveCount === legalMoves(sfen).length))
      .toEqual([true, true, true]);
    expect(calls[0].request.conditions).toEqual(JOB_PROFILES.free.conditions);
    expect(calls[0].request.deadlineMs).toBeGreaterThan(0);
    expect((await store.jobById('runner_all_positions'))?.status).toBe('completed');
    expect((await resultRows(sqlite, 'runner_all_positions')).map(({ ply, status }) => [ply, status]))
      .toEqual([[0, 'success'], [1, 'success'], [2, 'success']]);
    sqlite.close();
  });

  it('commits the server mate proof with every result, overriding driver data', async () => {
    // Black to move mates with L*1b; after it, White has no legal move (terminal).
    const { store, sqlite, rows } = seedJob('runner_mate_proof', [], 'free', '7nk/9/7G1/9/9/9/9/9/K8 b L 1');
    const forged = sessionBody(rows, 'free').trim().split('\n').map((text) => {
      const line = JSON.parse(text);
      if (line.type === 'result') {
        line.result.mateProof = { version: 1, status: 'proven', plies: 1, side: 'sente', pv: ['9i9h'] };
      }
      return JSON.stringify(line);
    }).join('\n') + '\n';
    expect(forged).toContain('9i9h');
    const outcome = await runner(store, 'runner_mate_proof', async () => ndjson(forged));
    expect(outcome.kind).toBe('done');
    const [row] = await resultRows(sqlite, 'runner_mate_proof');
    expect(JSON.parse(row.result_json).mateProof).toEqual({
      version: 1, status: 'proven', plies: 1, side: 'sente', pv: ['L*1b'],
    });
    sqlite.close();
  });

  it('records not-found proofs for ordinary positions', async () => {
    const { store, sqlite, rows } = seedJob('runner_no_mate', ['2g2f']);
    await runner(store, 'runner_no_mate', async () => ndjson(sessionBody(rows, 'free')));
    const proofs = (await resultRows(sqlite, 'runner_no_mate')).map((row) => JSON.parse(row.result_json).mateProof);
    expect(proofs).toEqual([{ version: 1, status: 'not-found' }, { version: 1, status: 'not-found' }]);
    sqlite.close();
  });

  it('ends the session at a committed boundary once the proof work budget is spent', async () => {
    const { store, sqlite, rows } = seedJob('runner_proof_budget', ['2g2f', '8c8d']);
    const outcome = await runner(store, 'runner_proof_budget', async () => ndjson(sessionBody(rows, 'free')), {
      sessionProofNodeBudget: 1,
    });
    expect(outcome.kind).toBe('continue');
    expect((await resultRows(sqlite, 'runner_proof_budget')).map(({ ply }) => ply)).toEqual([0]);
    expect((await store.jobById('runner_proof_budget'))?.next_ply).toBe(1);
    sqlite.close();
  });

  it('sends legalMoveCount and accepts the reduced effective multiPV', async () => {
    const { store, sqlite } = seedJob('runner_reduced_multipv', [], 'free');
    sqlite.prepare('UPDATE jobs SET initial_sfen = ? WHERE job_id = ?').run(ONE_MOVE_SFEN, 'runner_reduced_multipv');
    sqlite.prepare('UPDATE job_positions SET sfen = ? WHERE job_id = ? AND ply = 0').run(ONE_MOVE_SFEN, 'runner_reduced_multipv');
    let sent: SessionRequest | undefined;
    const outcome = await runner(store, 'runner_reduced_multipv', async (request) => {
      sent = await request.json() as SessionRequest;
      const onlyPosition = { ply: 0, sfen: ONE_MOVE_SFEN };
      return ndjson(sessionBody([onlyPosition], 'free'));
    });
    expect(outcome.kind).toBe('done');
    expect(sent?.positions).toEqual([{ ply: 0, sfen: ONE_MOVE_SFEN, legalMoveCount: 1 }]);
    const result = JSON.parse((await resultRows(sqlite, 'runner_reduced_multipv'))[0].result_json);
    expect(result.conditions.actual.multiPV).toBe(1);
    expect(result.candidates).toHaveLength(1);
    sqlite.close();
  });

  it('returns a durable-continuation outcome after progress so the DO can resume from the cursor', async () => {
    const { store, sqlite, rows } = seedJob('runner_deadline_resume', ['2g2f', '8c8d']);
    const calls: SessionRequest[] = [];
    const first = await runner(store, 'runner_deadline_resume', async (request) => {
      calls.push(await request.json() as SessionRequest);
      return ndjson(sessionBody(rows, 'free', { stopAfter: 1, end: 'deadline' }));
    });
    expect(first.kind).toBe('continue');
    expect((await store.jobById('runner_deadline_resume'))?.next_ply).toBe(1);
    const nextRows = rows.filter(({ ply }) => ply >= 1);
    const second = await runner(store, 'runner_deadline_resume', async (request) => {
      calls.push(await request.json() as SessionRequest);
      return ndjson(sessionBody(nextRows, 'free'));
    });
    expect(second.kind).toBe('done');
    expect(calls.map(({ positions }) => positions.map(({ ply }) => ply))).toEqual([[0, 1, 2], [1, 2]]);
    expect((await store.jobById('runner_deadline_resume'))?.status).toBe('completed');
    sqlite.close();
  });

  it('uses Precision conditions and reports continuation without stopping the job', async () => {
    const { store, sqlite, rows } = seedJob('runner_precision', ['2g2f'], 'precision');
    let sent: SessionRequest | undefined;
    const outcome = await runner(store, 'runner_precision', async (request) => {
      sent = await request.json() as SessionRequest;
      return ndjson(sessionBody(rows, 'precision', { stopAfter: 1, end: 'deadline' }));
    }, { profileId: 'precision' });
    expect(outcome.kind).toBe('continue');
    expect(sent?.conditions).toEqual(JOB_PROFILES.precision.conditions);
    expect((await store.jobById('runner_precision'))?.status).toBe('running');
    sqlite.close();
  });

  it('aborts a stalled stream at its budget without progress', async () => {
    const { store, sqlite } = seedJob('runner_stalled');
    let cancelled = 0;
    const outcome = await runner(store, 'runner_stalled', async (request) => {
      void request.signal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(sessionHeader('free')) + '\n')); },
        cancel() { cancelled += 1; },
      }), { headers: { 'content-type': 'application/x-ndjson' } });
    }, { budgetMs: 25 });
    expect(outcome.kind).toBe('retry');
    expect(cancelled).toBeGreaterThanOrEqual(1);
    expect((await store.jobById('runner_stalled'))?.next_ply).toBe(0);
    expect(await resultRows(sqlite, 'runner_stalled')).toHaveLength(0);
    sqlite.close();
  });

  it('stops processing buffered lines at the deadline and resumes from the committed cursor', async () => {
    const { store, sqlite, rows } = seedJob('runner_buffered_deadline', ['2g2f', '8c8d']);
    let fakeNow = BASE_TIME;
    const originalCommit = store.commitResult.bind(store);
    let expired = false;
    store.commitResult = async (...args) => {
      const committed = await originalCommit(...args);
      if (!expired && committed) { expired = true; fakeNow += 101; }
      return committed;
    };
    const calls: SessionRequest[] = [];
    const first = await runner(store, 'runner_buffered_deadline', async (request) => {
      if (new URL(request.url).pathname === '/session') calls.push(await request.json() as SessionRequest);
      return ndjson(sessionBody(rows, 'free'));
    }, { budgetMs: 100, now: () => fakeNow });
    expect(first.kind).toBe('continue');
    expect((await store.jobById('runner_buffered_deadline'))?.next_ply).toBe(1);
    expect(await resultRows(sqlite, 'runner_buffered_deadline')).toHaveLength(1);
    const second = await runner(store, 'runner_buffered_deadline', async (request) => {
      if (new URL(request.url).pathname === '/session') calls.push(await request.json() as SessionRequest);
      return ndjson(sessionBody(rows.slice(1), 'free'));
    }, { budgetMs: 10_000, now: () => fakeNow });
    expect(second.kind).toBe('done');
    expect(calls.map(({ positions }) => positions[0].ply)).toEqual([0, 1]);
    expect((await store.jobById('runner_buffered_deadline'))?.status).toBe('completed');
    sqlite.close();
  });

  it('does not refetch a completed or cancelled job', async () => {
    const completed = seedJob('runner_completed_duplicate', []);
    completed.sqlite.prepare("UPDATE jobs SET status = 'completed', next_ply = total_plies WHERE job_id = ?")
      .run('runner_completed_duplicate');
    let completedFetches = 0;
    expect((await runner(completed.store, 'runner_completed_duplicate', async () => {
      completedFetches += 1; return new Response('unexpected');
    })).kind).toBe('done');
    expect(completedFetches).toBe(0);

    const cancelled = seedJob('runner_cancelled_delivery');
    await cancelled.store.cancelJob('runner_cancelled_delivery', 'own_runner_cancelled_delivery', new Date().toISOString());
    let cancelledFetches = 0;
    let terminalCalls = 0;
    expect((await runner(cancelled.store, 'runner_cancelled_delivery', async () => {
      cancelledFetches += 1; return new Response('unexpected');
    }, { onTerminal: () => { terminalCalls += 1; } })).kind).toBe('done');
    expect(cancelledFetches).toBe(0);
    expect(terminalCalls).toBe(1);
    completed.sqlite.close();
    cancelled.sqlite.close();
  });

  it('retries transient driver failures from the failed ply without committing the failure', async () => {
    const { store, sqlite, rows } = seedJob('runner_failure_cursor', ['2g2f', '8c8d']);
    const fail = await runner(store, 'runner_failure_cursor', async () => ndjson(sessionBody(rows, 'free', {
      failure: { ply: 0, code: 'engine_error' }, end: 'error',
    })));
    expect(fail.kind).toBe('retry');
    expect((await store.jobById('runner_failure_cursor'))?.next_ply).toBe(0);
    expect(await resultRows(sqlite, 'runner_failure_cursor')).toHaveLength(0);

    const partialRows = await runner(store, 'runner_failure_cursor', async () => ndjson(sessionBody(rows, 'free', {
      stopAfter: 2, failure: { ply: 1, code: 'engine_error' }, end: 'error',
    })));
    expect(partialRows.kind).toBe('retry');
    expect((await store.jobById('runner_failure_cursor'))?.next_ply).toBe(1);
    expect((await resultRows(sqlite, 'runner_failure_cursor')).map(({ ply }) => ply)).toEqual([0]);

    const retryRows = await store.positionsFrom('runner_failure_cursor', 1);
    const finish = await runner(store, 'runner_failure_cursor', async (request) => {
      const body = await request.json() as SessionRequest;
      expect(body.positions.map(({ ply }) => ply)).toEqual([1, 2]);
      return ndjson(sessionBody(retryRows, 'free'));
    });
    expect(finish.kind).toBe('done');
    expect((await store.jobById('runner_failure_cursor'))?.status).toBe('completed');
    expect((await resultRows(sqlite, 'runner_failure_cursor')).map(({ ply }) => ply)).toEqual([0, 1, 2]);
    sqlite.close();
  });

  it('makes permanent driver failures and contract violations terminal outcomes', async () => {
    const { store, sqlite, rows } = seedJob('runner_permanent_failure');
    const permanent = await runner(store, 'runner_permanent_failure', async () => ndjson(sessionBody(rows, 'free', {
      failure: { ply: 0, code: 'identity_mismatch' }, end: 'error',
    })));
    expect(permanent).toMatchObject({ kind: 'fail', code: 'contract_violation' });
    expect((await resultRows(sqlite, 'runner_permanent_failure'))).toHaveLength(0);

    const violation = await runner(store, 'runner_permanent_failure', async () => ndjson('{"type":"end","reason":"complete"}\n'));
    expect(violation).toMatchObject({ kind: 'fail', code: 'contract_violation' });
    sqlite.close();
  });

  it('accepts legacy headers without sessionId and rejects malformed sessionIds', async () => {
    const legacy = seedJob('runner_legacy_header', []);
    const cancelPaths: string[] = [];
    const outcome = await runner(legacy.store, 'runner_legacy_header', async (request) => {
      const path = new URL(request.url).pathname;
      cancelPaths.push(path);
      return path === '/session'
        ? ndjson(sessionBody(legacy.rows, 'free', { sessionId: null }))
        : new Response(JSON.stringify({ schemaVersion: 1, cancelled: false }));
    });
    expect(outcome.kind).toBe('done');
    expect(cancelPaths).toEqual(['/session']);

    const malformed = seedJob('runner_bad_session_id', []);
    const rejected = await runner(malformed.store, 'runner_bad_session_id', async () => ndjson(sessionBody(malformed.rows, 'free', {
      sessionId: 'not-a-session-id',
    })));
    expect(rejected).toMatchObject({ kind: 'fail', code: 'contract_violation' });
    expect(await resultRows(malformed.sqlite, 'runner_bad_session_id')).toHaveLength(0);
    legacy.sqlite.close();
    malformed.sqlite.close();
  });

  it('cancels a named driver session when a deadline cuts its open stream', async () => {
    const { store, sqlite } = seedJob('runner_cancel_on_deadline');
    let nowCalls = 0;
    const fakeNow = () => (++nowCalls <= 7 ? BASE_TIME : BASE_TIME + 101);
    const paths: string[] = [];
    const cancelIds: unknown[] = [];
    const outcome = await runner(store, 'runner_cancel_on_deadline', async (request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path === '/session/cancel') {
        cancelIds.push(await request.json().then((body) => (body as { sessionId: unknown }).sessionId));
        return Response.json({ schemaVersion: 1, cancelled: true });
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(sessionHeader('free')) + '\n')); },
        pull() {},
      }), { headers: { 'content-type': 'application/x-ndjson' } });
    }, { budgetMs: 100, now: fakeNow });
    expect(outcome.kind).toBe('retry');
    expect(paths).toEqual(['/session', '/session/cancel']);
    expect(cancelIds).toEqual(['a'.repeat(32)]);
    sqlite.close();
  });

  it('handles a late session response after timeout and cancels its body without restarting transport', async () => {
    const { store, sqlite } = seedJob('runner_late_response');
    let resolveLate!: (response: Response) => void;
    let bodyCancelled = false;
    const pendingTasks: Promise<unknown>[] = [];
    let calls = 0;
    const outcome = await runJobSlice({
      store,
      jobId: 'runner_late_response',
      transport: () => {
        calls += 1;
        return new Promise<Response>((resolve) => { resolveLate = resolve; });
      },
      signal: new AbortController().signal,
      budgetMs: 20,
      tailMarginMs: 0,
      instanceType: 'standard-2',
      waitUntil: (task) => { pendingTasks.push(task); },
    });
    expect(outcome.kind).toBe('retry');
    resolveLate(new Response(new ReadableStream({ cancel() { bodyCancelled = true; } })));
    await Promise.all(pendingTasks);
    expect(bodyCancelled).toBe(true);
    expect(calls).toBe(1);
    sqlite.close();
  });

  it('does not fetch when markRunning loses a race to cancellation', async () => {
    const { store, sqlite } = seedJob('runner_mark_running_race');
    const originalMarkRunning = store.markRunning.bind(store);
    store.markRunning = async (jobId, at) => {
      await store.cancelJob(jobId, 'own_runner_mark_running_race', at);
      return originalMarkRunning(jobId, at);
    };
    let fetches = 0;
    let stops = 0;
    const outcome = await runner(store, 'runner_mark_running_race', async () => {
      fetches += 1; return new Response('unexpected');
    }, { onTerminal: () => { stops += 1; } });
    expect(outcome.kind).toBe('done');
    expect(fetches).toBe(0);
    expect(stops).toBe(1);
    sqlite.close();
  });

  it('does not duplicate a result when D1 commits and then reports a transient error', async () => {
    const { store, sqlite, rows } = seedJob('runner_commit_then_throw', []);
    const originalCommit = store.commitResult.bind(store);
    let throwAfterCommit = true;
    store.commitResult = async (...args) => {
      const committed = await originalCommit(...args);
      if (throwAfterCommit) { throwAfterCommit = false; throw new Error('lost D1 response after commit'); }
      return committed;
    };
    const first = await runner(store, 'runner_commit_then_throw', async () => ndjson(sessionBody(rows, 'free')));
    expect(first.kind).toBe('retry');
    expect((await store.jobById('runner_commit_then_throw'))?.next_ply).toBe(1);
    expect(await resultRows(sqlite, 'runner_commit_then_throw')).toHaveLength(1);
    const second = await runner(store, 'runner_commit_then_throw', async (request) => {
      const body = await request.json() as SessionRequest;
      expect(body.positions.map(({ ply }) => ply)).toEqual([1]);
      return ndjson(sessionBody([], 'free'));
    });
    // The first result already reached the last position. A clean runner read
    // completes from D1 without asking the driver to repeat it.
    expect(second.kind).toBe('done');
    expect((await resultRows(sqlite, 'runner_commit_then_throw'))).toHaveLength(1);
    sqlite.close();
  });
});
