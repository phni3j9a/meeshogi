import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: vi.fn(),
}));

import { requireOptionalNativeModule } from 'expo-modules-core';
import { analyzeNative, cancelNative, ENGINE_ID, MODEL_ID } from '../../src/analysis/native-engine';

const initialSfen = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL w - 1';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('native engine cancellation', () => {
  it('invalidates a request cancelled while native initialization is pending', async () => {
    const init = deferred<void>();
    const nativeModule = {
      initializeAsync: vi.fn(() => init.promise),
      analyzeAsync: vi.fn(async () =>
        JSON.stringify({
          status: 'complete',
          sfen: initialSfen,
          engineId: ENGINE_ID,
          modelId: MODEL_ID,
          candidates: [{ usi: '8c8d', pv: ['8c8d'], scoreCp: 0, mate: null, depth: 1 }],
          terminal: null,
          mateProof: null,
        }),
      ),
      cancelAsync: vi.fn(async () => undefined),
    };
    vi.mocked(requireOptionalNativeModule).mockReturnValue(nativeModule);

    const analysis = analyzeNative(initialSfen, { nodes: 1, multiPV: 1 });
    await Promise.resolve();
    expect(nativeModule.initializeAsync).toHaveBeenCalledOnce();

    await expect(cancelNative()).resolves.toBeUndefined();
    init.resolve();

    await expect(analysis).rejects.toThrow('解析がキャンセルされました');
    expect(nativeModule.cancelAsync).toHaveBeenCalledOnce();
    expect(nativeModule.analyzeAsync).not.toHaveBeenCalled();
  });
});
