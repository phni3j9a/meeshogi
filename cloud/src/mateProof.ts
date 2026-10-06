import {
  Color,
  Direction,
  handPieceTypes,
  Move,
  movableDirections,
  MoveType,
  PieceType,
  Position,
  resolveMoveType,
  Square,
} from 'tsshogi';

/**
 * Server-side proof of a 1- or 3-ply mate for the side to move (Issue #45).
 *
 * A proof means: the side to move has a checking move after which every legal
 * reply (none for 1 ply) is answered by a mating check. Legality is decided by
 * tsshogi's `isValidMove`; a pawn drop is never accepted as the mating move
 * (打ち歩詰め). The search is bounded by a deterministic work budget, not by
 * time: Workers do not advance timers during synchronous CPU work. Running out
 * of budget yields `incomplete`, never a claim that no mate exists.
 */
export const MATE_PROOF_VERSION = 1;
/** Positions examined (after a move is made) per proof before giving up. */
export const MATE_PROOF_NODE_BUDGET = 10_000;

export type MateProofResult =
  | { version: typeof MATE_PROOF_VERSION; status: 'proven'; plies: 1 | 3; side: 'sente' | 'gote'; pv: string[] }
  | { version: typeof MATE_PROOF_VERSION; status: 'not-found' | 'incomplete' };

class BudgetExhausted extends Error {}

const LINES: Direction[] = [
  Direction.UP, Direction.DOWN, Direction.LEFT, Direction.RIGHT,
  Direction.LEFT_UP, Direction.RIGHT_UP, Direction.LEFT_DOWN, Direction.RIGHT_DOWN,
];
const KNIGHT_JUMPS: Direction[] = [
  Direction.LEFT_UP_KNIGHT, Direction.RIGHT_UP_KNIGHT,
  Direction.LEFT_DOWN_KNIGHT, Direction.RIGHT_DOWN_KNIGHT,
];

function isPawnDrop(move: Move): boolean {
  return !(move.from instanceof Square) && move.pieceType === PieceType.PAWN;
}

/**
 * Empty squares from which a dropped piece could give check to, or block a
 * check on, `king`: the open lines and knight jumps around it.
 */
function dropTargets(position: Position, king: Square | undefined): Square[] {
  if (!king) return [];
  const squares: Square[] = [];
  for (const dir of LINES) {
    for (let square = king.neighbor(dir); square.valid; square = square.neighbor(dir)) {
      if (position.board.at(square)) break;
      squares.push(square);
    }
  }
  for (const dir of KNIGHT_JUMPS) {
    const square = king.neighbor(dir);
    if (square.valid && !position.board.at(square)) squares.push(square);
  }
  return squares;
}

/**
 * Legal moves for the side to move. Drops are restricted to `dropSquares`;
 * callers pass squares that cover every drop relevant to them (checking drops
 * for the attacker, blocking drops for a defender in check).
 */
export function* legalMoves(position: Position, dropSquares: readonly Square[]): Generator<Move> {
  const color = position.color;
  const seen = new Set<string>();
  const accept = (move: Move | null): Move | null => {
    if (!move || seen.has(move.usi)) return null;
    seen.add(move.usi);
    try {
      return position.isValidMove(move) ? move : null;
    } catch {
      return null;
    }
  };
  for (const from of position.board.listSquaresByColor(color)) {
    const piece = position.board.at(from)!;
    for (const dir of movableDirections(piece)) {
      const long = resolveMoveType(piece, dir) === MoveType.LONG;
      for (let to = from.neighbor(dir); to.valid; to = to.neighbor(dir)) {
        const occupant = position.board.at(to);
        if (occupant && occupant.color === color) break;
        const move = position.createMove(from, to);
        if (move) {
          const plain = accept(move);
          if (plain) yield plain;
          const promoted = accept(move.withPromote());
          if (promoted) yield promoted;
        }
        if (!long || occupant) break;
      }
    }
  }
  const hand = position.hand(color);
  for (const type of handPieceTypes) {
    if (!hand.count(type)) continue;
    for (const to of dropSquares) {
      const move = accept(position.createMove(type, to));
      if (move) yield move;
    }
  }
}

class Prover {
  nodes = 0;

  constructor(private readonly budget: number) {}

  private play(position: Position, move: Move): Position {
    if (++this.nodes > this.budget) throw new BudgetExhausted();
    const next = position.clone();
    next.doMove(move, { ignoreValidation: true });
    return next;
  }

  private *checks(position: Position): Generator<[Move, Position]> {
    const enemyKing = position.board.findKing(position.color === Color.BLACK ? Color.WHITE : Color.BLACK);
    for (const move of legalMoves(position, dropTargets(position, enemyKing))) {
      const next = this.play(position, move);
      if (next.checked) yield [move, next];
    }
  }

  private hasReply(position: Position): boolean {
    const king = position.board.findKing(position.color);
    for (const _ of legalMoves(position, dropTargets(position, king))) return true;
    return false;
  }

  private replies(position: Position): Move[] {
    const king = position.board.findKing(position.color);
    return [...legalMoves(position, dropTargets(position, king))];
  }

  mateIn1(position: Position): string[] | null {
    for (const [move, next] of this.checks(position)) {
      if (isPawnDrop(move)) continue;
      if (!this.hasReply(next)) return [move.usi];
    }
    return null;
  }

  mateIn3(position: Position): string[] | null {
    for (const [move, next] of this.checks(position)) {
      const replies = this.replies(next);
      if (replies.length === 0) continue;
      let line: string[] | null = null;
      for (const reply of replies) {
        const finish = this.mateIn1(this.play(next, reply));
        if (!finish) {
          line = null;
          break;
        }
        line ??= [move.usi, reply.usi, ...finish];
      }
      if (line) return line;
    }
    return null;
  }
}

/** The proof plus the work it consumed, so callers can bound a whole session. */
export function proveMate(
  sfen: string,
  budget: number = MATE_PROOF_NODE_BUDGET,
): { proof: MateProofResult; nodes: number } {
  const position = Position.newBySFEN(sfen);
  if (!position) return { proof: { version: MATE_PROOF_VERSION, status: 'not-found' }, nodes: 0 };
  const side = position.color === Color.BLACK ? 'sente' : 'gote';
  const prover = new Prover(budget);
  const done = (proof: MateProofResult) => ({ proof, nodes: prover.nodes });
  try {
    const one = prover.mateIn1(position);
    if (one) return done({ version: MATE_PROOF_VERSION, status: 'proven', plies: 1, side, pv: one });
    const three = prover.mateIn3(position);
    if (three) return done({ version: MATE_PROOF_VERSION, status: 'proven', plies: 3, side, pv: three });
    return done({ version: MATE_PROOF_VERSION, status: 'not-found' });
  } catch (error) {
    if (error instanceof BudgetExhausted) return done({ version: MATE_PROOF_VERSION, status: 'incomplete' });
    throw error;
  }
}
