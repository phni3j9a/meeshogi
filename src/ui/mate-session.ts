import { MateProof, Side } from '@/domain/model';

export type MateSession = { sfen: string; proof: MateProof; origin: string; bottomSide: Side };
let nextId = 0;
let current: { id: string; session: MateSession } | null = null;
/** Proofs are passed in memory, so a deep-link cannot invent a proven result. */
export function openMateSession(session: MateSession) {
  if (session.proof.status !== 'proven' || ![1, 3].includes(session.proof.plies ?? 0))
    throw new Error('証明済みの詰め手順がありません。');
  const id = String(++nextId);
  current = { id, session };
  return id;
}
export function getMateSession(id: string) {
  return current?.id === id ? current.session : null;
}
