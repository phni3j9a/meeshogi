import type {
  CloudJobServerStatus,
  CloudJobView,
  CloudResultsPage,
} from './contract';

/** Typed failure of a `/v1` call. `status === 0` means no HTTP response arrived. */
export class CloudApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'CloudApiError';
    this.status = status;
    this.code = code;
  }
}

export interface CloudCredential {
  credential: string;
  ownerId: string;
  installId: string;
  endpoint: string;
  issuedAt: string;
}

export interface CloudClient {
  createCredential(): Promise<{ credential: string; ownerId: string; createdAt: string }>;
  createJob(
    credential: string,
    body: { idempotencyKey: string; profileId: string; initialSfen: string; moves: string[] },
  ): Promise<CloudJobView>;
  getJob(credential: string, jobId: string): Promise<CloudJobView>;
  getResults(
    credential: string,
    jobId: string,
    afterPly: number,
    limit: number,
  ): Promise<CloudResultsPage>;
  cancelJob(credential: string, jobId: string): Promise<CloudJobView & { cancelled: boolean }>;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const integer = (value: unknown): value is number => Number.isSafeInteger(value);
const JOB_STATUSES: CloudJobServerStatus[] = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
];

function decodeJobView(value: unknown): CloudJobView {
  if (
    !object(value) ||
    !string(value.jobId) ||
    !JOB_STATUSES.includes(value.status as CloudJobServerStatus) ||
    typeof value.profileId !== 'string' ||
    !integer(value.totalPlies) ||
    !integer(value.nextPly) ||
    !object(value.resultCounts) ||
    !string(value.createdAt) ||
    !string(value.updatedAt)
  ) {
    throw new CloudApiError(0, 'invalid_response', 'Cloud応答の形式が不正です。');
  }
  const counts: Record<string, number> = {};
  for (const [key, count] of Object.entries(value.resultCounts)) {
    if (integer(count)) counts[key] = count;
  }
  const failure = object(value.failure) ? value.failure : undefined;
  return {
    jobId: value.jobId,
    status: value.status as CloudJobServerStatus,
    profileId: value.profileId,
    totalPlies: value.totalPlies,
    nextPly: value.nextPly,
    resultCounts: counts,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(string(value.finishedAt) ? { finishedAt: value.finishedAt } : {}),
    ...(failure && string(failure.code) && typeof failure.message === 'string'
      ? { failure: { code: failure.code, message: failure.message } }
      : {}),
    ...(value.idempotentReplay === true ? { idempotentReplay: true } : {}),
  };
}

function decodeResultsPage(value: unknown): CloudResultsPage {
  if (
    !object(value) ||
    !string(value.jobId) ||
    !JOB_STATUSES.includes(value.status as CloudJobServerStatus) ||
    !integer(value.totalPlies) ||
    !integer(value.nextPly) ||
    !Array.isArray(value.results) ||
    !integer(value.nextAfterPly) ||
    typeof value.hasMore !== 'boolean'
  ) {
    throw new CloudApiError(0, 'invalid_response', 'Cloud応答の形式が不正です。');
  }
  const results: CloudResultsPage['results'] = value.results.map((row: unknown, index) => {
    if (
      !object(row) ||
      !integer(row.ply) ||
      !string(row.sfen) ||
      !(row.engineLaunch === null || integer(row.engineLaunch)) ||
      !object(row.result)
    ) {
      throw new CloudApiError(0, 'invalid_response', `Cloud結果 ${index} 行目の形式が不正です。`);
    }
    return {
      ply: row.ply,
      sfen: row.sfen,
      engineLaunch: row.engineLaunch as number | null,
      result: row.result,
    };
  });
  return {
    jobId: value.jobId,
    status: value.status as CloudJobServerStatus,
    totalPlies: value.totalPlies,
    nextPly: value.nextPly,
    results,
    nextAfterPly: value.nextAfterPly,
    hasMore: value.hasMore,
  };
}

export function makeCloudClient(
  endpoint: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 30_000,
): CloudClient {
  const base = endpoint.replace(/\/+$/u, '');
  const call = async (
    path: string,
    init: { method: string; credential?: string; json?: unknown },
  ): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: init.method,
        headers: {
          ...(init.credential ? { authorization: `Bearer ${init.credential}` } : {}),
          ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
        signal: controller.signal,
      });
    } catch {
      throw new CloudApiError(0, 'network', 'Cloudサーバーへ接続できませんでした。');
    } finally {
      clearTimeout(timer);
    }
    let payload: unknown;
    const text = await response.text();
    if (text.length) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new CloudApiError(
          response.status,
          'invalid_response',
          'Cloud応答をJSONとして読めませんでした。',
        );
      }
    }
    if (!response.ok) {
      const failure = object(payload) && object(payload.failure) ? payload.failure : null;
      throw new CloudApiError(
        response.status,
        failure && string(failure.code) ? failure.code : 'http_error',
        failure && string(failure.message)
          ? failure.message
          : `Cloudサーバーがエラーを返しました（${response.status}）。`,
      );
    }
    return payload;
  };
  return {
    async createCredential() {
      const payload = await call('/v1/credentials', { method: 'POST' });
      if (!object(payload) || !string(payload.credential) || !string(payload.ownerId)) {
        throw new CloudApiError(0, 'invalid_response', 'Cloud応答の形式が不正です。');
      }
      return {
        credential: payload.credential,
        ownerId: payload.ownerId,
        createdAt: string(payload.createdAt) ? payload.createdAt : new Date().toISOString(),
      };
    },
    async createJob(credential, body) {
      const payload = await call('/v1/jobs', { method: 'POST', credential, json: body });
      return decodeJobView(payload);
    },
    async getJob(credential, jobId) {
      return decodeJobView(await call(`/v1/jobs/${jobId}`, { method: 'GET', credential }));
    },
    async getResults(credential, jobId, afterPly, limit) {
      return decodeResultsPage(
        await call(`/v1/jobs/${jobId}/results?afterPly=${afterPly}&limit=${limit}`, {
          method: 'GET',
          credential,
        }),
      );
    },
    async cancelJob(credential, jobId) {
      const payload = await call(`/v1/jobs/${jobId}/cancel`, {
        method: 'POST',
        credential,
        json: {},
      });
      const view = decodeJobView(payload);
      return { ...view, cancelled: (payload as Record<string, unknown>).cancelled === true };
    },
  };
}
