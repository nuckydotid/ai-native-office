import type { HistoryCursor } from '../../shared/workspace/protocol.ts';
import type { ChatKind, ChatMessage } from '../../shared/workspace/types.ts';

/** The most messages kept in memory. Older ones are still in the team database and come back with "Load earlier". */
export const CHAT_CAP = 2000;

/** How many messages one "Load earlier" asks for. */
export const PAGE_SIZE = 50;

/** The server orders by time, then by id as plain text (ids are ASCII), so this does too. */
export function compareMessages(a: Pick<ChatMessage, 'at' | 'id'>, b: Pick<ChatMessage, 'at' | 'id'>): number {
  if (a.at !== b.at) return a.at - b.at;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** What a message is. Old saved rows have no `kind`: they are people, or the office's own notes. */
export function kindOf(m: Pick<ChatMessage, 'kind' | 'scope' | 'from'>): ChatKind {
  if (m.kind) return m.kind;
  if (m.scope === 'system' || m.from === 'system') return 'system';
  return m.from.startsWith('agent:') ? 'agent' : 'human';
}

/** A message with its words taken out, as the server keeps it. */
const tombstone = (m: ChatMessage): ChatMessage => ({ ...m, text: '', deleted: true, mentions: [] });

/**
 * Adds `incoming` to `list` (a page of history, the tail from a welcome, or one live message) and returns them in order.
 * A message already there is not added twice; a removed message stays removed whichever copy arrives last; the copy that
 * carries the sender's `cid` keeps it; a message the server saved again later (a failure note repeated, an answer that
 * was taken back and asked for again) moves to its new time. Returns `list` itself when nothing changed.
 *
 * One thing can undo a removal: the server saved the same message again with a LATER time. A stale copy of the message
 * that was removed has the old time, so it never does.
 */
export function mergeMessages(list: readonly ChatMessage[], incoming: readonly ChatMessage[]): ChatMessage[] {
  if (incoming.length === 0) return list as ChatMessage[];
  const byId = new Map(list.map((m) => [m.id, m]));
  let changed = false;
  for (const m of incoming) {
    const have = byId.get(m.id);
    if (!have) {
      byId.set(m.id, m);
      changed = true;
      continue;
    }
    if (have.deleted && !m.deleted && m.at > have.at) {
      byId.set(m.id, { ...m, cid: m.cid ?? have.cid });
      changed = true;
      continue;
    }
    const merged = have.deleted || m.deleted ? tombstone(have.deleted ? have : m) : { ...m, cid: m.cid ?? have.cid };
    if (merged.deleted !== have.deleted || merged.text !== have.text || merged.cid !== have.cid || merged.at !== have.at) {
      byId.set(m.id, merged);
      changed = true;
    }
  }
  return changed ? [...byId.values()].sort(compareMessages) : (list as ChatMessage[]);
}

/**
 * Applies what the server says about messages the list already holds (a removal that happened while the person was away) and
 * ignores the rest: a page fetched only to check kept messages must not quietly load history the person never asked for.
 */
export function mergeKnown(list: readonly ChatMessage[], incoming: readonly ChatMessage[]): ChatMessage[] {
  const held = new Set(list.map((m) => m.id));
  return mergeMessages(list, incoming.filter((m) => held.has(m.id)));
}

/** Drops the oldest messages beyond `cap`. `trimmed` says some were dropped, so "Load earlier" must be offered again. */
export function trimOldest(list: ChatMessage[], cap = CHAT_CAP): { list: ChatMessage[]; trimmed: boolean } {
  return list.length > cap ? { list: list.slice(list.length - cap), trimmed: true } : { list, trimmed: false };
}

/** Drops everything older than `cursor` (what could not be checked against the server any more). */
export function dropBefore(list: ChatMessage[], cursor: HistoryCursor): ChatMessage[] {
  const kept = list.filter((m) => compareMessages(m, cursor) >= 0);
  return kept.length === list.length ? list : kept;
}

/** Takes the words out of one message (someone deleted it). */
export function markDeleted(list: ChatMessage[], id: string): ChatMessage[] {
  const i = list.findIndex((m) => m.id === id);
  if (i < 0 || list[i].deleted) return list;
  const next = [...list];
  next[i] = tombstone(list[i]);
  return next;
}

/** Where "Load earlier" continues from: the oldest message the person has. */
export function cursorOf(list: readonly ChatMessage[]): HistoryCursor | undefined {
  const first = list[0];
  return first ? { at: first.at, id: first.id } : undefined;
}

export interface Loaded {
  chat: ChatMessage[];
  historyHasMore: boolean;
}

/**
 * The latest messages the server sent on joining. After a short break the person already has most of them: they are
 * merged in, and whatever "Load earlier" had reached stays. After a long break (nothing in common) the old list would have
 * a hole in it, so it is replaced, the way a first visit starts. `replaced` tells the screen to jump to the bottom.
 */
export function applyWelcomeTail(current: Loaded, tail: readonly ChatMessage[], hasMoreBefore: boolean): Loaded & { replaced: boolean } {
  // The same message at the same time: a message the server saved again later (a repeated failure note) says nothing about
  // whether what lies between the two lists was seen.
  const known = new Map(current.chat.map((m) => [m.id, m.at]));
  const overlap = current.chat.length > 0 && tail.some((m) => known.get(m.id) === m.at);
  if (overlap) {
    // Never raised: the person may have loaded everything already, and the tail does not reach back that far.
    return { chat: mergeMessages(current.chat, tail), historyHasMore: current.historyHasMore, replaced: false };
  }
  return { chat: mergeMessages([], tail), historyHasMore: hasMoreBefore, replaced: current.chat.length > 0 };
}

/** Which messages the person has not read, for messages that arrive while they are not looking. */
export const isFromOthers = (m: ChatMessage, you: string | null): boolean => kindOf(m) !== 'system' && m.from !== you && !m.deleted;
