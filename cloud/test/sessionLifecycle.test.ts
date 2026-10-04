import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { EXPECTED_IDENTITY } from '../src/contract';
import { JOB_PROFILES } from '../src/jobConfig';

describe('runner response ownership in workerd with the installed Containers SDK', () => {
  let mf: Miniflare;
  let server: Server;
  const closedConnections = new Set<string>();
  beforeAll(async () => {
    server = createServer((request, response) => {
      request.resume();
      response.on('close', () => closedConnections.add(request.url!));
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write(JSON.stringify({
        type: 'session', contract: 'analysis-session-v1', profileId: 'free', engineLaunch: 1,
        driverBootId: '1'.repeat(32), identity: EXPECTED_IDENTITY, conditions: JOB_PROFILES.free.conditions,
      }) + '\n');
      if (request.url === '/http_end_without_eof') {
        response.write('{"type":"end","reason":"complete","analyzed":0}\n');
      }
      // Deliberately leave the HTTP body open. The consumer must close the socket.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const bundled = await build({
      entryPoints: [fileURLToPath(new URL('./fixtures/sessionLifecycle.worker.mjs', import.meta.url))],
      bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022',
      external: ['cloudflare:workers'],
    });
    mf = new Miniflare(convertV4MiniflareOptions({
      workers: [{
        name: 'session-lifecycle', modules: true, script: bundled.outputFiles[0].text,
        compatibilityDate: '2026-09-25', bindings: { HTTP_ORIGIN: origin },
      }],
      port: 0,
    }));
  });
  afterAll(async () => {
    await mf?.dispose();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each([
    ['normal_end', 'resume', false],
    ['end_without_eof', 'resume', true],
    ['late_headers', 'retry', true],
    ['abort_headers', 'retry', false],
    ['stalled_body', 'retry', true],
    ['invalid_header', 'fail', true],
    ['transport_error', 'retry', false],
    ['error_body', 'retry', true],
  ])('%s releases the inflight request and permits idle expiry', async (mode, outcome, bodyAbandoned) => {
    const response = await mf.dispatchFetch(`http://probe/${mode}`);
    expect(response.status).toBe(200);
    const result = await response.json() as { sourceCancelled: boolean; sourceAborted: boolean };
    expect(result).toMatchObject({
      outcome, inflightRequests: 0, expired: true, signalAborted: true, trackedResponses: 1,
    });
    expect(result.sourceCancelled || result.sourceAborted).toBe(bodyAbandoned);
  });

  it('abandons a session after the header and posts its session cancel (Issue #29)', async () => {
    const response = await mf.dispatchFetch('http://probe/cancel_after_header');
    expect(response.status).toBe(200);
    const result = await response.json() as { cancelBodies?: { sessionId?: string }[] };
    expect(result).toMatchObject({
      outcome: 'retry', inflightRequests: 0, expired: true, signalAborted: true, trackedResponses: 2,
    });
    expect(result.cancelBodies).toEqual([{ sessionId: 'f'.repeat(32) }]);
  });

  it.each([
    ['http_end_without_eof', 'resume'],
    ['http_stalled_body', 'retry'],
  ])('%s aborts a real HTTP response and releases the SDK counter', async (mode, outcome) => {
    const response = await mf.dispatchFetch(`http://probe/${mode}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome, inflightRequests: 0, expired: true, signalAborted: true });
    expect(closedConnections.has(`/${mode}`)).toBe(true);
  });
});
