import {
  COMPARISON_EXPORT_SCHEMA,
  COMPARISON_EXPORT_SCHEMA_VERSION,
  COMPARISON_METHODS,
  type CloudMethodExport,
  type ComparisonExport,
  type ComparisonMethod,
  type ExportScore,
  type PlyResult,
  type SekireiMethodExport,
} from './schema.ts';

const MAX_ERRORS = 50;
const MAX_STRING_BYTES = 4096;
const MOVE_LIST_HASH_RE = /^[0-9a-f]{64}$/u;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u;
const SFEN_CHARSET_RE = /^[0-9KkLlNnSsGgBbRrPp/+ bw-]+$/u;
const USI_MOVE_RE = /^(?:[1-9][a-i]){2}\+?$|^[PLNSGBR]\*[1-9][a-i]$/u;

/**
 * export に credential や token が紛れ込むことを拒否するガード。
 * `mcd1_` は /v1/credentials が一度だけ返す匿名 credential の prefix。
 * 厳密な秘匿検出ではなく、既知の秘密形状への fail-closed。
 */
const SECRET_PATTERNS: readonly { pattern: RegExp; name: string }[] = [
  { pattern: /mcd1_[A-Za-z0-9_-]{8,}/u, name: 'cloud credential (mcd1_…)' },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/iu, name: 'bearer token' },
];

type Errors = { list: string[]; at: (path: string, message: string) => void };

function makeErrors(): Errors {
  const list: string[] = [];
  return {
    list,
    at(path, message) {
      if (list.length < MAX_ERRORS) list.push(`${path}: ${message}`);
    },
  };
}

function isObj(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isBoundedString(value: unknown): value is string {
  return (
    typeof value === 'string' && new TextEncoder().encode(value).byteLength <= MAX_STRING_BYTES
  );
}

function isSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isNonNegativeInt(value: unknown): value is number {
  return isSafeInt(value) && value >= 0;
}

function isPositiveInt(value: unknown): value is number {
  return isSafeInt(value) && value > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isIsoDate(value: unknown): value is string {
  return isNonEmptyString(value) && ISO_DATE_RE.test(value) && !Number.isNaN(Date.parse(value));
}

/** 厳密な局面合法性までは見ない schema レベルの SFEN 形状チェック。 */
function isSfenLike(value: unknown): value is string {
  if (!isBoundedString(value) || value.length === 0 || value.trim() !== value) return false;
  if (!SFEN_CHARSET_RE.test(value)) return false;
  const fields = value.split(' ');
  return fields.length === 4 && /^[1-9][0-9]*$/u.test(fields[3]);
}

/** 既知キー集合の完全一致を要求し、未知フィールドの混入を検出する。 */
function checkKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: Errors,
): boolean {
  let ok = true;
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      errors.at(path, `unknown key '${key}'`);
      ok = false;
    }
  }
  for (const key of allowed) {
    if (!(key in value)) {
      errors.at(`${path}.${key}`, 'missing required key');
      ok = false;
    }
  }
  return ok;
}

/** optional キー版: unknown は拒否するが欠落は許す。 */
function checkOptionalKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: Errors,
): boolean {
  let ok = true;
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      errors.at(path, `unknown key '${key}'`);
      ok = false;
    }
  }
  return ok;
}

/** undefined（任意キーの欠落）・null（値なし）・検査済み値を許す。 */
function optNullable(value: unknown, check: (v: unknown) => boolean): boolean {
  return value === undefined || value === null || check(value);
}

function scoreEquals(a: ExportScore, b: ExportScore): boolean {
  if (a.kind !== b.kind || a.value !== b.value) return false;
  if (a.kind === 'mate' && b.kind === 'mate') return a.winner === b.winner;
  return true;
}

function validateScore(value: unknown, path: string, errors: Errors): value is ExportScore {
  if (!isObj(value)) {
    errors.at(path, 'must be an object');
    return false;
  }
  const kind = value.kind;
  if (kind === 'cp') {
    if (!checkKeys(value, ['kind', 'value'], path, errors)) return false;
    if (!isSafeInt(value.value)) {
      errors.at(`${path}.value`, 'cp value must be a safe integer');
      return false;
    }
    return true;
  }
  if (kind === 'mate') {
    if (!checkKeys(value, ['kind', 'value', 'winner'], path, errors)) return false;
    if (!isSafeInt(value.value)) {
      errors.at(`${path}.value`, 'mate value must be a safe integer');
      return false;
    }
    const winner = value.winner;
    if (winner !== 'black' && winner !== 'white' && winner !== 'unknown') {
      errors.at(`${path}.winner`, "must be 'black' | 'white' | 'unknown'");
      return false;
    }
    // 符号と winner の一致は export の不変条件。
    const signedWinner = value.value > 0 ? 'black' : value.value < 0 ? 'white' : 'unknown';
    if (winner !== signedWinner) {
      errors.at(`${path}.winner`, `inconsistent with signed mate value ${value.value}`);
      return false;
    }
    return true;
  }
  errors.at(`${path}.kind`, "must be 'cp' | 'mate'");
  return false;
}

function validatePlyResult(
  value: unknown,
  method: ComparisonMethod,
  path: string,
  errors: Errors,
): value is PlyResult {
  if (!isObj(value)) {
    errors.at(path, 'must be an object');
    return false;
  }
  if (
    !checkOptionalKeys(
      value,
      ['status', 'sfen', 'terminal', 'evaluation', 'candidates', 'observed', 'timing', 'fromCache'],
      path,
      errors,
    )
  ) {
    return false;
  }
  const status = value.status;
  if (
    status !== 'complete' &&
    status !== 'incomplete' &&
    status !== 'terminal' &&
    status !== 'missing'
  ) {
    errors.at(`${path}.status`, "must be 'complete' | 'incomplete' | 'terminal' | 'missing'");
    return false;
  }
  if (value.sfen !== undefined && !isSfenLike(value.sfen)) {
    errors.at(`${path}.sfen`, 'must be a SFEN-shaped string');
  }
  if (value.fromCache !== undefined) {
    if (typeof value.fromCache !== 'boolean') {
      errors.at(`${path}.fromCache`, 'must be a boolean');
    } else if (value.fromCache && method !== 'sekirei') {
      errors.at(`${path}.fromCache`, 'is a sekirei-only field');
    }
  }

  let observedMultiPV: number | null = null;
  if (value.observed !== undefined) {
    if (!isObj(value.observed)) {
      errors.at(`${path}.observed`, 'must be an object');
    } else {
      checkOptionalKeys(
        value.observed,
        ['nodes', 'completedDepth', 'multiPV', 'engineLaunch'],
        `${path}.observed`,
        errors,
      );
      const observed = value.observed;
      if (!optNullable(observed.nodes, isNonNegativeInt))
        errors.at(`${path}.observed.nodes`, 'must be a non-negative integer or null');
      if (!optNullable(observed.completedDepth, isNonNegativeInt))
        errors.at(`${path}.observed.completedDepth`, 'must be a non-negative integer or null');
      if (!optNullable(observed.multiPV, isPositiveInt))
        errors.at(`${path}.observed.multiPV`, 'must be a positive integer or null');
      if (!optNullable(observed.engineLaunch, isPositiveInt))
        errors.at(`${path}.observed.engineLaunch`, 'must be a positive integer or null');
      if (isPositiveInt(observed.multiPV)) observedMultiPV = observed.multiPV;
    }
  }

  if (value.timing !== undefined) {
    if (!isObj(value.timing)) {
      errors.at(`${path}.timing`, 'must be an object');
    } else if (checkKeys(value.timing, ['kind', 'elapsedMs'], `${path}.timing`, errors)) {
      const kind = value.timing.kind;
      if (kind !== 'app-call' && kind !== 'server-search') {
        errors.at(`${path}.timing.kind`, "must be 'app-call' | 'server-search'");
      } else {
        const expected = method === 'sekirei' ? 'app-call' : 'server-search';
        if (kind !== expected) {
          errors.at(`${path}.timing.kind`, `must be '${expected}' for ${method}`);
        }
      }
      if (!isNonNegativeNumber(value.timing.elapsedMs)) {
        errors.at(`${path}.timing.elapsedMs`, 'must be a non-negative number');
      }
    }
  }

  if (status === 'missing') {
    // missing は status だけを持つ。結果由来の情報を付けない。
    for (const key of ['sfen', 'terminal', 'evaluation', 'candidates', 'observed', 'timing']) {
      if (value[key] !== undefined) {
        errors.at(`${path}.${key}`, "must be absent when status is 'missing'");
      }
    }
    return true;
  }

  if (status === 'terminal') {
    if (!isObj(value.terminal)) {
      errors.at(`${path}.terminal`, "required when status is 'terminal'");
    } else if (checkKeys(value.terminal, ['kind', 'winner'], `${path}.terminal`, errors)) {
      const { kind, winner } = value.terminal;
      if (kind !== 'checkmate' && kind !== 'no-legal-moves') {
        errors.at(`${path}.terminal.kind`, "must be 'checkmate' | 'no-legal-moves'");
      } else if (kind === 'checkmate' && winner !== 'black' && winner !== 'white') {
        errors.at(`${path}.terminal.winner`, "checkmate requires winner 'black' | 'white'");
      } else if (kind === 'no-legal-moves' && winner !== null) {
        errors.at(`${path}.terminal.winner`, 'no-legal-moves requires winner null');
      }
    }
    if (value.evaluation !== undefined || value.candidates !== undefined) {
      errors.at(path, "terminal rows must not carry 'evaluation' or 'candidates'");
    }
    return true;
  }

  if (value.terminal !== undefined) {
    errors.at(`${path}.terminal`, "must be absent unless status is 'terminal'");
  }

  if (status === 'incomplete') {
    if (value.evaluation !== undefined || value.candidates !== undefined) {
      errors.at(path, "incomplete rows must not carry 'evaluation' or 'candidates'");
    }
    return true;
  }

  // status === 'complete'
  if (value.evaluation === undefined) {
    errors.at(`${path}.evaluation`, "required when status is 'complete'");
  }
  if (!Array.isArray(value.candidates) || value.candidates.length === 0) {
    errors.at(`${path}.candidates`, 'must be a non-empty array when status is complete');
  } else {
    const seen = new Set<string>();
    value.candidates.forEach((candidate, i) => {
      const cpath = `${path}.candidates[${i}]`;
      if (!isObj(candidate) || !checkKeys(candidate, ['move', 'score'], cpath, errors)) return;
      if (!isNonEmptyString(candidate.move)) {
        errors.at(`${cpath}.move`, 'must be a non-empty string');
      } else if (seen.has(candidate.move)) {
        errors.at(`${cpath}.move`, 'duplicate candidate move');
      }
      seen.add(String(candidate.move));
      validateScore(candidate.score, `${cpath}.score`, errors);
    });
    if (
      value.evaluation !== undefined &&
      isObj(value.evaluation) &&
      isObj(value.candidates[0]) &&
      isObj(value.candidates[0].score) &&
      (value.evaluation.kind === 'cp' || value.evaluation.kind === 'mate') &&
      (value.candidates[0].score.kind === 'cp' || value.candidates[0].score.kind === 'mate') &&
      !scoreEquals(
        value.evaluation as unknown as ExportScore,
        value.candidates[0].score as unknown as ExportScore,
      )
    ) {
      errors.at(`${path}.evaluation`, 'must equal candidates[0].score');
    }
    if (observedMultiPV !== null && observedMultiPV !== value.candidates.length) {
      errors.at(`${path}.observed.multiPV`, 'must equal candidates.length when present');
    }
  }
  return errors.list.length === 0;
}

const CLOUD_PROFILE_FOR_METHOD = { 'cloud-free': 'free', 'cloud-precision': 'precision' } as const;

function validateSekireiMethod(
  value: unknown,
  path: string,
  errors: Errors,
): value is SekireiMethodExport {
  if (
    !isObj(value) ||
    !checkKeys(value, ['method', 'attemptId', 'identity', 'conditions', 'timing'], path, errors)
  ) {
    return false;
  }
  if (value.method !== 'sekirei') errors.at(`${path}.method`, "must be 'sekirei'");
  if (!isNonEmptyString(value.attemptId) || value.attemptId.length > 128) {
    errors.at(`${path}.attemptId`, 'must be a non-empty string (<=128 chars)');
  }
  if (!isObj(value.identity)) {
    errors.at(`${path}.identity`, 'must be an object');
  } else if (checkKeys(value.identity, ['engineId', 'modelId'], `${path}.identity`, errors)) {
    if (!isNonEmptyString(value.identity.engineId)) {
      errors.at(`${path}.identity.engineId`, 'required');
    }
    if (!isNonEmptyString(value.identity.modelId)) {
      errors.at(`${path}.identity.modelId`, 'required');
    }
  }
  if (!isObj(value.conditions)) {
    errors.at(`${path}.conditions`, 'must be an object');
  } else if (checkKeys(value.conditions, ['nodes', 'multiPV'], `${path}.conditions`, errors)) {
    if (!isPositiveInt(value.conditions.nodes)) {
      errors.at(`${path}.conditions.nodes`, 'must be a positive integer');
    }
    if (!isPositiveInt(value.conditions.multiPV)) {
      errors.at(`${path}.conditions.multiPV`, 'must be a positive integer');
    }
  }
  if (!isObj(value.timing)) {
    errors.at(`${path}.timing`, 'must be an object');
  } else if (
    checkKeys(
      value.timing,
      ['wholeGameWallMs', 'cacheReuseCount', 'interrupted', 'resumed', 'completion'],
      `${path}.timing`,
      errors,
    )
  ) {
    const timing = value.timing;
    if (!optNullable(timing.wholeGameWallMs, isNonNegativeNumber)) {
      errors.at(`${path}.timing.wholeGameWallMs`, 'must be a non-negative number or null');
    }
    if (!optNullable(timing.cacheReuseCount, isNonNegativeInt)) {
      errors.at(`${path}.timing.cacheReuseCount`, 'must be a non-negative integer or null');
    }
    if (!optNullable(timing.interrupted, (v) => typeof v === 'boolean')) {
      errors.at(`${path}.timing.interrupted`, 'must be a boolean or null');
    }
    if (!optNullable(timing.resumed, (v) => typeof v === 'boolean')) {
      errors.at(`${path}.timing.resumed`, 'must be a boolean or null');
    }
    if (!['completed', 'partial', 'interrupted', 'unknown'].includes(String(timing.completion))) {
      errors.at(`${path}.timing.completion`, 'invalid completion value');
    }
  }
  return errors.list.length === 0;
}

function validateCloudMethod(
  value: unknown,
  method: 'cloud-free' | 'cloud-precision',
  path: string,
  errors: Errors,
): value is CloudMethodExport {
  if (
    !isObj(value) ||
    !checkKeys(
      value,
      ['method', 'attemptId', 'jobId', 'profileId', 'identity', 'conditions', 'timing'],
      path,
      errors,
    )
  ) {
    return false;
  }
  if (value.method !== method) errors.at(`${path}.method`, `must be '${method}'`);
  if (!isNonEmptyString(value.attemptId) || value.attemptId.length > 128) {
    errors.at(`${path}.attemptId`, 'must be a non-empty string (<=128 chars)');
  }
  if (!optNullable(value.jobId, isNonEmptyString)) {
    errors.at(`${path}.jobId`, 'must be a string or null');
  }
  if (value.profileId !== CLOUD_PROFILE_FOR_METHOD[method]) {
    errors.at(`${path}.profileId`, `must be '${CLOUD_PROFILE_FOR_METHOD[method]}' for ${method}`);
  }
  if (value.identity !== null) {
    const keys = [
      'engineName',
      'modelId',
      'engineSha256',
      'weightSha256',
      'optionsSha256',
      'sourceArchiveSha256',
      'sourceTreeSha256',
      'driverVersion',
      'contractVersion',
    ];
    if (!isObj(value.identity)) {
      errors.at(`${path}.identity`, 'must be an object or null');
    } else if (checkKeys(value.identity, keys, `${path}.identity`, errors)) {
      for (const key of keys) {
        const item = value.identity[key];
        if (item !== null && typeof item !== 'string') {
          errors.at(`${path}.identity.${key}`, 'must be a string or null');
        } else if (typeof item === 'string' && key.endsWith('Sha256') && !/^[0-9a-f]{64}$/u.test(item)) {
          errors.at(`${path}.identity.${key}`, 'must be a sha256 hex string or null');
        }
      }
    }
  }
  if (!isObj(value.conditions)) {
    errors.at(`${path}.conditions`, 'must be an object');
  } else if (checkKeys(value.conditions, ['requested'], `${path}.conditions`, errors)) {
    const requested = value.conditions.requested;
    if (!isObj(requested)) {
      errors.at(`${path}.conditions.requested`, 'must be an object');
    } else if (
      checkKeys(
        requested,
        ['threads', 'hashMb', 'moveTimeMs', 'multiPV'],
        `${path}.conditions.requested`,
        errors,
      )
    ) {
      for (const key of ['threads', 'hashMb', 'moveTimeMs', 'multiPV'] as const) {
        if (!optNullable(requested[key], isPositiveInt)) {
          errors.at(`${path}.conditions.requested.${key}`, 'must be a positive integer or null');
        }
      }
    }
  }
  if (!isObj(value.timing)) {
    errors.at(`${path}.timing`, 'must be an object');
  } else if (
    checkKeys(value.timing, ['createdAt', 'finishedAt', 'completion'], `${path}.timing`, errors)
  ) {
    const timing = value.timing;
    if (!optNullable(timing.createdAt, isIsoDate)) {
      errors.at(`${path}.timing.createdAt`, 'must be an ISO timestamp or null');
    }
    if (!optNullable(timing.finishedAt, isIsoDate)) {
      errors.at(`${path}.timing.finishedAt`, 'must be an ISO timestamp or null');
    }
    if (
      isIsoDate(timing.createdAt) &&
      isIsoDate(timing.finishedAt) &&
      Date.parse(timing.finishedAt) < Date.parse(timing.createdAt)
    ) {
      errors.at(`${path}.timing.finishedAt`, 'must not precede createdAt');
    }
    if (
      !['queued', 'running', 'completed', 'failed', 'cancelled', 'unknown'].includes(
        String(timing.completion),
      )
    ) {
      errors.at(`${path}.timing.completion`, 'invalid completion value');
    }
  }
  return errors.list.length === 0;
}

/** export 内の全文字列（キーと値）を既知の秘密形状で走査する。 */
function scanForSecrets(value: unknown, path: string, errors: Errors): void {
  if (typeof value === 'string') {
    for (const { pattern, name } of SECRET_PATTERNS) {
      if (pattern.test(value)) {
        errors.at(path, `looks like a ${name}; exports must never carry credentials`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => scanForSecrets(item, `${path}[${i}]`, errors));
    return;
  }
  if (isObj(value)) {
    for (const [key, item] of Object.entries(value)) {
      scanForSecrets(key, `${path}<key>`, errors);
      scanForSecrets(item, path === '$' ? `$.${key}` : `${path}.${key}`, errors);
    }
  }
}

export type ValidationResult =
  | { ok: true; value: ComparisonExport }
  | { ok: false; errors: string[] };

/**
 * 比較export JSON を schemaVersion 1 として検証する。
 * 構造・status とフィールドの整合・ply/SFEN の連続性・identity/profile の対応と、
 * 秘密形状の文字列混入を検査する。合法手としての将棋の正当性は export 生成側の責務。
 */
export function validateComparisonExport(input: unknown): ValidationResult {
  const errors = makeErrors();
  if (!isObj(input)) return { ok: false, errors: ['$: export must be a JSON object'] };

  scanForSecrets(input, '$', errors);

  if (input.schema !== COMPARISON_EXPORT_SCHEMA) {
    errors.at('$.schema', `must be '${COMPARISON_EXPORT_SCHEMA}'`);
  }
  if (input.schemaVersion !== COMPARISON_EXPORT_SCHEMA_VERSION) {
    errors.at('$.schemaVersion', `must be ${COMPARISON_EXPORT_SCHEMA_VERSION}`);
  }
  if (
    !checkKeys(
      input,
      ['schema', 'schemaVersion', 'exportedAt', 'generator', 'game', 'methods', 'plies'],
      '$',
      errors,
    )
  ) {
    return { ok: false, errors: errors.list };
  }
  if (!isIsoDate(input.exportedAt)) {
    errors.at('$.exportedAt', 'must be an ISO timestamp');
  }

  const generator = input.generator;
  if (!isObj(generator)) {
    errors.at('$.generator', 'must be an object');
  } else if (
    checkKeys(
      generator,
      ['platform', 'osVersion', 'deviceModel', 'appVersion', 'buildId'],
      '$.generator',
      errors,
    )
  ) {
    if (!['ios', 'android', 'unknown'].includes(String(generator.platform))) {
      errors.at('$.generator.platform', "must be 'ios' | 'android' | 'unknown'");
    }
    for (const key of ['osVersion', 'deviceModel', 'appVersion', 'buildId'] as const) {
      if (!optNullable(generator[key], isBoundedString)) {
        errors.at(`$.generator.${key}`, 'must be a string or null');
      }
    }
  }

  const game = input.game;
  if (!isObj(game)) {
    errors.at('$.game', 'must be an object');
    return { ok: false, errors: errors.list };
  }
  checkOptionalKeys(
    game,
    ['initialSfen', 'moveCount', 'moves', 'moveListHash', 'label'],
    '$.game',
    errors,
  );
  for (const key of ['initialSfen', 'moveCount', 'moves', 'moveListHash']) {
    if (!(key in game)) errors.at(`$.game.${key}`, 'missing required key');
  }
  if (game.initialSfen !== undefined && !isSfenLike(game.initialSfen)) {
    errors.at('$.game.initialSfen', 'must be a SFEN-shaped string');
  }
  if (game.moveCount !== undefined && !isNonNegativeInt(game.moveCount)) {
    errors.at('$.game.moveCount', 'must be a non-negative integer');
  }
  if (game.moveListHash !== undefined && !MOVE_LIST_HASH_RE.test(String(game.moveListHash))) {
    errors.at('$.game.moveListHash', 'must be a sha256 hex string');
  }
  if (game.label !== undefined && !isBoundedString(game.label)) {
    errors.at('$.game.label', 'must be a string');
  }
  if (Array.isArray(game.moves)) {
    game.moves.forEach((move, i) => {
      if (!isNonEmptyString(move) || !USI_MOVE_RE.test(move)) {
        errors.at(`$.game.moves[${i}]`, 'must be a USI move string');
      }
    });
    if (isNonNegativeInt(game.moveCount) && game.moves.length !== game.moveCount) {
      errors.at('$.game.moves', 'length must equal moveCount');
    }
  } else if ('moves' in game) {
    errors.at('$.game.moves', 'must be an array of USI move strings');
  }

  const methods = input.methods;
  if (!isObj(methods)) {
    errors.at('$.methods', 'must be an object');
  } else {
    for (const key of Object.keys(methods)) {
      if (!COMPARISON_METHODS.includes(key as ComparisonMethod)) {
        errors.at(`$.methods.${key}`, `unknown method '${key}'`);
      }
    }
    if (methods.sekirei !== undefined) {
      validateSekireiMethod(methods.sekirei, '$.methods.sekirei', errors);
    }
    for (const method of ['cloud-free', 'cloud-precision'] as const) {
      if (methods[method] !== undefined) {
        validateCloudMethod(methods[method], method, `$.methods.${method}`, errors);
      }
    }
  }

  const plies = input.plies;
  if (!Array.isArray(plies)) {
    errors.at('$.plies', 'must be an array');
    return { ok: false, errors: errors.list };
  }
  if (isNonNegativeInt(game.moveCount) && plies.length !== game.moveCount + 1) {
    errors.at('$.plies', 'length must equal moveCount + 1');
  }
  plies.forEach((row, i) => {
    const rpath = `$.plies[${i}]`;
    if (!isObj(row)) {
      errors.at(rpath, 'must be an object');
      return;
    }
    if (!checkKeys(row, ['ply', 'sfen', 'results'], rpath, errors)) return;
    if (row.ply !== i) errors.at(`${rpath}.ply`, `must equal its index (${i})`);
    if (!isSfenLike(row.sfen)) {
      errors.at(`${rpath}.sfen`, 'must be a SFEN-shaped string');
    } else if (i === 0 && isSfenLike(game.initialSfen) && row.sfen !== game.initialSfen) {
      errors.at(`${rpath}.sfen`, 'ply 0 must equal game.initialSfen');
    }
    if (!isObj(row.results)) {
      errors.at(`${rpath}.results`, 'must be an object');
      return;
    }
    for (const [method, result] of Object.entries(row.results)) {
      if (!COMPARISON_METHODS.includes(method as ComparisonMethod)) {
        errors.at(`${rpath}.results.${method}`, `unknown method '${method}'`);
        continue;
      }
      validatePlyResult(result, method as ComparisonMethod, `${rpath}.results.${method}`, errors);
    }
  });

  if (errors.list.length > 0) return { ok: false, errors: errors.list };
  return { ok: true, value: input as unknown as ComparisonExport };
}
