import { validAppearance } from '../shared/workspace/protocol.ts';
import { slugify } from './format.ts';
import type { AgentFile, Listing, SkillFile } from './format.ts';
import type { Appearance } from '../shared/workspace/types.ts';

/*
 * The hosted demo keeps its agents on the team server (`GET /agents`, `PUT /agents/:handle`). There a skill is a name and a body
 * that belongs to one agent; the Agents page works with skills as shared files with an id. This turns one into the other.
 */

/** An agent as the team server sends it. */
export interface WireAgent {
  handle: string;
  displayName: string;
  role: string;
  greeting: string;
  look: Appearance | null;
  persona: string;
  skills: { name: string; body: string }[];
}

const firstLine = (body: string) => (body.split('\n').find((l) => l.trim()) ?? '').replace(/^#+\s*/, '').trim().slice(0, 200);

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/** The server's roster as the listing the Agents page reads. Anything that is not an agent is left out. */
export function listingFromWire(wire: unknown): Listing {
  const skills = new Map<string, SkillFile>();
  const agents: AgentFile[] = [];
  for (const a of Array.isArray(wire) ? (wire as Partial<WireAgent>[]) : []) {
    if (!a || typeof a.handle !== 'string' || !a.handle) continue;
    const ids: string[] = [];
    for (const s of Array.isArray(a.skills) ? a.skills : []) {
      const name = text(s?.name, 60);
      if (!name) continue;
      const body = text(s.body, 8000);
      // Two agents with a skill of the same name share it, unless the words differ: then each keeps its own.
      const base = slugify(name) || 'skill';
      let id = base;
      for (let n = 2; skills.has(id) && skills.get(id)?.body !== body; n++) id = `${base}-${n}`;
      if (!skills.has(id)) skills.set(id, { id, name, description: firstLine(body), body });
      if (!ids.includes(id)) ids.push(id);
    }
    agents.push({
      handle: a.handle,
      displayName: text(a.displayName, 40) || a.handle,
      role: text(a.role, 60),
      greeting: text(a.greeting, 200),
      look: validAppearance(a.look) ? a.look : null,
      skills: ids,
      context: 'none',
      persona: text(a.persona, 12_000),
    });
  }
  return { agents, skills: [...skills.values()], problems: [] };
}

/** An agent as the server takes it back: the skills it uses, with their words. */
export function wireFromAgent(agent: AgentFile, listing: Pick<Listing, 'skills'>): WireAgent {
  return {
    handle: agent.handle,
    displayName: agent.displayName,
    role: agent.role,
    greeting: agent.greeting,
    look: agent.look,
    persona: agent.persona,
    skills: agent.skills.flatMap((id) => {
      const skill = listing.skills.find((s) => s.id === id);
      return skill ? [{ name: skill.name, body: skill.body }] : [];
    }),
  };
}
