import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { Position } from 'tsshogi';

const SFEN = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
function sfenAfter(moves: string[]): string {
  const position = Position.newBySFEN(SFEN);
  if (!position) throw new Error('invalid_fixture_sfen');
  for (const usi of moves) {
    const move = position.createMoveByUSI(usi);
    if (!move || !position.isValidMove(move) || !position.doMove(move)) throw new Error(`illegal_fixture_move:${usi}`);
  }
  return position.sfen;
}
const timeoutRequests = new Set([
  sfenAfter(['2g2f']),
  sfenAfter(['6g6f']), sfenAfter(['6g6f', '3c3d']), sfenAfter(['6g6f', '3c3d', '2g2f']),
]);
const retryOnceRequests = new Set([sfenAfter(['3g3f', '8c8d'])]);
const slowRequests = new Set([
  sfenAfter(['7g7f']), sfenAfter(['5g5f', '4c4d']), sfenAfter(['9g9f', '1c1d']),
]);
const busyRequests = new Set([sfenAfter(['8g8f'])]);
const protocolRequests = new Set([sfenAfter(['7g7f', '8c8d'])]);
const incompleteRequests = new Set([sfenAfter(['7g7f', '3c3d'])]);
const mateRequests = new Set([sfenAfter(['4g4f', '5c5d'])]);
const transientAttempts = new Map<string, number>();
const moves = ['7g7f', '2g2f', '3g3f'];

async function analysisEngine(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === '/__destroy') return Response.json({ destroyed: true });
  if (path === '/stop') return Response.json({ stopped: true });
  if (path === '/prove') return Response.json({ result: 'not-mate', nodesUsed: 1, plies: 3, budget: 10_000, budgetVersion: 'sekirei-proof-ops-v1' });
  const input = await request.json() as {
    sfen: string; movetime_ms: number; multipv: number; threads: number; hash_mb: number;
  };
  const expected = input.multipv === 3
    ? { movetime_ms: 2000, threads: 2, hash_mb: 256 }
    : { movetime_ms: 1000, threads: 1, hash_mb: 256 };
  if (
    input.movetime_ms !== expected.movetime_ms || input.threads !== expected.threads || input.hash_mb !== expected.hash_mb
  ) throw new Error('unexpected_server_profile');
  if (timeoutRequests.has(input.sfen)) {
    return Response.json({ reason: 'engine_timeout' }, { status: 503 });
  }
  if (protocolRequests.has(input.sfen)) return Response.json({ reason: 'illegal_pv' }, { status: 502 });
  if (incompleteRequests.has(input.sfen)) return Response.json({
    contractVersion: 3,
    engineId: 'YaneuraOu NNUE 9.70git 64AVX2',
    sfen: input.sfen,
    candidates: [],
    actualNodes: 0,
    completedDepth: 0,
    elapsedMs: 10,
    terminal: 'incomplete',
    requestedMultiPv: input.multipv,
    effectiveMultiPv: input.multipv,
    rootLegalMoveCount: 30,
    engineEpoch: 'synthetic-engine-epoch',
    restartCount: 0,
    processId: 1,
    engineBestmove: '7g7f',
    stats: { engineCpuMs: 10 },
  });
  if (retryOnceRequests.has(input.sfen)) {
    const attempts = (transientAttempts.get(input.sfen) ?? 0) + 1;
    transientAttempts.set(input.sfen, attempts);
    if (attempts === 1) return Response.json({ reason: 'engine_exit' }, { status: 503 });
  }
  if (slowRequests.has(input.sfen)) await new Promise((resolve) => setTimeout(resolve, 250));
  if (busyRequests.has(input.sfen)) await new Promise((resolve) => setTimeout(resolve, 1500));
  const mate = mateRequests.has(input.sfen);
  const candidates = moves.slice(0, input.multipv).map((move, index) => ({
    move,
    pvUsi: [move, ...(index === 0 ? ['3c3d'] : [])],
    depth: 5,
    ...(mate && index === 0 ? { scoreMate: 3, mateSign: 'sente' } : { scoreCp: 10 + index }),
  }));
  return Response.json({
    contractVersion: 3,
    engineId: 'YaneuraOu NNUE 9.70git 64AVX2',
    sfen: input.sfen,
    candidates,
    actualNodes: 100,
    completedDepth: 5,
    elapsedMs: 25,
    terminal: mate ? 'mate' : 'ok',
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

function profileEngine(vcpu: number): (request: Request) => Promise<Response> {
  return async (request) => {
    const response = await analysisEngine(request);
    if (!response.ok) return response;
    const body = await response.json() as Record<string, unknown>;
    const stats = body.stats && typeof body.stats === 'object' ? body.stats as Record<string, unknown> : {};
    return Response.json({ ...body, stats: { ...stats, engineCpuMs: vcpu * 20 } });
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.test.jsonc' },
    remoteBindings: false,
    miniflare: { serviceBindings: { ANALYSIS_ENGINE: profileEngine(1), ANALYSIS_ENGINE_PRECISION: profileEngine(2) } },
  })],
  test: { include: ['test/**/*.test.ts'], maxWorkers: 1, testTimeout: 20_000 },
});
