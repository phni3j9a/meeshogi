import { describe, expect, it, vi } from 'vitest';
vi.mock('@cloudflare/containers', () => ({
  Container: class {},
  getContainer: (binding: { getByName: (name: string) => unknown }, name: string) => binding.getByName(name),
}));
import {
  EXPECTED_IDENTITY,
  SEARCH_CONDITIONS,
  isLegalPv,
  isValidSfen,
  legalMoves,
} from '../src/contract';
import { handleRequest, type Env } from '../src/index';
import { Position } from 'tsshogi';

const STARTPOS = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
const TERMINAL_MATE = '2+Lk1+S3/9/1N1BB4/9/9/9/9/9/4K4 w LP 4';
const TERMINAL_NO_MOVES = 'k8/9/9/9/9/2nn1nn2/9/3p1p3/4K4 b - 1';
const TWO_MOVES = 'k8/9/9/9/9/9/9/8r/4K4 b - 1';
const SYNTHETIC_MIDDLEGAME = '1nrg3n1/l2s2k2/p1p1gp1pl/1p1pp2s1/6P1p/b1P5P/PP1PPP1P1/L1KSRSG2/1NG4NL b BP 1';
const SYNTHETIC_MATE_IN_ONE = '2p2+B2k/1+B3g2p/1P2L1Gpn/p1P2p3/3p2p2/lpG1NP3/P1KP+p3+l/LS1S2SP+n/1NR1S1+pg1 b RPp 1';

function candidate(move: string, nextMove: string, value: number) {
  return { move, pv: [move, nextMove], score: { kind: 'cp', value } };
}

function success(sfen: string, multiPV = Math.min(3, legalMoves(sfen).length)): Record<string, any> {
  const pvs = sfen === STARTPOS
    ? [candidate('7g7f', '3c3d', 42), candidate('2g2f', '8c8d', -15), candidate('6g6f', '4c4d', 7)]
    : sfen === TWO_MOVES
      ? legalMoves(sfen).map((move, index) => ({ move, pv: [move], score: { kind: 'cp', value: index ? -8 : 12 } }))
      : [candidate('5i5h', '9a9b', 12), candidate('5i4h', '9a9b', -8)];
  return {
    schemaVersion: 1,
    sfen,
    perspective: 'sente',
    status: 'success',
    terminal: null,
    candidates: pvs.slice(0, multiPV),
    meta: { nodes: 1200, completedDepth: 8, elapsedMs: 1500 },
    conditions: {
      requested: SEARCH_CONDITIONS,
      actual: { ...SEARCH_CONDITIONS, multiPV },
    },
    identity: EXPECTED_IDENTITY,
  };
}

function makeEnv(response?: (payload: unknown) => unknown, token?: string): Env & { calls: number[] } {
  const calls: number[] = [];
  const binding = {
    getByName: () => ({
      fetch: async (request: Request) => {
        calls.push(1);
        const payload = await request.json();
        return Response.json(response ? response(payload) : success((payload as { sfen: string }).sfen));
      },
    }),
  };
  return {
    ANALYSIS_INTERNAL_TOKEN: token,
    ANALYSIS_CONTAINER: binding as unknown as Env['ANALYSIS_CONTAINER'],
    calls,
  };
}

function request(body: string, options: { token?: string; contentType?: string; method?: string } = {}) {
  const headers = new Headers();
  if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`);
  if (options.contentType !== undefined) headers.set('content-type', options.contentType);
  return new Request('https://staging.example/internal/analyze', {
    method: options.method ?? 'POST',
    headers,
    body,
  });
}

async function result(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describe('staging analysis Worker boundary', () => {
  it('requires a configured bearer secret and never calls the Container on auth failure', async () => {
    const env = makeEnv(undefined, 'secret-token');
    const missing = await handleRequest(request(JSON.stringify({ sfen: STARTPOS })), env);
    const wrong = await handleRequest(request(JSON.stringify({ sfen: STARTPOS }), { token: 'wrong' }), env);
    const unsetEnv = makeEnv(undefined, undefined);
    const unset = await handleRequest(request(JSON.stringify({ sfen: STARTPOS }), { token: 'secret-token' }), unsetEnv);

    expect(missing.status).toBe(401);
    expect((await result(missing)).failure).toMatchObject({ code: 'unauthorized' });
    expect(wrong.status).toBe(401);
    expect((await result(wrong)).failure).toMatchObject({ code: 'unauthorized' });
    expect(unset.status).toBe(503);
    expect((await result(unset)).failure).toMatchObject({ code: 'auth_unconfigured' });
    expect(env.calls).toHaveLength(0);
    expect(unsetEnv.calls).toHaveLength(0);
  });

  it('rejects invalid JSON, oversized bodies, extra fields, bad SFEN, newlines, and control characters', async () => {
    const env = makeEnv(undefined, 'secret-token');
    const invalidJson = await handleRequest(request('{', { token: 'secret-token', contentType: 'application/json' }), env);
    const oversized = await handleRequest(
      request(JSON.stringify({ sfen: STARTPOS }) + ' '.repeat(1100), { token: 'secret-token', contentType: 'application/json' }),
      env,
    );
    const extra = await handleRequest(
      request(JSON.stringify({ sfen: STARTPOS, command: 'quit' }), { token: 'secret-token', contentType: 'application/json' }),
      env,
    );
    const malformed = await handleRequest(
      request(JSON.stringify({ sfen: 'not sfen' }), { token: 'secret-token', contentType: 'application/json' }),
      env,
    );
    const newline = await handleRequest(
      request(JSON.stringify({ sfen: `${STARTPOS}\nquit` }), { token: 'secret-token', contentType: 'application/json' }),
      env,
    );
    const control = await handleRequest(
      request(JSON.stringify({ sfen: `${STARTPOS}\u0001` }), { token: 'secret-token', contentType: 'application/json' }),
      env,
    );

    for (const response of [invalidJson, oversized, extra, malformed, newline, control]) {
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(env.calls).toHaveLength(0);
    expect(isValidSfen(STARTPOS)).toBe(true);
    expect(isValidSfen(`${STARTPOS}\r\n`)).toBe(false);
  });

  it('distinguishes checkmate and no-legal-moves without starting engine work', async () => {
    const env = makeEnv(undefined, 'secret-token');
    const checkmate = await handleRequest(
      request(JSON.stringify({ sfen: TERMINAL_MATE }), { token: 'secret-token', contentType: 'application/json' }),
      env,
    );
    const noMoves = await handleRequest(
      request(JSON.stringify({ sfen: TERMINAL_NO_MOVES }), { token: 'secret-token', contentType: 'application/json' }),
      env,
    );
    expect(checkmate.status).toBe(200);
    expect(await result(checkmate)).toMatchObject({ status: 'terminal', terminal: 'checkmate', candidates: [], meta: { nodes: null, completedDepth: null, elapsedMs: null } });
    expect(noMoves.status).toBe(200);
    expect(await result(noMoves)).toMatchObject({ status: 'terminal', terminal: 'no-legal-moves', candidates: [] });
    expect(env.calls).toHaveLength(0);
  });

  it('keeps the staging middlegame and mate-in-one fixtures legal and public', () => {
    expect(isValidSfen(SYNTHETIC_MIDDLEGAME)).toBe(true);
    expect(legalMoves(SYNTHETIC_MIDDLEGAME).length).toBeGreaterThan(0);
    expect(isValidSfen(SYNTHETIC_MATE_IN_ONE)).toBe(true);
    const matingMoves = legalMoves(SYNTHETIC_MATE_IN_ONE).filter((usi) => {
      const position = Position.newBySFEN(SYNTHETIC_MATE_IN_ONE);
      const move = position?.createMoveByUSI(usi);
      if (!position || !move || !position.isValidMove(move)) return false;
      const after = position.clone();
      if (!after.doMove(move)) return false;
      return after.checked && legalMoves(after.sfen).length === 0;
    });
    expect(matingMoves.length).toBeGreaterThan(0);
  });

  it('caps effective MultiPV to the legal move count and returns only validated lines', async () => {
    const env = makeEnv(undefined, 'secret-token');
    const response = await handleRequest(
      request(JSON.stringify({ sfen: TWO_MOVES }), { token: 'secret-token', contentType: 'application/json' }),
      env,
    );
    expect(response.status).toBe(200);
    expect(legalMoves(TWO_MOVES)).toHaveLength(2);
    expect(env.calls).toHaveLength(1);
    expect(await result(response)).toMatchObject({
      status: 'success',
      candidates: [{ score: { kind: 'cp' } }, { score: { kind: 'cp' } }],
      conditions: { requested: { multiPV: 3 }, actual: { multiPV: 2 } },
    });
  });

  it('accepts sente-perspective cp and mate scores but rejects an illegal PV', async () => {
    const mateResult = success(STARTPOS);
    mateResult.candidates[0] = {
      move: '7g7f',
      pv: ['7g7f', '3c3d'],
      score: { kind: 'mate', value: 5, winningSide: 'sente' },
    };
    const mateEnv = makeEnv(() => mateResult, 'secret-token');
    const mate = await handleRequest(
      request(JSON.stringify({ sfen: STARTPOS }), { token: 'secret-token', contentType: 'application/json' }),
      mateEnv,
    );
    expect(mate.status).toBe(200);
    expect(((await result(mate)).candidates as Array<Record<string, unknown>>)[0]).toMatchObject({
      score: { kind: 'mate', value: 5, winningSide: 'sente' },
    });

    const illegalResult = success(STARTPOS);
    illegalResult.candidates[0] = candidate('7g7f', '9a8b', 1);
    const illegalEnv = makeEnv(() => illegalResult, 'secret-token');
    const illegal = await handleRequest(
      request(JSON.stringify({ sfen: STARTPOS }), { token: 'secret-token', contentType: 'application/json' }),
      illegalEnv,
    );
    expect(illegal.status).toBe(502);
    expect((await result(illegal)).failure).toMatchObject({ code: 'engine_error' });
    expect(isLegalPv(STARTPOS, ['7g7f', '3c3d'])).toBe(true);
    expect(isLegalPv(STARTPOS, ['7g7f', '9a8b'])).toBe(false);
  });

  it('fails closed when the image identity differs from the expected manifest', async () => {
    const mismatched = success(STARTPOS);
    mismatched.identity = { ...EXPECTED_IDENTITY, weightSha256: '0'.repeat(64) } as unknown as typeof EXPECTED_IDENTITY;
    const env = makeEnv(() => mismatched, 'secret-token');
    const response = await handleRequest(
      request(JSON.stringify({ sfen: STARTPOS }), { token: 'secret-token', contentType: 'application/json' }),
      env,
    );
    expect(response.status).toBe(502);
    expect((await result(response)).failure).toMatchObject({ code: 'engine_error' });
  });

  it.each([
    ['busy', 409],
    ['timeout', 504],
  ] as const)('keeps the %s failure typed at the Worker boundary', async (code, status) => {
    const downstream = {
      schemaVersion: 1,
      sfen: STARTPOS,
      perspective: 'sente',
      status: 'failure',
      failure: { code, message: `synthetic ${code}` },
      identity: EXPECTED_IDENTITY,
    };
    const env = makeEnv(() => downstream, 'secret-token');
    const response = await handleRequest(
      request(JSON.stringify({ sfen: STARTPOS }), { token: 'secret-token', contentType: 'application/json' }),
      env,
    );
    expect(response.status).toBe(status);
    expect((await result(response)).failure).toMatchObject({ code });
  });

  it('does not expose the analysis route through another path or method', async () => {
    const env = makeEnv(undefined, 'secret-token');
    const wrongPath = await handleRequest(new Request('https://staging.example/debug'), env);
    const wrongMethod = await handleRequest(new Request('https://staging.example/internal/analyze', { method: 'GET' }), env);
    expect(wrongPath.status).toBe(404);
    expect(wrongMethod.status).toBe(405);
    expect(env.calls).toHaveLength(0);
  });
});
