import {
  ACCESSORIES,
  EMOTES,
  FLOOR_IDS,
  HAIR_STYLES,
  OUTFIT_STYLES,
  PANTS_STYLES,
  WALL_IDS,
  WORKSPACE_PAGES,
} from './types.ts';
import type {
  AskOption,
  Appearance,
  ChatCard,
  ChatMessage,
  Dir,
  EditOp,
  EmoteKind,
  GitActivity,
  MapProp,
  MapZone,
  PlayerState,
  PresenceStatus,
  ProposalItem,
  SessionInfo,
  SessionState,
  ThreadPatch,
  WorkThread,
  WorkspaceMap,
  WorkspacePage,
  WorkspaceRole,
} from './types.ts';
import { isPropKind } from './props.ts';
import { THREAD_ERRORS, THREAD_LIMITS, THREAD_STATES, validBranchName } from './threads.ts';
import { validHandle } from './chat.ts';
import { clampCodePoints, codePointLength, sanitizeText } from './text.ts';

export { sanitizeText };
export type { SessionInfo, SessionState };

/** Bumped when messages change in a way an old client or server would misread. The server refuses a `hello` below this. */
export const PROTOCOL_VERSION = 8;

/** Where "load earlier" continues from: the oldest message the client has. */
export interface HistoryCursor {
  at: number;
  id: string;
}

/** An agent as it is shown in chat. Agents live in each person's project folder, so the server only ever sees this snapshot. */
export interface AgentRef {
  handle: string;
  name: string;
  role?: string;
  look: Appearance;
}

/**
 * `fresh`: just mentioned. `resume`: the app reconnected and is still working on it. `rerun`: the person pressed "Run again"
 * on an older mention. The server allows older mentions for the last two.
 */
export type AgentStartMode = 'fresh' | 'resume' | 'rerun';

export type AgentRunState = 'queued' | 'thinking' | 'done' | 'failed' | 'expired';

/** What a server-run agent is doing while it is `thinking` (the office draws the agent walking and thinking from it). */
export type AgentPhase = 'queued' | 'thinking' | 'searching' | 'writing' | 'verifying';

/** What everyone in the room is told about an agent that is working on an answer. */
export interface AgentStatus {
  runId: string;
  /** Only in what the person who started the run is sent about it (other people never see it). */
  reqId?: string;
  agent: AgentRef;
  /** The person whose computer is running the agent. */
  by: string;
  byName: string;
  replyTo: string;
  state: AgentRunState;
  /** The room the run belongs to. */
  room?: string;
  /** The session the run belongs to. */
  session?: string;
  /** The person's app is not connected right now; the answer is still welcome for a few minutes. */
  offline?: boolean;
  reason?: string;
  /** Only for an agent that runs on the server: what it is doing now, and one safe line about it ("3 passages from 2 docs"). */
  phase?: AgentPhase;
  step?: string;
}

/* ───────────────────── Client → Server ───────────────────── */

export type ClientMsg =
  | { t: 'hello'; token: string; workspaceId: string; name: string; look: Appearance; github?: string; protocol?: number }
  | { t: 'move'; x: number; y: number; dir: Dir; moving: boolean }
  | { t: 'sit'; deskId: string | null }
  | { t: 'emote'; emote: EmoteKind }
  | { t: 'status'; status: PresenceStatus; text?: string }
  /** The page the person just opened: where they are seen in the office. */
  | { t: 'page.set'; page: WorkspacePage }
  | { t: 'activity'; activity: GitActivity | null }
  /** The Room conversation. `cid` is the client's own id for this send; the sender's copy of the saved message carries it back. */
  | { t: 'chat'; text: string; cid?: string; room?: string; thread?: string; scope?: 'nearby' | 'room' | 'dm'; to?: string }
  | { t: 'history.get'; reqId: string; room?: string; session?: string; before?: HistoryCursor; limit?: number }
  | { t: 'chat.delete'; id: string }
  | { t: 'agent.start'; reqId: string; replyTo: string; agent: AgentRef; mode: AgentStartMode }
  | { t: 'agent.reply'; reqId: string; replyTo: string; agent: AgentRef; text: string }
  | { t: 'agent.fail'; reqId: string }
  | { t: 'session.new'; reqId: string; room: string }
  | { t: 'session.archive'; reqId: string; room: string }
  | { t: 'session.delete'; reqId: string; session: string }
  | { t: 'desk.claim'; deskId: string | null }
  /** A worktree tab, in the sender's own zone (`room`). Only that zone's member may create or change one. */
  | { t: 'thread.new'; reqId: string; room: string; name: string; branch: string; base: string }
  | { t: 'thread.patch'; id: string; patch: ThreadPatch }
  | { t: 'thread.archive'; id: string }
  /** The owner's agent speaks in a tab (the project manager's question, an agent's progress), optionally with a card. */
  | { t: 'thread.say'; cid: string; thread: string; agent: AgentRef; text: string; ui?: ChatCard }
  /** The owner picks option(s) on an `ask` card (`picked` is empty for a `text` question answered in words). */
  | { t: 'card.answer'; thread: string; message: string; picked: string[] }
  /**
   * The owner decides a `plan` card in a worktree tab (`chosen` are agent handles), or a person accepts part of a `proposal` card
   * in a room (no `thread`; `chosen` are the card's item ids).
   */
  | { t: 'card.decide'; thread?: string; message: string; decision: 'proceeded' | 'dismissed'; chosen: string[] }
  | { t: 'edit'; op: EditOp }
  | { t: 'ping'; at: number };

/* ───────────────────── Server → Client ───────────────────── */

export interface WelcomeMsg {
  t: 'welcome';
  you: string;
  role: WorkspaceRole;
  workspace: { id: string; name: string };
  map: WorkspaceMap;
  players: PlayerState[];
  /** deskId → ownerId */
  deskOwners: Record<string, string>;
  /** The room the initial history belongs to. */
  room?: string;
  /** Active and archived sessions. */
  sessions?: SessionInfo[];
  /** The latest messages, oldest first. Older ones come from `history.get`. */
  history: ChatMessage[];
  /** There are messages older than the first one in `history`. */
  historyHasMore?: boolean;
  /** Agents that are working on an answer right now. */
  thinking?: AgentStatus[];
  /** The worktree tabs that are not archived. */
  threads?: WorkThread[];
  protocol?: number;
  serverTime: number;
}

/** Compact position tuple: [id, x, y, dir, moving(0/1)] */
export type PosTuple = [string, number, number, Dir, 0 | 1];

export type ServerMsg =
  | WelcomeMsg
  | { t: 'state'; time: number; p: PosTuple[] }
  | { t: 'join'; player: PlayerState }
  | { t: 'leave'; id: string }
  | { t: 'patch'; id: string; patch: Partial<PlayerState> }
  | { t: 'desk.owner'; deskId: string; ownerId: string | null }
  | { t: 'chat'; msg: ChatMessage }
  | { t: 'chat.deleted'; id: string }
  | { t: 'history.page'; reqId: string; room?: string; session?: string; messages: ChatMessage[]; hasMore: boolean; error?: string }
  | { t: 'agent.status'; status: AgentStatus }
  | { t: 'session.update'; session: SessionInfo }
  | { t: 'session.removed'; id: string; room: string }
  /** Your role changed while you were connected. */
  | { t: 'role'; role: WorkspaceRole }
  | { t: 'correct'; x: number; y: number }
  | { t: 'map.edit'; op: EditOp; by: string }
  /** The office was laid out again because the team changed. Everyone stays where they are unless the new walls need the spot. */
  | { t: 'map.set'; map: WorkspaceMap; deskOwners: Record<string, string> }
  /** A worktree tab was created or changed (`reqId` only in the answer to the person who asked for a new one). */
  | { t: 'thread.update'; thread: WorkThread; reqId?: string }
  /** Something on the Board or in Docs changed: the pages that show it read it again. */
  | { t: 'sync'; kind: 'board' | 'pages' | 'pipeline'; ids: string[] }
  /** A card changed (it was answered or decided). `thread` for a worktree tab's chat, `session` for a room's. */
  | { t: 'card'; id: string; thread?: string; session?: string; ui: ChatCard }
  /** Every refused request is answered: `cid` / `reqId` say which one. */
  | { t: 'error'; code: string; message: string; cid?: string; reqId?: string }
  | { t: 'pong'; at: number; serverTime: number };

/* ───────────────────── Limits ───────────────────── */

/** Text limits are in Unicode code points (an emoji counts once). Frames are checked in UTF-16 units at twice the limit first. */
export const LIMITS = {
  chatText: 500,
  /** What an agent is asked to keep its answer under. */
  agentTextAsked: 5000,
  /** What the server accepts. */
  agentText: 6000,
  agentName: 64,
  agentRole: 80,
  name: 32,
  statusText: 80,
  maxEditCells: 4096,
  maxMsgBytes: 256 * 1024,
  historyPage: 50,
  /** How long after an agent's answer the person who asked may still take it back (the app offers a shorter "Undo" bar). */
  undoMs: 60_000,
  /** How old a mention may be for each way of starting an agent run (`agent.start`'s `mode`). */
  startMaxAgeMs: { fresh: 60_000, resume: 15 * 60_000, rerun: 24 * 3600_000 },
} as const;

/* ───────────────────── Validation ───────────────────── */

const DIRS: Dir[] = ['down', 'left', 'right', 'up'];
const STATUSES: PresenceStatus[] = ['available', 'focus', 'meeting', 'away'];
const HEX = /^#[0-9a-fA-F]{6}$/;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length <= max;
const isInt = (v: unknown): v is number => isNum(v) && Number.isInteger(v);

export function validAppearance(v: unknown): v is Appearance {
  return (
    isObj(v) &&
    typeof v.skin === 'string' && HEX.test(v.skin) &&
    typeof v.hair === 'string' && HEX.test(v.hair) &&
    typeof v.outfit === 'string' && HEX.test(v.outfit) &&
    typeof v.pants === 'string' && HEX.test(v.pants) &&
    isInt(v.hairStyle) && v.hairStyle >= 0 && v.hairStyle < HAIR_STYLES &&
    isInt(v.accessory) && v.accessory >= 0 && v.accessory < ACCESSORIES &&
    (v.outfitStyle === undefined || (isInt(v.outfitStyle) && v.outfitStyle >= 0 && v.outfitStyle < OUTFIT_STYLES)) &&
    (v.pantsStyle === undefined || (isInt(v.pantsStyle) && v.pantsStyle >= 0 && v.pantsStyle < PANTS_STYLES))
  );
}

/** A look rebuilt from its known fields, so nothing extra a client attached to it is ever kept, saved or broadcast. */
export function pickAppearance(l: Appearance): Appearance {
  return {
    skin: l.skin, hair: l.hair, hairStyle: l.hairStyle, outfit: l.outfit, pants: l.pants, accessory: l.accessory,
    ...(l.outfitStyle === undefined ? {} : { outfitStyle: l.outfitStyle }),
    ...(l.pantsStyle === undefined ? {} : { pantsStyle: l.pantsStyle }),
  };
}

export function validActivity(v: unknown): v is GitActivity {
  return (
    isObj(v) &&
    isStr(v.repo, 80) && isStr(v.branch, 120) &&
    isInt(v.dirty) && isInt(v.ahead) && isInt(v.behind) && isInt(v.conflicts) &&
    (v.state === 'idle' || v.state === 'dirty' || v.state === 'merging' || v.state === 'conflict')
  );
}

/** A name or label that is already exactly what `sanitizeText` would keep (no control characters, half emoji or NUL). */
const isCleanText = (v: unknown, max: number): v is string => isStr(v, max * 2) && sanitizeText(v, max) === v;

function validProp(v: unknown): v is MapProp {
  return (
    isObj(v) && isMapId(v.id) && isPropKind(v.kind) &&
    isInt(v.x) && isInt(v.y) &&
    (v.variant === undefined || isInt(v.variant)) &&
    (v.label === undefined || isCleanText(v.label, 40))
  );
}

function validZone(v: unknown): v is MapZone {
  return (
    isObj(v) && isMapId(v.id) && isCleanText(v.name, 40) &&
    (v.kind === 'open' || v.kind === 'private' || v.kind === 'lounge' || v.kind === 'outdoor' || v.kind === 'lobby') &&
    isInt(v.x) && isInt(v.y) && isInt(v.w) && isInt(v.h) && v.w > 0 && v.h > 0 &&
    typeof v.color === 'string' && HEX.test(v.color) &&
    (v.private === undefined || typeof v.private === 'boolean')
  );
}

function validCells(v: unknown, allowed: number[]): v is [number, number, number][] {
  return (
    Array.isArray(v) && v.length <= LIMITS.maxEditCells &&
    v.every(
      (c) =>
        Array.isArray(c) && c.length === 3 && isInt(c[0]) && isInt(c[1]) &&
        isInt(c[2]) && allowed.includes(c[2]),
    )
  );
}

export function validEditOp(v: unknown): v is EditOp {
  if (!isObj(v) || typeof v.op !== 'string') return false;
  switch (v.op) {
    case 'floor': return validCells(v.cells, FLOOR_IDS);
    case 'wall': return validCells(v.cells, WALL_IDS);
    case 'prop.add': return validProp(v.prop);
    case 'prop.remove': return isMapId(v.id);
    case 'prop.move': return isMapId(v.id) && isInt(v.x) && isInt(v.y);
    case 'zone.set': return validZone(v.zone);
    case 'zone.remove': return isMapId(v.id);
    default: return false;
  }
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const isId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v);
/** A saved message's id: `<time>-<random>`, `a:<question>:<handle>`, `s:<question>:<handle>`. Printable, no NUL, so any database accepts it. */
const MSG_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
const isMsgId = (v: unknown): v is string => typeof v === 'string' && MSG_ID_RE.test(v);
/** The id of something on the map. */
const MAP_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
export const isMapId = (v: unknown): v is string => typeof v === 'string' && MAP_ID_RE.test(v);

/** The sizes of what a card may hold. */
export const CARD = {
  text: 300, option: 80, hint: 120, options: 8, steps: 8, step: 200, agents: 6, why: 200, risks: 5, summary: 600, body: 2000, size: 6000,
  /** A proposal: up to this many items, each with a title, a body and labels of these sizes. */
  items: 12, itemTitle: 200, itemBody: 800, labels: 8, label: 40, proposalSize: 14_000,
} as const;

const cleanLine = (v: unknown, max: number): string | null => {
  if (!isStr(v, max * 2)) return null;
  const t = sanitizeText(v, max);
  return t || null;
};

/**
 * A card from an untrusted client, cleaned, with `null` when it is not one. What only the server decides (`answered`, `decided`,
 * `chosen`) is never taken from the client.
 */
export function parseCard(v: unknown): ChatCard | null {
  if (!isObj(v) || JSON.stringify(v).length > (v.kind === 'proposal' ? CARD.proposalSize : CARD.size)) return null;
  switch (v.kind) {
    case 'ask': {
      const prompt = cleanLine(v.prompt, CARD.text);
      if (!prompt || typeof v.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(v.id)) return null;
      if (v.mode !== 'choice' && v.mode !== 'multi' && v.mode !== 'text') return null;
      if (!Array.isArray(v.options) || v.options.length > CARD.options) return null;
      const options: AskOption[] = [];
      for (const o of v.options) {
        if (!isObj(o) || !isMapId(o.id)) return null;
        const label = cleanLine(o.label, CARD.option);
        if (!label) return null;
        const hint = o.hint === undefined ? undefined : cleanLine(o.hint, CARD.hint);
        options.push({ id: o.id, label, ...(hint ? { hint } : {}) });
      }
      if (new Set(options.map((o) => o.id)).size !== options.length) return null;
      if (v.mode !== 'text' && options.length < 2) return null;
      return { kind: 'ask', id: v.id, mode: v.mode, prompt, options };
    }
    case 'plan': {
      const p = v.plan;
      if (!isObj(p)) return null;
      const summary = cleanLine(p.summary, CARD.summary);
      if (!summary || !Array.isArray(p.steps) || p.steps.length > CARD.steps || !Array.isArray(p.agents) || p.agents.length > CARD.agents) return null;
      const steps: string[] = [];
      for (const s of p.steps) {
        const line = cleanLine(s, CARD.step);
        if (!line) return null;
        steps.push(line);
      }
      const agents: { handle: string; why: string; effort?: 'low' | 'medium' | 'high' }[] = [];
      for (const a of p.agents) {
        if (!isObj(a) || !validHandle(a.handle)) return null;
        const effort = a.effort === 'low' || a.effort === 'medium' || a.effort === 'high' ? a.effort : undefined;
        agents.push({ handle: a.handle, why: cleanLine(a.why, CARD.why) ?? '', ...(effort ? { effort } : {}) });
      }
      if (new Set(agents.map((a) => a.handle)).size !== agents.length) return null;
      const risks: string[] = [];
      for (const r of Array.isArray(p.risks) ? p.risks.slice(0, CARD.risks) : []) {
        const line = cleanLine(r, CARD.step);
        if (line) risks.push(line);
      }
      let ticket: Extract<ChatCard, { kind: 'plan' }>['plan']['ticket'] = null;
      if (isObj(p.ticket)) {
        if (isMapId(p.ticket.link)) ticket = { link: p.ticket.link };
        else if (isObj(p.ticket.create)) {
          const title = cleanLine(p.ticket.create.title, 200);
          if (!title) return null;
          ticket = { create: { title, body: typeof p.ticket.create.body === 'string' ? sanitizeText(p.ticket.create.body, CARD.body) : '' } };
        }
      }
      return { kind: 'plan', plan: { summary, steps, agents, ticket, risks } };
    }
    case 'result': {
      const summary = cleanLine(v.summary, CARD.summary);
      if (!summary || (v.status !== 'done' && v.status !== 'blocked')) return null;
      return {
        kind: 'result', summary, status: v.status,
        ...(validBranchName(v.branch) ? { branch: v.branch } : {}),
        ...(v.ticket === null || isMapId(v.ticket) ? { ticket: v.ticket as string | null } : {}),
      };
    }
    case 'proposal': {
      const title = cleanLine(v.title, CARD.text);
      if (!title || typeof v.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(v.id)) return null;
      if (!Array.isArray(v.items) || v.items.length < 1 || v.items.length > CARD.items) return null;
      const items: ProposalItem[] = [];
      for (const it of v.items) {
        if (!isObj(it) || typeof it.id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(it.id)) return null;
        if (it.type !== 'ticket' && it.type !== 'doc' && it.type !== 'artifact') return null;
        const itemTitle = cleanLine(it.title, CARD.itemTitle);
        if (!itemTitle) return null;
        const labels: string[] = [];
        for (const l of Array.isArray(it.labels) ? it.labels.slice(0, CARD.labels) : []) {
          const label = cleanLine(l, CARD.label);
          if (label) labels.push(label);
        }
        items.push({
          id: it.id, type: it.type, title: itemTitle,
          body: typeof it.body === 'string' ? sanitizeText(it.body, CARD.itemBody) : '',
          ...(labels.length ? { labels } : {}),
          ...(isInt(it.points) && it.points >= 0 && it.points <= 100 ? { points: it.points } : {}),
          ...(isInt(it.duplicateOf) && it.duplicateOf >= 1 ? { duplicateOf: it.duplicateOf } : {}),
          ...(it.type === 'artifact' && typeof it.artifactId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(it.artifactId) ? { artifactId: it.artifactId } : {}),
          ...(it.type === 'artifact' && typeof it.artifactKind === 'string' && /^[a-z_]{1,32}$/.test(it.artifactKind) ? { artifactKind: it.artifactKind } : {}),
        });
      }
      if (new Set(items.map((i) => i.id)).size !== items.length) return null;
      return { kind: 'proposal', id: v.id, title, items };
    }
    default:
      return null;
  }
}

/** What an owner may change on a worktree tab, from an untrusted client, cleaned. `null` when anything in it is not allowed. */
export function parseThreadPatch(v: unknown): ThreadPatch | null {
  if (!isObj(v)) return null;
  const out: ThreadPatch = {};
  for (const [key, val] of Object.entries(v)) {
    switch (key) {
      case 'state':
        if (!THREAD_STATES.includes(val as never)) return null;
        out.state = val as ThreadPatch['state'];
        break;
      case 'step':
        if (val === null) out.step = null;
        else if (isStr(val, THREAD_LIMITS.step * 2)) out.step = sanitizeText(val, THREAD_LIMITS.step);
        else return null;
        break;
      case 'error':
        if (val === null) out.error = null;
        else if (isObj(val) && THREAD_ERRORS.includes(val.code as never) && isStr(val.message, THREAD_LIMITS.error * 2)) {
          out.error = { code: val.code as never, message: sanitizeText(val.message, THREAD_LIMITS.error) };
        } else return null;
        break;
      case 'name': {
        if (!isStr(val, THREAD_LIMITS.name * 2)) return null;
        const name = sanitizeText(val, THREAD_LIMITS.name);
        if (!name) return null;
        out.name = name;
        break;
      }
      case 'ticket':
        if (val === null || isId(val) || isMapId(val)) out.ticket = val;
        else return null;
        break;
      case 'docs':
        if (!Array.isArray(val) || val.length > THREAD_LIMITS.docs || !val.every((d) => isMapId(d))) return null;
        out.docs = [...new Set(val as string[])];
        break;
      case 'purpose':
        if (!isStr(val, THREAD_LIMITS.purpose * 2)) return null;
        out.purpose = sanitizeText(val, THREAD_LIMITS.purpose);
        break;
      default:
        return null;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** An agent snapshot from an untrusted client, cleaned. */
export function parseAgentRef(v: unknown): AgentRef | null {
  if (!isObj(v) || !validHandle(v.handle) || !isStr(v.name, LIMITS.agentName * 2) || !validAppearance(v.look)) return null;
  if (v.role !== undefined && !isStr(v.role, LIMITS.agentRole * 2)) return null;
  const name = sanitizeText(v.name, LIMITS.agentName);
  if (!name) return null;
  const role = typeof v.role === 'string' ? sanitizeText(v.role, LIMITS.agentRole) : undefined;
  return { handle: v.handle, name, ...(role ? { role } : {}), look: pickAppearance(v.look) };
}

/** The `cid` / `reqId` of a frame that failed validation, so the refusal can say which request it was. */
export function rawRefs(raw: string): { cid?: string; reqId?: string } {
  try {
    const v: unknown = JSON.parse(raw);
    if (!isObj(v)) return {};
    return { ...(isId(v.cid) ? { cid: v.cid } : {}), ...(isId(v.reqId) ? { reqId: v.reqId } : {}) };
  } catch {
    return {};
  }
}

/** Parse + validate an untrusted client frame. Returns null when invalid. */
export function parseClientMsg(raw: string): ClientMsg | null {
  if (raw.length > LIMITS.maxMsgBytes) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(v) || typeof v.t !== 'string') return null;
  switch (v.t) {
    case 'hello':
      if (
        isStr(v.token, 4096) && isStr(v.workspaceId, 64) && /^[A-Za-z0-9_-]{1,64}$/.test(v.workspaceId) &&
        isStr(v.name, LIMITS.name * 2) && validAppearance(v.look) &&
        (v.github === undefined || isStr(v.github, 512)) && (v.protocol === undefined || isInt(v.protocol))
      ) {
        const name = sanitizeText(v.name, LIMITS.name);
        if (!name) return null;
        return {
          t: 'hello', token: v.token, workspaceId: v.workspaceId, name, look: pickAppearance(v.look),
          github: typeof v.github === 'string' ? v.github : undefined,
          protocol: typeof v.protocol === 'number' ? v.protocol : undefined,
        };
      }
      return null;
    case 'move':
      if (isNum(v.x) && isNum(v.y) && DIRS.includes(v.dir as Dir) && typeof v.moving === 'boolean')
        return { t: 'move', x: v.x, y: v.y, dir: v.dir as Dir, moving: v.moving };
      return null;
    case 'sit':
      if (v.deskId === null || isStr(v.deskId, 64)) return { t: 'sit', deskId: v.deskId as string | null };
      return null;
    case 'emote':
      if (EMOTES.includes(v.emote as EmoteKind)) return { t: 'emote', emote: v.emote as EmoteKind };
      return null;
    case 'page.set':
      if (WORKSPACE_PAGES.includes(v.page as WorkspacePage)) return { t: 'page.set', page: v.page as WorkspacePage };
      return null;
    case 'status':
      if (STATUSES.includes(v.status as PresenceStatus) && (v.text === undefined || isStr(v.text, LIMITS.statusText * 2)))
        return {
          t: 'status',
          status: v.status as PresenceStatus,
          text: typeof v.text === 'string' ? sanitizeText(v.text, LIMITS.statusText) : undefined,
        };
      return null;
    case 'activity':
      if (v.activity === null) return { t: 'activity', activity: null };
      if (validActivity(v.activity)) return { t: 'activity', activity: v.activity };
      return null;
    case 'chat': {
      // Only the Room exists now: an old client asking for `nearby` or `dm` is refused, not quietly widened to everyone.
      if (v.scope !== undefined && v.scope !== 'room') return null;
      if (!isStr(v.text, LIMITS.chatText * 2) || (v.cid !== undefined && !isId(v.cid))) return null;
      if (v.room !== undefined && !isMapId(v.room)) return null;
      if (v.thread !== undefined && !isId(v.thread)) return null;
      const text = sanitizeText(v.text, LIMITS.chatText);
      if (!text) return null;
      return {
        t: 'chat',
        text,
        cid: v.cid as string | undefined,
        ...(typeof v.room === 'string' ? { room: v.room } : {}),
        ...(typeof v.thread === 'string' ? { thread: v.thread } : {}),
      };
    }
    case 'history.get': {
      if (!isId(v.reqId)) return null;
      if (v.room !== undefined && !isMapId(v.room)) return null;
      if (v.session !== undefined && !isId(v.session)) return null;
      let before: HistoryCursor | undefined;
      if (v.before !== undefined) {
        const at = isObj(v.before) ? v.before.at : undefined;
        if (!isObj(v.before) || typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0 || !isMsgId(v.before.id)) return null;
        before = { at, id: v.before.id };
      }
      if (v.limit !== undefined && (!isInt(v.limit) || v.limit < 1 || v.limit > LIMITS.historyPage)) return null;
      return {
        t: 'history.get',
        reqId: v.reqId,
        ...(typeof v.room === 'string' ? { room: v.room } : {}),
        ...(typeof v.session === 'string' ? { session: v.session } : {}),
        before,
        limit: v.limit as number | undefined,
      };
    }
    case 'chat.delete':
      if (isMsgId(v.id)) return { t: 'chat.delete', id: v.id };
      return null;
    case 'agent.start': {
      const agent = parseAgentRef(v.agent);
      if (isId(v.reqId) && isMsgId(v.replyTo) && agent && (v.mode === 'fresh' || v.mode === 'resume' || v.mode === 'rerun'))
        return { t: 'agent.start', reqId: v.reqId, replyTo: v.replyTo, agent, mode: v.mode };
      return null;
    }
    case 'agent.reply': {
      const agent = parseAgentRef(v.agent);
      if (isId(v.reqId) && isMsgId(v.replyTo) && agent && isStr(v.text, LIMITS.agentText * 2))
        return { t: 'agent.reply', reqId: v.reqId, replyTo: v.replyTo, agent, text: v.text };
      return null;
    }
    case 'agent.fail':
      if (isId(v.reqId)) return { t: 'agent.fail', reqId: v.reqId };
      return null;
    case 'session.new':
      if (isId(v.reqId) && isMapId(v.room)) return { t: 'session.new', reqId: v.reqId, room: v.room };
      return null;
    case 'session.archive':
      if (isId(v.reqId) && isMapId(v.room)) return { t: 'session.archive', reqId: v.reqId, room: v.room };
      return null;
    case 'session.delete':
      if (isId(v.reqId) && isId(v.session)) return { t: 'session.delete', reqId: v.reqId, session: v.session };
      return null;
    case 'desk.claim':
      if (v.deskId === null || isStr(v.deskId, 64)) return { t: 'desk.claim', deskId: v.deskId as string | null };
      return null;
    case 'thread.new': {
      if (!isId(v.reqId) || !isMapId(v.room) || !isStr(v.name, THREAD_LIMITS.name * 2)) return null;
      if (!validBranchName(v.branch) || !validBranchName(v.base)) return null;
      const name = sanitizeText(v.name, THREAD_LIMITS.name);
      if (!name) return null;
      return { t: 'thread.new', reqId: v.reqId, room: v.room, name, branch: v.branch, base: v.base };
    }
    case 'thread.patch': {
      const patch = parseThreadPatch(v.patch);
      if (isId(v.id) && patch) return { t: 'thread.patch', id: v.id, patch };
      return null;
    }
    case 'thread.archive':
      if (isId(v.id)) return { t: 'thread.archive', id: v.id };
      return null;
    case 'thread.say': {
      const agent = parseAgentRef(v.agent);
      if (!isId(v.cid) || !isId(v.thread) || !agent || !isStr(v.text, LIMITS.agentText * 2)) return null;
      if (v.ui === undefined) return { t: 'thread.say', cid: v.cid, thread: v.thread, agent, text: v.text };
      const ui = parseCard(v.ui);
      // A proposal is something the server's own agents make for a room; a tab's owner's app never sends one.
      return ui && ui.kind !== 'proposal' ? { t: 'thread.say', cid: v.cid, thread: v.thread, agent, text: v.text, ui } : null;
    }
    case 'card.answer':
      if (isId(v.thread) && isMsgId(v.message) && Array.isArray(v.picked) && v.picked.length <= CARD.options && v.picked.every((p) => isMapId(p)))
        return { t: 'card.answer', thread: v.thread, message: v.message, picked: [...new Set(v.picked as string[])] };
      return null;
    case 'card.decide':
      if (
        (v.thread === undefined || isId(v.thread)) && isMsgId(v.message) && (v.decision === 'proceeded' || v.decision === 'dismissed') &&
        Array.isArray(v.chosen) && v.chosen.length <= CARD.items && v.chosen.every((h) => validHandle(h))
      )
        return {
          t: 'card.decide', ...(typeof v.thread === 'string' ? { thread: v.thread } : {}), message: v.message, decision: v.decision,
          chosen: [...new Set(v.chosen as string[])],
        };
      return null;
    case 'edit':
      if (validEditOp(v.op)) return { t: 'edit', op: v.op };
      return null;
    case 'ping':
      if (isNum(v.at)) return { t: 'ping', at: v.at };
      return null;
    default:
      return null;
  }
}

/** Whether a map's layers are as long as its size says (a map that is not would be drawn and walked on wrongly). */
export function mapShapeOk(map: WorkspaceMap): boolean {
  const cells = map.width * map.height;
  return (
    Number.isInteger(map.width) && Number.isInteger(map.height) && map.width > 0 && map.height > 0 &&
    map.floor.length === cells && map.wall.length === cells
  );
}

/** Apply a validated edit op to a map (mutates). Returns false if it had no effect. */
export function applyEditOp(map: WorkspaceMap, op: EditOp): boolean {
  const { width: w, height: h } = map;
  const inb = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h;
  switch (op.op) {
    case 'floor':
    case 'wall': {
      const layer = op.op === 'floor' ? map.floor : map.wall;
      let changed = false;
      for (const [x, y, id] of op.cells) {
        if (!inb(x, y)) continue;
        if (layer[y * w + x] !== id) {
          layer[y * w + x] = id;
          changed = true;
        }
      }
      return changed;
    }
    case 'prop.add':
      if (!inb(op.prop.x, op.prop.y) || map.props.some((p) => p.id === op.prop.id)) return false;
      map.props.push({ ...op.prop });
      return true;
    case 'prop.remove': {
      const i = map.props.findIndex((p) => p.id === op.id);
      if (i < 0) return false;
      map.props.splice(i, 1);
      return true;
    }
    case 'prop.move': {
      const p = map.props.find((q) => q.id === op.id);
      if (!p || !inb(op.x, op.y)) return false;
      p.x = op.x;
      p.y = op.y;
      return true;
    }
    case 'zone.set': {
      const i = map.zones.findIndex((z) => z.id === op.zone.id);
      if (i >= 0) map.zones[i] = { ...op.zone };
      else map.zones.push({ ...op.zone });
      return true;
    }
    case 'zone.remove': {
      const i = map.zones.findIndex((z) => z.id === op.id);
      if (i < 0) return false;
      map.zones.splice(i, 1);
      return true;
    }
  }
}

/** The text of an agent's reply, cleaned, or null when it is empty or longer than the server accepts (it never truncates). */
export function cleanAgentText(text: string): string | null {
  const clean = sanitizeText(text, LIMITS.agentText + 1);
  if (!clean || codePointLength(clean) > LIMITS.agentText) return null;
  return clean;
}

export { clampCodePoints, codePointLength };
