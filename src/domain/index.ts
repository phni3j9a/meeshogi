import {
  Color as TsshogiColor,
  InitialPositionSFEN,
  Move as TsshogiMove,
  PieceType as TsshogiPieceType,
  Position,
  RecordMetadataKey,
  SpecialMoveType,
  Square,
  formatKIFMove,
  handPieceTypes,
  importKIF,
  isKnownSpecialMove,
  pieceTypeToStringForBoard,
  promotedPieceType,
} from 'tsshogi';
import type {
  Formation,
  GameMove,
  GameRecord,
  GameResult,
  Opening,
  OpeningTag,
  ParsedGame,
  Service,
  Settings,
  Side,
  StatFilter,
  Statistics,
  Tally,
} from './model';
import type { ImmutableNode, ImmutableRecord } from 'tsshogi';
import { effectiveResult } from './model';

export * from './model';

export const OPENING_RULE_VERSION = 'v1';
export const MAX_KIF_BYTES = 2 * 1024 * 1024;
export const MAX_KIF_PLIES = 10_000;
const OPENING_WINDOW_PLIES = 32;
const STATIC_MIN_PLIES = 20;

const KIF_PIECES: Record<string, TsshogiPieceType> = {
  歩: TsshogiPieceType.PAWN,
  香: TsshogiPieceType.LANCE,
  桂: TsshogiPieceType.KNIGHT,
  銀: TsshogiPieceType.SILVER,
  金: TsshogiPieceType.GOLD,
  角: TsshogiPieceType.BISHOP,
  飛: TsshogiPieceType.ROOK,
  玉: TsshogiPieceType.KING,
  王: TsshogiPieceType.KING,
  と: TsshogiPieceType.PROM_PAWN,
  杏: TsshogiPieceType.PROM_LANCE,
  圭: TsshogiPieceType.PROM_KNIGHT,
  全: TsshogiPieceType.PROM_SILVER,
  馬: TsshogiPieceType.HORSE,
  龍: TsshogiPieceType.DRAGON,
  竜: TsshogiPieceType.DRAGON,
};

type RawMoveRow = {
  line: number;
  number: number;
  text: string;
  timing?: { elapsedMs: number; totalElapsedMs: number };
};

type ParsedNotation = {
  to: Square;
  from: Square | TsshogiPieceType;
  pieceType: TsshogiPieceType;
  promote: boolean;
};

type Cell = {
  file: number;
  rank: number;
  side: Side;
  piece: string;
  label: string;
};

type HandCell = {
  piece: string;
  label: string;
  count: number;
};

export type BoardView = {
  turn: Side;
  cells: Cell[];
  hands: Record<Side, HandCell[]>;
};

export class KifParseError extends Error {
  readonly line: number | null;

  constructor(reason: string, line?: number) {
    super(`KIFを読み込めません: ${line === undefined ? '' : `${line}行目: `}${reason}`);
    this.name = 'KifParseError';
    this.line = line ?? null;
  }
}

function fail(reason: string, line?: number): never {
  throw new KifParseError(reason, line);
}

function sideFromColor(color: TsshogiColor): Side {
  return color === TsshogiColor.BLACK ? 'black' : 'white';
}

function colorFromSide(side: Side): TsshogiColor {
  return side === 'black' ? TsshogiColor.BLACK : TsshogiColor.WHITE;
}

function stripBom(raw: string): string {
  return raw.replace(/^\uFEFF/, '');
}

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function normaliseDigits(text: string): string {
  return text.replace(/[０-９]/gu, (digit) => String(digit.charCodeAt(0) - '０'.charCodeAt(0)));
}

function compactKif(text: string): string {
  return normaliseDigits(text).replace(/[ \t\u3000]/gu, '');
}

function readRawHeaders(lines: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || /^手数/u.test(trimmed)) {
      continue;
    }
    const match = /^(.*?)[：:]\s*(.*?)\s*$/u.exec(trimmed);
    if (match && match[1] && !/^\d+\s/u.test(trimmed) && !trimmed.startsWith('まで')) {
      headers[match[1].trim()] = match[2];
    }
  }
  return headers;
}

function readMoveTime(text: string, line: number): Pick<RawMoveRow, 'text' | 'timing'> {
  const normalised = normaliseDigits(text).replace(/：/gu, ':');
  const time = /\s*\(\s*(\d+)\s*:\s*(\d+)\s*\/\s*(\d+)\s*:\s*(\d+)\s*:\s*(\d+)\s*\)\s*$/u.exec(
    normalised,
  );
  if (!time) {
    if (/\([^)]*[:/][^)]*\)\s*$/u.test(normalised)) fail('消費時間の形式が不正です', line);
    return { text: text.replace(/\s*\+\s*$/u, '').trim() };
  }
  const [, minutes, seconds, hoursTotal, minutesTotal, secondsTotal] = time.map(Number);
  const elapsedMs = (minutes * 60 + seconds) * 1000;
  const totalElapsedMs = (hoursTotal * 3600 + minutesTotal * 60 + secondsTotal) * 1000;
  if (
    seconds >= 60 ||
    minutesTotal >= 60 ||
    secondsTotal >= 60 ||
    !Number.isSafeInteger(elapsedMs) ||
    !Number.isSafeInteger(totalElapsedMs)
  )
    fail('消費時間の形式が不正です', line);
  return { text: text.slice(0, time.index).trim(), timing: { elapsedMs, totalElapsedMs } };
}

function readRawMoveRows(lines: string[]): RawMoveRow[] {
  const rows: RawMoveRow[] = [];
  let inMoves = false;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (/^手数[-ー]+/u.test(trimmed)) {
      inMoves = true;
      return;
    }
    const match = /^\s*(\d+)\s+(.+?)\s*$/u.exec(line);
    if (match && (inMoves || rows.length > 0)) {
      rows.push({
        line: index + 1,
        number: Number(match[1]),
        ...readMoveTime(match[2], index + 1),
      });
    }
  });
  return rows;
}

function containsBranch(raw: string, record: ImmutableRecord): boolean {
  if (/^\s*変化\s*[：:]/mu.test(raw)) {
    return true;
  }
  let branch = false;
  record.forEach((node: ImmutableNode) => {
    if (node.hasBranch || !node.isFirstBranch) {
      branch = true;
    }
  });
  return branch;
}

function isSpecialText(text: string): boolean {
  const clean = compactKif(text);
  return /^(投了|中断|持将棋|千日手|詰み?|不詰|切れ負け|時間切れ.*|.*反則(?:勝ち|負け)|.*入玉勝ち|不戦(?:勝|敗)|トライ|.*勝ち)$/u.test(
    clean,
  );
}

function parseKifNotation(text: string, previousTo: Square | null, line: number): ParsedNotation {
  const clean = compactKif(text);
  const destination = /^(同|[1-9][一二三四五六七八九])(.*)$/u.exec(clean);
  if (!destination) {
    fail(`指し手の着地点を解釈できません: ${text}`, line);
  }

  let to: Square;
  if (destination[1] === '同') {
    if (!previousTo) {
      fail('「同」の直前の着地点がありません', line);
    }
    to = previousTo;
  } else {
    const file = Number(destination[1][0]);
    const rank = '一二三四五六七八九'.indexOf(destination[1][1]) + 1;
    to = new Square(file, rank);
  }

  const rest = destination[2];
  const piece = /^(成香|成桂|成銀|歩|香|桂|銀|金|角|飛|玉|王|と|杏|圭|全|馬|龍|竜)(.*)$/u.exec(
    rest,
  );
  if (!piece) {
    fail(`駒表記を解釈できません: ${text}`, line);
  }
  const parsedPiece = KIF_PIECES[piece[1]];
  if (!parsedPiece) {
    fail(`未対応の駒表記です: ${piece[1]}`, line);
  }

  let remainder = piece[2];
  let resultPiece = parsedPiece;
  let promote = false;
  if (
    /^成/u.test(remainder) &&
    parsedPiece !== TsshogiPieceType.PROM_PAWN &&
    parsedPiece !== TsshogiPieceType.PROM_LANCE &&
    parsedPiece !== TsshogiPieceType.PROM_KNIGHT &&
    parsedPiece !== TsshogiPieceType.PROM_SILVER &&
    parsedPiece !== TsshogiPieceType.HORSE &&
    parsedPiece !== TsshogiPieceType.DRAGON
  ) {
    promote = true;
    resultPiece = promotedPieceType(parsedPiece);
    remainder = remainder.slice(1);
  } else if (/^不成/u.test(remainder)) {
    remainder = remainder.slice(2);
  }

  const drop = /打/u.test(remainder);
  if (drop) {
    if (
      parsedPiece !== resultPiece ||
      parsedPiece === TsshogiPieceType.PROM_PAWN ||
      parsedPiece === TsshogiPieceType.PROM_LANCE ||
      parsedPiece === TsshogiPieceType.PROM_KNIGHT ||
      parsedPiece === TsshogiPieceType.PROM_SILVER ||
      parsedPiece === TsshogiPieceType.HORSE ||
      parsedPiece === TsshogiPieceType.DRAGON
    ) {
      fail(`打ち駒の表記が不正です: ${text}`, line);
    }
    return { to, from: parsedPiece, pieceType: resultPiece, promote: false };
  }

  const source = /\(([1-9])([1-9])\)/u.exec(remainder);
  if (!source) {
    fail(`移動元がありません: ${text}`, line);
  }
  const from = new Square(Number(source[1]), Number(source[2]));
  return { to, from, pieceType: promote ? parsedPiece : resultPiece, promote };
}

function pieceTypesMatch(raw: ParsedNotation, move: TsshogiMove): boolean {
  if (!raw.to.equals(move.to) || raw.pieceType !== move.pieceType || raw.promote !== move.promote) {
    return false;
  }
  if (raw.from instanceof Square && move.from instanceof Square) {
    return raw.from.equals(move.from);
  }
  return raw.from === move.from;
}

function getMetadata(
  record: ImmutableRecord,
  key: RecordMetadataKey,
  header: Record<string, string>,
  headerName: string,
): string | undefined {
  return header[headerName] ?? record.metadata.getStandardMetadata(key);
}

function metadataHeaders(
  record: ImmutableRecord,
  rawHeaders: Record<string, string>,
): Record<string, string> {
  const headers = { ...rawHeaders };
  for (const key of record.metadata.standardMetadataKeys) {
    const value = record.metadata.getStandardMetadata(key);
    if (value !== undefined && headers[key] === undefined) {
      headers[key] = value;
    }
  }
  for (const key of record.metadata.customMetadataKeys) {
    const value = record.metadata.getCustomMetadata(key);
    if (value !== undefined && headers[key] === undefined) {
      headers[key] = value;
    }
  }
  return headers;
}

function validateInitialPosition(record: ImmutableRecord, headers: Record<string, string>): void {
  if (
    record.initialPosition.sfen !== InitialPositionSFEN.STANDARD ||
    (headers['手合割'] && headers['手合割'] !== '平手')
  ) {
    fail('平手以外の初期局面には対応していません');
  }
}

function validateAndCollectMoves(record: ImmutableRecord): {
  nodes: ImmutableNode[];
  terminal: ImmutableNode | null;
  positions: string[];
} {
  const nodes = record.moves.filter((node) => node.ply > 0 && node.move instanceof TsshogiMove);
  const terminalNodes = record.moves.filter(
    (node) => node.ply > 0 && !(node.move instanceof TsshogiMove),
  );
  if (terminalNodes.length > 1) {
    fail('終局手が複数あります');
  }

  const positions: string[] = [record.moves[0].sfen];
  for (const node of nodes) {
    if (!node.prev) {
      fail('指し手の直前局面がありません', node.ply);
    }
    const before = Position.newBySFEN(node.prev.sfen);
    if (!before) {
      fail('指し手の直前局面が不正です', node.ply);
    }
    const nodeMove = node.move;
    if (!(nodeMove instanceof TsshogiMove)) {
      fail('指し手の型が不正です', node.ply);
    }
    const move = before.createMoveByUSI(nodeMove.usi);
    if (!move || !before.isValidMove(move) || !move.equals(nodeMove)) {
      fail(`合法手ではありません: ${nodeMove.usi}`, node.ply);
    }
    const after = before.clone();
    if (!after.doMove(move) || after.sfen !== node.sfen) {
      fail(`指し手適用後の局面が一致しません: ${nodeMove.usi}`, node.ply);
    }
    positions.push(node.sfen);
  }
  return { nodes, terminal: terminalNodes[0] ?? null, positions };
}

function validateNotation(
  rows: RawMoveRow[],
  nodes: ImmutableNode[],
  terminal: ImmutableNode | null,
): void {
  if (rows.length !== nodes.length + (terminal ? 1 : 0)) {
    fail(
      `指し手の件数が一致しません (KIF=${rows.length}, 解析=${nodes.length + (terminal ? 1 : 0)})`,
    );
  }
  let previousTo: Square | null = null;
  rows.forEach((row, index) => {
    const node = index < nodes.length ? nodes[index] : terminal;
    if (!node || row.number !== node.ply) {
      fail(`手数が連続していません: ${row.number}`, row.line);
    }
    if (node.move instanceof TsshogiMove) {
      const raw = parseKifNotation(row.text, previousTo, row.line);
      if (!pieceTypesMatch(raw, node.move)) {
        fail(`駒表記と局面上の指し手が一致しません: ${row.text}`, row.line);
      }
      previousTo = node.move.to;
    } else if (!isSpecialText(row.text)) {
      fail(`終局手を解釈できません: ${row.text}`, row.line);
    }
  });
}

function getTerminalSummary(raw: string): string | null {
  const summaries = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('まで'));
  return summaries.at(-1) ?? null;
}

function validateTerminalSummary(
  summary: string | null,
  boardMoveCount: number,
  terminal: ImmutableNode | null,
): void {
  if (!summary) {
    return;
  }
  const match = /^まで([0-9]+)手/u.exec(compactKif(summary));
  if (!match) {
    fail(`終局結果の行を解釈できません: ${summary}`);
  }
  if (Number(match[1]) !== boardMoveCount) {
    fail(`終局手数が一致しません (記載=${match[1]}, 実際=${boardMoveCount})`);
  }
  if (!terminal) {
    fail('終局結果の行がありますが、終局手がありません');
  }
}

function winnerFromSummary(summary: string | null): Side | null {
  if (!summary) {
    return null;
  }
  const clean = compactKif(summary);
  if (/先手の勝ち/u.test(clean) || /先手の入玉勝ち/u.test(clean) || /先手の反則勝ち/u.test(clean)) {
    return 'black';
  }
  if (/後手の勝ち/u.test(clean) || /後手の入玉勝ち/u.test(clean) || /後手の反則勝ち/u.test(clean)) {
    return 'white';
  }
  return null;
}

function resultForTerminal(
  terminal: ImmutableNode | null,
  summary: string | null,
): { result: GameResult; termination: string } {
  if (!terminal) {
    return { result: 'unknown', termination: 'unknown' };
  }
  const move = terminal.move;
  const knownSpecial = isKnownSpecialMove(move);
  const termination = knownSpecial ? move.type : 'name' in move ? move.name : 'unknown';
  const previousPosition = terminal.prev ? Position.newBySFEN(terminal.prev.sfen) : null;
  const sideToMove = previousPosition ? sideFromColor(previousPosition.color) : null;
  const opposite = sideToMove === 'black' ? 'white' : sideToMove === 'white' ? 'black' : null;
  const winnerResult = (winner: Side | null): GameResult =>
    winner ? (winner === 'black' ? 'black-win' : 'white-win') : 'unknown';
  let result: GameResult;
  switch (knownSpecial ? move.type : null) {
    case SpecialMoveType.RESIGN:
    case SpecialMoveType.TIMEOUT:
    case SpecialMoveType.MATE:
      result = winnerResult(opposite);
      break;
    case SpecialMoveType.FOUL_WIN:
    case SpecialMoveType.ENTERING_OF_KING:
    case SpecialMoveType.WIN_BY_DEFAULT:
      result = winnerResult(sideToMove);
      break;
    case SpecialMoveType.FOUL_LOSE:
    case SpecialMoveType.LOSE_BY_DEFAULT:
      result = winnerResult(opposite);
      break;
    case SpecialMoveType.IMPASS:
    case SpecialMoveType.DRAW:
    case SpecialMoveType.REPETITION_DRAW:
    case SpecialMoveType.MAX_MOVES:
      result = 'draw';
      break;
    case SpecialMoveType.INTERRUPT:
      result = 'interrupted';
      break;
    default:
      result = 'unknown';
  }
  const summaryWinner = winnerFromSummary(summary);
  if (summaryWinner && (result === 'draw' || result === 'interrupted')) {
    fail('引き分け・中断の終局手と勝者表記が一致しません');
  }
  if (summaryWinner && result !== 'unknown' && result !== 'draw' && result !== 'interrupted') {
    const inferredWinner = result === 'black-win' ? 'black' : 'white';
    if (summaryWinner !== inferredWinner) {
      fail('終局結果の表記と終局手が一致しません');
    }
  }
  if (summaryWinner && result === 'unknown') {
    result = summaryWinner === 'black' ? 'black-win' : 'white-win';
  }
  return { result, termination };
}

function inferOpeningForSide(nodes: ImmutableNode[], side: Side): Opening {
  const initialFile = side === 'black' ? 2 : 8;
  const targetFiles: Record<number, Opening> =
    side === 'black'
      ? { 3: 'third-file', 5: 'central', 6: 'fourth-file', 8: 'opposing' }
      : { 2: 'opposing', 3: 'third-file', 4: 'fourth-file', 5: 'central' };
  let rookSquare: Square | null = new Square(initialFile, side === 'black' ? 8 : 2);
  let rookAlive = true;
  const inOwnCamp = (rank: number): boolean => (side === 'black' ? rank >= 7 : rank <= 3);
  for (const node of nodes) {
    if (node.ply > OPENING_WINDOW_PLIES) {
      break;
    }
    const move = node.move as TsshogiMove;
    if (!rookAlive || !rookSquare || !(move.to instanceof Square)) {
      continue;
    }
    if (sideFromColor(move.color) !== side) {
      if (move.to.equals(rookSquare) && move.capturedPieceType === TsshogiPieceType.ROOK) {
        rookAlive = false;
      }
      continue;
    }
    if (!(move.from instanceof Square) || !move.from.equals(rookSquare)) {
      continue;
    }
    if (move.pieceType !== TsshogiPieceType.ROOK || move.promote) {
      rookAlive = false;
      continue;
    }
    if (move.to.file !== initialFile) {
      if (
        !inOwnCamp(move.from.rank) ||
        !inOwnCamp(move.to.rank) ||
        move.from.rank !== move.to.rank ||
        move.capturedPieceType !== null
      ) {
        return 'unknown';
      }
      return targetFiles[move.to.file] ?? 'unknown';
    }
    rookSquare = move.to;
  }
  if (
    nodes.length < STATIC_MIN_PLIES ||
    !rookAlive ||
    !rookSquare ||
    rookSquare.file !== initialFile
  ) {
    return 'unknown';
  }
  return 'static';
}

function openingTag(opening: Opening): OpeningTag {
  return { automatic: opening, manual: null };
}

function inferOpenings(nodes: ImmutableNode[]): ParsedGame['openings'] {
  return {
    black: openingTag(inferOpeningForSide(nodes, 'black')),
    white: openingTag(inferOpeningForSide(nodes, 'white')),
    ruleVersion: OPENING_RULE_VERSION,
  };
}

function identityForGame(input: {
  startedAt: string;
  blackName: string;
  whiteName: string;
  initialSfen: string;
  moves: string[];
  result: GameResult;
  termination: string;
}): string {
  return [
    input.startedAt,
    input.blackName,
    input.whiteName,
    input.initialSfen,
    input.moves.join(','),
    input.result,
    input.termination,
  ]
    .map((part) => `${part.length}:${part}`)
    .join('|');
}

/** Compare the written local time, without changing the original KIF or stored identity. */
export function sameGameOccasion(a: ParsedGame, b: ParsedGame): boolean {
  return (
    (localDateKey(a.startedAt) || a.startedAt.trim()) ===
      (localDateKey(b.startedAt) || b.startedAt.trim()) &&
    a.blackName === b.blackName &&
    a.whiteName === b.whiteName
  );
}

export function sameRecordedGame(a: ParsedGame, b: ParsedGame): boolean {
  return (
    sameGameOccasion(a, b) &&
    a.positions[0] === b.positions[0] &&
    a.result === b.result &&
    a.termination === b.termination &&
    a.moves.length === b.moves.length &&
    a.moves.every((move, index) => move.usi === b.moves[index].usi)
  );
}

function readService(place: string): Service {
  if (/将棋ウォーズ|shogiwars/i.test(place)) {
    return 'shogiwars';
  }
  if (/棋桜|kiou/i.test(place)) {
    return 'kiou';
  }
  return 'unknown';
}

function readTimeControl(headers: Record<string, string>, record: ImmutableRecord): string {
  const timeLimit =
    headers['持ち時間'] ?? record.metadata.getStandardMetadata(RecordMetadataKey.TIME_LIMIT) ?? '';
  const byoyomi =
    headers['秒読み'] ?? record.metadata.getStandardMetadata(RecordMetadataKey.BYOYOMI) ?? '';
  if (timeLimit && byoyomi && !timeLimit.includes('+')) {
    return `${timeLimit}+${byoyomi}`;
  }
  return timeLimit || byoyomi;
}

function moveToGameMove(node: ImmutableNode): GameMove {
  const move = node.move as TsshogiMove;
  const previous = node.prev?.move instanceof TsshogiMove ? node.prev.move : undefined;
  return {
    usi: move.usi,
    label: formatKIFMove(move, { prev: previous }),
    elapsedMs: node.elapsedMs,
    totalElapsedMs: node.totalElapsedMs,
  };
}

export function parseKif(raw: string): ParsedGame {
  if (typeof raw !== 'string' || raw.trim() === '') {
    fail('棋譜本文が空です');
  }
  if (utf8ByteLength(raw) > MAX_KIF_BYTES) {
    fail('KIFが大きすぎます。2MB以下の棋譜を指定してください');
  }
  const source = stripBom(raw);
  const lines = source.split(/\r?\n/u);
  const rows = readRawMoveRows(lines);
  if (rows.length > MAX_KIF_PLIES) {
    fail(`指し手が多すぎます。${MAX_KIF_PLIES}手以下の棋譜を指定してください`);
  }
  const rawHeaders = readRawHeaders(lines);
  let imported: ReturnType<typeof importKIF>;
  try {
    imported = importKIF(source);
  } catch (error) {
    fail(
      `tsshogiの取り込みに失敗しました: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (imported instanceof Error) {
    fail(`tsshogiの取り込みに失敗しました: ${imported.message}`);
  }
  const record = imported;
  if (containsBranch(source, record)) {
    fail('分岐のある棋譜には対応していません');
  }
  const headers = metadataHeaders(record, rawHeaders);
  validateInitialPosition(record, headers);
  const collected = validateAndCollectMoves(record);
  if (collected.nodes.length > MAX_KIF_PLIES) {
    fail(`指し手が多すぎます。${MAX_KIF_PLIES}手以下の棋譜を指定してください`);
  }
  validateNotation(rows, collected.nodes, collected.terminal);
  const summary = getTerminalSummary(source);
  validateTerminalSummary(summary, collected.nodes.length, collected.terminal);
  const terminalResult = resultForTerminal(collected.terminal, summary);
  const startedAt =
    getMetadata(record, RecordMetadataKey.START_DATETIME, headers, '開始日時') ??
    headers['日付'] ??
    '';
  const endedAt = getMetadata(record, RecordMetadataKey.END_DATETIME, headers, '終了日時') ?? null;
  const blackName = getMetadata(record, RecordMetadataKey.BLACK_NAME, headers, '先手') ?? '';
  const whiteName = getMetadata(record, RecordMetadataKey.WHITE_NAME, headers, '後手') ?? '';
  const blackRank = headers['先手段級'] ?? null;
  const whiteRank = headers['後手段級'] ?? null;
  const place = getMetadata(record, RecordMetadataKey.PLACE, headers, '場所') ?? '';
  const totals = [0, 0];
  const moves = collected.nodes.map((node, index) => {
    const move = moveToGameMove(node);
    const timing = rows[index]?.timing;
    move.elapsedMs = timing?.elapsedMs ?? 0;
    // Keep the service's written cumulative value, including clock adjustments.
    // Only derive a cumulative value when the row has no time column.
    move.totalElapsedMs = timing?.totalElapsedMs ?? totals[index % 2] + move.elapsedMs;
    totals[index % 2] = move.totalElapsedMs;
    return move;
  });
  const identity = identityForGame({
    startedAt,
    blackName,
    whiteName,
    initialSfen: record.initialPosition.sfen,
    moves: moves.map((move) => move.usi),
    result: terminalResult.result,
    termination: terminalResult.termination,
  });
  return {
    rawKif: raw,
    identity,
    blackName,
    whiteName,
    blackRank,
    whiteRank,
    startedAt,
    endedAt,
    timeControl: readTimeControl(headers, record),
    headers,
    service: readService(place),
    result: terminalResult.result,
    termination: terminalResult.termination,
    moves,
    positions: collected.positions,
    openings: inferOpenings(collected.nodes),
  };
}

function parsePositionOrFail(sfen: string): Position {
  const position = Position.newBySFEN(sfen);
  if (!position) {
    fail(`SFENが不正です: ${sfen}`);
  }
  return position;
}

export function applyUsi(sfen: string, usi: string): string {
  const position = parsePositionOrFail(sfen);
  const move = position.createMoveByUSI(usi);
  if (!move || !position.isValidMove(move)) {
    fail(`合法手ではありません: ${usi}`);
  }
  const after = position.clone();
  if (!after.doMove(move)) {
    fail(`指し手を適用できません: ${usi}`);
  }
  return after.sfen;
}

export function legalMoves(sfen: string): string[] {
  const position = parsePositionOrFail(sfen);
  const moves = new Set<string>();
  const add = (move: TsshogiMove | null): void => {
    if (!move) {
      return;
    }
    try {
      if (position.isValidMove(move)) {
        moves.add(move.usi);
      }
    } catch {
      // Some impossible hand/board candidates throw in tsshogi; they are simply not legal.
    }
  };
  for (const from of position.board.listSquaresByColor(position.color)) {
    for (const to of Square.all) {
      const move = position.createMove(from, to);
      add(move);
      if (move && move.from instanceof Square) {
        try {
          add(move.withPromote());
        } catch {
          // The piece cannot promote on this destination.
        }
      }
    }
  }
  const hand = position.hand(position.color);
  for (const pieceType of handPieceTypes) {
    if (hand.count(pieceType) === 0) {
      continue;
    }
    for (const to of Square.all) {
      add(position.createMove(pieceType, to));
    }
  }
  return [...moves].sort();
}

export function moveLabel(sfen: string, usi: string): string {
  const position = parsePositionOrFail(sfen);
  const move = position.createMoveByUSI(usi);
  if (!move || !position.isValidMove(move)) {
    fail(`合法手ではありません: ${usi}`);
  }
  const formatted = formatKIFMove(move);
  const body = formatted.replace(/\([1-9][1-9]\)/u, '');
  return `${position.color === TsshogiColor.BLACK ? '▲' : '△'}${body}`;
}

export function boardView(sfen: string): BoardView {
  const position = parsePositionOrFail(sfen);
  const cells: Cell[] = [];
  for (const square of position.board.listNonEmptySquares()) {
    const piece = position.board.at(square);
    if (!piece) {
      continue;
    }
    cells.push({
      file: square.file,
      rank: square.rank,
      side: sideFromColor(piece.color),
      piece: piece.type,
      label: pieceTypeToStringForBoard(piece.type),
    });
  }
  const hands: Record<Side, HandCell[]> = { black: [], white: [] };
  for (const side of ['black', 'white'] as const) {
    const hand = position.hand(colorFromSide(side));
    hands[side] = hand.counts
      .map(({ type: piece, count }) => ({ piece, label: pieceTypeToStringForBoard(piece), count }))
      .filter((piece) => piece.count > 0);
  }
  return { turn: sideFromColor(position.color), cells, hands };
}

function emptyTally(): Tally {
  return { total: 0, wins: 0, losses: 0, draws: 0, interrupted: 0, unknown: 0, winRate: null };
}

function addOutcome(tally: Tally, game: GameRecord): void {
  const result = effectiveResult(game);
  tally.total += 1;
  if (result === 'draw') {
    tally.draws += 1;
  } else if (result === 'interrupted') {
    tally.interrupted += 1;
  } else if (result === 'unknown' || game.mySide === null) {
    tally.unknown += 1;
  } else if (
    (result === 'black-win' && game.mySide === 'black') ||
    (result === 'white-win' && game.mySide === 'white')
  ) {
    tally.wins += 1;
  } else {
    tally.losses += 1;
  }
  const decided = tally.wins + tally.losses;
  tally.winRate = decided === 0 ? null : tally.wins / decided;
}

/** A sortable written local date; no timezone or UTC conversion is introduced. */
export function localDateKey(value: string): string {
  const match =
    /^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?(?:\s*)$/u.exec(
      value.trim(),
    );
  if (!match) return '';
  const [, yearText, monthText, dayText, hourText = '0', minuteText = '0', secondText = '0'] =
    match;
  const [year, month, day, hour, minute, second] = [
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
  ].map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return '';
  return `${yearText}-${monthText.padStart(2, '0')}-${dayText.padStart(2, '0')} ${hourText.padStart(2, '0')}:${minuteText.padStart(2, '0')}:${secondText.padStart(2, '0')}`;
}

export function gameMonth(game: Pick<GameRecord, 'startedAt'>): string {
  return localDateKey(game.startedAt).slice(0, 7);
}

function gameOpening(game: GameRecord, side: 'self' | 'opponent' | undefined): Opening {
  const selectedSide =
    side === 'opponent' ? (game.mySide === 'black' ? 'white' : 'black') : game.mySide;
  if (!selectedSide) {
    return 'unknown';
  }
  const tag = game.openings[selectedSide];
  return tag.manual ?? tag.automatic;
}

function matchesFilter(game: GameRecord, filter: StatFilter): boolean {
  if (game.mySide === null) {
    return false;
  }
  if (filter.month && gameMonth(game) !== filter.month.replace('/', '-')) {
    return false;
  }
  if (filter.service && game.service !== filter.service) {
    return false;
  }
  if (filter.side && game.mySide !== filter.side) {
    return false;
  }
  if (filter.opening && gameOpening(game, filter.openingSide) !== filter.opening) {
    return false;
  }
  return true;
}

function tallyGames(games: GameRecord[]): Tally {
  const tally = emptyTally();
  games.forEach((game) => addOutcome(tally, game));
  return tally;
}

const ALL_SIDES: Side[] = ['black', 'white'];
const ALL_SERVICES: Service[] = ['shogiwars', 'kiou', 'unknown'];
const ALL_OPENINGS: Opening[] = [
  'static',
  'fourth-file',
  'central',
  'third-file',
  'opposing',
  'unknown',
];
const ALL_FORMATIONS: Formation[] = [
  'double-static',
  'static-ranging',
  'double-ranging',
  'unknown',
];

/** Derive from the effective tags so manual corrections cannot leave a stale formation. */
export function gameFormation(game: Pick<ParsedGame, 'openings'>): Formation {
  const { black, white } = game.openings;
  return formationForOpening(black.manual ?? black.automatic, white.manual ?? white.automatic);
}

export function getStatistics(games: GameRecord[], filter: StatFilter = {}): Statistics {
  const filtered = games.filter((game) => matchesFilter(game, filter));
  const tally = tallyGames(filtered);
  const months = [...new Set(filtered.map(gameMonth).filter(Boolean))].sort().map((month) => ({
    month,
    tally: tallyGames(filtered.filter((game) => gameMonth(game) === month)),
  }));
  const sides = Object.fromEntries(
    ALL_SIDES.map((side) => [side, tallyGames(filtered.filter((game) => game.mySide === side))]),
  ) as Record<Side, Tally>;
  const services = Object.fromEntries(
    ALL_SERVICES.map((service) => [
      service,
      tallyGames(filtered.filter((game) => game.service === service)),
    ]),
  ) as Record<Service, Tally>;
  const openings = ALL_OPENINGS.map((opening) => ({
    opening,
    tally: tallyGames(filtered.filter((game) => gameOpening(game, filter.openingSide) === opening)),
  }));
  const formations = ALL_FORMATIONS.map((formation) => ({
    formation,
    tally: tallyGames(filtered.filter((game) => gameFormation(game) === formation)),
  }));
  const chronological = [...filtered].sort((a, b) =>
    `${localDateKey(a.startedAt)}\u0000${a.identity}`.localeCompare(
      `${localDateKey(b.startedAt)}\u0000${b.identity}`,
    ),
  );
  const trendTally = emptyTally();
  const trend = chronological.map((game) => {
    addOutcome(trendTally, game);
    return { gameId: game.id, winRate: trendTally.winRate };
  });
  return { ...tally, games: filtered, months, sides, services, openings, formations, trend };
}

export function inferAttribution(
  game: ParsedGame | GameRecord,
  settings: Settings,
): { mySide: Side | null; attribution: 'automatic' | 'manual' | 'ambiguous' | 'none' } {
  const configured = settings.playerNames[game.service] ?? [];
  const names = configured.map((name) => name.trim()).filter(Boolean);
  const black = names.some((name) => name === game.blackName.trim());
  const white = names.some((name) => name === game.whiteName.trim());
  if (black && white) {
    return { mySide: null, attribution: 'ambiguous' };
  }
  if (black) {
    return { mySide: 'black', attribution: 'automatic' };
  }
  if (white) {
    return { mySide: 'white', attribution: 'automatic' };
  }
  return { mySide: null, attribution: 'none' };
}

export function formationForOpening(opening: Opening, opponentOpening: Opening): Formation {
  const ownStatic = opening === 'static';
  const opponentStatic = opponentOpening === 'static';
  if (opening === 'unknown' || opponentOpening === 'unknown') {
    return 'unknown';
  }
  if (ownStatic && opponentStatic) {
    return 'double-static';
  }
  if (ownStatic !== opponentStatic) {
    return 'static-ranging';
  }
  return 'double-ranging';
}
