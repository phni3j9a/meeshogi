import type { AnalysisCandidate } from '../domain/model';
import {
  CLOUD_EXPECTED_IDENTITY,
  CLOUD_PROFILES,
  type CloudProfileId,
  type CloudResultRow,
  type CloudSearchConditions,
  type CloudWireRow,
} from './contract';

/**
 * A persisted Cloud result prepared for display. Candidates keep the raw
 * engine scores already normalized to sente (black) perspective by the server;
 * the app never flips them again and never synthesizes mateProof from them.
 */
export interface CloudPositionResult {
  ply: number;
  sfen: string;
  status: 'success' | 'incomplete' | 'terminal';
  terminal?: 'checkmate' | 'no-legal-moves';
  candidates: AnalysisCandidate[];
  meta: { nodes: number | null; completedDepth: number | null; elapsedMs: number | null };
  engineLaunch: number | null;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value);
const positiveInteger = (value: unknown): value is number =>
  integer(value) && (value as number) > 0;
const member = (value: unknown, values: readonly string[]) =>
  typeof value === 'string' && values.includes(value);

/** Score values are already normalized to sente perspective on the server. */
function decodeScore(value: unknown): { scoreCp: number | null; mate: number | null } | null {
  if (!object(value)) return null;
  if (value.kind === 'cp') {
    return integer(value.value) ? { scoreCp: value.value as number, mate: null } : null;
  }
  if (value.kind === 'mate') {
    if (!integer(value.value)) return null;
    if (!member(value.winningSide, ['sente', 'gote', 'unknown'])) return null;
    // winningSide is derived from the signed value by the driver; reject rows
    // where the two disagree rather than trusting either field alone.
    if (value.winningSide === 'sente' && !(value.value > 0)) return null;
    if (value.winningSide === 'gote' && !(value.value < 0)) return null;
    if (value.winningSide === 'unknown' && value.value !== 0) return null;
    // mate=0 or unknown winner carries no information: keep the candidate move
    // but expose neither a centipawn score nor a mate claim.
    if (value.value === 0 || value.winningSide === 'unknown') {
      return { scoreCp: null, mate: null };
    }
    return { scoreCp: null, mate: value.value as number };
  }
  return null;
}

/** Syntax only: the server validates move legality before publishing a row. */
function isUsiMove(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === (value.endsWith('+') ? 5 : 4) &&
    /^(?:[1-9][a-i][1-9][a-i]\+?|[PLNSGBR]\*[1-9][a-i])$/u.test(value)
  );
}

function decodePv(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) return null;
  if (!value.every(isUsiMove)) return null;
  return value as string[];
}

function requestedMatch(requested: unknown, profileId: CloudProfileId): boolean {
  const profile = CLOUD_PROFILES[profileId];
  if (!object(requested)) return false;
  return (
    requested.threads === profile.threads &&
    requested.hashMb === profile.hashMb &&
    requested.moveTimeMs === profile.moveTimeMs &&
    requested.multiPV === profile.multiPV
  );
}

function conditionsMatch(
  requested: unknown,
  actual: unknown,
  profileId: CloudProfileId,
): actual is CloudSearchConditions {
  const profile = CLOUD_PROFILES[profileId];
  if (!requestedMatch(requested, profileId) || !object(actual)) return false;
  return (
    actual.threads === profile.threads &&
    actual.hashMb === profile.hashMb &&
    actual.moveTimeMs === profile.moveTimeMs &&
    positiveInteger(actual.multiPV) &&
    actual.multiPV <= profile.multiPV
  );
}

/**
 * Check a server-validated row's shape, position, pinned identity and profile.
 * The server owns PV legality, terminal adjudication and the legal-move limit
 * on MultiPV. Never replay PVs or generate legal moves on the app's JS thread
 * here (including when reopening stored results). Interactive board moves
 * still go through the domain's move validation when applied.
 */
export function validateCloudResult(
  row: CloudWireRow,
  expectedSfen: string,
  profileId: CloudProfileId,
): CloudResultRow | null {
  const result = row.result;
  if (!object(result) || result.schemaVersion !== 1) return null;
  if (result.perspective !== 'sente') return null;
  if (result.sfen !== expectedSfen || row.sfen !== expectedSfen) return null;
  const identity = result.identity;
  if (!object(identity)) return null;
  for (const [key, expected] of Object.entries(CLOUD_EXPECTED_IDENTITY)) {
    if (identity[key] !== expected) return null;
  }
  if (!member(result.status, ['success', 'incomplete', 'terminal'])) return null;
  if (!object(result.conditions) || !object(result.conditions.requested)) return null;

  const status = result.status as 'success' | 'incomplete' | 'terminal';

  if (status === 'terminal') {
    if (!member(result.terminal, ['checkmate', 'no-legal-moves'])) return null;
    if (!Array.isArray(result.candidates) || result.candidates.length !== 0) return null;
    if (!requestedMatch(result.conditions.requested, profileId)) return null;
    if (result.conditions.actual !== null) return null;
    const meta = result.meta;
    if (
      !object(meta) ||
      meta.nodes !== null ||
      meta.completedDepth !== null ||
      meta.elapsedMs !== null
    ) {
      return null;
    }
    return { ply: row.ply, sfen: row.sfen, status, engineLaunch: row.engineLaunch, result };
  }

  const actual = result.conditions.actual;
  if (!conditionsMatch(result.conditions.requested, actual, profileId)) return null;
  if (result.terminal !== null) return null;
  if (!Array.isArray(result.candidates)) return null;

  const meta = result.meta;
  if (!object(meta)) return null;
  const nodes = meta.nodes === null ? null : meta.nodes;
  const completedDepth = meta.completedDepth === null ? null : meta.completedDepth;
  const elapsedMs = meta.elapsedMs === null ? null : meta.elapsedMs;
  if (
    (nodes !== null && !positiveInteger(nodes)) ||
    (completedDepth !== null && !positiveInteger(completedDepth)) ||
    (elapsedMs !== null && !positiveInteger(elapsedMs))
  ) {
    return null;
  }

  if (status === 'success') {
    if (
      nodes === null ||
      completedDepth === null ||
      elapsedMs === null ||
      result.candidates.length !== actual.multiPV
    ) {
      return null;
    }
  } else {
    // incomplete: a real engine attempt that produced no established eval line.
    if (result.candidates.length !== 0 || completedDepth !== null) return null;
  }

  const seenMoves = new Set<string>();
  for (const candidate of result.candidates) {
    if (!object(candidate)) return null;
    if (!isUsiMove(candidate.move)) return null;
    const pv = decodePv(candidate.pv);
    if (!pv || pv[0] !== candidate.move) return null;
    if (decodeScore(candidate.score) === null) return null;
    if (seenMoves.has(candidate.move)) return null;
    seenMoves.add(candidate.move);
  }
  return { ply: row.ply, sfen: row.sfen, status, engineLaunch: row.engineLaunch, result };
}

/** Convert a validated row into the display shape. Incomplete rows carry no candidates. */
export function toCloudPositionResult(row: CloudResultRow): CloudPositionResult {
  const result = row.result as Record<string, unknown>;
  const meta = result.meta as Record<string, unknown>;
  const candidates: AnalysisCandidate[] = [];
  if (row.status === 'success' && Array.isArray(result.candidates)) {
    const depth = meta.completedDepth as number;
    for (const candidate of result.candidates as Record<string, unknown>[]) {
      const score = decodeScore(candidate.score);
      candidates.push({
        usi: candidate.move as string,
        pv: candidate.pv as string[],
        scoreCp: score?.scoreCp ?? null,
        mate: score?.mate ?? null,
        depth,
      });
    }
  }
  return {
    ply: row.ply,
    sfen: row.sfen,
    status: row.status,
    ...(row.status === 'terminal'
      ? { terminal: result.terminal as 'checkmate' | 'no-legal-moves' }
      : {}),
    candidates,
    meta: {
      nodes: meta.nodes as number | null,
      completedDepth: meta.completedDepth as number | null,
      elapsedMs: meta.elapsedMs as number | null,
    },
    engineLaunch: row.engineLaunch,
  };
}
