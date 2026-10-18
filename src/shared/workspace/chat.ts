/** What an agent is called in `@mentions`: a short slug. */
export const HANDLE_RE = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * Words that already mean something in a chat, or are folders in the agents' seed that aren't an agent, so no agent may
 * have them as its handle.
 */
export const RESERVED_HANDLES: readonly string[] = ['here', 'all', 'everyone', 'channel', 'system', 'agent', 'you', 'me', 'skills', 'office'];

export const validHandle = (h: unknown): h is string => typeof h === 'string' && HANDLE_RE.test(h) && !RESERVED_HANDLES.includes(h);

/** One message may call at most this many different agents. */
export const MAX_MENTIONS = 3;

// `@name` at the start of the text or after a space or an opening bracket, and not followed by more name or by a slash or
// an at sign: `ann@example.com` and `@scope/package` are not mentions.
const MENTION = /(?:^|[\s(])@([A-Za-z][A-Za-z0-9-]{0,39})(?=$|[\s.,;:!?)])/g;

/** Every distinct handle mentioned, lower case, in order (reserved words left out). */
export function allMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION)) {
    const handle = m[1].toLowerCase();
    if (validHandle(handle) && !out.includes(handle)) out.push(handle);
  }
  return out;
}

/** The first `max` distinct handles: the ones an agent run is started for. */
export const extractMentions = (text: string, max = MAX_MENTIONS): string[] => allMentions(text).slice(0, max);

/** The id of the saved reply an agent gave to a message. Deterministic, so "already answered" is a lookup that survives a restart. */
export const agentReplyId = (replyTo: string, handle: string) => `a:${replyTo}:${handle}`;

/** The id of the note saved when an agent run fails or runs out of time. */
export const agentFailureId = (replyTo: string, handle: string) => `s:${replyTo}:${handle}`;
