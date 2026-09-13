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
      prepareRequest: vi.fn(() => 1),
      analyzeAsync: vi.fn(async (_sfen: string, _nodes: number, _multiPV: number, _requestId: number) =>
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
      cancelAsync: vi.fn(async (_requestId: number) => undefined),
    };
    vi.mocked(requireOptionalNativeModule).mockReturnValue(nativeModule);

    const analysis = analyzeNative(initialSfen, { nodes: 1, multiPV: 1 });
    await Promise.resolve();
    expect(nativeModule.initializeAsync).toHaveBeenCalledOnce();

    await expect(cancelNative()).resolves.toBeUndefined();
    init.resolve();

    await expect(analysis).rejects.toThrow('解析がキャンセルされました');
    expect(nativeModule.cancelAsync).not.toHaveBeenCalled();
    expect(nativeModule.analyzeAsync).not.toHaveBeenCalled();
  });

  it('cancels the prepared native request and discards a racing completion', async () => {
    const result = deferred<string>();
    const nativeModule = {
      initializeAsync: vi.fn(async () => undefined),
      prepareRequest: vi.fn(() => 42),
      analyzeAsync: vi.fn(() => result.promise),
      cancelAsync: vi.fn(async (_requestId: number) => undefined),
    };
    vi.mocked(requireOptionalNativeModule).mockReturnValue(nativeModule);

    const analysis = analyzeNative(initialSfen, { nodes: 1, multiPV: 1 });
    for (let attempt = 0; attempt < 8 && nativeModule.analyzeAsync.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(nativeModule.analyzeAsync).toHaveBeenCalledOnce();

    const cancellation = cancelNative();
    expect(nativeModule.cancelAsync).toHaveBeenCalledWith(42);
    await expect(cancellation).resolves.toBeUndefined();

    result.resolve(
      JSON.stringify({
        status: 'complete',
        sfen: initialSfen,
        engineId: ENGINE_ID,
        modelId: MODEL_ID,
        candidates: [{ usi: '8c8d', pv: ['8c8d'], scoreCp: 0, mate: null, depth: 1 }],
        terminal: null,
        mateProof: null,
      }),
    );
    await expect(analysis).rejects.toThrow('解析がキャンセルされました');
  });

  it('rejects malformed board geometry before loading the native module', async () => {
    vi.mocked(requireOptionalNativeModule).mockReturnValue(null);
    await expect(
      analyzeNative('4k5/9/9/9/9/9/9/9/4K4 b - 1', { nodes: 1, multiPV: 1 }),
    ).rejects.toThrow('SFEN');
  });
});
