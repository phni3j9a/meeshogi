import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: vi.fn(),
}));

import { requireOptionalNativeModule } from 'expo-modules-core';
import { analyzeNative, cancelNative, ENGINE_ID, MODEL_ID } from '../../src/analysis/native-engine';

const initialSfen = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL w - 1';
const whiteCheckmateSfen = '4k4/3RG4/9/9/9/9/9/9/8K w - 1';
const blackCheckmateSfen = '8k/9/9/9/9/9/9/3rg4/4K4 b - 1';
const noLegalMovesSfen = 'k8/9/9/9/9/9/4n4/2r6/4K4 b - 1';

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
          meta: { requestedNodes: 1, nodes: 1, completedDepth: 1, fallback: false, budgetReached: true },
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
        meta: { requestedNodes: 1, nodes: 1, completedDepth: 1, fallback: false, budgetReached: true },
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

function nativeModuleFor(result: unknown) {
  return {
    initializeAsync: vi.fn(async () => undefined),
    prepareRequest: vi.fn(() => 99),
    analyzeAsync: vi.fn(async () => JSON.stringify(result)),
    cancelAsync: vi.fn(async (_requestId: number) => undefined),
  };
}

function completePayload(sfen: string, overrides: Record<string, unknown> = {}) {
  return {
    status: 'complete',
    sfen,
    engineId: ENGINE_ID,
    modelId: MODEL_ID,
    candidates: [{ usi: '8c8d', pv: ['8c8d'], scoreCp: 0, mate: null, depth: 1 }],
    terminal: null,
    mateProof: null,
    meta: { requestedNodes: 1, nodes: 1, completedDepth: 1, fallback: false, budgetReached: true },
    ...overrides,
  };
}

describe('native result contract', () => {
  it('rejects an incomplete first iteration through the existing error path', async () => {
    const nativeModule = nativeModuleFor({ status: 'incomplete' });
    vi.mocked(requireOptionalNativeModule).mockReturnValue(nativeModule);
    await expect(analyzeNative(initialSfen, { nodes: 1, multiPV: 1 })).rejects.toThrow(
      'ネイティブ解析が完了しませんでした: incomplete',
    );
  });

  it.each([
    ['missing meta', undefined],
    ['non-integer requestedNodes', { requestedNodes: 1.5, nodes: 1, completedDepth: 1, fallback: false, budgetReached: true }],
    ['invalid nodes range', { requestedNodes: 1, nodes: -1, completedDepth: 1, fallback: false, budgetReached: true }],
    ['invalid boolean', { requestedNodes: 1, nodes: 1, completedDepth: 1, fallback: 'false', budgetReached: true }],
  ])('rejects malformed meta: %s', async (_name, meta) => {
    const nativeModule = nativeModuleFor(completePayload(initialSfen, { meta }));
    vi.mocked(requireOptionalNativeModule).mockReturnValue(nativeModule);
    await expect(analyzeNative(initialSfen, { nodes: 1, multiPV: 1 })).rejects.toThrow('meta');
  });

  it('requires exactly the requested number of legal candidates for a complete position', async () => {
    const oneCandidate = completePayload(initialSfen);
    const nativeModule = nativeModuleFor(oneCandidate);
    vi.mocked(requireOptionalNativeModule).mockReturnValue(nativeModule);
    await expect(analyzeNative(initialSfen, { nodes: 1, multiPV: 2 })).rejects.toThrow('候補手数');

    const twoCandidates = completePayload(initialSfen, {
      candidates: [
        { usi: '8c8d', pv: ['8c8d'], scoreCp: 0, mate: null, depth: 1 },
        { usi: '2c2d', pv: ['2c2d'], scoreCp: -10, mate: null, depth: 1 },
      ],
    });
    vi.mocked(requireOptionalNativeModule).mockReturnValue(nativeModuleFor(twoCandidates));
    const analysis = await analyzeNative(initialSfen, { nodes: 1, multiPV: 2 });
    expect(analysis.candidates.map((candidate) => candidate.usi)).toEqual(['8c8d', '2c2d']);
  });

  it('accepts both terminal kinds only when they match check state and legal moves', async () => {
    for (const [sfen, terminal] of [
      [whiteCheckmateSfen, 'checkmate'],
      [blackCheckmateSfen, 'checkmate'],
      [noLegalMovesSfen, 'no-legal-moves'],
    ] as const) {
      const nativeModule = nativeModuleFor(
        completePayload(sfen, {
          candidates: [],
          terminal,
          meta: { requestedNodes: 1, nodes: 0, completedDepth: 0, fallback: false, budgetReached: false },
        }),
      );
      vi.mocked(requireOptionalNativeModule).mockReturnValue(nativeModule);
      await expect(analyzeNative(sfen, { nodes: 1, multiPV: 1 })).resolves.toMatchObject({
        sfen,
        terminal,
        candidates: [],
      });
    }
  });

  it.each([
    [whiteCheckmateSfen, 'no-legal-moves'],
    [noLegalMovesSfen, 'checkmate'],
  ] as const)('rejects terminal %s for an inconsistent position', async (sfen, terminal) => {
    vi.mocked(requireOptionalNativeModule).mockReturnValue(
      nativeModuleFor(
        completePayload(sfen, {
          candidates: [],
          terminal,
          meta: { requestedNodes: 1, nodes: 0, completedDepth: 0, fallback: false, budgetReached: false },
        }),
      ),
    );
    await expect(analyzeNative(sfen, { nodes: 1, multiPV: 1 })).rejects.toThrow('王手状態');
  });
});
