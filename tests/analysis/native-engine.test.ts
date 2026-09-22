import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: vi.fn(),
}));

import { requireOptionalNativeModule } from 'expo-modules-core';
import { analyzeNative, cancelNative, ENGINE_ID, MODEL_ID } from '../../src/analysis/native-engine';
import { AnalysisBudgetIncompleteError } from '../../src/analysis/errors';

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
      analyzeAsync: vi.fn(
        async (_sfen: string, _nodes: number, _multiPV: number, _requestId: number) =>
          JSON.stringify({
            status: 'complete',
            sfen: initialSfen,
            engineId: ENGINE_ID,
            modelId: MODEL_ID,
            nodes: 1,
            depth: 1,
            candidates: [{ usi: '8c8d', pv: ['8c8d'], scoreCp: 0, mate: null, depth: 1 }],
            terminal: null,
            mateProof: null,
            meta: {
              requestedNodes: 1,
              nodes: 1,
              completedDepth: 1,
              fallback: false,
              budgetReached: true,
            },
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
    for (
      let attempt = 0;
      attempt < 8 && nativeModule.analyzeAsync.mock.calls.length === 0;
      attempt += 1
    ) {
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
        nodes: 1,
        depth: 1,
        candidates: [{ usi: '8c8d', pv: ['8c8d'], scoreCp: 0, mate: null, depth: 1 }],
        terminal: null,
        mateProof: null,
        meta: {
          requestedNodes: 1,
          nodes: 1,
          completedDepth: 1,
          fallback: false,
          budgetReached: true,
        },
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
    nodes: 1,
    depth: 1,
    candidates: [{ usi: '8c8d', pv: ['8c8d'], scoreCp: 0, mate: null, depth: 1 }],
    terminal: null,
    mateProof: null,
    meta: { requestedNodes: 1, nodes: 1, completedDepth: 1, fallback: false, budgetReached: true },
    ...overrides,
  };
}

function incompletePayload(sfen: string, overrides: Record<string, unknown> = {}) {
  return {
    status: 'incomplete',
    sfen,
    engineId: ENGINE_ID,
    modelId: MODEL_ID,
    nodes: 1,
    depth: 0,
    candidates: [{ usi: '8c8d', pv: ['8c8d'], scoreCp: -1, mate: null, depth: 0 }],
    terminal: null,
    mateProof: null,
    meta: { requestedNodes: 1, nodes: 1, completedDepth: 0, fallback: true, budgetReached: true },
    ...overrides,
  };
}

describe('native result contract', () => {
  it('converts a fully validated budget-incomplete position to the dedicated error', async () => {
    const nativeModule = nativeModuleFor(incompletePayload(initialSfen));
    vi.mocked(requireOptionalNativeModule).mockReturnValue(nativeModule);
    const error = await analyzeNative(initialSfen, { nodes: 1, multiPV: 1 }).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(AnalysisBudgetIncompleteError);
    expect((error as AnalysisBudgetIncompleteError).meta).toMatchObject({
      requestedNodes: 1,
      completedDepth: 0,
      fallback: true,
      budgetReached: true,
    });
    expect((error as Error).message).toContain('探索量が不足');
    expect((error as Error).message).not.toContain(initialSfen);
  });

  it.each([
    [
      'fallback flag is false',
      incompletePayload(initialSfen, {
        meta: {
          requestedNodes: 1,
          nodes: 1,
          completedDepth: 0,
          fallback: false,
          budgetReached: true,
        },
      }),
    ],
    [
      'budget was not reached',
      incompletePayload(initialSfen, {
        nodes: 0,
        meta: {
          requestedNodes: 1,
          nodes: 0,
          completedDepth: 0,
          fallback: true,
          budgetReached: false,
        },
      }),
    ],
    [
      'a completed depth is present',
      incompletePayload(initialSfen, {
        nodes: 1,
        depth: 1,
        candidates: [{ usi: '8c8d', pv: ['8c8d'], scoreCp: -1, mate: null, depth: 1 }],
        meta: {
          requestedNodes: 1,
          nodes: 1,
          completedDepth: 1,
          fallback: true,
          budgetReached: true,
        },
      }),
    ],
    [
      'the position is terminal',
      incompletePayload(whiteCheckmateSfen, {
        nodes: 0,
        depth: 0,
        candidates: [],
        terminal: 'checkmate',
        meta: {
          requestedNodes: 1,
          nodes: 0,
          completedDepth: 0,
          fallback: false,
          budgetReached: false,
        },
      }),
    ],
    [
      'fallback PV is illegal',
      incompletePayload(initialSfen, {
        candidates: [{ usi: '8c8e', pv: ['8c8e'], scoreCp: -1, mate: null, depth: 0 }],
      }),
    ],
    [
      'fallback candidates are duplicated',
      incompletePayload(initialSfen, {
        candidates: [
          { usi: '8c8d', pv: ['8c8d'], scoreCp: -1, mate: null, depth: 0 },
          { usi: '8c8d', pv: ['8c8d'], scoreCp: -2, mate: null, depth: 0 },
        ],
      }),
    ],
    [
      'fallback mate proof is malformed',
      incompletePayload(initialSfen, {
        mateProof: { status: 'incomplete', side: 'white', plies: 1, pv: [] },
      }),
    ],
    ['fallback candidate set is empty', incompletePayload(initialSfen, { candidates: [] })],
    ['status is unknown', incompletePayload(initialSfen, { status: 'paused' })],
  ])('keeps %s on the ordinary fatal path', async (_name, payload) => {
    vi.mocked(requireOptionalNativeModule).mockReturnValue(nativeModuleFor(payload));
    const error = await analyzeNative(initialSfen, { nodes: 1, multiPV: 2 }).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AnalysisBudgetIncompleteError);
  });

  it.each([
    ['missing meta', undefined],
    [
      'non-integer requestedNodes',
      { requestedNodes: 1.5, nodes: 1, completedDepth: 1, fallback: false, budgetReached: true },
    ],
    [
      'invalid nodes range',
      { requestedNodes: 1, nodes: -1, completedDepth: 1, fallback: false, budgetReached: true },
    ],
    [
      'invalid boolean',
      { requestedNodes: 1, nodes: 1, completedDepth: 1, fallback: 'false', budgetReached: true },
    ],
    [
      'fallback on complete result',
      { requestedNodes: 1, nodes: 1, completedDepth: 1, fallback: true, budgetReached: true },
    ],
    [
      'budget flag mismatch',
      { requestedNodes: 1, nodes: 1, completedDepth: 1, fallback: false, budgetReached: false },
    ],
  ])('rejects malformed meta: %s', async (_name, meta) => {
    const nativeModule = nativeModuleFor(completePayload(initialSfen, { meta }));
    vi.mocked(requireOptionalNativeModule).mockReturnValue(nativeModule);
    await expect(analyzeNative(initialSfen, { nodes: 1, multiPV: 1 })).rejects.toThrow(
      meta === undefined || (meta as Record<string, unknown>).fallback !== true ? 'meta' : '未完了',
    );
  });

  it('keeps an incomplete mate proof separate from a complete search result', async () => {
    const nativeModule = nativeModuleFor(
      completePayload(initialSfen, {
        mateProof: { status: 'incomplete', side: 'white', pv: [] },
      }),
    );
    vi.mocked(requireOptionalNativeModule).mockReturnValue(nativeModule);
    await expect(analyzeNative(initialSfen, { nodes: 1, multiPV: 1 })).resolves.toMatchObject({
      status: 'complete',
      mateProof: { status: 'incomplete', side: 'white', pv: [] },
    });
  });

  it('accepts observed nodes above the requested budget', async () => {
    const nativeModule = nativeModuleFor(
      completePayload(initialSfen, {
        nodes: 10001,
        meta: {
          requestedNodes: 10000,
          nodes: 10001,
          completedDepth: 1,
          fallback: false,
          budgetReached: true,
        },
      }),
    );
    vi.mocked(requireOptionalNativeModule).mockReturnValue(nativeModule);

    await expect(analyzeNative(initialSfen, { nodes: 10000, multiPV: 1 })).resolves.toMatchObject({
      status: 'complete',
      meta: {
        requestedNodes: 10000,
        nodes: 10001,
        budgetReached: true,
      },
    });
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
    expect(analysis).toMatchObject({
      status: 'complete',
      meta: {
        requestedNodes: 1,
        nodes: 1,
        completedDepth: 1,
        fallback: false,
        budgetReached: true,
      },
      candidates: [{ usi: '8c8d' }, { usi: '2c2d' }],
    });
  });

  it('rejects top-level nodes/depth that disagree with meta', async () => {
    vi.mocked(requireOptionalNativeModule).mockReturnValue(
      nativeModuleFor(completePayload(initialSfen, { nodes: 2 })),
    );
    await expect(analyzeNative(initialSfen, { nodes: 1, multiPV: 1 })).rejects.toThrow(
      'トップレベル nodes/depth と meta が一致しません',
    );
  });

  it('rejects a non-terminal candidate depth that disagrees with meta.completedDepth', async () => {
    vi.mocked(requireOptionalNativeModule).mockReturnValue(
      nativeModuleFor(
        completePayload(initialSfen, {
          candidates: [{ usi: '8c8d', pv: ['8c8d'], scoreCp: 0, mate: null, depth: 2 }],
        }),
      ),
    );
    await expect(analyzeNative(initialSfen, { nodes: 1, multiPV: 1 })).rejects.toThrow(
      '候補手 depth が meta.completedDepth と一致しません',
    );
  });

  it('rejects terminal metadata with non-zero nodes or completedDepth', async () => {
    vi.mocked(requireOptionalNativeModule).mockReturnValue(
      nativeModuleFor(
        completePayload(whiteCheckmateSfen, {
          candidates: [],
          terminal: 'checkmate',
          nodes: 1,
          depth: 1,
          meta: {
            requestedNodes: 1,
            nodes: 1,
            completedDepth: 1,
            fallback: false,
            budgetReached: true,
          },
        }),
      ),
    );
    await expect(analyzeNative(whiteCheckmateSfen, { nodes: 1, multiPV: 1 })).rejects.toThrow(
      '終局解析の meta.nodes と meta.completedDepth は0である必要があります',
    );
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
          nodes: 0,
          depth: 0,
          meta: {
            requestedNodes: 1,
            nodes: 0,
            completedDepth: 0,
            fallback: false,
            budgetReached: false,
          },
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
          nodes: 0,
          depth: 0,
          meta: {
            requestedNodes: 1,
            nodes: 0,
            completedDepth: 0,
            fallback: false,
            budgetReached: false,
          },
        }),
      ),
    );
    await expect(analyzeNative(sfen, { nodes: 1, multiPV: 1 })).rejects.toThrow('王手状態');
  });
});
