import { describe, expect, it } from 'vitest';
import { JOB_PROFILES } from '../src/jobConfig';
import { capacityWaitMessage, runSession } from '../src/jobRunner';
import type { JobStore, JobRow } from '../src/jobStore';

const JOB: JobRow = {
  job_id: 'job_runner_capacity', owner_id: 'own_test', idempotency_key: 'key', input_hash: 'hash',
  profile_id: 'free', initial_sfen: '', moves_json: '[]', total_plies: 1, status: 'running', next_ply: 0,
  jst_day: '2026-10-04', created_ms: 0, created_at: '', updated_at: '', finished_at: null,
  failure_code: null, failure_message: null,
};

const SDK_CAPACITY_RESPONSE = 'There is no Container instance available at this time.\n'
  + 'This is likely because you have reached your max concurrent instance count (set in wrangler config) '
  + 'or are currently provisioning the Container.';

function runnerDeps(store: JobStore, transport: (request: Request) => Promise<Response>) {
  const signal = new AbortController().signal;
  return {
    store,
    jobId: JOB.job_id,
    transport,
    signal,
    budgetMs: 600_000,
    tailMarginMs: 20_000,
    instanceType: 'standard-2' as const,
    now: () => Date.now(),
  };
}

async function startSession(response: () => Promise<Response>) {
  const store = { jobById: async () => JOB } as unknown as JobStore;
  const transport = async () => response();
  const controller = new AbortController();
  const outcome = await runSession(
    store, transport, controller.signal, JOB, JOB_PROFILES.free, [], Date.now() + 3_000,
    () => Date.now(), { ...runnerDeps(store, transport), signal: controller.signal },
  );
  return outcome;
}

describe('job runner capacity classification', () => {
  it('recognizes the two documented no-instance forms and rejects generic 503 diagnostics', async () => {
    expect(capacityWaitMessage(new Error('there is no container instance that can be provided to this durable object')))
      .toContain('there is no container instance');
    expect(capacityWaitMessage(SDK_CAPACITY_RESPONSE)).toContain('max concurrent instance count');
    expect(capacityWaitMessage('503 from D1 terminal fence')).toBeNull();
    expect(capacityWaitMessage('Service unavailable')).toBeNull();
  });

  it('returns capacity wait only for the SDK instance-limit response body', async () => {
    const capacity = await startSession(async () => new Response(SDK_CAPACITY_RESPONSE, { status: 503 }));
    expect(capacity).toMatchObject({ kind: 'capacity' });

    const generic = await startSession(async () => new Response('driver temporarily unavailable', { status: 503 }));
    expect(generic.kind).toBe('retry');
  });

  it('classifies the SDK no-instance exception while keeping ambiguous transport failures transient', async () => {
    const store = { jobById: async () => JOB } as unknown as JobStore;
    const run = async (error: Error) => {
      const transport = async () => { throw error; };
      const controller = new AbortController();
      return runSession(
        store, transport, controller.signal, JOB, JOB_PROFILES.free, [], Date.now() + 3_000,
        () => Date.now(), { ...runnerDeps(store, transport), signal: controller.signal },
      );
    };
    expect((await run(new Error('there is no container instance that can be provided to this durable object'))).kind)
      .toBe('capacity');
    expect((await run(new Error('socket closed'))).kind).toBe('retry');
  });
});
