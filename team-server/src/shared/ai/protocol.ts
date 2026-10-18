// Copied from Worktrees Studio (src/shared/ai) by `npm run sync-core`. Do not edit here.
import { parseArtifactDraft } from '../pipeline/protocol.ts';
import { PIPELINE_LIMITS } from '../pipeline/types.ts';
import type { ArtifactDraft } from '../pipeline/types.ts';
import { LIMITS, cleanAgentText, parseCard, sanitizeText } from '../workspace/protocol.ts';
import type { ChatCard, Citation } from '../workspace/types.ts';
import { AI_LIMITS } from './types.ts';
import type { AgentPhase, RunErrorCode, RunEvent, RunFinal } from './types.ts';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const PHASES: AgentPhase[] = ['queued', 'thinking', 'searching', 'writing', 'verifying'];
const ERROR_CODES: RunErrorCode[] = ['budget', 'model_unavailable', 'invalid', 'internal'];

/** An id that is safe to put in a link and a database key. */
const CITE_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

/** What an agent says an answer rests on, cleaned: unknown kinds and odd ids are dropped, never repaired. */
export function parseCitations(v: unknown): Citation[] {
  if (!Array.isArray(v)) return [];
  const out: Citation[] = [];
  const seen = new Set<string>();
  for (const c of v) {
    if (out.length >= AI_LIMITS.citations) break;
    if (!isObj(c) || (c.kind !== 'doc' && c.kind !== 'ticket' && c.kind !== 'chat')) continue;
    if (typeof c.id !== 'string' || !CITE_ID.test(c.id)) continue;
    const title = typeof c.title === 'string' ? sanitizeText(c.title, 200) : '';
    if (!title) continue;
    const key = `${c.kind}:${c.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const quote = typeof c.quote === 'string' ? sanitizeText(c.quote, AI_LIMITS.quote) : '';
    out.push({ kind: c.kind, id: c.id, title, ...(quote ? { quote } : {}) });
  }
  return out;
}

/**
 * One event of the agent service's answer, checked the way a client frame is: the agent service is ours, but what a model wrote is
 * not, so nothing in `final` reaches a room without passing the same cleaning as a person's message. `null` when it is not an event.
 */
export function parseRunEvent(name: string, raw: string): RunEvent | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(v)) return null;
  switch (name) {
    case 'status':
      return PHASES.includes(v.phase as AgentPhase) ? { event: 'status', data: { phase: v.phase as AgentPhase } } : null;
    case 'step': {
      const tool = typeof v.tool === 'string' ? sanitizeText(v.tool, 60) : '';
      const summary = typeof v.summary === 'string' ? sanitizeText(v.summary, 160) : '';
      return tool ? { event: 'step', data: { tool, summary } } : null;
    }
    case 'final': {
      if (typeof v.text !== 'string') return null;
      const text = cleanAgentText(v.text);
      if (text === null) return null;
      const cards: ChatCard[] = [];
      for (const c of Array.isArray(v.cards) ? v.cards.slice(0, 2) : []) {
        const card = parseCard(c);
        if (card) cards.push(card);
      }
      // An artifact that is not valid is dropped, never repaired; the others are kept.
      const artifacts: ArtifactDraft[] = [];
      for (const a of Array.isArray(v.artifacts) ? v.artifacts.slice(0, PIPELINE_LIMITS.draftsPerRun) : []) {
        const draft = parseArtifactDraft(a);
        if (draft) artifacts.push(draft);
      }
      const u = isObj(v.usage) ? v.usage : {};
      const final: RunFinal = {
        text,
        citations: parseCitations(v.citations),
        cards,
        ...(artifacts.length ? { artifacts } : {}),
        usage: {
          model: typeof u.model === 'string' ? sanitizeText(u.model, 80) : '',
          inputTokens: isNum(u.inputTokens) ? Math.max(0, Math.floor(u.inputTokens)) : 0,
          outputTokens: isNum(u.outputTokens) ? Math.max(0, Math.floor(u.outputTokens)) : 0,
          seconds: isNum(u.seconds) ? Math.max(0, u.seconds) : 0,
        },
      };
      return { event: 'final', data: final };
    }
    case 'error': {
      const code = ERROR_CODES.includes(v.code as RunErrorCode) ? (v.code as RunErrorCode) : 'internal';
      const message = typeof v.message === 'string' ? sanitizeText(v.message, 300) : '';
      return { event: 'error', data: { code, message } };
    }
    default:
      return null;
  }
}

/** The answer text limit in one place, for callers that only have this module. */
export const ANSWER_LIMIT = LIMITS.agentText;
