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

abstract class CostTrackedAnalysisContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '30s';

  protected abstract readonly profileId: JobIdentity['profileId'];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS cost_lifecycle_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), instance_key TEXT NOT NULL, generation INTEGER NOT NULL, active INTEGER NOT NULL, sleep_pending INTEGER NOT NULL)',
    );
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO cost_lifecycle_state(singleton, instance_key, generation, active, sleep_pending) VALUES (1, ?, 0, 0, 0)', crypto.randomUUID());
  }

  private async recordLifecycle(event: 'first_contact' | 'sleep_timer_elapsed' | 'sleep_confirmed' | 'stop_confirmed' | 'stop_failed', details: Record<string, unknown> = {}): Promise<void> {
    const row = this.ctx.storage.sql.exec<{ generation: number; instance_key: string }>('SELECT generation, instance_key FROM cost_lifecycle_state WHERE singleton = 1').toArray()[0];
    if (!row) return;
    await this.env.JOB_COORDINATOR.getByName('staging-global').recordContainerLifecycleEvent({
      profileId: this.profileId, lifecycleKey: `${this.profileId}:${row.instance_key}:${row.generation}`, event, details, now: Date.now(),
    });
  }

  override async onStart(): Promise<void> {
    const row = this.ctx.storage.sql.exec<{ generation: number; active: number }>('SELECT generation, active FROM cost_lifecycle_state WHERE singleton = 1').toArray()[0];
    if (!row) return;
    if (row.active === 0) {
      this.ctx.storage.sql.exec('UPDATE cost_lifecycle_state SET generation = generation + 1, active = 1, sleep_pending = 0 WHERE singleton = 1');
    }
    await this.recordLifecycle('first_contact', { startedAt: Date.now() });
  }

  override async onActivityExpired(): Promise<void> {
    this.ctx.storage.sql.exec('UPDATE cost_lifecycle_state SET sleep_pending = 1 WHERE singleton = 1');
    await this.recordLifecycle('sleep_timer_elapsed', { sleepAfterSeconds: 30 });
    try {
      await this.stop();
    } catch {
      await this.recordLifecycle('stop_failed', { action: 'destroy_after_stop_failure' }).catch(() => undefined);
      try { await this.destroy(); } catch { await this.recordLifecycle('stop_failed', { action: 'destroy_failed' }).catch(() => undefined); }
    }
  }

  override async onStop(params: StopParams): Promise<void> {
    const row = this.ctx.storage.sql.exec<{ sleep_pending: number }>('SELECT sleep_pending FROM cost_lifecycle_state WHERE singleton = 1').toArray()[0];
    await this.recordLifecycle(row?.sleep_pending === 1 ? 'sleep_confirmed' : 'stop_confirmed', {
      reason: params.reason, exitCode: params.exitCode,
    });
    this.ctx.storage.sql.exec('UPDATE cost_lifecycle_state SET active = 0, sleep_pending = 0 WHERE singleton = 1');
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
