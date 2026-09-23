import { Container, getContainer } from '@cloudflare/containers';
import { handleRequest, type DriverClient } from './handler';
import {
  handleJobsQueue,
  handleJobsRequest,
  handleJobsScheduled,
  isJobApiPath,
} from './jobs';
import { JobCoordinator } from './job-coordinator';
import type { AnalysisProfileId, JobChunk, JobEnvironment } from './job-types';

type Env = JobEnvironment & {
  ANALYSIS_CONTAINER: DurableObjectNamespace<AnalysisContainer>;
  ANALYSIS_CONTAINER_PRECISION: DurableObjectNamespace<AnalysisContainerPrecision>;
};

export class AnalysisContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '30s';
}

export class AnalysisContainerPrecision extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '30s';
}

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
    return { fetch: (request) => container.fetch(request), destroy: () => container.destroy() };
  }
  const container = getContainer(env.ANALYSIS_CONTAINER_PRECISION, 'single-analysis-slot-precision-staging');
  return { fetch: (request) => container.fetch(request), destroy: () => container.destroy() };
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
