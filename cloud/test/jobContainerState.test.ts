import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Position } from 'tsshogi';
import { EXPECTED_IDENTITY, legalMoves } from '../src/contract';
import { JOB_EXECUTION, JOB_PROFILES, type JobProfileId } from '../src/jobConfig';
import { FreeJobContainer, PrecisionJobContainer } from '../src/jobContainers';
import type { Env } from '../src/index';
import { JobStore } from '../src/jobStore';
import { createTestDb } from './testDb';

vi.mock('@cloudflare/containers', () => ({
  Container: class {
    private readonly context: any;
    public envVars: Record<string, string> = {};
    constructor(context: any) { this.context = context; }
    schedule(delaySeconds: number, callback: string, payload: unknown) {
      return this.context.schedule(delaySeconds, callback, payload);
    }
    async listSchedules<T>(callback: string) {
      return this.context.listSchedules(callback) as Promise<{ taskId: string; callback: string; payload: T; time: number }[]>;
    }
    deleteSchedules(callback: string) { this.context.deleteSchedules(callback); }
    async fetch(request: Request) { return this.context.container.getTcpPort().fetch(request); }
    async destroy() { await this.context.container.destroy(); }
  },
  getContainer: (binding: { getByName: (name: string) => unknown }, name: string) => binding.getByName(name),
}));

const STARTPOS = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
const BASE_TIME = Date.parse('2026-10-04T00:00:00.000Z');
const RUN_CALLBACK = 'runScheduledSlice';
const RECOVERY_CALLBACK = 'recoverScheduledSlice';

type PositionRow = { ply: number; sfen: string };
type Schedule = { taskId: string; callback: string; payload: { schemaVersion: 1; generation: number; runId: string }; time: number };
type SessionRequest = { contract: string; profileId: JobProfileId; conditions: Record<string, number>; positions: PositionRow[]; deadlineMs: number };
type Control = { schemaVersion: 1; jobId: string; profileId: JobProfileId; generation: number; attempt: number; notBefore: number; runId: string | null; taskId: string | null; phase: string; recoveryTaskId: string | null; recoveryAt: number | null };

function positionsFor(moves: string[]): PositionRow[] {
  const position = Position.newBySFEN(STARTPOS)!;
  const rows: PositionRow[] = [{ ply: 0, sfen: position.sfen }];
  for (const usi of moves) {
    const move = position.createMoveByUSI(usi);
    if (!move || !position.isValidMove(move)) throw new Error(`invalid fixture move ${usi}`);
    position.doMove(move);
    rows.push({ ply: rows.length, sfen: position.sfen });
  }
  return rows;
}

function seedJob(jobId: string, moves = ['2g2f', '8c8d'], profileId: JobProfileId = 'free') {
  const db = createTestDb();
  const ownerId = `own_${jobId}`;
  db.sqlite.prepare('INSERT INTO owners (owner_id, credential_hash, precision_allowed, created_at) VALUES (?, ?, 1, ?)')
    .run(ownerId, `hash_${jobId}`, '2026-10-04T00:00:00.000Z');
  const positions = positionsFor(moves);
  db.sqlite.prepare(`INSERT INTO jobs (
    job_id, owner_id, idempotency_key, input_hash, profile_id, initial_sfen, moves_json,
    total_plies, status, next_ply, jst_day, created_ms, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, '2026-10-04', ?, ?, ?)`)
    .run(jobId, ownerId, `key_${jobId}`, 'input-hash', profileId, positions[0].sfen, JSON.stringify(moves), positions.length,
      BASE_TIME, '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z');
  const insert = db.sqlite.prepare('INSERT INTO job_positions (job_id, ply, sfen, terminal) VALUES (?, ?, ?, NULL)');
  for (const position of positions) insert.run(jobId, position.ply, position.sfen);
  return { ...db, ownerId, positions, store: new JobStore(db.d1.rawDb) };
}

function successLine(position: PositionRow, profileId: JobProfileId) {
  const conditions = JOB_PROFILES[profileId].conditions;
  const moves = legalMoves(position.sfen);
  const multiPV = Math.min(conditions.multiPV, moves.length);
  return {
    type: 'result', ply: position.ply, engineLaunch: 1,
    result: {
      schemaVersion: 1, sfen: position.sfen, perspective: 'sente', status: 'success', terminal: null,
      candidates: moves.slice(0, multiPV).map((move, index) => ({ move, pv: [move], score: { kind: 'cp', value: 10 - index } })),
      meta: { nodes: 1000, completedDepth: 5, elapsedMs: 100 },
      conditions: { requested: conditions, actual: { ...conditions, multiPV } },
      identity: EXPECTED_IDENTITY,
    },
  };
}

function sessionResponse(
  positions: PositionRow[],
  profileId: JobProfileId,
  options: { stopAfter?: number; end?: 'complete' | 'deadline' | 'error'; sessionId?: string | null; failure?: { ply: number; code: string } } = {},
): Response {
  const header = {
    type: 'session', contract: 'analysis-session-v1', profileId, conditions: JOB_PROFILES[profileId].conditions,
    driverBootId: 'b'.repeat(32), engineLaunch: 1, identity: EXPECTED_IDENTITY,
    ...(options.sessionId === null ? {} : { sessionId: options.sessionId ?? 'a'.repeat(32) }),
  };
  const lines: unknown[] = [header];
  for (const position of positions.slice(0, options.stopAfter ?? positions.length)) {
    if (options.failure?.ply === position.ply) {
      lines.push({ type: 'result', ply: position.ply, engineLaunch: 1, result: {
        schemaVersion: 1, sfen: position.sfen, perspective: 'sente', status: 'failure',
        failure: { code: options.failure.code, message: 'driver failure' }, identity: EXPECTED_IDENTITY,
      } });
    } else lines.push(successLine(position, profileId));
  }
  if (options.stopAfter === undefined || options.end !== undefined) lines.push({ type: 'end', reason: options.end ?? 'complete' });
  return new Response(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, {
    headers: { 'content-type': 'application/x-ndjson' },
  });
}

type Transport = (request: Request, sessionCount: number) => Promise<Response>;

function makeDo(
  jobId: string,
  d1: ReturnType<typeof createTestDb>['d1'],
  transport: Transport,
  options: { profileId?: JobProfileId; failSchedule?: () => boolean } = {},
) {
  const profileId = options.profileId ?? 'free';
  const values = new Map<string, unknown>();
  let schedules: Schedule[] = [];
  let scheduleIndex = 0;
  let failPut: ((key: string, value: unknown) => boolean) | undefined;
  let sessionCount = 0;
  let destroys = 0;
  const storage = {
    get: async <T,>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      if (failPut?.(key, value)) { failPut = undefined; throw new Error('injected storage put failure'); }
      values.set(key, value);
    },
    kv: { get: (key: string) => values.get(key) },
    sql: { exec: () => [] },
    setAlarm: async () => undefined,
    sync: async () => undefined,
    deleteAlarm: async () => undefined,
  };
  const context = {
    storage,
    id: { name: jobId },
    schedules,
    schedule: async (delaySeconds: number, callback: string, payload: Schedule['payload']) => {
      if (options.failSchedule?.()) throw new Error('injected schedule failure');
      const record: Schedule = {
        taskId: `task-${++scheduleIndex}`, callback, payload,
        // Containers SDK 0.3.7 floors schedule targets to whole Unix seconds.
        time: Math.floor(Date.now() / 1000 + Math.max(0, delaySeconds)),
      };
      schedules.push(record);
      return record;
    },
    listSchedules: async (callback: string) => schedules.filter((item) => item.callback === callback),
    deleteSchedules: (callback: string) => { schedules = schedules.filter((item) => item.callback !== callback); context.schedules = schedules; },
    consumeSchedule: (taskId: string) => { schedules = schedules.filter((item) => item.taskId !== taskId); context.schedules = schedules; },
    container: {
      getTcpPort: () => ({ fetch: async (request: Request) => {
        if (new URL(request.url).pathname === '/session') sessionCount += 1;
        return transport(request, sessionCount);
      } }),
      destroy: async () => { destroys += 1; },
    },
  };
  const env = { JOBS_DB: d1 as unknown as D1Database } as Env;
  const container = profileId === 'free'
    ? new FreeJobContainer(context as never, env)
    : new PrecisionJobContainer(context as never, env);
  return {
    container,
    store: new JobStore(d1.rawDb),
    values,
    context,
    get schedules() { return schedules; },
    get sessionCount() { return sessionCount; },
    get destroys() { return destroys; },
    failNextPut: (predicate: (key: string, value: unknown) => boolean) => { failPut = predicate; },
  };
}

function control(harness: ReturnType<typeof makeDo>): Control {
  return harness.values.get('job:control') as Control;
}

function runSchedule(harness: ReturnType<typeof makeDo>, schedule = harness.schedules.find((item) => item.callback === RUN_CALLBACK)) {
  if (!schedule) throw new Error('no run callback is scheduled');
  const { container } = harness;
  harness.context.consumeSchedule(schedule.taskId);
  vi.setSystemTime(Math.max(Date.now(), schedule.time * 1000));
  return container.runScheduledSlice(schedule.payload as never, schedule as never);
}

describe('JobContainer durable control state machine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('repairs fault 1 after control marker persistence but before reservation creation', async () => {
    const db = seedJob('do_fault_marker');
    let failOnce = true;
    const harness = makeDo('do_fault_marker', db.d1, async () => new Response('unused'), {
      failSchedule: () => { if (!failOnce) return false; failOnce = false; return true; },
    });
    await expect(harness.container.startJob({ jobId: 'do_fault_marker', profileId: 'free' })).rejects.toThrow('injected schedule failure');
    const accepted = control(harness);
    expect(accepted).toMatchObject({ phase: 'scheduled', generation: 1, attempt: 1, taskId: null });
    await harness.container.startJob({ jobId: 'do_fault_marker', profileId: 'free' });
    expect(harness.schedules.filter((row) => row.callback === RUN_CALLBACK)).toHaveLength(1);
    expect(control(harness)).toMatchObject({ generation: 1, attempt: 1, notBefore: accepted.notBefore });
    db.sqlite.close();
  });

  it('repairs fault 2 when the SDK reservation exists but taskId persistence fails', async () => {
    const db = seedJob('do_fault_task_id');
    const harness = makeDo('do_fault_task_id', db.d1, async () => new Response('unused'));
    harness.failNextPut((key, value) => key === 'job:control' && (value as Control).taskId !== null);
    await expect(harness.container.startJob({ jobId: 'do_fault_task_id', profileId: 'free' })).rejects.toThrow('injected storage put failure');
    const accepted = control(harness);
    expect(harness.schedules.filter((row) => row.callback === RUN_CALLBACK)).toHaveLength(1);
    expect(accepted.taskId).toBeNull();
    await harness.container.startJob({ jobId: 'do_fault_task_id', profileId: 'free' });
    expect(harness.schedules.filter((row) => row.callback === RUN_CALLBACK)).toHaveLength(1);
    expect(control(harness).taskId).toBe(harness.schedules[0].taskId);
    expect(control(harness).notBefore).toBe(accepted.notBefore);
    db.sqlite.close();
  });

  it('serializes parallel and sequential duplicate starts without resetting retry state', async () => {
    const db = seedJob('do_duplicate_start');
    const harness = makeDo('do_duplicate_start', db.d1, async () => new Response('unused'));
    const [first, second] = await Promise.all([
      harness.container.startJob({ jobId: 'do_duplicate_start', profileId: 'free' }),
      harness.container.startJob({ jobId: 'do_duplicate_start', profileId: 'free' }),
    ]);
    expect(first.generation).toBe(1);
    expect(second.generation).toBe(1);
    const original = control(harness);
    await harness.context.storage.put('job:control', { ...original, attempt: 3, notBefore: Date.now() + 20_000 });
    const before = control(harness);
    await harness.container.startJob({ jobId: 'do_duplicate_start', profileId: 'free' });
    expect(harness.schedules.filter((row) => row.callback === RUN_CALLBACK)).toHaveLength(1);
    expect(control(harness)).toMatchObject({ generation: before.generation, attempt: 3, notBefore: before.notBefore });
    db.sqlite.close();
  });

  it('schedules progress continuation and resumes the saved D1 cursor without stopping', async () => {
    const db = seedJob('do_continue', ['2g2f', '8c8d']);
    const requests: SessionRequest[] = [];
    const harness = makeDo('do_continue', db.d1, async (request) => {
      if (new URL(request.url).pathname !== '/session') return Response.json({ schemaVersion: 1, cancelled: true });
      const body = await request.json() as SessionRequest;
      requests.push(body);
      return sessionResponse(body.positions, 'free', requests.length === 1 ? { stopAfter: 1, end: 'deadline' } : {});
    });
    await harness.container.startJob({ jobId: 'do_continue', profileId: 'free' });
    await runSchedule(harness);
    expect(await harness.store.jobById('do_continue')).toMatchObject({ status: 'running', next_ply: 1 });
    expect(control(harness)).toMatchObject({ phase: 'scheduled', attempt: 1, generation: 2 });
    expect(harness.schedules.filter((row) => row.callback === RUN_CALLBACK)).toHaveLength(1);
    await runSchedule(harness);
    expect(requests.map((row) => row.positions.map((position) => position.ply))).toEqual([[0, 1, 2], [1, 2]]);
    expect(await harness.store.jobById('do_continue')).toMatchObject({ status: 'completed', next_ply: 3 });
    expect(harness.destroys).toBe(1);
    db.sqlite.close();
  });

  it('routes Precision analysis through its fixed profile conditions and keeps continuation alive', async () => {
    const db = seedJob('do_precision', ['2g2f'], 'precision');
    let requestBody: SessionRequest | undefined;
    const harness = makeDo('do_precision', db.d1, async (request) => {
      if (new URL(request.url).pathname !== '/session') return Response.json({ schemaVersion: 1, cancelled: true });
      requestBody = await request.json() as SessionRequest;
      return sessionResponse(db.positions, 'precision', { stopAfter: 1, end: 'deadline' });
    }, { profileId: 'precision' });
    await harness.container.startJob({ jobId: 'do_precision', profileId: 'precision' });
    await runSchedule(harness);
    expect(requestBody?.conditions).toEqual(JOB_PROFILES.precision.conditions);
    expect(requestBody?.profileId).toBe('precision');
    expect(control(harness).phase).toBe('scheduled');
    expect(harness.destroys).toBe(0);
    db.sqlite.close();
  });

  it('accepts a duplicate start for a completed job while preserving the terminal fence', async () => {
    const db = seedJob('do_completed_duplicate', []);
    db.sqlite.prepare("UPDATE jobs SET status = 'completed', next_ply = total_plies WHERE job_id = ?")
      .run('do_completed_duplicate');
    let fetches = 0;
    const harness = makeDo('do_completed_duplicate', db.d1, async () => {
      fetches += 1;
      return new Response('unexpected');
    });
    const accepted = await harness.container.startJob({ jobId: 'do_completed_duplicate', profileId: 'free' });
    expect(accepted.accepted).toBe(true);
    expect(await harness.context.storage.get('job:terminated')).toBe(true);
    expect(harness.values.has('job:control')).toBe(false);
    expect(harness.schedules).toHaveLength(0);
    expect(fetches).toBe(0);
    db.sqlite.close();
  });

  it('persists permanent driver failures and contract violations instead of reserving retries', async () => {
    const driverDb = seedJob('do_permanent_driver_failure', []);
    const driverFailure = makeDo('do_permanent_driver_failure', driverDb.d1, async () => sessionResponse(
      driverDb.positions, 'free', { failure: { ply: 0, code: 'identity_mismatch' }, end: 'error' },
    ));
    await driverFailure.container.startJob({ jobId: 'do_permanent_driver_failure', profileId: 'free' });
    await runSchedule(driverFailure);
    expect(await driverFailure.store.jobById('do_permanent_driver_failure'))
      .toMatchObject({ status: 'failed', failure_code: 'contract_violation' });
    expect(control(driverFailure).phase).toBe('terminal');
    expect(driverFailure.schedules).toHaveLength(0);

    const contractDb = seedJob('do_contract_violation', []);
    const contractViolation = makeDo('do_contract_violation', contractDb.d1, async () => new Response('{"type":"end","reason":"complete"}\n', {
      headers: { 'content-type': 'application/x-ndjson' },
    }));
    await contractViolation.container.startJob({ jobId: 'do_contract_violation', profileId: 'free' });
    await runSchedule(contractViolation);
    expect(await contractViolation.store.jobById('do_contract_violation'))
      .toMatchObject({ status: 'failed', failure_code: 'contract_violation' });
    expect(control(contractViolation).phase).toBe('terminal');
    expect(contractViolation.schedules).toHaveLength(0);
    driverDb.sqlite.close();
    contractDb.sqlite.close();
  });

  it('distinguishes max_instances capacity wait from generic 503 and preserves attempts only for capacity', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const capacityDb = seedJob('do_capacity');
    const capacityHarness = makeDo('do_capacity', capacityDb.d1, async () => new Response(
      'There is no Container instance available at this time. max concurrent instance count reached.', { status: 503 },
    ));
    await capacityHarness.container.startJob({ jobId: 'do_capacity', profileId: 'free' });
    await runSchedule(capacityHarness);
    const capacity = control(capacityHarness);
    expect(capacity).toMatchObject({ phase: 'scheduled', generation: 2, attempt: 1 });
    expect(capacity.notBefore - Date.now()).toBeGreaterThanOrEqual(4_000);
    expect(capacity.notBefore - Date.now()).toBeLessThanOrEqual(6_000);

    const genericDb = seedJob('do_generic_503');
    const genericHarness = makeDo('do_generic_503', genericDb.d1, async () => new Response('ordinary unavailable', { status: 503 }));
    await genericHarness.container.startJob({ jobId: 'do_generic_503', profileId: 'free' });
    await runSchedule(genericHarness);
    expect(control(genericHarness)).toMatchObject({ phase: 'scheduled', generation: 2, attempt: 2 });
    expect(control(genericHarness).notBefore - Date.now()).toBeGreaterThanOrEqual(9_000);
    expect(control(genericHarness).notBefore - Date.now()).toBeLessThanOrEqual(11_000);
    capacityDb.sqlite.close();
    genericDb.sqlite.close();
  });

  it('aligns fractional retry times to SDK seconds and restores a reservation after an early callback', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const db = seedJob('do_fractional_capacity');
    let sessionCalls = 0;
    const harness = makeDo('do_fractional_capacity', db.d1, async (request) => {
      if (new URL(request.url).pathname !== '/session') return Response.json({ schemaVersion: 1, cancelled: true });
      sessionCalls += 1;
      if (sessionCalls === 1) {
        // Model a capacity response arriving at a fractional wall-clock second.
        vi.setSystemTime(Date.now() + 987);
        return new Response(
          'There is no Container instance available at this time. max concurrent instance count reached.',
          { status: 503 },
        );
      }
      return sessionResponse(db.positions, 'free');
    });

    await harness.container.startJob({ jobId: 'do_fractional_capacity', profileId: 'free' });
    const initial = harness.schedules.find((row) => row.callback === RUN_CALLBACK)!;
    expect(initial.time * 1000).toBeGreaterThanOrEqual(control(harness).notBefore);
    await runSchedule(harness, initial);

    const retryControl = control(harness);
    const retry = harness.schedules.find((row) => row.callback === RUN_CALLBACK)!;
    expect(retryControl.notBefore % 1000).toBe(0);
    expect(retry.time * 1000).toBe(retryControl.notBefore);

    // A defensive early callback must replace the fired SDK reservation before returning.
    harness.context.consumeSchedule(retry.taskId);
    vi.setSystemTime(retryControl.notBefore - 1);
    await harness.container.runScheduledSlice(retry.payload as never, retry as never);
    expect(sessionCalls).toBe(1);
    const restored = harness.schedules.find((row) => row.callback === RUN_CALLBACK)!;
    expect(restored.time * 1000).toBeGreaterThanOrEqual(retryControl.notBefore);

    // The whole-second callback then resumes after capacity is available.
    await runSchedule(harness, restored);
    expect(sessionCalls).toBe(2);
    expect(await harness.store.jobById('do_fractional_capacity')).toMatchObject({ status: 'completed', next_ply: 3 });
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM job_results WHERE job_id = ?').get('do_fractional_capacity'))
      .toEqual({ count: 3 });
    expect(harness.schedules.filter((row) => row.callback === RUN_CALLBACK)).toHaveLength(0);
    db.sqlite.close();
  });

  it('uses 10/20/30 second execution retries and terminalizes the fourth transient failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    const db = seedJob('do_retry_exhaustion');
    const paths: string[] = [];
    const harness = makeDo('do_retry_exhaustion', db.d1, async (request) => {
      paths.push(new URL(request.url).pathname);
      return new Response('ordinary busy', { status: 409 });
    });
    await harness.container.startJob({ jobId: 'do_retry_exhaustion', profileId: 'free' });
    for (const [attempt, delaySeconds] of [[2, 10], [3, 20], [4, 30]] as const) {
      const next = harness.schedules.find((row) => row.callback === RUN_CALLBACK)!;
      await runSchedule(harness, next);
      expect(control(harness)).toMatchObject({ phase: 'scheduled', attempt });
      expect(control(harness).notBefore - Date.now()).toBe(delaySeconds * 1000);
      vi.setSystemTime(control(harness).notBefore);
    }
    const fourth = harness.schedules.find((row) => row.callback === RUN_CALLBACK)!;
    await runSchedule(harness, fourth);
    expect(await harness.store.jobById('do_retry_exhaustion')).toMatchObject({ status: 'failed', failure_code: 'retry_exhausted' });
    expect(control(harness)).toMatchObject({ phase: 'terminal', generation: 5 });
    expect(harness.schedules.filter((row) => row.callback === RUN_CALLBACK || row.callback === RECOVERY_CALLBACK)).toHaveLength(0);
    expect(paths).toEqual(['/session', '/session', '/session', '/session']);
    db.sqlite.close();
  });

  it('keeps callback recovery and schedules a retry when failed-state persistence fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    const db = seedJob('do_failure_write');
    const harness = makeDo('do_failure_write', db.d1, async () => new Response('ordinary busy', { status: 409 }));
    await harness.container.startJob({ jobId: 'do_failure_write', profileId: 'free' });
    await harness.context.storage.put('job:control', { ...control(harness), attempt: JOB_EXECUTION.maxRetries + 1 });
    let failMark = true;
    const originalPrepare = db.d1.prepare.bind(db.d1);
    db.d1.prepare = ((sql: string) => {
      if (failMark && sql.includes("SET status = 'failed'")) {
        failMark = false;
        return { bind: () => ({ run: async () => { throw new Error('injected D1 terminal write failure'); } }) } as never;
      }
      return originalPrepare(sql);
    }) as typeof db.d1.prepare;
    await runSchedule(harness);
    expect(await harness.store.jobById('do_failure_write')).toMatchObject({ status: 'running', failure_code: null });
    expect(control(harness)).toMatchObject({ phase: 'scheduled', attempt: 4 });
    expect(harness.schedules.some((row) => row.callback === RUN_CALLBACK)).toBe(true);
    expect(harness.schedules.some((row) => row.callback === RECOVERY_CALLBACK)).toBe(false);
    db.sqlite.close();
  });

  it('repairs fault 4 when follow-up reservation succeeds but its taskId write fails', async () => {
    const db = seedJob('do_fault_followup');
    const harness = makeDo('do_fault_followup', db.d1, async () => new Response('ordinary busy', { status: 409 }));
    await harness.container.startJob({ jobId: 'do_fault_followup', profileId: 'free' });
    const initial = harness.schedules.find((row) => row.callback === RUN_CALLBACK)!;
    harness.failNextPut((key, value) => key === 'job:control'
      && (value as Control).generation > 1 && (value as Control).taskId !== null);
    await expect(runSchedule(harness, initial)).rejects.toThrow('injected storage put failure');
    const afterFault = control(harness);
    expect(afterFault).toMatchObject({ phase: 'scheduled', generation: 2, attempt: 2, taskId: null });
    expect(harness.schedules.filter((row) => row.callback === RUN_CALLBACK)).toHaveLength(1);
    await harness.container.startJob({ jobId: 'do_fault_followup', profileId: 'free' });
    expect(control(harness).taskId).toBe(harness.schedules.find((row) => row.callback === RUN_CALLBACK)?.taskId);
    expect(harness.schedules.filter((row) => row.callback === RUN_CALLBACK)).toHaveLength(1);
    db.sqlite.close();
  });

  it('retries from the unchanged cursor when the result D1 commit fails before writing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    const db = seedJob('do_commit_before', ['2g2f']);
    const harness = makeDo('do_commit_before', db.d1, async (request) => {
      if (new URL(request.url).pathname !== '/session') return Response.json({ schemaVersion: 1, cancelled: true });
      return sessionResponse(db.positions, 'free');
    });
    await harness.container.startJob({ jobId: 'do_commit_before', profileId: 'free' });
    let failInsert = true;
    const originalPrepare = db.d1.prepare.bind(db.d1);
    db.d1.prepare = ((sql: string) => {
      if (failInsert && sql.includes('INSERT INTO job_results')) {
        failInsert = false;
        return {
          bind: (..._params: unknown[]) => ({ runSync: () => { throw new Error('injected commit failure'); } }),
        } as never;
      }
      return originalPrepare(sql);
    }) as typeof db.d1.prepare;
    await runSchedule(harness);
    expect(await harness.store.jobById('do_commit_before')).toMatchObject({ next_ply: 0, status: 'running' });
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM job_results WHERE job_id = ?').get('do_commit_before'))
      .toEqual({ count: 0 });
    expect(control(harness)).toMatchObject({ phase: 'scheduled', attempt: 2 });
    vi.setSystemTime(control(harness).notBefore);
    await runSchedule(harness, harness.schedules.find((row) => row.callback === RUN_CALLBACK)!);
    expect(await harness.store.jobById('do_commit_before')).toMatchObject({ status: 'completed', next_ply: 2 });
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM job_results WHERE job_id = ?').get('do_commit_before'))
      .toEqual({ count: 2 });
    db.sqlite.close();
  });

  it('repairs a lost run reservation on the running recovery callback without overlapping work', async () => {
    const db = seedJob('do_recovery');
    let resolveResponse!: (response: Response) => void;
    let sessionBegun!: () => void;
    const begun = new Promise<void>((resolve) => { sessionBegun = resolve; });
    let inFlight = 0;
    let maxInFlight = 0;
    const harness = makeDo('do_recovery', db.d1, async (request) => {
      if (new URL(request.url).pathname !== '/session') return Response.json({ schemaVersion: 1, cancelled: true });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      sessionBegun();
      const response = await new Promise<Response>((resolve) => { resolveResponse = resolve; });
      inFlight -= 1;
      return response;
    });
    await harness.container.startJob({ jobId: 'do_recovery', profileId: 'free' });
    const scheduled = harness.schedules.find((row) => row.callback === RUN_CALLBACK)!;
    const pendingRun = runSchedule(harness, scheduled);
    await begun;
    const recovery = harness.schedules.find((row) => row.callback === RECOVERY_CALLBACK)!;
    expect(recovery).toBeDefined();
    await harness.container.recoverScheduledSlice(recovery.payload as never, recovery as never);
    expect(harness.schedules.filter((row) => row.callback === RECOVERY_CALLBACK)).toHaveLength(1);
    await harness.container.startJob({ jobId: 'do_recovery', profileId: 'free' });
    expect(harness.sessionCount).toBe(1);
    expect(harness.schedules.filter((row) => row.callback === RUN_CALLBACK)).toHaveLength(0);
    resolveResponse(sessionResponse(db.positions, 'free'));
    await pendingRun;
    expect(maxInFlight).toBe(1);
    expect(await harness.store.jobById('do_recovery')).toMatchObject({ status: 'completed' });
    db.sqlite.close();
  });

  it('ignores stale generations and callbacks after terminal fencing without fetching the Container', async () => {
    const db = seedJob('do_stale_callback');
    let fetches = 0;
    const harness = makeDo('do_stale_callback', db.d1, async () => { fetches += 1; return new Response('unexpected'); });
    await harness.container.startJob({ jobId: 'do_stale_callback', profileId: 'free' });
    const stale = harness.schedules[0];
    await harness.context.storage.put('job:control', { ...control(harness), generation: 2 });
    await harness.container.runScheduledSlice(stale.payload as never, stale as never);
    expect(fetches).toBe(0);

    await harness.store.cancelJob('do_stale_callback', 'own_do_stale_callback', new Date().toISOString());
    await harness.container.terminateJob();
    const current = { ...stale.payload, generation: 3, runId: 'f'.repeat(32) };
    await harness.container.runScheduledSlice(current as never);
    expect(fetches).toBe(0);
    expect(await harness.context.storage.get('job:terminated')).toBe(true);
    expect(control(harness).phase).toBe('terminal');
    db.sqlite.close();
  });

  it('does not refetch a cancelled job Container while the next job runs in its own DO', async () => {
    const cancelledDb = seedJob('do_cancelled_before_next');
    const nextDb = seedJob('do_next_job');
    let cancelledFetches = 0;
    let nextFetches = 0;
    const cancelled = makeDo('do_cancelled_before_next', cancelledDb.d1, async () => {
      cancelledFetches += 1;
      return new Response('unexpected');
    });
    const next = makeDo('do_next_job', nextDb.d1, async (request) => {
      if (new URL(request.url).pathname !== '/session') return Response.json({ schemaVersion: 1, cancelled: true });
      nextFetches += 1;
      return sessionResponse(nextDb.positions, 'free');
    });
    await cancelled.container.startJob({ jobId: 'do_cancelled_before_next', profileId: 'free' });
    const stale = cancelled.schedules.find((row) => row.callback === RUN_CALLBACK)!;
    await cancelled.store.cancelJob('do_cancelled_before_next', cancelledDb.ownerId, new Date().toISOString());
    await cancelled.container.terminateJob();
    await next.container.startJob({ jobId: 'do_next_job', profileId: 'free' });
    await runSchedule(next);
    await cancelled.container.runScheduledSlice(stale.payload as never, stale as never);
    expect(cancelledFetches).toBe(0);
    expect(nextFetches).toBe(1);
    expect(await next.store.jobById('do_next_job')).toMatchObject({ status: 'completed' });
    cancelledDb.sqlite.close();
    nextDb.sqlite.close();
  });

  it('runs at most once for duplicate due callbacks from the same generation', async () => {
    const db = seedJob('do_duplicate_alarm', ['2g2f']);
    let sessionCalls = 0;
    const harness = makeDo('do_duplicate_alarm', db.d1, async (request) => {
      if (new URL(request.url).pathname !== '/session') return Response.json({ schemaVersion: 1, cancelled: true });
      sessionCalls += 1;
      return sessionResponse(db.positions, 'free', { stopAfter: 1, end: 'deadline' });
    });
    await harness.container.startJob({ jobId: 'do_duplicate_alarm', profileId: 'free' });
    const first = harness.schedules.find((row) => row.callback === RUN_CALLBACK)!;
    const duplicate: Schedule = { ...first, taskId: 'duplicate-alarm-task' };
    harness.context.schedules.push(duplicate);
    await runSchedule(harness, first);
    await harness.container.runScheduledSlice(duplicate.payload as never, duplicate as never);
    expect(sessionCalls).toBe(1);
    expect(await harness.store.jobById('do_duplicate_alarm')).toMatchObject({ status: 'running', next_ply: 1 });
    db.sqlite.close();
  });

  it('aborts a live response body during terminateJob and finishes within the stop bound', async () => {
    const db = seedJob('do_stream_cancel');
    let sessionBegun!: () => void;
    let bodyCancelled = false;
    const begun = new Promise<void>((resolve) => { sessionBegun = resolve; });
    const harness = makeDo('do_stream_cancel', db.d1, async (request) => {
      if (new URL(request.url).pathname !== '/session') return Response.json({ schemaVersion: 1, cancelled: true });
      sessionBegun();
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({
          type: 'session', contract: 'analysis-session-v1', profileId: 'free',
          conditions: JOB_PROFILES.free.conditions, driverBootId: 'b'.repeat(32), engineLaunch: 1,
          identity: EXPECTED_IDENTITY, sessionId: 'a'.repeat(32),
        }) + '\n')); },
        cancel() { bodyCancelled = true; },
      }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/x-ndjson' } });
    });
    await harness.container.startJob({ jobId: 'do_stream_cancel', profileId: 'free' });
    const run = runSchedule(harness);
    await begun;
    await harness.store.cancelJob('do_stream_cancel', 'own_do_stream_cancel', new Date().toISOString());
    const started = Date.now();
    await harness.container.terminateJob();
    const duration = Date.now() - started;
    await run;
    expect(duration).toBeLessThan(5_000);
    expect(bodyCancelled).toBe(true);
    expect(await harness.context.storage.get('job:terminated')).toBe(true);
    expect(harness.destroys).toBe(1);
    db.sqlite.close();
  });

  it('repairs cancellation racing a transient Container response without rescheduling terminal work', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    const db = seedJob('do_cancel_race');
    let release!: (response: Response) => void;
    let requested!: () => void;
    const started = new Promise<void>((resolve) => { requested = resolve; });
    let fetches = 0;
    const harness = makeDo('do_cancel_race', db.d1, async (request) => {
      if (new URL(request.url).pathname !== '/session') return Response.json({ schemaVersion: 1, cancelled: true });
      fetches += 1;
      requested();
      return new Promise<Response>((resolve) => { release = resolve; });
    });
    await harness.container.startJob({ jobId: 'do_cancel_race', profileId: 'free' });
    const run = runSchedule(harness);
    await started;
    await harness.store.cancelJob('do_cancel_race', 'own_do_cancel_race', new Date().toISOString());
    const termination = harness.container.terminateJob();
    await vi.advanceTimersByTimeAsync(5_000);
    await termination;
    release(new Response('ordinary busy', { status: 503 }));
    await run;
    expect(fetches).toBe(1);
    expect(control(harness).phase).toBe('terminal');
    expect(harness.schedules.filter((row) => row.callback === RUN_CALLBACK || row.callback === RECOVERY_CALLBACK)).toHaveLength(0);
    db.sqlite.close();
  });
});
