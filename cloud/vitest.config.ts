import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

const timeoutRequests = new Set([77, 900]);
const retryOnceRequests = new Set([901]);
const slowRequests = new Set([902]);
const transientAttempts = new Map<string, number>();
const moves = ['7g7f', '2g2f', '3g3f'];

async function analysisEngine(request: Request): Promise<Response> {
  const input = await request.json() as {
    sfen: string; movetime_ms: number; multipv: number; threads: number; hash_mb: number;
  };
  const expected = input.multipv === 3
    ? { movetime_ms: 2000, threads: 2, hash_mb: 256 }
    : { movetime_ms: 1000, threads: 1, hash_mb: 256 };
  if (
    input.movetime_ms !== expected.movetime_ms || input.threads !== expected.threads || input.hash_mb !== expected.hash_mb
  ) throw new Error('unexpected_server_profile');
  const moveNumber = Number(input.sfen.split(' ').at(-1));
  if (timeoutRequests.has(moveNumber)) {
    return Response.json({ reason: 'engine_timeout' }, { status: 503 });
  }
  if (retryOnceRequests.has(moveNumber)) {
    const attempts = (transientAttempts.get(input.sfen) ?? 0) + 1;
    transientAttempts.set(input.sfen, attempts);
    if (attempts === 1) throw new Error('synthetic_transport_reset');
  }
  if (slowRequests.has(moveNumber)) await new Promise((resolve) => setTimeout(resolve, 250));
  const candidates = moves.slice(0, input.multipv).map((move, index) => ({
    move,
    pvUsi: [move, ...(index === 0 ? ['3c3d'] : [])],
    depth: 5,
    scoreCp: 10 + index,
  }));
  return Response.json({
    contractVersion: 3,
    engineId: 'YaneuraOu NNUE 9.70git 64AVX2',
    sfen: input.sfen,
    candidates,
    actualNodes: 100,
    completedDepth: 5,
    elapsedMs: 25,
    terminal: 'ok',
    requestedMultiPv: input.multipv,
    effectiveMultiPv: input.multipv,
    rootLegalMoveCount: 30,
    engineEpoch: 'synthetic-engine-epoch',
    restartCount: 0,
    processId: 1,
    engineBestmove: '7g7f',
    stats: { engineCpuMs: 20 },
  });
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.test.jsonc' },
    remoteBindings: false,
    miniflare: { serviceBindings: { ANALYSIS_ENGINE: analysisEngine } },
  })],
  test: { include: ['test/**/*.test.ts'], maxWorkers: 1, testTimeout: 20_000 },
});
