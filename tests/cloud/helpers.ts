import { DatabaseSync } from 'node:sqlite';
import { CloudApiError, type CloudClient } from '../../src/cloud/client';
import {
  CLOUD_EXPECTED_IDENTITY,
  CLOUD_PROFILES,
  type CloudJobView,
  type CloudProfileId,
  type CloudResultsPage,
  type CloudWireRow,
} from '../../src/cloud/contract';
import type { CredentialStore } from '../../src/cloud/credentials';
import { memoryCredentialStore } from '../../src/cloud/credentials';
import { applyUsi, legalMoves } from '../../src/domain';
import { LocalRepository, type Database } from '../../src/storage/repository';
import type { CloudDeps } from '../../src/store/cloud-controller';

export const ENDPOINT = 'https://analysis.test.example';
export const STARTPOS = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
export const TERMINAL_MATE = '2+Lk1+S3/9/1N1BB4/9/9/9/9/9/4K4 w LP 4';
export const TERMINAL_NO_MOVES = 'k8/9/9/9/9/2nn1nn2/9/3p1p3/4K4 b - 1';

export function sqliteDb(path = ':memory:'): { db: DatabaseSync; adapter: Database } {
  const db = new DatabaseSync(path);
  return {
    db,
    adapter: {
      execAsync: async (sql) => {
        db.exec(sql);
      },
      runAsync: async (sql, ...args) => db.prepare(sql).run(...args),
      getAllAsync: async <T>(sql: string, ...args: (string | number | null)[]) =>
        db.prepare(sql).all(...args) as T[],
    },
  };
}

export function openSqliteRepository(adapter: Database) {
  return new LocalRepository(adapter);
}

export interface SuccessOptions {
  scores?: ({ kind: 'cp'; value: number } | { kind: 'mate'; value: number; winningSide: string })[];
  candidateCount?: number;
  moves?: string[]; // explicit candidate move subset (still must be legal)
  pvOverride?: (move: string, index: number) => string[];
}

/** Build a contract-valid v1 success result for a position and profile. */
export function makeSuccessResult(
  sfen: string,
  profileId: CloudProfileId = 'free',
  options: SuccessOptions = {},
) {
  const legal = legalMoves(sfen);
  const count = Math.min(CLOUD_PROFILES[profileId].multiPV, legal.length);
  const moves = options.moves ?? legal.slice(0, options.candidateCount ?? count);
  return {
    schemaVersion: 1,
    sfen,
    perspective: 'sente',
    status: 'success',
    terminal: null,
    candidates: moves.map((move, index) => ({
      move,
      pv: options.pvOverride ? options.pvOverride(move, index) : [move],
      score: options.scores?.[index] ?? { kind: 'cp', value: 25 + index * 10 },
    })),
    meta: { nodes: 100000, completedDepth: 12, elapsedMs: 950 },
    conditions: {
      requested: { ...CLOUD_PROFILES[profileId] },
      actual: { ...CLOUD_PROFILES[profileId], multiPV: count },
    },
    identity: { ...CLOUD_EXPECTED_IDENTITY },
  };
}

export function makeIncompleteResult(sfen: string, profileId: CloudProfileId = 'free') {
  return {
    schemaVersion: 1,
    sfen,
    perspective: 'sente',
    status: 'incomplete',
    terminal: null,
    candidates: [],
    meta: { nodes: 1234, completedDepth: null, elapsedMs: 900 },
    conditions: {
      requested: { ...CLOUD_PROFILES[profileId] },
      actual: {
        ...CLOUD_PROFILES[profileId],
        multiPV: Math.min(CLOUD_PROFILES[profileId].multiPV, legalMoves(sfen).length),
      },
    },
    identity: { ...CLOUD_EXPECTED_IDENTITY },
  };
}

export function makeTerminalResult(
  sfen: string,
  terminal: 'checkmate' | 'no-legal-moves',
  profileId: CloudProfileId = 'free',
) {
  return {
    schemaVersion: 1,
    sfen,
    perspective: 'sente',
    status: 'terminal',
    terminal,
    candidates: [],
    meta: { nodes: null, completedDepth: null, elapsedMs: null },
    conditions: { requested: { ...CLOUD_PROFILES[profileId] }, actual: null },
    identity: { ...CLOUD_EXPECTED_IDENTITY },
  };
}

export function positionsFor(initialSfen: string, moves: string[]): string[] {
  const positions = [initialSfen];
  for (const move of moves) positions.push(applyUsi(positions[positions.length - 1], move));
  return positions;
}

export interface FakeJob {
  jobId: string;
  idempotencyKey: string;
  profileId: CloudProfileId;
  initialSfen: string;
  moves: string[];
  /** Original submit body, for same-key input comparison on replay. */
  request?: { profileId: string; initialSfen: string; moves: string[] };
  totalPlies: number;
  /** Number of positions processed server-side (results visible below this). */
  nextPly: number;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  failure?: { code: string; message: string };
  results: CloudWireRow[];
  /** Simulate server-side processing progress. */
  advance(steps: number): void;
}

export interface FakeCloudOptions {
  credential?: { credential: string; ownerId: string; createdAt: string };
  /** Throw this error on the Nth createJob call (1-based) after recording the job. */
  createJobFailAfterCreate?: number;
  createJobError?: (call: number, body: unknown) => void;
  /** Advance each job's nextPly by this many positions per getJob call. */
  perPollAdvance?: number;
  /** Extra per-call hooks for edge cases. */
  getResultsError?: (call: number) => Error | null;
  cancelJobResult?: (job: FakeJob) => void;
}

export function fakeCloud(options: FakeCloudOptions = {}) {
  const jobs = new Map<string, FakeJob>();
  const calls: { method: string; detail: string }[] = [];
  let jobSeq = 0;
  let createCalls = 0;
  let getResultsCalls = 0;
  let getJobCalls = 0;
  const credential = options.credential ?? {
    credential: 'mcd1_testcredential',
    ownerId: 'own_test',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const findJob = (jobId: string) => {
    const job = [...jobs.values()].find((item) => item.jobId === jobId);
    if (!job) throw new CloudApiError(404, 'not_found', 'job not found');
    return job;
  };
  const view = (job: FakeJob): CloudJobView => ({
    jobId: job.jobId,
    status: job.status,
    profileId: job.profileId,
    totalPlies: job.totalPlies,
    nextPly: job.nextPly,
    resultCounts: {
      success: job.results.filter((row) => (row.result as { status: string }).status === 'success' && row.ply < job.nextPly).length,
      incomplete: job.results.filter((row) => (row.result as { status: string }).status === 'incomplete' && row.ply < job.nextPly).length,
      terminal: job.results.filter((row) => (row.result as { status: string }).status === 'terminal' && row.ply < job.nextPly).length,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...(job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled'
      ? { finishedAt: '2026-01-01T00:01:00.000Z' }
      : {}),
    ...(job.failure ? { failure: job.failure } : {}),
  });
  const client: CloudClient = {
    async createCredential() {
      calls.push({ method: 'createCredential', detail: '' });
      return credential;
    },
    async createJob(_credential, body) {
      createCalls += 1;
      calls.push({ method: 'createJob', detail: body.idempotencyKey });
      options.createJobError?.(createCalls, body);
      const existing = jobs.get(body.idempotencyKey);
      if (existing) {
        // Real backend (cloud/src/jobs.ts): same key + same input replays the
        // existing job with HTTP 200 even after it finished; only a same-key
        // DIFFERENT input is a 409 conflict.
        const sameInput =
          existing.request?.profileId === body.profileId &&
          existing.request?.initialSfen === body.initialSfen &&
          JSON.stringify(existing.request?.moves) === JSON.stringify(body.moves);
        if (!sameInput) {
          throw new CloudApiError(409, 'idempotency_key_in_use', 'different request body');
        }
        return { ...view(existing), idempotentReplay: true };
      }
      const positions = positionsFor(body.initialSfen, body.moves);
      const job: FakeJob = {
        jobId: `job_${++jobSeq}`,
        idempotencyKey: body.idempotencyKey,
        profileId: body.profileId as CloudProfileId,
        initialSfen: body.initialSfen,
        moves: [...body.moves],
        totalPlies: positions.length,
        nextPly: 0,
        status: 'queued',
        request: {
          profileId: body.profileId,
          initialSfen: body.initialSfen,
          moves: [...body.moves],
        },
        results: positions.map((sfen, ply) => ({
          ply,
          sfen,
          engineLaunch: 1,
          result: makeSuccessResult(sfen, body.profileId as CloudProfileId),
        })),
        advance(steps: number) {
          if (
            this.status === 'completed' ||
            this.status === 'cancelled' ||
            this.status === 'failed'
          )
            return;
          this.status = 'running';
          this.nextPly = Math.min(this.totalPlies, this.nextPly + steps);
          if (this.nextPly >= this.totalPlies) this.status = 'completed';
        },
      };
      jobs.set(body.idempotencyKey, job);
      if (options.createJobFailAfterCreate === createCalls) {
        throw new CloudApiError(0, 'network', 'network');
      }
      return view(job);
    },
    async getJob(_credential, jobId) {
      getJobCalls += 1;
      calls.push({ method: 'getJob', detail: jobId });
      const job = findJob(jobId);
      if (options.perPollAdvance) job.advance(options.perPollAdvance);
      return view(job);
    },
    async getResults(_credential, jobId, afterPly, limit) {
      getResultsCalls += 1;
      calls.push({ method: 'getResults', detail: `${jobId}:${afterPly}` });
      const injected = options.getResultsError?.(getResultsCalls);
      if (injected) throw injected;
      const job = findJob(jobId);
      const rows = job.results.filter((row) => row.ply > afterPly && row.ply < job.nextPly);
      const page = rows.slice(0, limit);
      return {
        jobId: job.jobId,
        status: job.status,
        totalPlies: job.totalPlies,
        nextPly: job.nextPly,
        results: page,
        nextAfterPly: page.length ? page[page.length - 1].ply : afterPly,
        hasMore: page.length < rows.length,
      } satisfies CloudResultsPage;
    },
    async cancelJob(_credential, jobId) {
      calls.push({ method: 'cancelJob', detail: jobId });
      const job = findJob(jobId);
      options.cancelJobResult?.(job);
      if (job.status !== 'completed' && job.status !== 'failed') job.status = 'cancelled';
      return { ...view(job), cancelled: true };
    },
  };
  const jobList = () => [...jobs.values()];
  return {
    client,
    calls,
    credential,
    jobs,
    jobList,
    counts: {
      get createJob() {
        return createCalls;
      },
      get getResults() {
        return getResultsCalls;
      },
      get getJob() {
        return getJobCalls;
      },
    },
  };
}

export function makeCloudDeps(
  client: CloudClient,
  credentials: CredentialStore = memoryCredentialStore(),
  overrides: Partial<CloudDeps> = {},
): CloudDeps {
  let idSeq = 0;
  return {
    endpoint: () => ENDPOINT,
    clientFor: () => client,
    credentialsFor: () => credentials,
    createId: () => `test-${++idSeq}`,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 0)),
    nowIso: () => '2026-01-02T00:00:00.000Z',
    pollIntervalMs: 1,
    maxBackoffMs: 4,
    ...overrides,
  };
}
