// Exercise the installed Containers SDK and production consumer in workerd.
// Only the TCP transport and persistence are substituted; no private engine is used.
import { FreeJobContainer } from '../../src/jobContainers';
import { runSession } from '../../src/jobConsumer';
import { JOB_PROFILES } from '../../src/jobConfig';
import { EXPECTED_IDENTITY } from '../../src/contract';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default {
  async fetch(request, env, ctx) {
    const mode = new URL(request.url).pathname.slice(1);
    const container = Object.create(FreeJobContainer.prototype);
    Object.assign(container, {
      defaultPort: 8080, sleepAfter: '5m', inflightRequests: 0, sleepAfterMs: 0,
      terminationRequested: false, inFlightFetches: new Set(), ctx: { storage: { get: async () => undefined } },
    });
    container.state = { getState: async () => ({ status: 'healthy' }) };
    let sourceCancelled = false;
    let sourceAborted = false;
    let sourceClosed = false;
    let signalAborted = false;
    const cancelBodies = [];
    const background = [];
    const header = {
      type: 'session', contract: 'analysis-session-v1', profileId: 'free', engineLaunch: 1,
      driverBootId: '1'.repeat(32), identity: EXPECTED_IDENTITY, conditions: JOB_PROFILES.free.conditions,
    };
    container.container = {
      running: true,
      getTcpPort: () => ({
        fetch: async (_url, request) => {
          request.signal.addEventListener('abort', () => { signalAborted = true; });
          if (new URL(request.url).pathname === '/session/cancel') {
            cancelBodies.push(await request.json());
            return Response.json({ schemaVersion: 1, cancelled: true });
          }
          if (mode.startsWith('http_')) {
            return fetch(`${env.HTTP_ORIGIN}/${mode}`, request);
          }
          if (mode === 'transport_error') throw new Error('transport failed');
          if (mode === 'abort_headers') {
            return await new Promise((_resolve, reject) => {
              request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
            });
          }
          if (mode === 'late_headers') await wait(100); // Deliberately ignores abort.
          return new Response(new ReadableStream({
            start(controller) {
              // Real fetch aborts the response body with its request signal.
              // Late-header mode intentionally ignores it to exercise ownership
              // when a response arrives after abort already happened.
              request.signal.addEventListener('abort', () => {
                if (!sourceClosed && !sourceCancelled) {
                  sourceAborted = true;
                  controller.error(request.signal.reason);
                }
              }, { once: true });
              const first = mode === 'invalid_header' ? {}
                : mode === 'cancel_after_header' ? { ...header, sessionId: 'f'.repeat(32) } : header;
              controller.enqueue(new TextEncoder().encode(JSON.stringify(first) + '\n'));
              if (mode !== 'stalled_body' && mode !== 'cancel_after_header') {
                controller.enqueue(new TextEncoder().encode('{"type":"end","reason":"complete","analyzed":0}\n'));
              }
              if (mode === 'normal_end') { sourceClosed = true; controller.close(); }
            },
            cancel() { sourceCancelled = true; },
          }), { status: mode === 'error_body' ? 503 : 200 });
        },
      }),
    };
    const ns = { idFromName: () => 'probe', get: () => container };
    const expiresSoon = ['late_headers', 'abort_headers', 'stalled_body', 'http_stalled_body', 'cancel_after_header'].includes(mode);
    const outcome = await runSession(
      {
        ANALYSIS_CONTAINER: ns,
        ANALYSIS_BENCHMARK_STANDARD_3: ns,
        JOB_FREE_CONTAINER: ns,
        JOB_PRECISION_CONTAINER: ns,
      }, {}, { profile_id: 'free' },
      JOB_PROFILES.free, [], Date.now() + (expiresSoon ? 20 : 2000), () => Date.now(),
      { waitUntil: (task) => { background.push(task); ctx.waitUntil(task); }, sessionCancelTimeoutMs: 500 },
    );
    await Promise.all(background);
    await wait(30); // Let the SDK's response pipe settle after cancellation.
    container.sleepAfterMs = Date.now() - 1;
    return Response.json({
      outcome: outcome.kind, inflightRequests: container.inflightRequests,
      expired: container.isActivityExpired(), sourceCancelled, sourceAborted, signalAborted,
      trackedResponses: background.length, cancelBodies,
    });
  },
};
