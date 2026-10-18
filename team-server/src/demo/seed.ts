import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Issue, IssuePriority, IssueStatus } from '../shared/board/types.ts';
import { BOARD_LIMITS, ISSUE_PRIORITIES, ISSUE_STATUSES } from '../shared/board/types.ts';
import type { Page } from '../shared/pages/types.ts';
import { PIPELINE_STAGES, statusForStage } from '../shared/pipeline/types.ts';
import type { PipelineStage } from '../shared/pipeline/types.ts';
import { PAGES_LIMITS } from '../shared/pages/types.ts';
import { lookFromSeed } from '../shared/workspace/looks.ts';
import type { ChatMessage, SessionInfo, WorkspaceRole } from '../shared/workspace/types.ts';
import { clampCodePoints, sanitizeText } from '../shared/workspace/protocol.ts';
import { HANDLE_RE } from '../shared/workspace/chat.ts';
import type { CollabStore } from '../collab-store.ts';
import { OFFICE_ID } from '../store.ts';
import type { MemberDoc, Store } from '../store.ts';
import { parseAgentDef } from '../ai/agents.ts';
import type { AgentDef } from '../ai/agents.ts';
import { DEFAULT_AGENTS } from '../ai/default-agents.ts';

/** The demo's fictional team, as `docs/demo-data/team.json` describes it. */
export interface SeedMember {
  handle: string;
  name: string;
  role: 'founder' | 'pm' | 'frontend';
}

export interface SeedPage {
  /** The file name without `.md`. */
  slug: string;
  id: string;
  title: string;
  /** The slug of the parent page, or null. */
  parent: string | null;
  order: number;
  body: string;
}

export interface SeedTicket {
  key: number;
  title: string;
  body: string;
  status: IssueStatus;
  priority: IssuePriority;
  /** A member's handle. */
  assignee: string | null;
  labels: string[];
  points: number;
  pr: string | null;
  /** What `tickets/<key>.md` would hold; appended to the body so the agents can read it. */
  notes: string;
  /** Where the ticket is in the delivery pipeline when the pipeline is on. Left out: derived from `status`. */
  stage?: PipelineStage;
}

export interface SeedData {
  name: string;
  members: SeedMember[];
  pages: SeedPage[];
  tickets: SeedTicket[];
  standup: { title: string; messages: { who: string; text: string }[] };
  agents: AgentDef[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number) => (typeof v === 'string' ? sanitizeText(v, max) : '');

/** `---` front matter with `key: value` lines (no nesting), then the body. */
export function frontMatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n?/g, '\n'));
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: m[2] };
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
// Sorted, so the agents (and where they stand in the lobby) come in the same order on every machine.
const dirs = (path: string) => (existsSync(path) ? readdirSync(path).filter((n) => statSync(join(path, n)).isDirectory()).sort() : []);

/** What the demo has when no seed folder is given or found: enough to open, ask a question and see a board. */
export function builtinSeed(): SeedData {
  const body = (s: string) => s.trim().replace(/\n {6}/g, '\n');
  return {
    name: 'Northwind Field App',
    members: [
      { handle: 'maya', name: 'Maya', role: 'founder' },
      { handle: 'ravi', name: 'Ravi', role: 'pm' },
      { handle: 'linh', name: 'Linh', role: 'frontend' },
    ],
    pages: [
      { slug: 'handbook', id: 'p-handbook', title: 'Handbook', parent: null, order: 1, body: 'The team’s handbook. Everything here is synthetic demo data.' },
      {
        slug: 'release-process', id: 'p-release-process', title: 'Release process', parent: 'handbook', order: 1,
        body: body(`
      # Release process

      We ship to the stores every second Tuesday. A release needs two approvals and a green test run.
      The release owner posts the notes in the lobby the day before.
      `),
      },
    ],
    tickets: [
      { key: 1, title: 'Write the release checklist', body: 'Turn the release process into a checklist the release owner can tick through.', status: 'todo', priority: 'medium', assignee: null, labels: ['docs'], points: 3, pr: null, notes: '' },
      { key: 2, title: 'Offline mode for the visit list', body: 'The visit list should open without a connection.', status: 'in_progress', priority: 'high', assignee: 'linh', labels: ['feature'], points: 8, pr: null, notes: '' },
    ],
    standup: {
      title: 'Monday standup',
      messages: [
        { who: 'maya', text: 'Morning. We ship on Tuesday, so today is about the release checklist.' },
        { who: 'ravi', text: 'Decision: we freeze the code on Monday at 5 pm. Nothing new after that.' },
        { who: 'linh', text: 'I will finish the offline visit list before the freeze.' },
      ],
    },
    agents: DEFAULT_AGENTS,
  };
}

/** Reads the seed folder (`docs/demo-data`). Anything missing falls back to the built-in minimal seed, so the demo always opens. */
export function loadSeed(dir: string | undefined, warn: (message: string) => void = () => {}): SeedData {
  const fallback = builtinSeed();
  if (!dir || !existsSync(dir)) {
    warn(`no seed folder at ${dir ?? '(none)'}: using the built-in seed`);
    return fallback;
  }
  const out: SeedData = { ...fallback };

  const teamFile = join(dir, 'team.json');
  if (existsSync(teamFile)) {
    const t = readJson(teamFile);
    if (isObj(t)) {
      const members: SeedMember[] = [];
      for (const m of Array.isArray(t.members) ? t.members : []) {
        if (!isObj(m) || typeof m.handle !== 'string' || !HANDLE_RE.test(m.handle)) {
          warn(`team.json: a member needs a handle like "maya" (lower case letters, digits, dashes): ${JSON.stringify(isObj(m) ? m.handle : m)}`);
          continue;
        }
        const role = m.role === 'founder' || m.role === 'pm' ? m.role : 'frontend';
        const name = str(m.name, 32);
        if (name) members.push({ handle: m.handle, name, role });
        else warn(`team.json: ${m.handle} has no name`);
      }
      if (members.length) {
        out.members = members;
        out.name = str(t.name, 64) || fallback.name;
      }
    }
  }

  const pagesDir = join(dir, 'pages');
  if (existsSync(pagesDir)) {
    const pages: SeedPage[] = [];
    for (const file of readdirSync(pagesDir).filter((n) => n.endsWith('.md')).sort()) {
      const slug = file.slice(0, -3);
      const { meta, body } = frontMatter(readFileSync(join(pagesDir, file), 'utf8'));
      const title = sanitizeText(meta.title ?? '', 200);
      if (!title) {
        warn(`pages/${file}: no "title:" in the front matter, left out`);
        continue;
      }
      const id = /^[A-Za-z0-9_-]{1,64}$/.test(meta.id ?? '') ? meta.id : `p-${slug}`;
      pages.push({ slug, id, title, parent: meta.parent ? meta.parent : null, order: Number(meta.order) || pages.length + 1, body: clampCodePoints(body.trim(), PAGES_LIMITS.body) });
    }
    if (pages.length) out.pages = pages;
  }

  const ticketsFile = join(dir, 'tickets.json');
  if (existsSync(ticketsFile)) {
    const raw = readJson(ticketsFile);
    const tickets: SeedTicket[] = [];
    for (const t of Array.isArray(raw) ? raw : []) {
      if (!isObj(t) || !Number.isInteger(t.key) || (t.key as number) < 1) {
        warn(`tickets.json: a ticket needs a whole "key" of 1 or more: ${JSON.stringify(isObj(t) ? t.key : t)}`);
        continue;
      }
      const title = str(t.title, BOARD_LIMITS.title);
      if (!title) {
        warn(`tickets.json: #${t.key} has no title, left out`);
        continue;
      }
      const stage = (PIPELINE_STAGES as readonly unknown[]).includes(t.stage) ? (t.stage as PipelineStage) : undefined;
      const status = stage ? statusForStage(stage) : (ISSUE_STATUSES as readonly unknown[]).includes(t.status) ? (t.status as IssueStatus) : 'todo';
      const assignee = typeof t.assignee === 'string' && HANDLE_RE.test(t.assignee) ? t.assignee : null;
      const pr = typeof t.pr === 'string' && t.pr.startsWith('https://') ? t.pr.slice(0, 300) : null;
      // The two column rules hold for seeded tickets too: no In Progress without someone on it, no In Review without a pull request.
      // (A ticket that names a pipeline stage is not held to them: its stage decides its status.)
      if (!stage && ((status === 'in_progress' && !assignee) || (status === 'review' && !pr))) {
        warn(`tickets.json: #${t.key} is ${status} but has no ${status === 'review' ? 'https "pr"' : '"assignee" handle'}, left out`);
        continue;
      }
      if (assignee && !out.members.some((m) => m.handle === assignee)) warn(`tickets.json: #${t.key} is assigned to "${assignee}", who is not in team.json: it will have nobody on it`);
      if (tickets.some((x) => x.key === t.key)) {
        warn(`tickets.json: #${t.key} appears twice, the later one is left out`);
        continue;
      }
      tickets.push({
        key: t.key as number, title, body: typeof t.body === 'string' ? t.body : '', status,
        priority: (ISSUE_PRIORITIES as readonly unknown[]).includes(t.priority) ? (t.priority as IssuePriority) : 'medium',
        assignee, labels: Array.isArray(t.labels) ? t.labels.map((l) => str(l, 40)).filter(Boolean).slice(0, 8) : [],
        points: Number.isInteger(t.points) && (t.points as number) >= 0 && (t.points as number) <= 100 ? (t.points as number) : 0,
        pr, notes: typeof t.notes === 'string' ? t.notes : '',
        ...(stage ? { stage } : {}),
      });
    }
    if (tickets.length) out.tickets = tickets;
  }

  const standupFile = join(dir, 'standup.json');
  if (existsSync(standupFile)) {
    const s = readJson(standupFile);
    if (isObj(s) && Array.isArray(s.messages)) {
      const messages = s.messages
        .filter((m): m is { who: string; text: string } => isObj(m) && typeof m.who === 'string' && typeof m.text === 'string')
        .map((m) => ({ who: m.who, text: clampCodePoints(m.text, 500) }))
        .filter((m) => m.text);
      for (const m of messages) if (!out.members.some((x) => x.handle === m.who)) warn(`standup.json: "${m.who}" is not in team.json, that line is not played`);
      if (messages.length) out.standup = { title: str(s.title, 80) || 'Standup', messages };
    }
  }

  const agentsDir = join(dir, 'agents');
  if (existsSync(agentsDir)) {
    const skills = new Map<string, { name: string; body: string }>();
    for (const id of dirs(join(agentsDir, 'skills'))) {
      const file = join(agentsDir, 'skills', id, 'SKILL.md');
      if (!existsSync(file)) continue;
      const { meta, body } = frontMatter(readFileSync(file, 'utf8'));
      skills.set(id, { name: meta.name || id, body: [meta.description, body.trim()].filter(Boolean).join('\n\n') });
    }
    const agents: AgentDef[] = [];
    for (const handle of dirs(agentsDir).filter((h) => h !== 'skills')) {
      const jsonFile = join(agentsDir, handle, 'agent.json');
      const personaFile = join(agentsDir, handle, 'persona.md');
      if (!existsSync(jsonFile) || !existsSync(personaFile)) continue;
      const a = readJson(jsonFile);
      if (!isObj(a)) continue;
      const ids = Array.isArray(a.skills) ? a.skills.filter((s): s is string => typeof s === 'string') : [];
      const def = parseAgentDef(handle, {
        displayName: a.displayName, role: a.role, greeting: a.greeting, look: a.look ?? lookFromSeed(handle),
        persona: readFileSync(personaFile, 'utf8'), skills: ids.map((id) => skills.get(id)).filter(Boolean),
      });
      if (def) agents.push(def);
      else warn(`agents/${handle}: needs displayName, role, a persona.md and a look (hex colours, hairStyle, accessory), left out`);
    }
    if (agents.length) out.agents = agents;
  }
  return out;
}

const DAY = 86_400_000;
/** The stage a seeded ticket starts in when its seed names none. */
const STAGE_OF_STATUS: Record<IssueStatus, PipelineStage> = { todo: 'plan', in_progress: 'build', review: 'test', done: 'done' };
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const workspaceRoleOf = (r: SeedMember['role']): WorkspaceRole => (r === 'founder' ? 'owner' : r === 'pm' ? 'admin' : 'member');
export const seedUid = (handle: string) => `seed-${handle}`;

/** What a ticket's number is in its pull request's address (`.../pull/42`), if it has one. */
const prNumber = (pr: string | null, fallback: number) => Number(/(\d{1,7})\/?$/.exec(pr ?? '')?.[1]) || fallback;

/**
 * Writes the demo workspace into empty stores: the team, the docs tree, the board, and the lobby's first conversation. Ids are
 * fixed, so seeding twice (or after a crash half way) writes the same rows again rather than a second copy.
 */
export async function writeSeed(store: Store, collab: CollabStore, seed: SeedData, now = Date.now(), opts: { pipeline?: boolean } = {}): Promise<{ standup: { uid: string; text: string }[] }> {
  const base = now - 14 * DAY;
  const founder = seed.members.find((m) => m.role === 'founder') ?? seed.members[0];
  const by = seedUid(founder.handle);
  await store.putWorkspace({ id: OFFICE_ID, name: seed.name, createdAt: base });

  for (const [i, m] of seed.members.entries()) {
    const doc: MemberDoc = { uid: seedUid(m.handle), role: workspaceRoleOf(m.role), name: m.name, look: lookFromSeed(m.handle), desk: null, joinedAt: base + i * 3_600_000, lastSeen: now - 3 * DAY };
    await store.putMember(OFFICE_ID, doc);
  }

  const idOfSlug = new Map(seed.pages.map((p) => [p.slug, p.id]));
  for (const [i, p] of seed.pages.entries()) {
    const page: Page = {
      id: p.id, parent: p.parent ? (idOfSlug.get(p.parent) ?? null) : null, title: p.title, body: p.body, order: p.order * 1024,
      createdBy: by, createdAt: base + i * 60_000, updatedBy: by, updatedAt: base + i * 60_000,
    };
    await collab.putPage(OFFICE_ID, page);
  }

  for (const t of seed.tickets) {
    const assignee = t.assignee && seed.members.some((m) => m.handle === t.assignee) ? seedUid(t.assignee) : null;
    const at = base + t.key * 3_600_000;
    const notes = t.notes.trim();
    const body = clampCodePoints([t.body.trim(), notes ? `## Notes (tickets/${t.key}.md)\n\n${notes}` : ''].filter(Boolean).join('\n\n'), BOARD_LIMITS.body);
    const merged = t.status === 'done';
    // With the pipeline on, a ticket's stage decides its status (a seed that names no stage gets the stage its status implies).
    const stage: PipelineStage | null = opts.pipeline ? (t.stage ?? STAGE_OF_STATUS[t.status]) : null;
    const status = stage ? statusForStage(stage) : t.status;
    const issue: Issue = {
      id: `i-${t.key}`, key: t.key, title: t.title, body, status, priority: t.priority, assignee, labels: t.labels, points: t.points,
      order: t.key * 1024, docs: [], thread: null, branch: t.status === 'todo' ? null : `feat/${t.key}-${slugify(t.title)}`,
      pr: t.pr, prInfo: t.pr ? { number: prNumber(t.pr, t.key), title: t.title, state: merged ? 'merged' : 'open', updatedAt: at + 3_600_000 } : null,
      links: [], images: [], threads: [],
      activity: [
        { at, by, kind: 'created', text: 'Created the ticket.' },
        ...(t.status === 'todo' ? [] : [{ at: at + 1_800_000, by, kind: 'status' as const, text: `Moved from todo to ${t.status.replace('_', ' ')}.` }]),
      ],
      ...(stage ? { pipeline: { stage, mainRev: 'main@0' } } : {}),
      createdBy: by, createdAt: at, updatedBy: by, updatedAt: at + 1_800_000,
    };
    await collab.putIssue(OFFICE_ID, issue);
  }

  // The lobby already has a conversation, opened by Studio, so the first thing a visitor sees says what to try.
  const studio = seed.agents.find((a) => a.handle === 'studio') ?? seed.agents[0];
  if (studio) {
    const session: SessionInfo = { id: 'welcome-lobby', room: 'lobby', state: 'active', createdAt: now - 60_000, createdBy: 'system' };
    await store.putSession(OFFICE_ID, session);
    const hello: ChatMessage = {
      id: 'welcome-1', kind: 'agent', from: `agent:${studio.handle}`, fromName: studio.displayName, look: studio.look, at: now - 59_000, mentions: [], room: 'lobby', session: session.id,
      text: `Welcome to ${seed.name}. Everything here is synthetic demo data, and it resets every night. Try asking @librarian where something is written down, ask @planner to plan a feature, or play the sample standup and then end the meeting to get minutes and proposed tickets.`,
    };
    await store.insertMessage(OFFICE_ID, hello);
  }

  return { standup: seed.standup.messages.filter((m) => seed.members.some((x) => x.handle === m.who)).map((m) => ({ uid: seedUid(m.who), text: m.text })) };
}
