import { FreeJobContainer, getJobContainer } from '../../src/jobContainers';
import { JOB_PROFILES } from '../../src/jobConfig';
import { EXPECTED_IDENTITY, legalMoves } from '../../src/contract';
import { D1RawDb, JobStore } from '../../src/jobStore';

const sessionCounts = new Map();
const cancelCounts = new Map();
const requestedCursors = new Map();

function resultFor(position, conditions) {
  const moves = legalMoves(position.sfen);
  const multiPV = Math.min(conditions.multiPV, moves.length);
  return {
    schemaVersion: 1,
    sfen: position.sfen,
    perspective: 'sente',
    status: 'success',
    terminal: null,
    candidates: moves.slice(0, multiPV).map((move, index) => ({
      move, pv: [move], score: { kind: 'cp', value: 12 - index },
    })),
    meta: { nodes: 1200, completedDepth: 6, elapsedMs: 200 },
    conditions: { requested: conditions, actual: { ...conditions, multiPV } },
    identity: EXPECTED_IDENTITY,
  };
}

function makeNativeContainer(jobId) {
  let running = true;
  return {
    get running() { return running; },
    start() { running = true; },
    monitor() { return new Promise(() => {}); },
    async destroy() { running = false; },
    async stop() { running = false; },
    signal() { running = false; },
    getTcpPort() {
      return {
        async fetch(url, request) {
          if (!(request instanceof Request)) return new Response('ready');
          const pathname = new URL(request.url ?? url).pathname;
          if (pathname === '/session/cancel') {
            cancelCounts.set(jobId, (cancelCounts.get(jobId) ?? 0) + 1);
            return Response.json({ schemaVersion: 1, cancelled: true });
          }
          const body = await request.json();
          const count = (sessionCounts.get(jobId) ?? 0) + 1;
          sessionCounts.set(jobId, count);
          const cursors = requestedCursors.get(jobId) ?? [];
          cursors.push(body.positions.map((position) => position.ply));
          requestedCursors.set(jobId, cursors);
          const encoder = new TextEncoder();
          const lines = [{
            type: 'session', contract: 'analysis-session-v1', profileId: 'free', engineLaunch: 1,
            driverBootId: '1'.repeat(32), sessionId: 'a'.repeat(32),
            identity: EXPECTED_IDENTITY, conditions: JOB_PROFILES.free.conditions,
          }];
          const firstAttempt = count === 1;
          const firstAttemptStalls = firstAttempt
            && (jobId === 'job-49-cancel' || jobId === 'job-49-running-stream' || jobId === 'job-49-running-replay');
          const positions = firstAttempt ? body.positions.slice(0, 1) : body.positions;
          for (const position of positions) {
            lines.push({ type: 'result', ply: position.ply, engineLaunch: 1, result: resultFor(position, JOB_PROFILES.free.conditions) });
          }
          if (firstAttemptStalls) {
            // Leave the body open to exercise terminateJob's active stream abort.
          } else if (firstAttempt) lines.push({ type: 'end', reason: 'error' });
          else lines.push({ type: 'end', reason: 'complete' });
          let index = 0;
          let closed = false;
          return new Response(new ReadableStream({
            start(controller) {
              const sendNext = () => {
                if (request.signal.aborted) {
                  closed = true;
                  controller.error(request.signal.reason ?? new DOMException('Aborted', 'AbortError'));
                  return;
                }
                if (index >= lines.length || (firstAttemptStalls && index >= 2)) {
                  if (!firstAttemptStalls) {
                    closed = true;
                    controller.close();
                  }
                  return;
                }
                controller.enqueue(encoder.encode(JSON.stringify(lines[index++]) + '\n'));
                if (!firstAttemptStalls || index < 2) setTimeout(sendNext, 2);
              };
              request.signal.addEventListener('abort', () => {
                if (!closed) {
                  closed = true;
                  controller.error(request.signal.reason ?? new DOMException('Aborted', 'AbortError'));
                }
              }, { once: true });
              sendNext();
            },
            cancel() { closed = true; },
          }), { headers: { 'content-type': 'application/x-ndjson' } });
        },
      };
    },
  };
}

export class WorkerdFreeJobContainer extends FreeJobContainer {
  constructor(ctx, env) {
    Object.defineProperty(ctx, 'container', { value: makeNativeContainer(ctx.id.name), configurable: true });
    super(ctx, env);
  }

  async inspectJob() {
    return {
      control: await this.doState.storage.get('job:control') ?? null,
      terminated: await this.doState.storage.get('job:terminated') ?? false,
      inFlightFetches: this.inFlightFetches.size,
      activeRun: this.activeRun ? { generation: this.activeRun.generation, runId: this.activeRun.runId } : null,
      runSchedules: await this.listSchedules('runScheduledSlice'),
      recoverySchedules: await this.listSchedules('recoverScheduledSlice'),
    };
  }

  async forceRecovery() {
    const control = await this.doState.storage.get('job:control');
    if (!control || !control.runId) return { accepted: false };
    await this.recoverScheduledSlice({ schemaVersion: 1, generation: control.generation, runId: control.runId });
    return { accepted: true, generation: control.generation };
  }

  async replayRunCallback() {
    const control = await this.doState.storage.get('job:control');
    if (!control || !control.runId) return { accepted: false };
    await this.runScheduledSlice({ schemaVersion: 1, generation: control.generation, runId: control.runId });
    return { accepted: true, generation: control.generation };
  }

  async releaseActiveStreamForTest() {
    const active = this.activeRun;
    if (!active) return { released: false };
    active.controller.abort(new DOMException('Simulated workerd instance loss.', 'AbortError'));
    const deadline = Date.now() + 5_000;
    while (this.activeRun?.runId === active.runId && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return { released: this.activeRun?.runId !== active.runId };
  }
}

function storeFor(env) {
  return new JobStore(new D1RawDb(env.JOBS_DB));
}

function stubFor(env, jobId) {
  return getJobContainer(env, jobId, 'free');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const jobId = url.searchParams.get('job') ?? 'job-49-workerd';
    const stub = stubFor(env, jobId);
    if (url.pathname === '/start') return Response.json(await stub.startJob({ jobId, profileId: 'free' }));
    if (url.pathname === '/inspect') return Response.json(await stub.inspectJob());
    if (url.pathname === '/recover') return Response.json(await stub.forceRecovery());
    if (url.pathname === '/replay-run-callback') return Response.json(await stub.replayRunCallback());
    if (url.pathname === '/release-stream') return Response.json(await stub.releaseActiveStreamForTest());
    if (url.pathname === '/request-cursors') return Response.json(requestedCursors.get(jobId) ?? []);
    if (url.pathname === '/terminate') {
      const store = storeFor(env);
      await store.cancelJob(jobId, 'own_workerd', new Date().toISOString());
      const started = Date.now();
      await stub.terminateJob();
      return Response.json({ durationMs: Date.now() - started, cancelCount: cancelCounts.get(jobId) ?? 0 });
    }
    const row = await storeFor(env).jobById(jobId);
    if (url.pathname === '/job') return Response.json(row);
    if (url.pathname === '/result-count') return Response.json({ count: (await storeFor(env).resultsPage(jobId, -1, 100)).length });
    if (url.pathname === '/result-plies') {
      const results = await storeFor(env).resultsPage(jobId, -1, 100);
      return Response.json(results.map((result) => result.ply));
    }
    return new Response('not found', { status: 404 });
  },
};
