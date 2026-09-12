import { requireOptionalNativeModule } from 'expo-modules-core';
import { applyUsi, legalMoves } from '../domain';
import type { AnalysisCandidate, AnalysisConditions, MateProof, PositionAnalysis, Side } from '../domain/model';

export const ENGINE_ID = 'sekirei-v0.3.36@aeb6ea30d58f93cad84ffe98bc13441feb807fa8';
export const MODEL_ID = 'c-leaf-wrm-seed42@807c18da03521414a8c75dfe51dd4de2caf8e9ec4909320826eac12b66852eab';

const NATIVE_MODULE_NAME = 'MeeshogiSekirei';
const MIN_NODES = 1;
const MAX_NODES = 10_000_000;
const MAX_MULTI_PV = 3;

type NativeSekireiModule = {
  initializeAsync(): Promise<void>;
  analyzeAsync(sfen: string, nodes: number, multiPV: number): Promise<string | NativePayload>;
  cancelAsync(): void | Promise<void>;
};

type NativePayload = {
  status: string;
  sfen: string;
  engineId: string;
  modelId: string;
  candidates: unknown;
  terminal: unknown;
  mateProof: unknown;
};

let initialization: Promise<void> | undefined;
let cancellationGeneration = 0;

function nativeModule(): NativeSekireiModule | null {
  return requireOptionalNativeModule<NativeSekireiModule>(NATIVE_MODULE_NAME);
}

function ensureModule(): NativeSekireiModule {
  const module = nativeModule();
  if (!module) {
    throw new Error('端末内解析エンジンがこのビルドに含まれていません。iOS または Android の native build を使用してください。');
  }
  return module;
}

function ensureConditions(conditions: AnalysisConditions): void {
  if (!Number.isSafeInteger(conditions.nodes) || conditions.nodes < MIN_NODES || conditions.nodes > MAX_NODES) {
    throw new Error(`解析ノード数は ${MIN_NODES} から ${MAX_NODES} の整数で指定してください。`);
  }
  if (!Number.isSafeInteger(conditions.multiPV) || conditions.multiPV < 1 || conditions.multiPV > MAX_MULTI_PV) {
    throw new Error(`候補手数は 1 から ${MAX_MULTI_PV} の整数で指定してください。`);
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`ネイティブ解析結果の ${label} が不正です。`);
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
  if (!Array.isArray(value) || value.some(move => typeof move !== 'string' || move.length === 0)) {
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
  if (scoreCp !== null && mate !== null) throw new Error(`候補 ${index + 1} に score と mate が同時に設定されています。`);
  return {
    usi: asString(candidate.usi, `candidates[${index}].usi`),
    pv: asPv(candidate.pv, `candidates[${index}].pv`),
    scoreCp,
    mate,
    depth: asFiniteInteger(candidate.depth, `candidates[${index}].depth`),
  };
}

function sideFromSfen(sfen: string): Side {
  const side = sfen.trim().split(/\s+/u)[1];
  if (side === 'b') return 'black';
  if (side === 'w') return 'white';
  throw new Error('SFEN の手番が不正です。');
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
  if (side !== 'black' && side !== 'white') throw new Error('ネイティブ解析結果の mateProof.side が不正です。');
  if (side !== expectedSide) throw new Error('ネイティブ解析結果の mateProof.side が局面の手番と一致しません。');
  const pliesValue = proof.plies;
  const plies = pliesValue === null || pliesValue === undefined ? undefined : asFiniteInteger(pliesValue, 'mateProof.plies');
  if (plies !== undefined && plies !== 1 && plies !== 3) throw new Error('ネイティブ解析結果の mateProof.plies が不正です。');
  if (status === 'proven' && plies === undefined) throw new Error('証明済み詰みには手数が必要です。');
  const pv = asPv(proof.pv, 'mateProof.pv');
  if (status === 'proven' && pv.length !== plies) throw new Error('証明済み詰みの PV 長が手数と一致しません。');
  if (pv.length > 0) validatePv(sfen, pv, 'mateProof.pv');
  return { status, plies, side: side as Side, pv };
}

function parseNativeResult(raw: string | NativePayload, sfen: string, conditions: AnalysisConditions): PositionAnalysis {
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
  if (status !== 'complete') throw new Error(`ネイティブ解析が完了しませんでした: ${status}`);
  if (asString(result.sfen, 'sfen') !== sfen) throw new Error('ネイティブ解析結果の局面が一致しません。');
  if (asString(result.engineId, 'engineId') !== ENGINE_ID || asString(result.modelId, 'modelId') !== MODEL_ID) {
    throw new Error('ネイティブ解析結果の engine/model identity が一致しません。');
  }
  const expectedSide = sideFromSfen(sfen);
  if (!Array.isArray(result.candidates)) throw new Error('ネイティブ解析結果の candidates が不正です。');
  const candidates = result.candidates.map((candidate, index) => parseCandidate(candidate, index));
  candidates.forEach((candidate, index) => validateCandidatePv(sfen, candidate, index));
  const terminalValue = result.terminal;
  const terminal = terminalValue === null || terminalValue === undefined ? undefined : asString(terminalValue, 'terminal');
  if (terminal !== undefined && terminal !== 'checkmate' && terminal !== 'no-legal-moves') {
    throw new Error('ネイティブ解析結果の terminal が不正です。');
  }
  if (candidates.length === 0 && terminal === undefined) throw new Error('ネイティブ解析結果に候補手がありません。');
  if (candidates.length > 0 && terminal !== undefined) throw new Error('候補手のある解析に terminal が設定されています。');
  if (candidates.length === 0) {
    try {
      if (legalMoves(sfen).length !== 0) throw new Error('position has legal moves');
    } catch {
      throw new Error('候補手のない解析結果ですが、局面に合法手があります。');
    }
  }
  return {
    sfen,
    engineId: ENGINE_ID,
    modelId: MODEL_ID,
    conditions: { ...conditions },
    candidates,
    ...(terminal === undefined ? {} : { terminal }),
    mateProof: parseProof(result.mateProof, expectedSide, sfen),
    completedAt: new Date().toISOString(),
  };
}

async function initialize(module: NativeSekireiModule): Promise<void> {
  if (!initialization) {
    initialization = module.initializeAsync().catch(error => {
      initialization = undefined;
      throw error;
    });
  }
  await initialization;
}

export async function analyzeNative(sfen: string, conditions: AnalysisConditions): Promise<PositionAnalysis> {
  const requestGeneration = cancellationGeneration;
  if (!sfen.trim()) throw new Error('解析する SFEN が空です。');
  ensureConditions(conditions);
  const module = ensureModule();
  await initialize(module);
  if (requestGeneration !== cancellationGeneration) throw new Error('解析がキャンセルされました。');
  const result = await module.analyzeAsync(sfen, conditions.nodes, conditions.multiPV);
  return parseNativeResult(result, sfen, conditions);
}

export async function cancelNative(): Promise<void> {
  cancellationGeneration += 1;
  const module = nativeModule();
  if (module) await module.cancelAsync();
}
