import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    // The SDK imports this runtime-provided module; the focused SDK lifecycle
    // test supplies only its DurableObject base class in Node.
    alias: {
      'cloudflare:workers': fileURLToPath(new URL('./test/fixtures/cloudflare-workers.stub.mjs', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    maxWorkers: 2,
  },
});
