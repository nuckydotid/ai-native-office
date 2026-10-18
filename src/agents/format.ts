import { validAppearance } from '../shared/workspace/protocol.ts';
import { lookFromSeed } from '../shared/workspace/looks.ts';
import { validHandle } from '../shared/workspace/chat.ts';
import { codePointLength } from '../shared/workspace/text.ts';
import type { AgentRef } from '../shared/workspace/protocol.ts';
import type { Appearance } from '../shared/workspace/types.ts';

/*
 * The agents of the Office, as the Agents page sees them: the shapes the screens use, the limits the server holds them to, and the
 * small rules that need no network, so they can be tested.
 */

export type AgentContext = 'none' | 'project';

export interface AgentFile {
  /** What people type after `@`. Also the folder name. */
  handle: string;
  displayName: string;
  role: string;
  greeting: string;
  /** Null when the file has no usable look: draw `agentLook(agent)` instead. */
  look: Appearance | null;
  /** Ids of skills in `.agents/office/skills`. */
  skills: string[];
  context: AgentContext;
  persona: string;
  /** How much this agent thinks unless a request says otherwise; Auto decides when it is absent. */
  effort?: 'low' | 'medium' | 'high';
}

export interface SkillFile {
  id: string;
  name: string;
  description: string;
  body: string;
}

/** Something in the files that couldn't be used, in words for the person. */
export interface FileProblem {
  path: string;
  message: string;
}

export interface Listing {
  agents: AgentFile[];
  skills: SkillFile[];
  problems: FileProblem[];
}

export const EMPTY_LISTING: Listing = { agents: [], skills: [], problems: [] };

/** The limits `agent_files.rs` holds files to, in characters (code points). */
export const AGENT_LIMITS = {
  name: 40,
  role: 60,
  greeting: 200,
  persona: 12_000,
  skillsPerAgent: 12,
  skillName: 60,
  description: 200,
  skillBody: 8_000,
} as const;

export const HANDLE_PATTERN = '^[a-z][a-z0-9-]{0,39}$';
const SLUG = new RegExp(HANDLE_PATTERN);
export const validSlug = (s: unknown): s is string => typeof s === 'string' && SLUG.test(s);

/** A name turned into something that can be a handle or a skill id: `Zoë Ünal` → `zoe-unal`. Empty when nothing is left. */
export function slugify(text: string): string {
  const plain = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return plain;
}

/** Why `handle` can't be used (null when it can). `others` are the handles already taken. */
export function handleProblem(handle: string, others: readonly string[] = []): string | null {
  if (!handle) return 'Give the agent a handle.';
  if (!SLUG.test(handle)) return 'Use a–z, 0–9 and dashes, starting with a letter (up to 40).';
  if (!validHandle(handle)) return `“${handle}” is a reserved word in chat. Pick another handle.`;
  if (others.includes(handle)) return `There is already an agent called @${handle}.`;
  return null;
}

const tooLong = (text: string, max: number) => codePointLength(text) > max;
// The same characters `agent_files.rs` refuses, and `sanitizeText` (src/shared/workspace/text.ts) removes from chat: control
// characters, and the invisible ones that flip or hide text. The zero-width joiner and non-joiner stay (emoji sequences need them).
const INVISIBLE = '\\u061c\\u180e\\u200b\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff\\u{e0000}-\\u{e007f}';
/** One line of text: no control characters of any kind (line breaks included), no invisible ones. */
const LINE_BAD = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f${INVISIBLE}]`, 'u');
/** Several lines: control characters other than newline, tab and carriage return are refused too. */
const TEXT_BAD = new RegExp(`[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f${INVISIBLE}]`, 'u');
const INVISIBLE_ONLY = new RegExp(`^[\\s${INVISIBLE}]*$`, 'u');

const hasControl = (text: string) => LINE_BAD.test(text);
const hasBadText = (text: string) => TEXT_BAD.test(text);
const LINE_MESSAGE = 'No line breaks or invisible characters here.';
const TEXT_MESSAGE = 'Some characters in here can’t be saved (control or invisible ones).';

export type AgentField = 'handle' | 'displayName' | 'role' | 'greeting' | 'persona' | 'skills' | 'look';

/** What is wrong with the agent as a form, by field. Empty when it can be saved. `others` are the other agents' handles. */
export function agentProblems(agent: AgentFile, others: readonly string[] = []): Partial<Record<AgentField, string>> {
  const out: Partial<Record<AgentField, string>> = {};
  const handle = handleProblem(agent.handle, others);
  if (handle) out.handle = handle;
  if (INVISIBLE_ONLY.test(agent.displayName)) out.displayName = 'Give the agent a name.';
  else if (tooLong(agent.displayName, AGENT_LIMITS.name)) out.displayName = `At most ${AGENT_LIMITS.name} characters.`;
  else if (hasControl(agent.displayName)) out.displayName = LINE_MESSAGE;
  if (tooLong(agent.role, AGENT_LIMITS.role)) out.role = `At most ${AGENT_LIMITS.role} characters.`;
  else if (hasControl(agent.role)) out.role = LINE_MESSAGE;
  if (tooLong(agent.greeting, AGENT_LIMITS.greeting)) out.greeting = `At most ${AGENT_LIMITS.greeting} characters.`;
  else if (hasControl(agent.greeting)) out.greeting = LINE_MESSAGE;
  if (tooLong(agent.persona, AGENT_LIMITS.persona)) out.persona = `At most ${AGENT_LIMITS.persona.toLocaleString('en-US')} characters.`;
  else if (hasBadText(agent.persona)) out.persona = TEXT_MESSAGE;
  if (agent.skills.length > AGENT_LIMITS.skillsPerAgent) out.skills = `An agent can use at most ${AGENT_LIMITS.skillsPerAgent} skills.`;
  if (!agent.look || !validAppearance(agent.look)) out.look = 'Pick how the agent looks.';
  return out;
}

export type SkillField = 'id' | 'name' | 'description' | 'body';

export function skillProblems(skill: SkillFile, others: readonly string[] = []): Partial<Record<SkillField, string>> {
  const out: Partial<Record<SkillField, string>> = {};
  if (!skill.id) out.id = 'Give the skill an id.';
  else if (!SLUG.test(skill.id)) out.id = 'Use a–z, 0–9 and dashes, starting with a letter (up to 40).';
  else if (others.includes(skill.id)) out.id = `There is already a skill called ${skill.id}.`;
  if (INVISIBLE_ONLY.test(skill.name)) out.name = 'Give the skill a name.';
  else if (tooLong(skill.name, AGENT_LIMITS.skillName)) out.name = `At most ${AGENT_LIMITS.skillName} characters.`;
  else if (hasControl(skill.name)) out.name = LINE_MESSAGE;
  if (tooLong(skill.description, AGENT_LIMITS.description)) out.description = `At most ${AGENT_LIMITS.description} characters.`;
  else if (hasControl(skill.description)) out.description = LINE_MESSAGE;
  if (tooLong(skill.body, AGENT_LIMITS.skillBody)) out.body = `At most ${AGENT_LIMITS.skillBody.toLocaleString('en-US')} characters.`;
  else if (hasBadText(skill.body)) out.body = TEXT_MESSAGE;
  else if (skill.body.trimStart().startsWith('---')) out.body = 'Don’t start with a line of dashes.';
  return out;
}

/** How an agent is drawn: its own look, or one made from its handle, the same everywhere. */
export function agentLook(agent: Pick<AgentFile, 'handle' | 'look'>): Appearance {
  return agent.look && validAppearance(agent.look) ? agent.look : lookFromSeed(`agent:${agent.handle}`);
}

/** What the server is told about an agent when someone mentions it. */
export function agentRef(agent: AgentFile): AgentRef {
  const name = agent.displayName.trim() || agent.handle;
  const role = agent.role.trim();
  return { handle: agent.handle, name, ...(role ? { role } : {}), look: agentLook(agent) };
}

/** The instructions a new agent starts with: a few lines to rewrite, which use the name once it is known. */
export const starterPersona = (name: string): string =>
  `${name.trim() ? `You are ${name.trim()}, a teammate` : 'You are a teammate'} in this project’s chat.\n\nSay what you are good at, how you like to answer, and what you never do.\n`;

/** A new agent with a look, a first line of persona and nothing else decided. */
export function newAgent(handle: string, displayName: string): AgentFile {
  const name = displayName.trim() || handle;
  return {
    handle,
    displayName: name,
    role: '',
    greeting: '',
    look: lookFromSeed(`agent:${handle}`),
    skills: [],
    context: 'none',
    persona: starterPersona(name),
  };
}

export function newSkill(id: string, name: string): SkillFile {
  return { id, name: name.trim() || id, description: '', body: 'Describe when to use this skill, and the steps to follow.\n' };
}

/** Text as it reads back from the server: line endings as `\n`, no blanks at either end. */
const clean = (text: string) => text.replace(/\r\n/g, '\n').trim();

/** Two copies that differ only in what the files would not keep (blanks at the ends, line endings): handy for “has it changed?”. */
export const sameAgent = (a: AgentFile, b: AgentFile): boolean => JSON.stringify(normalised(a)) === JSON.stringify(normalised(b));

function normalised(a: AgentFile) {
  return { ...a, displayName: clean(a.displayName), role: clean(a.role), greeting: clean(a.greeting), persona: clean(a.persona), look: a.look ?? null };
}

export const sameSkill = (a: SkillFile, b: SkillFile): boolean =>
  a.id === b.id && clean(a.name) === clean(b.name) && clean(a.description) === clean(b.description) && clean(a.body) === clean(b.body);

/** The skills an agent uses that exist, and the ids that don't (deleted, or not pulled yet). */
export function skillsOf(agent: Pick<AgentFile, 'skills'>, listing: Pick<Listing, 'skills'>): { found: SkillFile[]; missing: string[] } {
  const found: SkillFile[] = [];
  const missing: string[] = [];
  for (const id of agent.skills) {
    const skill = listing.skills.find((s) => s.id === id);
    if (skill) found.push(skill);
    else missing.push(id);
  }
  return { found, missing };
}

/** The agents that use a skill, so deleting it can say who is affected. */
export const agentsUsing = (skillId: string, listing: Pick<Listing, 'agents'>): AgentFile[] => listing.agents.filter((a) => a.skills.includes(skillId));

export function findAgent(listing: Pick<Listing, 'agents'>, handle: string): AgentFile | undefined {
  const wanted = handle.toLowerCase();
  return listing.agents.find((a) => a.handle === wanted);
}
