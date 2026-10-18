import { validAppearance, pickAppearance, sanitizeText } from '../shared/workspace/protocol.ts';
import { validHandle } from '../shared/workspace/chat.ts';
import type { Appearance } from '../shared/workspace/types.ts';

/** An AI colleague on the server: who it is in the office, and the instructions the agent service gives the model. */
export interface AgentDef {
  handle: string;
  displayName: string;
  role: string;
  greeting: string;
  look: Appearance;
  persona: string;
  skills: { name: string; body: string }[];
}

/** The sizes the Agents page already enforces for files in a repository. */
export const AGENT_LIMITS = { name: 40, role: 60, greeting: 200, persona: 12_000, skills: 12, skillName: 60, skillBody: 8_000, agents: 24 } as const;

/** The agents the server knows, by handle. In memory: the seed (or the Agents page) fills it, and a reset puts the seed back. */
export class AgentRegistry {
  private defs = new Map<string, AgentDef>();

  constructor(defs: AgentDef[] = []) {
    this.replaceAll(defs);
  }

  list(): AgentDef[] {
    return [...this.defs.values()];
  }

  get(handle: string): AgentDef | undefined {
    return this.defs.get(handle);
  }

  has(handle: string): boolean {
    return this.defs.has(handle);
  }

  set(def: AgentDef) {
    this.defs.set(def.handle, def);
  }

  replaceAll(defs: AgentDef[]) {
    this.defs = new Map(defs.slice(0, AGENT_LIMITS.agents).map((d) => [d.handle, d]));
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An agent from an untrusted body (the Agents page) or a seed file, cleaned; `null` when something is not allowed. */
export function parseAgentDef(handle: string, v: unknown): AgentDef | null {
  if (!validHandle(handle) || !isObj(v)) return null;
  const displayName = typeof v.displayName === 'string' ? sanitizeText(v.displayName, AGENT_LIMITS.name) : '';
  const role = typeof v.role === 'string' ? sanitizeText(v.role, AGENT_LIMITS.role) : '';
  if (!displayName || !role) return null;
  const greeting = typeof v.greeting === 'string' ? sanitizeText(v.greeting, AGENT_LIMITS.greeting) : '';
  if (!validAppearance(v.look)) return null;
  if (typeof v.persona !== 'string') return null;
  const persona = sanitizeText(v.persona, AGENT_LIMITS.persona);
  if (!persona) return null;
  const skills: AgentDef['skills'] = [];
  for (const s of Array.isArray(v.skills) ? v.skills : []) {
    if (!isObj(s) || skills.length >= AGENT_LIMITS.skills) return null;
    const name = typeof s.name === 'string' ? sanitizeText(s.name, AGENT_LIMITS.skillName) : '';
    const body = typeof s.body === 'string' ? sanitizeText(s.body, AGENT_LIMITS.skillBody) : '';
    if (!name || !body) return null;
    skills.push({ name, body });
  }
  return { handle, displayName, role, greeting, look: pickAppearance(v.look), persona, skills };
}
