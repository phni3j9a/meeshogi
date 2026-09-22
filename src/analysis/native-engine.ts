import { requireOptionalNativeModule } from 'expo-modules-core';
import { applyUsi, boardView, isInCheck, legalMoves } from '../domain';
import type {
  AnalysisCandidate,
  AnalysisConditions,
  MateProof,
  PositionAnalysis,
  Side,
} from '../domain/model';

import { AnalysisBudgetIncompleteError } from './errors';
import { ENGINE_ID, MODEL_ID } from './identity';
export { ENGINE_ID, MODEL_ID } from './identity';
export { AnalysisBudgetIncompleteError } from './errors';

const NATIVE_MODULE_NAME = 'MeeshogiSekirei';
const MIN_NODES = 1;
const MAX_NODES = 10_000_000;
const MAX_MULTI_PV = 3;
const MAX_DEPTH = 64;

type NativeSekireiModule = {
  initializeAsync(): Promise<void>;
  prepareRequest(): number;
  analyzeAsync(
    sfen: string,
    nodes: number,
    multiPV: number,
    requestId: number,
  ): Promise<string | NativePayload>;
  cancelAsync(requestId: number): void | Promise<void>;
};

type NativePayload = {
  status: string;
  sfen: string;
  engineId: string;
  modelId: string;
  nodes: unknown;
  depth: unknown;
  candidates: unknown;
  terminal: unknown;
  mateProof: unknown;
  meta: unknown;
};

type NativeMeta = {
  requestedNodes: number;
  nodes: number;
  completedDepth: number;
  fallback: boolean;
  budgetReached: boolean;
};

let initialization: Promise<void> | undefined;
let cancellationGeneration = 0;
let currentRequestId: number | undefined;

function nativeModule(): NativeSekireiModule | null {
  return requireOptionalNativeModule<NativeSekireiModule>(NATIVE_MODULE_NAME);
}

function ensureModule(): NativeSekireiModule {
  const module = nativeModule();
  if (!module) {
    throw new Error(
      '端末内解析エンジンがこのビルドに含まれていません。iOS または Android の native build を使用してください。',
    );
  }
  return module;
}

function ensureConditions(conditions: AnalysisConditions): void {
  if (
    !Number.isSafeInteger(conditions.nodes) ||
    conditions.nodes < MIN_NODES ||
    conditions.nodes > MAX_NODES
  ) {
    throw new Error(`解析ノード数は ${MIN_NODES} から ${MAX_NODES} の整数で指定してください。`);
  }
  if (
    !Number.isSafeInteger(conditions.multiPV) ||
    conditions.multiPV < 1 ||
    conditions.multiPV > MAX_MULTI_PV
  ) {
    throw new Error(`候補手数は 1 から ${MAX_MULTI_PV} の整数で指定してください。`);
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`ネイティブ解析結果の ${label} が不正です。`);
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`ネイティブ解析結果の ${label} が不正です。`);
  return value;
}

function asFiniteInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`ネイティブ解析結果の ${label} が不正です。`);
  return value as number;
}

function asPv(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((move) => typeof move !== 'string' || move.length === 0)
  ) {
    throw new Error(`ネイティブ解析結果の ${label} が不正です。`);
  }
  return value as string[];
}

function nullableInteger(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  return asFiniteInteger(value, label);
}

function parseCandidate(value: unknown, index: number): AnalysisCandidate {
  const candidate = asRecord(value, `candidates[${index}]`);
  const scoreCp = nullableInteger(candidate.scoreCp, `candidates[${index}].scoreCp`);
  const mate = nullableInteger(candidate.mate, `candidates[${index}].mate`);
  if ((scoreCp === null) === (mate === null))
    throw new Error(`候補 ${index + 1} には score または mate の一方が必要です。`);
  const depth = asFiniteInteger(candidate.depth, `candidates[${index}].depth`);
  if (depth < 0 || depth > MAX_DEPTH)
    throw new Error(`ネイティブ解析結果の candidates[${index}].depth が不正です。`);
  return {
    usi: asString(candidate.usi, `candidates[${index}].usi`),
    pv: asPv(candidate.pv, `candidates[${index}].pv`),
    scoreCp,
    mate,
    depth,
  };
}

function parseMeta(value: unknown, conditions: AnalysisConditions): NativeMeta {
  const meta = asRecord(value, 'meta');
  const requestedNodes = asFiniteInteger(meta.requestedNodes, 'meta.requestedNodes');
  const nodes = asFiniteInteger(meta.nodes, 'meta.nodes');
  const completedDepth = asFiniteInteger(meta.completedDepth, 'meta.completedDepth');
  if (
    requestedNodes < MIN_NODES ||
    requestedNodes > MAX_NODES ||
    requestedNodes !== conditions.nodes ||
    nodes < 0 ||
    completedDepth < 0 ||
    completedDepth > MAX_DEPTH
  ) {
    throw new Error('ネイティブ解析結果の meta の整数範囲が不正です。');
  }
  if (typeof meta.fallback !== 'boolean' || typeof meta.budgetReached !== 'boolean') {
    throw new Error('ネイティブ解析結果の meta の真偽値が不正です。');
  }
  if (meta.budgetReached !== nodes >= requestedNodes) {
    throw new Error('ネイティブ解析結果の meta の成立条件が不正です。');
  }
  return {
    requestedNodes,
    nodes,
    completedDepth,
    fallback: meta.fallback,
    budgetReached: meta.budgetReached,
  };
}

function sideFromSfen(sfen: string): Side {
  const side = sfen.trim().split(/\s+/u)[1];
  if (side === 'b') return 'black';
  if (side === 'w') return 'white';
  throw new Error('SFEN の手番が不正です。');
}

function validateSfen(sfen: string): void {
  let board: ReturnType<typeof boardView>;
  try {
    board = boardView(sfen);
  } catch {
    throw new Error('解析する SFEN が不正です。');
  }
  const blackKings = board.cells.filter(
    (cell) => cell.side === 'black' && cell.piece === 'king',
  ).length;
  const whiteKings = board.cells.filter(
    (cell) => cell.side === 'white' && cell.piece === 'king',
  ).length;
  if (blackKings !== 1 || whiteKings !== 1) {
    throw new Error('解析する SFEN には先後の玉が1つずつ必要です。');
  }
}

function validatePv(sfen: string, pv: string[], label: string): void {
  let current = sfen;
  try {
    for (const move of pv) {
      if (!legalMoves(current).includes(move)) throw new Error('illegal move');
      current = applyUsi(current, move);
    }
  } catch {
    throw new Error(`ネイティブ解析結果の ${label} に合法でない指し手があります。`);
  }
}

function validateCandidatePv(sfen: string, candidate: AnalysisCandidate, index: number): void {
  if (candidate.pv.length === 0 || candidate.pv[0] !== candidate.usi) {
    throw new Error(`候補 ${index + 1} の PV 先頭が候補手と一致しません。`);
  }
  validatePv(sfen, candidate.pv, `candidates[${index}].pv`);
}

function parseProof(value: unknown, expectedSide: Side, sfen: string): MateProof | null {
  if (value === null || value === undefined) return null;
  const proof = asRecord(value, 'mateProof');
  const status = asString(proof.status, 'mateProof.status');
  if (status !== 'proven' && status !== 'not-found' && status !== 'incomplete') {
    throw new Error('ネイティブ解析結果の mateProof.status が不正です。');
  }
  const side = asString(proof.side, 'mateProof.side');
  if (side !== 'black' && side !== 'white')
    throw new Error('ネイティブ解析結果の mateProof.side が不正です。');
  if (side !== expectedSide)
    throw new Error('ネイティブ解析結果の mateProof.side が局面の手番と一致しません。');
  const pliesValue = proof.plies;
  const plies =
    pliesValue === null || pliesValue === undefined
      ? undefined
      : asFiniteInteger(pliesValue, 'mateProof.plies');
  if (plies !== undefined && plies !== 1 && plies !== 3)
    throw new Error('ネイティブ解析結果の mateProof.plies が不正です。');
  if (status === 'proven' && plies === undefined)
    throw new Error('証明済み詰みには手数が必要です。');
  const pv = asPv(proof.pv, 'mateProof.pv');
  if (status === 'proven' && pv.length !== plies)
    throw new Error('証明済み詰みの PV 長が手数と一致しません。');
  if (status !== 'proven' && (plies !== undefined || pv.length !== 0))
    throw new Error('未証明の詰み結果には手数と PV を設定できません。');
  if (pv.length > 0) validatePv(sfen, pv, 'mateProof.pv');
  return { status, plies, side: side as Side, pv };
}

function parseNativeResult(
  raw: string | NativePayload,
  sfen: string,
  conditions: AnalysisConditions,
): PositionAnalysis {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new Error('ネイティブ解析結果を JSON として読めません。');
    }
  }
  const result = asRecord(value, 'result');
  if (typeof result.error === 'string') throw new Error(result.error);
  const status = asString(result.status, 'status');
  const resultSfen = asString(result.sfen, 'sfen');
  if (resultSfen !== sfen) throw new Error('ネイティブ解析結果の局面が一致しません。');
  if (
    asString(result.engineId, 'engineId') !== ENGINE_ID ||
    asString(result.modelId, 'modelId') !== MODEL_ID
  ) {
    throw new Error('ネイティブ解析結果の engine/model identity が一致しません。');
  }
  const meta = parseMeta(result.meta, conditions);
  const nodes = asFiniteInteger(result.nodes, 'nodes');
  const depth = asFiniteInteger(result.depth, 'depth');
  if (nodes !== meta.nodes || depth !== meta.completedDepth) {
    throw new Error('ネイティブ解析結果のトップレベル nodes/depth と meta が一致しません。');
  }
  const expectedSide = sideFromSfen(sfen);
  if (!Array.isArray(result.candidates))
    throw new Error('ネイティブ解析結果の candidates が不正です。');
  const candidates = result.candidates.map((candidate, index) => parseCandidate(candidate, index));
  candidates.forEach((candidate, index) => validateCandidatePv(sfen, candidate, index));
  const candidateMoves = new Set<string>();
  for (const candidate of candidates) {
    if (candidateMoves.has(candidate.usi))
      throw new Error('ネイティブ解析結果に候補手の重複があります。');
    candidateMoves.add(candidate.usi);
  }
  const terminalValue = result.terminal;
  const terminal =
    terminalValue === null || terminalValue === undefined
      ? undefined
      : asString(terminalValue, 'terminal');
  if (terminal !== undefined && terminal !== 'checkmate' && terminal !== 'no-legal-moves') {
    throw new Error('ネイティブ解析結果の terminal が不正です。');
  }
  let positionLegalMoves: string[];
  try {
    positionLegalMoves = legalMoves(sfen);
  } catch {
    throw new Error('解析結果の検証対象となる局面の合法手を取得できません。');
  }
  if (candidates.length > 0 && terminal !== undefined)
    throw new Error('候補手のある解析に terminal が設定されています。');
  if (terminal === undefined) {
    if (positionLegalMoves.length === 0) {
      throw new Error('合法手のない解析結果には terminal が必要です。');
    }
  } else {
    if (candidates.length !== 0) throw new Error('終局解析には候補手を設定できません。');
    if (meta.nodes !== 0 || meta.completedDepth !== 0 || meta.fallback) {
      throw new Error('終局解析の meta.nodes と meta.completedDepth は0である必要があります。');
    }
    if (positionLegalMoves.length !== 0)
      throw new Error('候補手のない解析結果ですが、局面に合法手があります。');
    let inCheck: boolean;
    try {
      inCheck = isInCheck(sfen);
    } catch {
      throw new Error('終局解析の王手状態を検証できません。');
    }
    const expectedTerminal = inCheck ? 'checkmate' : 'no-legal-moves';
    if (terminal !== expectedTerminal) {
      throw new Error('ネイティブ解析結果の terminal が局面の王手状態と一致しません。');
    }
  }
  const mateProof = parseProof(result.mateProof, expectedSide, sfen);
  if (status === 'incomplete') {
    if (
      terminal !== undefined ||
      positionLegalMoves.length === 0 ||
      meta.completedDepth !== 0 ||
      !meta.fallback ||
      !meta.budgetReached
    ) {
      throw new Error('ネイティブ解析の incomplete 結果が予算不足の成立条件を満たしません。');
    }
    const maxFallbackCandidates = Math.min(conditions.multiPV, positionLegalMoves.length);
    if (candidates.length < 1 || candidates.length > maxFallbackCandidates) {
      throw new Error('ネイティブ解析結果の予算不足候補手数が不正です。');
    }
    if (candidates.some((candidate) => candidate.depth !== meta.completedDepth)) {
      throw new Error(
        'ネイティブ解析結果の予算不足候補手 depth が meta.completedDepth と一致しません。',
      );
    }
    throw new AnalysisBudgetIncompleteError(sfen, conditions, meta);
  }
  if (status !== 'complete') throw new Error(`ネイティブ解析が完了しませんでした: ${status}`);
  if (terminal === undefined) {
    if (meta.fallback || meta.completedDepth === 0) {
      throw new Error('未完了のネイティブ解析を完了結果として保存できません。');
    }
    if (candidates.some((candidate) => candidate.depth !== meta.completedDepth)) {
      throw new Error('ネイティブ解析結果の候補手 depth が meta.completedDepth と一致しません。');
    }
    const expectedCandidates = Math.min(conditions.multiPV, positionLegalMoves.length);
    if (candidates.length !== expectedCandidates) {
      throw new Error(`ネイティブ解析結果の候補手数が不正です。期待値: ${expectedCandidates}`);
    }
  }
  return {
    sfen,
    engineId: ENGINE_ID,
    modelId: MODEL_ID,
    status: 'complete',
    meta,
    conditions: { ...conditions },
    candidates,
    ...(terminal === undefined ? {} : { terminal }),
    mateProof,
    completedAt: new Date().toISOString(),
  };
}

async function initialize(module: NativeSekireiModule): Promise<void> {
  if (!initialization) {
    initialization = module.initializeAsync().catch((error) => {
      initialization = undefined;
      throw error;
    });
  }
  await initialization;
}

export async function analyzeNative(
  sfen: string,
  conditions: AnalysisConditions,
): Promise<PositionAnalysis> {
  const requestGeneration = cancellationGeneration;
  if (!sfen.trim()) throw new Error('解析する SFEN が空です。');
  ensureConditions(conditions);
  validateSfen(sfen);
  const module = ensureModule();
  await initialize(module);
  if (requestGeneration !== cancellationGeneration) throw new Error('解析がキャンセルされました。');
  const requestId = module.prepareRequest();
  if (!Number.isSafeInteger(requestId) || requestId <= 0)
    throw new Error('ネイティブ解析の request id が不正です。');
  currentRequestId = requestId;
  try {
    const result = await module.analyzeAsync(sfen, conditions.nodes, conditions.multiPV, requestId);
    // A native request can finish at the same time as cancelAsync(). Keep the
    // generation check after the await so a result that crossed that boundary
    // cannot be persisted by the caller.
    if (requestGeneration !== cancellationGeneration)
      throw new Error('解析がキャンセルされました。');
    return parseNativeResult(result, sfen, conditions);
  } finally {
    if (currentRequestId === requestId) currentRequestId = undefined;
  }
}

export async function cancelNative(): Promise<void> {
  cancellationGeneration += 1;
  const module = nativeModule();
  if (module && currentRequestId !== undefined) await module.cancelAsync(currentRequestId);
}
