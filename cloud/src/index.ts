import { Container, getContainer } from '@cloudflare/containers';
import { handleRequest, type WorkerEnv } from './handler';

type Env = WorkerEnv & { ANALYSIS_CONTAINER: unknown };

export class AnalysisContainer extends Container {
  defaultPort = 8080;
  sleepAfter = '30s';
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const binding = env.ANALYSIS_CONTAINER as Parameters<typeof getContainer>[0];
    const container = getContainer(binding, 'single-analysis-slot-staging');
    return handleRequest(request, env, {
      fetch: (containerRequest) => container.fetch(containerRequest),
    });
  },
};
