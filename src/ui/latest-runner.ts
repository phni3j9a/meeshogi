/**
 * Applies only the most recent request's result: a stale promise that resolves
 * (or rejects) after a newer `run()` or `invalidate()` is dropped. Used where a
 * live async evaluation must not overwrite a newer state (FP-016).
 */
export function createLatestRunner<T>(
  onValue: (value: T) => void,
  onError: () => void,
): { run: (promise: Promise<T>) => void; invalidate: () => void } {
  let seq = 0;
  return {
    run: (promise) => {
      const mine = ++seq;
      void promise.then(
        (value) => {
          if (mine === seq) onValue(value);
        },
        () => {
          if (mine === seq) onError();
        },
      );
    },
    invalidate: () => {
      seq += 1;
    },
  };
}
