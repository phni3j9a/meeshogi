import { describe, expect, it, vi } from 'vitest';
import { AnalysisContainer } from '../src/index';

type PendingEvent = { lifecycle_key: string; event: string; observed_at: string; details: string };

function makeContainer(record: (input: { lifecycleKey: string; event: string }) => Promise<void>) {
  const state = { generation: 1, instance_key: 'lifecycle-test-instance', active: 1, sleep_pending: 0 };
  const pending = new Map<string, PendingEvent>();
  const received = new Set<string>();
  const sql = {
    exec(statement: string, ...args: unknown[]) {
      let rows: unknown[] = [];
      if (statement.includes('SELECT generation, instance_key')) rows = [{ generation: state.generation, instance_key: state.instance_key }];
      else if (statement.includes('SELECT sleep_pending')) rows = [{ sleep_pending: state.sleep_pending }];
      else if (statement.includes('SELECT lifecycle_key, event, observed_at, details')) rows = [...pending.values()];
      else if (statement.includes('INSERT OR IGNORE INTO cost_lifecycle_pending')) {
        const [profile, lifecycleKey, event, observedAt, details] = args as [string, string, string, string, string];
        const key = `${profile}:${lifecycleKey}:${event}`;
        if (!pending.has(key)) pending.set(key, { lifecycle_key: lifecycleKey, event, observed_at: observedAt, details });
      } else if (statement.includes('DELETE FROM cost_lifecycle_pending')) {
        const [, lifecycleKey, event] = args as [string, string, string];
        for (const [key, value] of pending) if (value.lifecycle_key === lifecycleKey && value.event === event) pending.delete(key);
      } else if (statement.includes('SET sleep_pending = 1')) state.sleep_pending = 1;
      else if (statement.includes('SET active = 0, sleep_pending = 0')) { state.active = 0; state.sleep_pending = 0; }
      return { toArray: () => rows };
    },
  };
  const instance = Object.assign(Object.create(AnalysisContainer.prototype) as Record<string, unknown>, {
    profileId: 'free-v1',
    ctx: { storage: { sql } },
    env: { JOB_COORDINATOR: { getByName: () => ({ recordContainerLifecycleEvent: async (input: { lifecycleKey: string; event: string }) => {
      await record(input);
      received.add(`${input.lifecycleKey}:${input.event}`);
    } }) } },
    stop: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
  });
  return { instance: instance as unknown as AnalysisContainer & { stop: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }, pending, received, state };
}

describe('container cost lifecycle recovery', () => {
  it('runs stop despite a D1 lifecycle-log outage and flushes local records after recovery', async () => {
    let d1Available = false;
    const delivered = new Set<string>();
    const { instance, pending, received, state } = makeContainer(async ({ lifecycleKey, event }) => {
      if (!d1Available) throw new Error('injected_d1_outage');
      delivered.add(`${lifecycleKey}:${event}`);
    });

    await instance.onActivityExpired();
    expect(instance.stop).toHaveBeenCalledOnce();
    expect(instance.destroy).not.toHaveBeenCalled();
    expect([...pending.values()].map((row) => row.event)).toContain('sleep_timer_elapsed');

    d1Available = true;
    await instance.onStop({ reason: 'sleep', exitCode: 0 } as never);
    expect(pending.size).toBe(0);
    expect(state).toMatchObject({ active: 0, sleep_pending: 0 });
    expect([...received].map((value) => value.split(':').at(-1))).toContain('sleep_timer_elapsed');
    expect([...received].map((value) => value.split(':').at(-1))).toContain('sleep_confirmed');
    expect(delivered.size).toBe(2);
  });

  it('tries destroy when the bounded stop operation fails', async () => {
    const { instance } = makeContainer(async () => undefined);
    instance.stop.mockRejectedValue(new Error('injected_stop_failure'));

    await instance.onActivityExpired();

    expect(instance.stop).toHaveBeenCalledOnce();
    expect(instance.destroy).toHaveBeenCalledOnce();
  });

  it('tries destroy when stop exceeds its five-second deadline', async () => {
    const { instance } = makeContainer(async () => undefined);
    instance.stop.mockImplementation(() => new Promise<void>(() => undefined));
    vi.useFakeTimers();
    try {
      const expired = instance.onActivityExpired();
      await vi.advanceTimersByTimeAsync(5_000);
      await expired;
      expect(instance.stop).toHaveBeenCalledOnce();
      expect(instance.destroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
