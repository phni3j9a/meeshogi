import { Container, getContainer, type StopParams } from '@cloudflare/containers';
import { handleRequest, type DriverClient } from './handler';
import {
  handleJobsQueue,
  handleJobsRequest,
  handleJobsScheduled,
  isJobApiPath,
} from './jobs';
import { JobCoordinator } from './job-coordinator';
import type { AnalysisProfileId, JobChunk, JobEnvironment, JobIdentity } from './job-types';

type Env = JobEnvironment & {
  ANALYSIS_CONTAINER: DurableObjectNamespace<AnalysisContainer>;
  ANALYSIS_CONTAINER_PRECISION: DurableObjectNamespace<AnalysisContainerPrecision>;
};

const LIFECYCLE_RPC_TIMEOUT_MS = 1_000;
const CONTAINER_STOP_GRACE_MS = 5_000;
const CONTAINER_DESTROY_TIMEOUT_MS = 10_000;

abstract class CostTrackedAnalysisContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '30s';

  protected abstract readonly profileId: JobIdentity['profileId'];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS cost_lifecycle_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), instance_key TEXT NOT NULL, generation INTEGER NOT NULL, active INTEGER NOT NULL, sleep_pending INTEGER NOT NULL)',
    );
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS cost_lifecycle_pending (profile_id TEXT NOT NULL, lifecycle_key TEXT NOT NULL, event TEXT NOT NULL, observed_at TEXT NOT NULL, details TEXT NOT NULL, PRIMARY KEY (profile_id, lifecycle_key, event))',
    );
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO cost_lifecycle_state(singleton, instance_key, generation, active, sleep_pending) VALUES (1, ?, 0, 0, 0)', crypto.randomUUID());
  }

  private recordLifecycle(event: 'first_contact' | 'sleep_timer_elapsed' | 'sleep_confirmed' | 'stop_confirmed' | 'stop_failed', details: Record<string, unknown> = {}): void {
    const row = this.ctx.storage.sql.exec<{ generation: number; instance_key: string }>('SELECT generation, instance_key FROM cost_lifecycle_state WHERE singleton = 1').toArray()[0];
    if (!row) return;
    const lifecycleKey = `${this.profileId}:${row.instance_key}:${row.generation}`;
    const now = Date.now();
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO cost_lifecycle_pending(profile_id, lifecycle_key, event, observed_at, details) VALUES (?, ?, ?, ?, ?)',
      this.profileId, lifecycleKey, event, new Date(now).toISOString(), JSON.stringify(details),
    );
  }

  private async flushPendingLifecycle(): Promise<void> {
    const deadline = Date.now() + LIFECYCLE_RPC_TIMEOUT_MS;
    const rows = this.ctx.storage.sql.exec<{ lifecycle_key: string; event: 'first_contact' | 'sleep_timer_elapsed' | 'sleep_confirmed' | 'stop_confirmed' | 'stop_failed'; observed_at: string; details: string }>(
      'SELECT lifecycle_key, event, observed_at, details FROM cost_lifecycle_pending WHERE profile_id = ? ORDER BY observed_at, event',
    this.profileId,
    ).toArray();
    for (const row of rows) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return;
      try {
        await this.withLifecycleTimeout(Promise.resolve().then(() => this.env.JOB_COORDINATOR.getByName('staging-global').recordContainerLifecycleEvent({
          profileId: this.profileId, lifecycleKey: row.lifecycle_key, event: row.event,
          details: JSON.parse(row.details) as Record<string, unknown>, now: Date.parse(row.observed_at),
        })), remainingMs);
      } catch { return; }
      this.ctx.storage.sql.exec(
        'DELETE FROM cost_lifecycle_pending WHERE profile_id = ? AND lifecycle_key = ? AND event = ?',
        this.profileId, row.lifecycle_key, row.event,
      );
    }
  }

  private async withLifecycleTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('container_lifecycle_timeout')), timeoutMs); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async stopAndConfirmWithinGrace(): Promise<void> {
    const deadline = Date.now() + CONTAINER_STOP_GRACE_MS;
    await this.withLifecycleTimeout(this.stop(), Math.max(1, deadline - Date.now()));
    while (Date.now() < deadline) {
      const remainingMs = deadline - Date.now();
      try {
        const state = await this.withLifecycleTimeout(this.getState(), Math.min(250, remainingMs));
        if (state.status === 'stopped' || state.status === 'stopped_with_code') return;
      } catch { /* Keep checking until the stop grace expires. */ }
      const delayMs = Math.min(100, deadline - Date.now());
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error('container_stop_unconfirmed');
  }

  override async onStart(): Promise<void> {
    const row = this.ctx.storage.sql.exec<{ generation: number; active: number }>('SELECT generation, active FROM cost_lifecycle_state WHERE singleton = 1').toArray()[0];
    if (!row) return;
    if (row.active === 0) {
      this.ctx.storage.sql.exec('UPDATE cost_lifecycle_state SET generation = generation + 1, active = 1, sleep_pending = 0 WHERE singleton = 1');
    }
    this.recordLifecycle('first_contact', { startedAt: Date.now() });
    await this.flushPendingLifecycle();
  }

  override async onActivityExpired(): Promise<void> {
    try {
      this.ctx.storage.sql.exec('UPDATE cost_lifecycle_state SET sleep_pending = 1 WHERE singleton = 1');
      this.recordLifecycle('sleep_timer_elapsed', { sleepAfterSeconds: 30 });
    } catch { /* Continue to stop even when local lifecycle recording fails. */ }
    void this.flushPendingLifecycle().catch(() => undefined);
    try {
      await this.stopAndConfirmWithinGrace();
    } catch {
      try { this.recordLifecycle('stop_failed', { action: 'destroy_after_stop_failure' }); } catch { /* Best-effort local evidence. */ }
      void this.flushPendingLifecycle().catch(() => undefined);
      try {
        await this.withLifecycleTimeout(this.destroy(), CONTAINER_DESTROY_TIMEOUT_MS);
      } catch {
        try { this.recordLifecycle('stop_failed', { action: 'destroy_failed' }); } catch { /* Best-effort local evidence. */ }
        void this.flushPendingLifecycle().catch(() => undefined);
      }
    }
  }

  override async onStop(params: StopParams): Promise<void> {
    let sleepPending = false;
    try {
      const row = this.ctx.storage.sql.exec<{ sleep_pending: number }>('SELECT sleep_pending FROM cost_lifecycle_state WHERE singleton = 1').toArray()[0];
      sleepPending = row?.sleep_pending === 1;
    } catch { /* A failed local read must not delay the stop transition. */ }
    try {
      this.recordLifecycle(sleepPending ? 'sleep_confirmed' : 'stop_confirmed', {
        reason: params.reason, exitCode: params.exitCode,
      });
    } catch { /* Preserve the SDK stop hook even if durable logging fails. */ }
    try {
      this.ctx.storage.sql.exec('UPDATE cost_lifecycle_state SET active = 0, sleep_pending = 0 WHERE singleton = 1');
    } catch { /* The external RPC is never allowed to gate this local transition. */ }
    await this.flushPendingLifecycle();
  }

  async prepareSigstop(fence: string): Promise<void> {
    await this.destroy();
    await this.startAndWaitForPorts({
      ports: [8080],
      startOptions: { envVars: { MEESHOGI_TEST_SIGSTOP_ENGINE: '1', MEESHOGI_TEST_SIGSTOP_FENCE: fence } },
    });
  }
}

export class AnalysisContainer extends CostTrackedAnalysisContainer { protected readonly profileId = 'free-v1' as const; }
export class AnalysisContainerPrecision extends CostTrackedAnalysisContainer { protected readonly profileId = 'precision-v1' as const; }

export { JobCoordinator };

function driverClient(env: Env, profile: AnalysisProfileId): DriverClient {
  const testBinding = profile === 'free-v1' ? env.ANALYSIS_ENGINE : env.ANALYSIS_ENGINE_PRECISION;
  if (testBinding) {
    return {
      fetch: (request) => testBinding.fetch(request),
      destroy: async () => {
        const response = await testBinding.fetch(new Request('http://analysis-engine.test/__destroy', { method: 'POST' }));
        if (!response.ok) throw new Error('test_container_destroy_failed');
      },
    };
  }
  if (profile === 'free-v1') {
    const container = getContainer(env.ANALYSIS_CONTAINER, 'single-analysis-slot-free-staging');
    return {
      fetch: (request) => container.fetch(request), destroy: () => container.destroy(),
      prepareSigstop: (fence) => container.prepareSigstop(fence),
    };
  }
  const container = getContainer(env.ANALYSIS_CONTAINER_PRECISION, 'single-analysis-slot-precision-staging');
  return {
    fetch: (request) => container.fetch(request), destroy: () => container.destroy(),
    prepareSigstop: (fence) => container.prepareSigstop(fence),
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (isJobApiPath(new URL(request.url).pathname)) {
      try {
        return await handleJobsRequest(request, env, (profile) => driverClient(env, profile));
      } catch {
        return new Response(JSON.stringify({ error: 'job_service_unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
    }
    return handleRequest(request, env, (profile) => driverClient(env, profile));
  },
  async queue(batch: MessageBatch<JobChunk>, env: Env): Promise<void> {
    await handleJobsQueue(batch, env, (profile) => driverClient(env, profile));
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await handleJobsScheduled(env, (profile) => driverClient(env, profile));
  },
};
