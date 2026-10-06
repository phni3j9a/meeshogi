import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { importKIF, Position, Square } from 'tsshogi';
import { legalMoves as referenceLegalMoves } from '../src/contract';
import { legalMoves, MATE_PROOF_VERSION, proveMate } from '../src/mateProof';

function gamePositions(path: string): string[] {
  const record = importKIF(readFileSync(new URL(path, import.meta.url), 'utf8'));
  if (record instanceof Error) throw record;
  record.goto(0);
  const sfens = [record.position.sfen];
  while (record.goForward()) sfens.push(record.position.sfen);
  return sfens;
}

const GAMES = [
  gamePositions('../../fixtures/kif/shogiwars.kif'),
  gamePositions('../../fixtures/kif/kiou.kif'),
];

/** Replays a proof and checks it really ends in mate with every reply covered. */
function replayEndsInMate(sfen: string, pv: string[]): boolean {
  const position = Position.newBySFEN(sfen)!;
  for (const [index, usi] of pv.entries()) {
    const move = position.createMoveByUSI(usi);
    if (!move || !position.isValidMove(move) || !position.doMove(move)) return false;
    // Every move of the mating side must give check.
    if (index % 2 === 0 && !position.checked) return false;
  }
  return position.checked && referenceLegalMoves(position.sfen).length === 0;
}

/** Independent brute-force reference: the plain legal-move generator, no pruning. */
function play(sfen: string, usi: string): string {
  const position = Position.newBySFEN(sfen)!;
  position.doMove(position.createMoveByUSI(usi)!);
  return position.sfen;
}
const isCheck = (sfen: string) => Position.newBySFEN(sfen)!.checked;
function referenceMate1(sfen: string): boolean {
  return referenceLegalMoves(sfen).some((usi) => {
    if (/^P\*/u.test(usi)) return false;
    const next = play(sfen, usi);
    return isCheck(next) && referenceLegalMoves(next).length === 0;
  });
}
function referencePlies(sfen: string): 1 | 3 | null {
  if (referenceMate1(sfen)) return 1;
  const mate3 = referenceLegalMoves(sfen).some((usi) => {
    const next = play(sfen, usi);
    if (!isCheck(next)) return false;
    const replies = referenceLegalMoves(next);
    return replies.length > 0 && replies.every((reply) => referenceMate1(play(next, reply)));
  });
  return mate3 ? 3 : null;
}

describe('mate proof move generation', () => {
  it('matches the reference legal-move generator on real game positions', () => {
    for (const sfens of GAMES) {
      for (const sfen of sfens) {
        const position = Position.newBySFEN(sfen)!;
        const fast = [...legalMoves(position, Square.all)].map((move) => move.usi).sort();
        expect(fast).toEqual([...referenceLegalMoves(sfen)].sort());
      }
    }
  });

  it('matches the reference generator with many pieces in hand and promotions', () => {
    for (const sfen of [
      '9/9/9/4k4/9/9/9/9/4K4 b 2R2B4G4S4N4L18P 1',
      'ln1g3nl/1r1s1kg2/p1pppp1pp/6p2/1p7/2P6/PPSPPPPPP/1B5R1/LN1GKGSNL b BGSNLP2p 1',
      '4k4/2P1P1P2/9/9/9/9/2p1p1p2/9/4K4 w RBGSNLP 1',
    ]) {
      const position = Position.newBySFEN(sfen)!;
      const fast = [...legalMoves(position, Square.all)].map((move) => move.usi).sort();
      expect(fast).toEqual([...referenceLegalMoves(sfen)].sort());
    }
  });
});

describe('server mate proof', () => {
  it('proves a 1-ply drop mate', () => {
    const { proof } = proveMate('7nk/9/7G1/9/9/9/9/9/K8 b L 1');
    expect(proof).toEqual({ version: MATE_PROOF_VERSION, status: 'proven', plies: 1, side: 'sente', pv: ['L*1b'] });
  });

  it('never accepts a pawn-drop mate (打ち歩詰め)', () => {
    // P*1b would leave the king without a legal reply, so it is an illegal drop.
    expect(proveMate('7nk/9/7G1/9/9/9/9/9/K8 b P 1').proof.status).toBe('not-found');
  });

  it('proves a 3-ply mate only when every reply is mated, for the side to move', () => {
    const sfen = GAMES[1][76];
    const { proof } = proveMate(sfen);
    expect(proof).toMatchObject({ status: 'proven', plies: 3, side: 'sente' });
    if (proof.status !== 'proven') throw new Error('expected proof');
    expect(proof.pv).toHaveLength(3);
    expect(replayEndsInMate(sfen, proof.pv)).toBe(true);
  });

  it('prefers a 1-ply mate and reports gote proofs on real positions', () => {
    const sfens = GAMES[0];
    const { proof } = proveMate(sfens[51]);
    expect(proof).toMatchObject({ status: 'proven', plies: 1, side: 'gote' });
    if (proof.status !== 'proven') throw new Error('expected proof');
    expect(replayEndsInMate(sfens[51], proof.pv)).toBe(true);
  });

  it('every proof on the fixture games replays to mate', () => {
    let proven = 0;
    for (const sfens of GAMES) {
      for (const sfen of sfens) {
        const { proof } = proveMate(sfen);
        if (proof.status !== 'proven') continue;
        proven += 1;
        expect(proof.pv).toHaveLength(proof.plies);
        expect(replayEndsInMate(sfen, proof.pv)).toBe(true);
      }
    }
    expect(proven).toBeGreaterThan(0);
  });

  it('agrees with a brute-force reference on every fixture position', () => {
    for (const sfens of GAMES) {
      for (const sfen of sfens) {
        const { proof } = proveMate(sfen);
        expect(proof.status === 'proven' ? proof.plies : null).toBe(referencePlies(sfen));
      }
    }
  });

  it('reports not-found for the initial position', () => {
    const sfen = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
    expect(proveMate(sfen).proof).toEqual({ version: MATE_PROOF_VERSION, status: 'not-found' });
  });

  it('reports incomplete, not "no mate", when the work budget runs out', () => {
    const result = proveMate('9/9/9/4k4/9/9/9/9/4K4 b 2R2B4G4S4N4L18P 1', 100);
    expect(result.proof).toEqual({ version: MATE_PROOF_VERSION, status: 'incomplete' });
    expect(result.nodes).toBe(101);
  });
});
