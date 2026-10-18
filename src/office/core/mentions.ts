import { allMentions, MAX_MENTIONS, validHandle } from '../../shared/workspace/chat.ts';

/** An `@name` being typed: where it starts (at the `@`), where the caret is, and what is typed after the `@`. */
export interface MentionAtCaret {
  start: number;
  end: number;
  query: string;
}

const WORD = /^[A-Za-z0-9-]*$/;

/**
 * The `@name` the caret is in or right after, if any: the `@` has to be at the start of the text or after a space, a new line or
 * an opening bracket (so `ann@example.com` is not a mention), and only letters, digits and dashes follow it.
 */
export function mentionAtCaret(text: string, caret: number): MentionAtCaret | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  const query = before.slice(at + 1);
  if (!WORD.test(query) || query.length > 40) return null;
  const prev = at === 0 ? '' : before[at - 1];
  if (prev !== '' && !/[\s(]/.test(prev)) return null;
  return { start: at, end: caret, query };
}

/** What can be mentioned, as the list of suggestions needs it. */
export interface Mentionable {
  handle: string;
  displayName: string;
  role?: string;
}

/** The agents to suggest for what is typed after the `@`: names that start with it first, then ones that contain it. */
export function suggestAgents<T extends Mentionable>(agents: readonly T[], query: string, limit = 6): T[] {
  const q = query.toLowerCase();
  const score = (a: T) => {
    const handle = a.handle.toLowerCase();
    const name = a.displayName.toLowerCase();
    if (!q) return 2;
    if (handle.startsWith(q) || name.startsWith(q)) return 0;
    if (name.split(/\s+/).some((w) => w.startsWith(q))) return 1;
    if (handle.includes(q) || name.includes(q)) return 2;
    return -1;
  };
  return agents
    .map((a, i) => ({ a, i, s: score(a) }))
    .filter((x) => x.s >= 0)
    .sort((x, y) => x.s - y.s || x.a.handle.localeCompare(y.a.handle) || x.i - y.i)
    .slice(0, limit)
    .map((x) => x.a);
}

/** What a message calls that the project can't answer: handles no agent has, and handles past the limit of three. */
export function checkMentions(text: string, known: readonly string[]): { unknown: string[]; skipped: string[] } {
  const all = allMentions(text);
  const kept = all.slice(0, MAX_MENTIONS);
  return { unknown: kept.filter((h) => !known.includes(h)), skipped: all.slice(MAX_MENTIONS) };
}

/** The sentence for a message that called something this project doesn't have. */
export function mentionNotice(check: { unknown: string[]; skipped: string[] }): string | null {
  const parts: string[] = [];
  if (check.unknown.length === 1) parts.push(`No agent named ${check.unknown[0]} in this project. Pull the latest, or create it in Agents.`);
  else if (check.unknown.length > 1) parts.push(`No agents named ${check.unknown.join(', ')} in this project. Pull the latest, or create them in Agents.`);
  if (check.skipped.length) parts.push(`A message can call three agents; ${check.skipped.join(', ')} ${check.skipped.length === 1 ? 'was' : 'were'} left out.`);
  return parts.length ? parts.join(' ') : null;
}

/** The message without the `@handles` of the agents it called, for the question the agent is asked. Empty when only agents were named. */
export function stripMentions(text: string, handles: readonly string[]): string {
  let out = text;
  for (const h of handles) {
    if (!validHandle(h)) continue;
    out = out.replace(new RegExp(`(^|[\\s(])@${h}(?=$|[\\s.,;:!?)])`, 'gi'), '$1');
  }
  // Nothing was removed: the question is exactly what was typed (its line breaks and spacing included).
  if (out === text) return text.trim();
  // Close the gap a removed handle left, on its own line only (a line break is part of the question).
  return out
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/^[\s,;:]+/, '')
    .trim();
}
