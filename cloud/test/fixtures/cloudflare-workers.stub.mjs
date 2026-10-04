// Node tests cannot load Cloudflare's runtime module. The SDK lifecycle test
// needs only the base class to retain the Durable Object context and env.
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkerEntrypoint {}
