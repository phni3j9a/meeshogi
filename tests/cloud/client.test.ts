import { describe, expect, it, vi } from 'vitest';
import { CloudApiError, makeCloudClient } from '../../src/cloud/client';
import { ENDPOINT, STARTPOS } from './helpers';

const jobView = {
  jobId: 'job_1',
  status: 'queued',
  profileId: 'free',
  totalPlies: 3,
  nextPly: 0,
  resultCounts: { success: 0, incomplete: 0, terminal: 0 },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function fetchWith(status: number, body: unknown) {
  return vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
}

describe('Cloudクライアント', () => {
  it('Bearer認証とJSON POSTを行う', async () => {
    const f = fetchWith(201, {
      credential: 'mcd1_abc',
      ownerId: 'own_1',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const client = makeCloudClient(ENDPOINT, f);
    const issued = await client.createCredential();
    expect(issued.credential).toBe('mcd1_abc');
    expect(issued.ownerId).toBe('own_1');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${ENDPOINT}/v1/credentials`);
    expect(init.method).toBe('POST');
  });

  it('createJobはidempotencyKeyと棋譜を送り、jobViewを解釈する', async () => {
    const f = fetchWith(201, jobView);
    const client = makeCloudClient(ENDPOINT, f);
    const view = await client.createJob('mcd1_abc', {
      idempotencyKey: 'mk.1',
      profileId: 'free',
      initialSfen: STARTPOS,
      moves: ['7g7f', '3c3d'],
    });
    expect(view.jobId).toBe('job_1');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${ENDPOINT}/v1/jobs`);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer mcd1_abc');
    expect(JSON.parse(init.body as string)).toMatchObject({ idempotencyKey: 'mk.1' });
  });

  it('resultsはafterPly/limitクエリを付ける', async () => {
    const f = fetchWith(200, {
      jobId: 'job_1',
      status: 'running',
      totalPlies: 3,
      nextPly: 1,
      results: [
        { ply: 0, sfen: STARTPOS, engineLaunch: 1, result: { schemaVersion: 1, status: 'success' } },
      ],
      nextAfterPly: 0,
      hasMore: false,
    });
    const client = makeCloudClient(ENDPOINT, f);
    const page = await client.getResults('mcd1_abc', 'job_1', -1, 200);
    expect(page.results).toHaveLength(1);
    const [url] = f.mock.calls[0] as unknown as [string];
    expect(url).toBe(`${ENDPOINT}/v1/jobs/job_1/results?afterPly=-1&limit=200`);
  });

  it('エラー応答をcode付きのCloudApiErrorに変換する', async () => {
    const f = fetchWith(403, {
      schemaVersion: 1,
      status: 'failure',
      failure: { code: 'profile_not_allowed', message: '精密解析は許可されていません。' },
    });
    const client = makeCloudClient(ENDPOINT, f);
    const error = await client.createJob('mcd1_abc', {
      idempotencyKey: 'k',
      profileId: 'precision',
      initialSfen: STARTPOS,
      moves: [],
    }).catch((e) => e);
    expect(error).toBeInstanceOf(CloudApiError);
    expect(error.status).toBe(403);
    expect(error.code).toBe('profile_not_allowed');
    expect(error.message).toContain('精密解析');
  });

  it('ネットワーク障害をstatus=0のエラーにする', async () => {
    const f = vi.fn(async () => {
      throw new Error('offline');
    });
    const client = makeCloudClient(ENDPOINT, f);
    const error = await client.getJob('mcd1_abc', 'job_1').catch((e) => e);
    expect(error.status).toBe(0);
    expect(error.code).toBe('network');
  });

  it('不正JSON・不正jobViewをinvalid_responseにする', async () => {
    const f = fetchWith(200, 'not json');
    const client = makeCloudClient(ENDPOINT, f);
    const error = await client.getJob('mcd1_abc', 'job_1').catch((e) => e);
    expect(error.status).toBe(200);
    expect(error.code).toBe('invalid_response');

    const f2 = fetchWith(200, { jobId: 123 });
    const client2 = makeCloudClient(ENDPOINT, f2);
    const error2 = await client2.getJob('mcd1_abc', 'job_1').catch((e) => e);
    expect(error2.code).toBe('invalid_response');
  });
});
