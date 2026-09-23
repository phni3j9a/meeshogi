import { Container, getContainer } from '@cloudflare/containers';
import { handleRequest, type DriverClient } from './handler';
import { handleJobsQueue, handleJobsRequest, isJobApiPath } from './jobs';
import { JobCoordinator } from './job-coordinator';
import type { JobEnvironment, JobChunk } from './job-types';

type Env = JobEnvironment & { ANALYSIS_CONTAINER: unknown };

export class AnalysisContainer extends Container {
  defaultPort = 8080;
  sleepAfter = '30s';
}

export { JobCoordinator };

function driverClient(env: Env): DriverClient {
  if (env.ANALYSIS_ENGINE) return { fetch: (request) => env.ANALYSIS_ENGINE?.fetch(request) ?? Promise.resolve(new Response(null, { status: 503 })) };
  const binding = env.ANALYSIS_CONTAINER as Parameters<typeof getContainer>[0];
  const container = getContainer(binding, 'single-analysis-slot-staging');
  return { fetch: (request) => container.fetch(request) };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (isJobApiPath(new URL(request.url).pathname)) {
      try {
        return await handleJobsRequest(request, env);
      } catch {
        return new Response(JSON.stringify({ error: 'job_service_unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
    }
    return handleRequest(request, env, driverClient(env));
  },
  async queue(batch: MessageBatch<JobChunk>, env: Env): Promise<void> {
    await handleJobsQueue(batch, env, driverClient(env));
  },
};
