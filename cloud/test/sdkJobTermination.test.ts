import { expect, it, vi } from 'vitest';
import { FreeJobContainer } from '../src/jobContainers';

it('does not resume an SDK startup retry after terminateJob', async () => {
  const values = new Map<string, unknown>();
  const events: string[] = [];
  const noInstance = new Error('there is no container instance that can be provided to this durable object');
  let starts = 0;
  let firstPing!: () => void;
  const pingReached = new Promise<void>((resolve) => { firstPing = resolve; });
  let running = false;
  const storage = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => { values.set(key, value); },
    kv: { get: (key: string) => values.get(key) },
    sql: { exec: () => [] },
    setAlarm: async () => {},
    sync: async () => {},
    deleteAlarm: async () => {},
  };
  const native = {
    get running() { return running; },
    start: () => { starts += 1; events.push(`start-${starts}`); running = starts > 1; },
    monitor: () => {
      const pending = starts === 1 ? Promise.reject(noInstance) : new Promise<never>(() => {});
      // The SDK may consume the native monitor rejection after it is created.
      void pending.catch(() => {});
      return pending;
    },
    destroy: async () => { running = false; events.push('destroy'); },
    getTcpPort: () => ({ fetch: async () => {
      if (starts === 1) { firstPing(); throw noInstance; }
      const response = new Response(null, { status: 204 });
      Object.defineProperty(response, 'webSocket', { value: null });
      return response;
    } }),
  };
  const blocks: Promise<unknown>[] = [];
  const ctx = {
    storage,
    container: native,
    blockConcurrencyWhile: (callback: () => Promise<unknown>) => {
      const result = callback();
      blocks.push(result);
      return result;
    },
  };

  vi.useFakeTimers();
  try {
    // This test imports the installed @cloudflare/containers 0.3.7 package.
    const container = new FreeJobContainer(ctx as never, {} as never);
    await Promise.all(blocks);
    const pending = container.fetch(new Request('http://container/session'));

    // Let the SDK issue its first startup health check and enter its retry path.
    await pingReached;
    await Promise.resolve();
    await Promise.resolve();
    const termination = container.terminateJob();
    // If the SDK leaves startup pending, termination is bounded by its 5s settle limit.
    await vi.advanceTimersByTimeAsync(5_000);
    await termination;

    expect(values.get('job:terminated')).toBe(true);
    expect(events).toEqual(['start-1', 'destroy']);
    const late = await container.fetch(new Request('http://container/session/cancel'));
    expect(late.status).toBe(410);

    // Advance beyond the SDK's 300ms retry interval: the aborted request must
    // settle without allowing its startup loop to issue another native start.
    await pending;
    expect(events).toEqual(['start-1', 'destroy']);
    expect(running).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
