/** What the message list looked like before it changed. */
export interface Before {
  firstId: string | null;
  lastId: string | null;
  /** Whether the person was reading the newest messages (at or near the bottom). */
  nearBottom: boolean;
}

export type ScrollPlan =
  /** The list changed somewhere the person is not looking, or in place (a deleted message): leave the scroll alone. */
  | 'keep'
  /** Older messages were added above: move by the height they took, so what is on screen does not jump. */
  | 'anchor'
  /** Go to the newest message. */
  | 'bottom'
  /** New messages arrived while the person is reading older ones: keep their place and offer "New messages". */
  | 'unread';

/**
 * What to do with the scroll position when the list changes.
 * `replaced`: the list was thrown away and started again (rejoining after a long break). `lastIsMine`: the person just
 * sent the newest message, so they want to see it.
 */
export function planScroll(before: Before, next: { firstId: string | null; lastId: string | null }, opts: { replaced?: boolean; lastIsMine?: boolean } = {}): ScrollPlan {
  if (next.lastId === null) return 'keep';
  if (before.firstId === null || opts.replaced) return 'bottom';
  if (next.lastId !== before.lastId) return before.nearBottom || opts.lastIsMine ? 'bottom' : 'unread';
  if (next.firstId !== before.firstId) return 'anchor';
  return 'keep';
}

/** At or within `slack` pixels of the bottom of a scrolling box. */
export function nearBottom(box: { scrollTop: number; scrollHeight: number; clientHeight: number }, slack = 48): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= slack;
}

/** How many messages come after `id` (all of them when it is not in the list any more). */
export function countAfter(ids: readonly string[], id: string | null): number {
  if (id === null) return ids.length;
  const i = ids.lastIndexOf(id);
  return i < 0 ? ids.length : ids.length - 1 - i;
}
