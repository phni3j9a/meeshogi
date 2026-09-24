import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { Position } from 'tsshogi';

const ARTIFACT_PROVENANCE = {
  engineBinarySha256: 'a'.repeat(64),
  weightSha256: 'b'.repeat(64),
  engineOptionsSha256: 'c'.repeat(64),
  helperBinarySha256: 'd'.repeat(64),
  driverSha256: 'e'.repeat(64),
};

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
const failureSequenceMoves = ['2g2f', '3c3d', '8g8f', '8c8d', '5g5f', '4c4d', '3g3f', '6c6d', '4g4f'];
const persistentFailureRequests = new Set(Array.from({ length: 5 }, (_, index) =>
  sfenAfter(failureSequenceMoves.slice(0, index * 2 + 1)),
));
const retryOnceRequests = new Set([sfenAfter(['3g3f', '8c8d'])]);
const destroyDuringRequests = new Set([sfenAfter(['4g4f'])]);
const slowRequests = new Set([
  sfenAfter(['7g7f']), sfenAfter(['5g5f', '4c4d']), sfenAfter(['9g9f', '1c1d']),
]);
const busyRequests = new Set([sfenAfter(['8g8f'])]);
const protocolRequests = new Set([sfenAfter(['7g7f', '8c8d'])]);
const incompleteRequests = new Set([sfenAfter(['7g7f', '3c3d'])]);
const terminalRequests = new Map<string, 'no_legal_moves' | 'none' | 'win' | 'resign'>([
  [sfenAfter(['1g1f']), 'no_legal_moves'],
  [sfenAfter(['1g1f', '9c9d']), 'none'],
  [sfenAfter(['1g1f', '9c9d', '2g2f']), 'win'],
  [sfenAfter(['1g1f', '9c9d', '2g2f', '8c8d']), 'resign'],
]);
const mateRequests = new Set([sfenAfter(['4g4f', '5c5d'])]);
const transientAttempts = new Map<string, number>();
const transportLossRequests = new Set([sfenAfter(['6g6f', '1c1d'])]);
const transportLossAttempts = new Map<string, number>();
let activeSearch: { fence: string; destroyed: boolean; release: () => void } | null = null;
let runtimeMismatch = false;
const moves = ['7g7f', '2g2f', '3g3f'];

async function analysisEngine(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === '/__destroy') {
    if (activeSearch) {
      activeSearch.destroyed = true;
      activeSearch.release();
    }
    return Response.json({ destroyed: true });
  }
  if (path === '/__runtime-mismatch/on') { runtimeMismatch = true; return Response.json({ enabled: true }); }
  if (path === '/__runtime-mismatch/off' || path === '/__reset') { runtimeMismatch = false; activeSearch = null; return Response.json({ enabled: false }); }
  if (path === '/health') return Response.json({
    ready: true,
    engineId: 'YaneuraOu NNUE 9.70git 64AVX2',
    artifactProvenance: runtimeMismatch
      ? { ...ARTIFACT_PROVENANCE, helperBinarySha256: 'f'.repeat(64) }
      : ARTIFACT_PROVENANCE,
    activeFence: activeSearch?.fence ?? null,
    searchStarted: activeSearch !== null,
  });
  if (path === '/stop') return Response.json({ stopped: true });
  if (path === '/prove') {
    const proofRequest = await request.json() as { sfen: string; budget: number };
    if (proofRequest.sfen === SFEN) await new Promise((resolve) => setTimeout(resolve, 10));
    return Response.json(proofRequest.sfen === SFEN
      ? { result: 'proven', plies: 1, line: ['7g7f'], nodesUsed: 2, budget: proofRequest.budget, budgetVersion: 'sekirei-proof-ops-v2' }
      : { result: 'not-mate', plies: null, line: null, nodesUsed: 1, budget: proofRequest.budget, budgetVersion: 'sekirei-proof-ops-v2' });
  }
  const input = await request.json() as {
    sfen: string; movetime_ms: number; multipv: number; threads: number; hash_mb: number; fence?: string;
  };
  const expected = input.multipv === 3
    ? { movetime_ms: 2000, threads: 2, hash_mb: 256 }
    : { movetime_ms: 1000, threads: 1, hash_mb: 256 };
  if (
    input.movetime_ms !== expected.movetime_ms || input.threads !== expected.threads || input.hash_mb !== expected.hash_mb
  ) throw new Error('unexpected_server_profile');
  if (transportLossRequests.has(input.sfen)) {
    transportLossAttempts.set(input.sfen, (transportLossAttempts.get(input.sfen) ?? 0) + 1);
    return Response.json({ reason: 'driver_transport_uncertain' }, { status: 503 });
  }
  if (persistentFailureRequests.has(input.sfen) || timeoutRequests.has(input.sfen)) return Response.json({
    contractVersion: 3,
    engineId: 'YaneuraOu NNUE 9.70git 64AVX2',
    sfen: input.sfen,
    candidates: [],
    actualNodes: 100,
    completedDepth: 0,
    elapsedMs: 25,
    multipv: 0,
    terminal: 'position_failed:engine_timeout',
    requestedMultiPv: input.multipv,
    effectiveMultiPv: input.multipv,
    rootLegalMoveCount: 30,
    completedAt: '2026-09-24T00:00:00.000Z',
    engineEpoch: 'synthetic-engine-epoch',
    restartCount: 0,
    processId: 1,
  });
  if (protocolRequests.has(input.sfen)) return Response.json({ reason: 'illegal_pv' }, { status: 502 });
  const requestedTerminal = terminalRequests.get(input.sfen);
  if (requestedTerminal) {
    const noLegalMove = requestedTerminal === 'no_legal_moves' || requestedTerminal === 'none';
    return Response.json({
      contractVersion: 3,
      engineId: 'YaneuraOu NNUE 9.70git 64AVX2',
      sfen: input.sfen,
      candidates: [],
      actualNodes: 0,
      completedDepth: 0,
      elapsedMs: 10,
      terminal: requestedTerminal,
      requestedMultiPv: input.multipv,
      effectiveMultiPv: noLegalMove ? 0 : input.multipv,
      rootLegalMoveCount: noLegalMove ? 0 : 30,
      ...(requestedTerminal === 'no_legal_moves' ? { terminalDetail: 'no_legal_moves' } : {}),
      ...(requestedTerminal === 'none' ? { terminalDetail: 'checkmate' } : {}),
      ...(requestedTerminal === 'win' ? { terminalDetail: 'declaration_win' } : {}),
      engineEpoch: 'synthetic-engine-epoch',
      restartCount: 0,
      processId: 1,
      stats: { engineCpuMs: 10 },
    });
  }
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
  if (busyRequests.has(input.sfen) || destroyDuringRequests.has(input.sfen)) {
    let release!: () => void;
    const search = { fence: input.fence ?? '', destroyed: false, release: () => release() };
    const destroyed = new Promise<void>((resolve) => { release = resolve; });
    activeSearch = search;
    try {
      await Promise.race([new Promise<void>((resolve) => setTimeout(resolve, 1500)), destroyed]);
      if (search.destroyed) throw new Error('synthetic_search_destroyed');
    } finally {
      if (activeSearch === search) activeSearch = null;
    }
  }
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
    let response: Response;
    try {
      response = await analysisEngine(request);
    } catch {
      return Response.json({ reason: 'driver_transport_uncertain' }, { status: 503 });
    }
    if (!response.ok || new URL(request.url).pathname !== '/analyze') return response;
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
