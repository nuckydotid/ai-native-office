import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lookFromSeed } from '../shared/workspace/looks.ts';
import { listingFromWire, wireFromAgent } from './wire.ts';

const look = lookFromSeed('librarian');

test('the server’s roster becomes agents and shared skills', () => {
  const listing = listingFromWire([
    { handle: 'librarian', displayName: 'Lena', role: 'Librarian', greeting: 'Hi', look, persona: 'You find things.', skills: [{ name: 'Cite sources', body: '# Cite\nAlways cite.' }] },
    { handle: 'scribe', displayName: 'Sam', role: 'Scribe', greeting: '', look: null, persona: '', skills: [{ name: 'Cite sources', body: '# Cite\nAlways cite.' }, { name: 'Minutes', body: 'Write minutes.' }] },
  ]);
  assert.deepEqual(listing.agents.map((a) => a.handle), ['librarian', 'scribe']);
  assert.deepEqual(listing.skills.map((s) => s.id), ['cite-sources', 'minutes']);
  assert.equal(listing.skills[0].description, 'Cite');
  assert.deepEqual(listing.agents[1].skills, ['cite-sources', 'minutes']);
  assert.equal(listing.agents[1].look, null);
  assert.equal(listing.agents[0].context, 'none');
});

test('a skill of the same name with other words is a different skill', () => {
  const listing = listingFromWire([
    { handle: 'a', displayName: 'A', role: '', greeting: '', look, persona: '', skills: [{ name: 'Review', body: 'one' }] },
    { handle: 'b', displayName: 'B', role: '', greeting: '', look, persona: '', skills: [{ name: 'Review', body: 'two' }] },
  ]);
  assert.deepEqual(listing.skills.map((s) => s.id), ['review', 'review-2']);
  assert.deepEqual(listing.agents.map((a) => a.skills), [['review'], ['review-2']]);
});

test('junk in the roster is left out', () => {
  assert.deepEqual(listingFromWire(null).agents, []);
  assert.deepEqual(listingFromWire([null, 3, { handle: '' }, { displayName: 'x' }]).agents, []);
  const only = listingFromWire([{ handle: 'x', skills: [{ name: '' }, null, { name: 'ok', body: 7 }] }]);
  assert.equal(only.agents[0].displayName, 'x');
  assert.deepEqual(only.skills.map((s) => [s.id, s.body]), [['ok', '']]);
});

test('an edited agent goes back with the words of its skills', () => {
  const listing = listingFromWire([{ handle: 'librarian', displayName: 'Lena', role: 'Librarian', greeting: 'Hi', look, persona: 'p', skills: [{ name: 'Cite', body: 'Always cite.' }] }]);
  const edited = { ...listing.agents[0], persona: 'new persona', skills: [...listing.agents[0].skills, 'gone'] };
  const wire = wireFromAgent(edited, listing);
  assert.equal(wire.persona, 'new persona');
  assert.deepEqual(wire.skills, [{ name: 'Cite', body: 'Always cite.' }]);
  assert.equal(wire.handle, 'librarian');
});
