import { Position } from 'tsshogi';
import { isInCheck, legalMoves } from '../domain';
import {
  DEFAULT_SETTINGS,
  PIECE_SET_IDS,
  type AnalysisMeta,
  type GameRecord,
  type Settings,
} from '../domain/model';
import { CURRENT_ANALYSIS_IDENTITY } from '../analysis/identity';
import { isValidAnalysisMeta } from '../analysis/meta';

const services = ['shogiwars', 'kiou', 'unknown'];
const sides = ['black', 'white'];
const openings = ['static', 'fourth-file', 'central', 'third-file', 'opposing', 'unknown'];
const usi = /^(?:[1-9][a-i][1-9][a-i]\+?|[PLNSGBR]\*[1-9][a-i])$/;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string';
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const member = (value: unknown, values: unknown[]) => values.includes(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(string);
const pv = (value: unknown): value is string[] =>
  strings(value) && value.length <= 64 && value.every((move) => usi.test(move));
function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new Error('保存したデータの形式が不正です。');
}
function validAnalysis(value: unknown, sfen: string): boolean {
  if (
    !object(value) ||
    value.sfen !== sfen ||
    !string(value.engineId) ||
    !value.engineId ||
    !string(value.modelId) ||
    !value.modelId ||
    !string(value.completedAt) ||
    !object(value.conditions) ||
    !integer(value.conditions.nodes, 1, 10_000_000) ||
    !integer(value.conditions.multiPV, 1, 3) ||
    !Array.isArray(value.candidates) ||
    value.candidates.length > 3
  )
    return false;
  const isCurrentIdentity =
    value.engineId === CURRENT_ANALYSIS_IDENTITY.engineId &&
    value.modelId === CURRENT_ANALYSIS_IDENTITY.modelId;
  // Current records fail closed when the complete-result contract is absent;
  // old identities remain lenient so loading never performs a destructive migration.
  const currentMeta = isValidAnalysisMeta(value.meta, value.conditions)
    ? (value.meta as AnalysisMeta)
    : undefined;
  if (isCurrentIdentity && (value.status !== 'complete' || !currentMeta)) return false;
  let positionLegalMoves: string[] | undefined;
  if (isCurrentIdentity) {
    try {
      positionLegalMoves = legalMoves(sfen);
    } catch {
      return false;
    }
  }
  if (
    !value.candidates.every(
      (candidate: unknown) =>
        object(candidate) &&
        string(candidate.usi) &&
        usi.test(candidate.usi) &&
        pv(candidate.pv) &&
        candidate.pv[0] === candidate.usi &&
        integer(candidate.depth, 0, 64) &&
        ((integer(candidate.scoreCp, -1_000_000, 1_000_000) && candidate.mate === null) ||
          (candidate.scoreCp === null && integer(candidate.mate, -1_000_000, 1_000_000))),
    )
  )
    return false;
  if (value.candidates.length === 0) {
    if (!member(value.terminal, ['checkmate', 'no-legal-moves'])) return false;
    if (isCurrentIdentity) {
      if (currentMeta?.nodes !== 0 || currentMeta?.completedDepth !== 0) return false;
      if (positionLegalMoves?.length !== 0) return false;
      let inCheck: boolean;
      try {
        inCheck = isInCheck(sfen);
      } catch {
        return false;
      }
      if (value.terminal !== (inCheck ? 'checkmate' : 'no-legal-moves')) return false;
    }
  } else if (value.terminal !== undefined) return false;
  if (
    isCurrentIdentity &&
    value.terminal === undefined &&
    (value.candidates.length !==
      Math.min(value.conditions.multiPV, positionLegalMoves?.length ?? 0) ||
      currentMeta?.nodes === 0 ||
      currentMeta?.fallback ||
      currentMeta?.completedDepth === 0 ||
      value.candidates.some(
        (candidate: unknown) =>
          !object(candidate) || candidate.depth !== currentMeta?.completedDepth,
      ))
  )
    return false;
  if (value.mateProof === null) return true;
  const proof = value.mateProof;
  if (
    !object(proof) ||
    !member(proof.status, ['proven', 'not-found', 'incomplete']) ||
    !member(proof.side, sides) ||
    !pv(proof.pv) ||
    proof.side !== (sfen.split(' ')[1] === 'b' ? 'black' : 'white')
  )
    return false;
  return proof.status === 'proven'
    ? member(proof.plies, [1, 3]) && proof.pv.length === proof.plies
    : proof.plies === undefined && proof.pv.length === 0;
}

/** Decode persisted schema 1 without coercing damaged fields into valid results. */
export function decodeGame(value: unknown, id: string, identity: string): GameRecord {
  requireValid(object(value));
  requireValid(value.id === id && string(id) && !!id && value.identity === identity && !!identity);
  requireValid(
    [
      'rawKif',
      'blackName',
      'whiteName',
      'startedAt',
      'timeControl',
      'termination',
      'createdAt',
    ].every((key) => string(value[key])),
  );
  requireValid(
    ['blackRank', 'whiteRank', 'endedAt'].every((key) => value[key] === null || string(value[key])),
  );
  requireValid(value.lastOpenedAt === undefined || string(value.lastOpenedAt));
  requireValid(
    member(value.manualResult, [
      undefined,
      null,
      'black-win',
      'white-win',
      'draw',
      'interrupted',
      'unknown',
    ]),
  );
  requireValid(object(value.headers) && Object.values(value.headers).every(string));
  requireValid(
    member(value.service, services) &&
      member(value.result, ['black-win', 'white-win', 'draw', 'interrupted', 'unknown']),
  );
  requireValid(
    typeof value.favorite === 'boolean' &&
      member(value.mySide, [...sides, null]) &&
      member(value.attribution, ['automatic', 'manual', 'ambiguous', 'none']),
  );
  requireValid(Array.isArray(value.moves) && value.moves.length <= 10_000);
  requireValid(
    value.moves.every(
      (move: unknown) =>
        object(move) &&
        string(move.usi) &&
        usi.test(move.usi) &&
        string(move.label) &&
        integer(move.elapsedMs) &&
        integer(move.totalElapsedMs),
    ),
  );
  requireValid(
    strings(value.positions) &&
      value.positions.length === value.moves.length + 1 &&
      value.positions.every((sfen) => Position.isValidSFEN(sfen)),
  );
  requireValid(integer(value.lastViewedPly, 0, value.moves.length));
  requireValid(object(value.openings) && string(value.openings.ruleVersion));
  requireValid(
    sides.every((side) => {
      const tag = (value.openings as Record<string, unknown>)[side];
      return (
        object(tag) && member(tag.automatic, openings) && member(tag.manual, [...openings, null])
      );
    }),
  );
  requireValid(object(value.analysis));
  requireValid(
    Object.entries(value.analysis).every(
      ([key, analysis]) =>
        /^(0|[1-9]\d*)$/.test(key) &&
        Number(key) < (value.positions as string[]).length &&
        validAnalysis(analysis, (value.positions as string[])[Number(key)]),
    ),
  );
  return value as unknown as GameRecord;
}

export function decodeSettings(value: unknown): Settings {
  requireValid(object(value));
  requireValid(value.playerNames === undefined || object(value.playerNames));
  const savedNames = value.playerNames as Record<string, unknown> | undefined;
  requireValid(
    !savedNames ||
      Object.entries(savedNames).every(
        ([service, names]) => services.includes(service) && strings(names),
      ),
  );
  const settings = {
    ...DEFAULT_SETTINGS,
    ...value,
    // An unavailable visual preset must not prevent saved games from loading.
    pieceSet: PIECE_SET_IDS.find((id) => id === value.pieceSet) ?? DEFAULT_SETTINGS.pieceSet,
    playerNames: { ...DEFAULT_SETTINGS.playerNames, ...savedNames },
  };
  requireValid(
    integer(settings.analysisNodes, 1000, 1_000_000) &&
      integer(settings.multiPV, 1, 3) &&
      member(settings.theme, ['system', 'light', 'dark']),
  );
  requireValid(
    ['autoAnalyze', 'boardFlip', 'showArrows', 'showMateBadges', 'haptics'].every(
      (key) => typeof (settings as Record<string, unknown>)[key] === 'boolean',
    ),
  );
  return settings as Settings;
}
