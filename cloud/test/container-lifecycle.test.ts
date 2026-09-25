import { describe, expect, it, vi } from 'vitest';
import { AnalysisContainer } from '../src/index';

type PendingEvent = { lifecycle_key: string; event: string; observed_at: string; details: string };
type StoredState = { generation: number; instance_key: string; active: number; sleep_pending: number };
type RuntimeState = { status: 'running' | 'stopping' | 'healthy' | 'stopped' | 'stopped_with_code'; lastChange: number };
type Store = {
  state: StoredState;
  runtime: RuntimeState;
  pending: Map<string, PendingEvent>;
  received: Set<string>;
  ctx: { storage: { sql: { exec: (statement: string, ...args: unknown[]) => { toArray: () => unknown[] } } } };
};

function createStore(): Store {
  const store = {
    state: { generation: 1, instance_key: 'lifecycle-test-instance', active: 1, sleep_pending: 0 },
    runtime: { status: 'healthy' as const, lastChange: 0 },
    pending: new Map<string, PendingEvent>(),
    received: new Set<string>(),
    ctx: undefined as unknown as Store['ctx'],
  };
  store.ctx = {
    storage: {
      sql: {
        exec(statement: string, ...args: unknown[]) {
          let rows: unknown[] = [];
          if (statement.includes('SELECT generation, instance_key')) rows = [{ generation: store.state.generation, instance_key: store.state.instance_key }];
          else if (statement.includes('SELECT sleep_pending')) rows = [{ sleep_pending: store.state.sleep_pending }];
          else if (statement.includes('SELECT lifecycle_key, event, observed_at, details')) rows = [...store.pending.values()];
          else if (statement.includes('INSERT OR IGNORE INTO cost_lifecycle_pending')) {
            const [profile, lifecycleKey, event, observedAt, details] = args as [string, string, string, string, string];
            const key = `${profile}:${lifecycleKey}:${event}`;
            if (!store.pending.has(key)) store.pending.set(key, { lifecycle_key: lifecycleKey, event, observed_at: observedAt, details });
          } else if (statement.includes('DELETE FROM cost_lifecycle_pending')) {
            const [, lifecycleKey, event] = args as [string, string, string];
            for (const [key, value] of store.pending) if (value.lifecycle_key === lifecycleKey && value.event === event) store.pending.delete(key);
          } else if (statement.includes('SET sleep_pending = 1')) store.state.sleep_pending = 1;
          else if (statement.includes('SET active = 0, sleep_pending = 0')) {
            store.state.active = 0;
            store.state.sleep_pending = 0;
          }
          return { toArray: () => rows };
        },
      },
    },
  };
  return store;
}

function makeContainer(
  record: (input: { lifecycleKey: string; event: string }) => Promise<void>,
  store = createStore(),
) {
  const instance = Object.assign(Object.create(AnalysisContainer.prototype) as Record<string, unknown>, {
    profileId: 'free-v1',
    ctx: store.ctx,
    env: { JOB_COORDINATOR: { getByName: () => ({ recordContainerLifecycleEvent: async (input: { lifecycleKey: string; event: string }) => {
      await record(input);
      store.received.add(`${input.lifecycleKey}:${input.event}`);
    } }) } },
    getState: vi.fn(async () => ({ ...store.runtime })),
    stop: vi.fn(async () => { store.runtime = { status: 'stopped', lastChange: Date.now() }; }),
    destroy: vi.fn(async () => { store.runtime = { status: 'stopped', lastChange: Date.now() }; }),
  });
  return {
    instance: instance as unknown as AnalysisContainer & {
      getState: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    },
    store,
  };
}

describe('container cost lifecycle recovery', () => {
  it('runs stop after the local record when the lifecycle RPC rejects', async () => {
    const { instance, store } = makeContainer(async () => { throw new Error('injected_d1_rejection'); });

    await instance.onActivityExpired();
    await Promise.resolve();

    expect(instance.stop).toHaveBeenCalledOnce();
    expect(instance.destroy).not.toHaveBeenCalled();
    expect([...store.pending.values()].map((row) => row.event)).toContain('sleep_timer_elapsed');
    expect([...store.pending.values()].map((row) => row.event)).not.toContain('sleep_confirmed');
  });

  it('runs stop without waiting for a lifecycle RPC that never resolves', async () => {
    vi.useFakeTimers();
    try {
      const { instance, store } = makeContainer(() => new Promise<void>(() => undefined));

      await instance.onActivityExpired();

      expect(instance.stop).toHaveBeenCalledOnce();
      expect(instance.destroy).not.toHaveBeenCalled();
      expect([...store.pending.values()].map((row) => row.event)).toContain('sleep_timer_elapsed');
      await vi.advanceTimersByTimeAsync(1_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tries destroy when stop rejects', async () => {
    const { instance } = makeContainer(async () => undefined);
    instance.stop.mockRejectedValue(new Error('injected_stop_failure'));

    await instance.onActivityExpired();

    expect(instance.stop).toHaveBeenCalledOnce();
    expect(instance.destroy).toHaveBeenCalledOnce();
  });

  it('tries destroy when stop does not resolve before its five-second deadline', async () => {
    vi.useFakeTimers();
    try {
      const { instance } = makeContainer(async () => undefined);
      instance.stop.mockImplementation(() => new Promise<void>(() => undefined));

      const expired = instance.onActivityExpired();
      await vi.advanceTimersByTimeAsync(5_000);
      await expired;

      expect(instance.stop).toHaveBeenCalledOnce();
      expect(instance.destroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('destroys after the five-second grace when stop resolves but the runtime remains running', async () => {
    vi.useFakeTimers();
    try {
      const { instance, store } = makeContainer(async () => undefined);
      store.runtime = { status: 'healthy', lastChange: Date.now() };
      instance.stop.mockResolvedValue(undefined);

      const expired = instance.onActivityExpired();
      await vi.advanceTimersByTimeAsync(5_000);
      await expired;

      expect(instance.stop).toHaveBeenCalledOnce();
      expect(instance.getState).toHaveBeenCalled();
      expect(instance.destroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('commits onStop local state before waiting on an unresolved lifecycle RPC', async () => {
    vi.useFakeTimers();
    try {
      const { instance, store } = makeContainer(() => new Promise<void>(() => undefined));
      store.state.sleep_pending = 1;

      const stopped = instance.onStop({ reason: 'sleep', exitCode: 0 } as never);
      expect(store.state).toMatchObject({ active: 0, sleep_pending: 0 });
      expect([...store.pending.values()].map((row) => row.event)).toContain('sleep_confirmed');
      await vi.advanceTimersByTimeAsync(1_000);
      await stopped;

      expect(store.pending.size).toBe(1);
      expect(store.received.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes a pending event after object reconstruction on the same SQLite with the same lifecycle key', async () => {
    const attempts = new Map<string, Array<string>>();
    const delivered = new Set<string>();
    const record = async ({ lifecycleKey, event }: { lifecycleKey: string; event: string }) => {
      const keys = attempts.get(event) ?? [];
      keys.push(lifecycleKey);
      attempts.set(event, keys);
      if (event === 'sleep_timer_elapsed' && keys.length === 1) throw new Error('injected_d1_rejection');
      delivered.add(`${lifecycleKey}:${event}`);
    };
    const first = makeContainer(record);
    const instanceKey = first.store.state.instance_key;

    await first.instance.onActivityExpired();
    await Promise.resolve();
    expect([...first.store.pending.values()].map((row) => row.event)).toContain('sleep_timer_elapsed');

    const reconstructed = makeContainer(record, first.store);
    await reconstructed.instance.onStop({ reason: 'sleep', exitCode: 0 } as never);

    expect(reconstructed.store.state.instance_key).toBe(instanceKey);
    expect(reconstructed.store.pending.size).toBe(0);
    expect(attempts.get('sleep_timer_elapsed')).toHaveLength(2);
    expect(new Set(attempts.get('sleep_timer_elapsed')).size).toBe(1);
    expect([...delivered].filter((key) => key.endsWith(':sleep_timer_elapsed'))).toHaveLength(1);
  });
});
