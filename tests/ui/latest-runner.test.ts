import { describe, expect, it } from 'vitest';
import { createLatestRunner } from '../../src/ui/latest-runner';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('createLatestRunner', () => {
  it('遅い古い評価が新しい結果を上書きしない（FP-016シナリオ）', async () => {
    const applied: string[] = [];
    const runner = createLatestRunner<string>(
      (value) => applied.push(value),
      () => applied.push('error'),
    );
    // First probe is held mid-flight (e.g. SecureStore read stalls).
    const first = deferred<string>();
    runner.run(first.promise);
    // Credential restored → a second evaluation resolves 'recoverable'.
    const second = deferred<string>();
    runner.run(second.promise);
    second.resolve('recoverable');
    await Promise.resolve();
    expect(applied).toEqual(['recoverable']);
    // The stale first probe resolves late with 'absent' → dropped.
    first.resolve('unrecoverable-forget');
    await Promise.resolve();
    expect(applied).toEqual(['recoverable']);
  });

  it('staleなrejectも無視し、最新のrejectだけがerrorを適用する', async () => {
    const applied: string[] = [];
    const runner = createLatestRunner<string>(
      (value) => applied.push(value),
      () => applied.push('error'),
    );
    const first = deferred<string>();
    const second = deferred<string>();
    runner.run(first.promise);
    runner.run(second.promise);
    first.reject(new Error('stale'));
    await Promise.resolve();
    expect(applied).toEqual([]);
    second.reject(new Error('latest'));
    await Promise.resolve();
    expect(applied).toEqual(['error']);
  });

  it('invalidateでin-flightの結果をすべて破棄する（cleanup/blur/target変更）', async () => {
    const applied: string[] = [];
    const runner = createLatestRunner<string>(
      (value) => applied.push(value),
      () => applied.push('error'),
    );
    const pending = deferred<string>();
    runner.run(pending.promise);
    runner.invalidate();
    pending.resolve('stale');
    await Promise.resolve();
    expect(applied).toEqual([]);
    // After invalidation a fresh run still works.
    const next = deferred<string>();
    runner.run(next.promise);
    next.resolve('fresh');
    await Promise.resolve();
    expect(applied).toEqual(['fresh']);
  });
});
