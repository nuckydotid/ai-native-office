import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { lookFromSeed } from '../shared/workspace/looks.ts';
import { validAppearance } from '../shared/workspace/protocol.ts';
import { AGENT_LIMITS, agentLook, agentProblems, agentRef, agentsUsing, findAgent, handleProblem, newAgent, newSkill, sameAgent, sameSkill, skillProblems, skillsOf, slugify, starterPersona, validSlug } from './format.ts';
import type { AgentFile, Listing, SkillFile } from './format.ts';

const agent = (over: Partial<AgentFile> = {}): AgentFile => ({ ...newAgent('john', 'John'), role: 'Shopping advisor', ...over });
const skill = (over: Partial<SkillFile> = {}): SkillFile => ({ ...newSkill('compare', 'Compare'), ...over });

describe('handles and slugs', () => {
  test('a name becomes a handle', () => {
    assert.equal(slugify('John'), 'john');
    assert.equal(slugify('Zoë Ünal'), 'zoe-unal');
    assert.equal(slugify('  Ux  Writer! '), 'ux-writer');
    assert.equal(slugify('3d Artist'), 'd-artist', 'a handle starts with a letter');
    assert.equal(slugify('日本語'), '');
    assert.equal(slugify('a'.repeat(60)).length, 40);
    assert.ok(validSlug(slugify('Mary-Jane O’Neil')));
  });

  test('why a handle cannot be used', () => {
    assert.equal(handleProblem('john'), null);
    assert.match(handleProblem('') ?? '', /handle/);
    assert.match(handleProblem('John') ?? '', /a–z/);
    assert.match(handleProblem('a b') ?? '', /a–z/);
    assert.match(handleProblem('all') ?? '', /reserved/);
    assert.match(handleProblem('skills') ?? '', /reserved/, 'it is the skills folder');
    assert.match(handleProblem('john', ['john', 'sarah']) ?? '', /already/);
    assert.equal(handleProblem('alex', ['john']), null);
  });
});

describe('what can be saved', () => {
  test('a new agent can be saved as it is', () => {
    assert.deepEqual(agentProblems(newAgent('john', 'John')), {});
    assert.ok(validAppearance(newAgent('john', 'John').look));
  });

  test('a new agent starts with instructions that use its name, once it has one', () => {
    assert.match(newAgent('john', 'John').persona, /^You are John, a teammate in this project’s chat\./);
    assert.match(starterPersona(''), /^You are a teammate in this project’s chat\./);
    assert.match(starterPersona('  Zoë '), /^You are Zoë, a teammate/);
  });

  test('control and invisible characters are refused the way the files refuse them', () => {
    const c = (...codes: number[]) => String.fromCharCode(...codes);
    assert.ok(agentProblems(agent({ displayName: `A${c(0x85)}B` })).displayName, 'a C1 control');
    assert.ok(agentProblems(agent({ role: `x${c(0x200b)}y` })).role, 'a zero-width space');
    assert.ok(agentProblems(agent({ greeting: `x${c(0x202e)}y` })).greeting, 'a bidi override');
    assert.ok(agentProblems(agent({ displayName: c(0x200b, 0x2060) })).displayName, 'only invisible characters is no name at all');
    assert.ok(agentProblems(agent({ persona: `x${c(0)}y` })).persona, 'a NUL in the instructions');
    assert.ok(agentProblems(agent({ persona: `x${c(0x2066)}y` })).persona, 'a bidi isolate in the instructions');
    assert.ok(agentProblems(agent({ persona: `x${String.fromCodePoint(0xe0041)}y` })).persona, 'a hidden "tag" character');
    // Newlines and tabs are fine in instructions, and an emoji keeps its joiner.
    assert.deepEqual(agentProblems(agent({ persona: 'a\r\n\tb\n' })), {});
    assert.deepEqual(agentProblems(agent({ displayName: `${String.fromCodePoint(0x1f469)}${c(0x200d)}${String.fromCodePoint(0x1f4bb)} Dev` })), {});
    const skill = (over: Partial<SkillFile>) => skillProblems({ ...newSkill('s', 'S'), ...over });
    assert.ok(skill({ name: `a${c(0x200e)}` }).name);
    assert.ok(skill({ description: 'a\nb' }).description);
    assert.ok(skill({ body: `x${c(0)}` }).body);
    assert.deepEqual(skill({ body: 'one\ntwo\n' }), {});
  });

  test('every limit is checked in characters, not in code units', () => {
    assert.deepEqual(agentProblems(agent({ displayName: '😀'.repeat(AGENT_LIMITS.name) })), {});
    assert.ok(agentProblems(agent({ displayName: '😀'.repeat(AGENT_LIMITS.name + 1) })).displayName);
    assert.ok(agentProblems(agent({ displayName: '  ' })).displayName);
    assert.ok(agentProblems(agent({ role: 'a\nb' })).role);
    assert.ok(agentProblems(agent({ greeting: 'x'.repeat(AGENT_LIMITS.greeting + 1) })).greeting);
    assert.deepEqual(agentProblems(agent({ persona: 'é'.repeat(AGENT_LIMITS.persona) })), {});
    assert.ok(agentProblems(agent({ persona: 'é'.repeat(AGENT_LIMITS.persona + 1) })).persona);
    assert.ok(agentProblems(agent({ skills: Array.from({ length: 13 }, (_, i) => `s${i}`) })).skills);
    assert.ok(agentProblems(agent({ look: null })).look);
    assert.ok(agentProblems(agent({ look: { ...lookFromSeed('x'), skin: 'red' } })).look);
    assert.ok(agentProblems(agent({ handle: 'sarah' }), ['sarah']).handle);
  });

  test('skills follow the same rules', () => {
    assert.deepEqual(skillProblems(skill()), {});
    assert.ok(skillProblems(skill({ id: 'Bad Id' })).id);
    assert.ok(skillProblems(skill({ id: 'compare' }), ['compare']).id);
    assert.ok(skillProblems(skill({ name: '' })).name);
    assert.ok(skillProblems(skill({ description: 'a\nb' })).description);
    assert.ok(skillProblems(skill({ body: 'x'.repeat(AGENT_LIMITS.skillBody + 1) })).body);
    assert.ok(skillProblems(skill({ body: '---\nname: sneaky' })).body, 'a body must not look like another block of settings');
  });
});

describe('looks and references', () => {
  test('an agent without a usable look is drawn from its handle, the same everywhere', () => {
    assert.deepEqual(agentLook({ handle: 'john', look: null }), lookFromSeed('agent:john'));
    assert.notDeepEqual(agentLook({ handle: 'sarah', look: null }), agentLook({ handle: 'john', look: null }));
    const mine = lookFromSeed('mine');
    assert.equal(agentLook({ handle: 'john', look: mine }), mine);
    assert.deepEqual(agentLook({ handle: 'john', look: { ...mine, hair: '#12' } }), lookFromSeed('agent:john'));
  });

  test('what the server hears about an agent', () => {
    const ref = agentRef(agent({ look: null, role: ' Shopping advisor ' }));
    assert.equal(ref.handle, 'john');
    assert.equal(ref.name, 'John');
    assert.equal(ref.role, 'Shopping advisor');
    assert.ok(validAppearance(ref.look));
    assert.equal('role' in agentRef(agent({ role: '  ' })), false, 'no empty role');
    assert.equal(agentRef(agent({ displayName: ' ' })).name, 'john', 'the handle stands in for a missing name');
  });
});

describe('listings', () => {
  const listing: Listing = { agents: [agent(), agent({ handle: 'sarah', skills: ['compare', 'gone'] })], skills: [skill(), skill({ id: 'other', name: 'Other' })], problems: [] };

  test('skills an agent uses, and the ones that are gone', () => {
    const { found, missing } = skillsOf(listing.agents[1], listing);
    assert.deepEqual(found.map((s) => s.id), ['compare']);
    assert.deepEqual(missing, ['gone']);
  });

  test('who uses a skill', () => {
    assert.deepEqual(agentsUsing('compare', listing).map((a) => a.handle), ['sarah']);
    assert.deepEqual(agentsUsing('other', listing), []);
  });

  test('finding an agent by what was typed after the @', () => {
    assert.equal(findAgent(listing, 'John')?.handle, 'john');
    assert.equal(findAgent(listing, 'nobody'), undefined);
  });

  test('comparing agents ignores line endings and the end of the persona', () => {
    assert.ok(sameAgent(agent({ persona: 'a\nb\n' }), agent({ persona: 'a\r\nb' })));
    // The files keep what was typed without blanks at the ends, so a saved agent must not look unsaved.
    assert.ok(sameAgent(agent({ displayName: ' John ', role: 'Reviewer ', greeting: 'hi \n' }), agent({ displayName: 'John', role: 'Reviewer', greeting: 'hi' })));
    assert.ok(!sameAgent(agent({ displayName: 'John' }), agent({ displayName: 'Joan' })));
    assert.ok(!sameAgent(agent(), agent({ role: 'Other' })));
    assert.ok(!sameAgent(agent({ skills: ['a'] }), agent({ skills: ['b'] })));
  });
});

test('a skill is the same after the files trim it, and not when a word changed', () => {
  const a = newSkill('plan', 'Plan');
  assert.ok(sameSkill({ ...a, name: ' Plan ', description: 'When it helps. ', body: 'Steps\r\n' }, { ...a, name: 'Plan', description: 'When it helps.', body: 'Steps' }));
  assert.ok(!sameSkill(a, { ...a, name: 'Plans' }));
  assert.ok(!sameSkill(a, { ...a, id: 'other' }));
});
