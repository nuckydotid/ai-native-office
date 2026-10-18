// ui-check-ignore-file: a character look in a test message is data, not app styling
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseCard, parseClientMsg } from '../workspace/protocol.ts';
import { parseCitations, parseRunEvent } from './protocol.ts';

const proposal = (over: Record<string, unknown> = {}) => ({
  kind: 'proposal', id: 'pr-1', title: 'Follow-ups',
  items: [{ id: 'item-1', type: 'ticket', title: 'Freeze the code', body: 'Nothing new after 5 pm.', labels: ['release', ''], points: 3, duplicateOf: 7 }, { id: 'item-2', type: 'doc', title: 'Minutes', body: '# Minutes' }],
  ...over,
});

describe('proposal cards', () => {
  test('a proposal is cleaned, and what only the server decides is never taken from the sender', () => {
    const card = parseCard({ ...proposal(), decided: 'proceeded', chosen: ['item-1'], created: [{ item: 'item-1', ref: '#1' }] });
    assert.equal(card?.kind, 'proposal');
    if (card?.kind !== 'proposal') return;
    assert.deepEqual(card.items[0], { id: 'item-1', type: 'ticket', title: 'Freeze the code', body: 'Nothing new after 5 pm.', labels: ['release'], points: 3, duplicateOf: 7 });
    assert.deepEqual([card.decided, card.chosen, card.created], [undefined, undefined, undefined]);
  });

  test('a proposal with no items, too many, repeated or odd ones is not a card', () => {
    assert.equal(parseCard(proposal({ items: [] })), null);
    assert.equal(parseCard(proposal({ items: Array.from({ length: 13 }, (_, i) => ({ id: `item-${i}`, type: 'ticket', title: 't', body: '' })) })), null);
    assert.equal(parseCard(proposal({ items: [{ id: 'item-1', type: 'ticket', title: 'a', body: '' }, { id: 'item-1', type: 'doc', title: 'b', body: '' }] })), null);
    assert.equal(parseCard(proposal({ items: [{ id: 'Item 1', type: 'ticket', title: 'a', body: '' }] })), null);
    assert.equal(parseCard(proposal({ items: [{ id: 'item-1', type: 'epic', title: 'a', body: '' }] })), null);
    assert.equal(parseCard(proposal({ id: 'has spaces' })), null);
  });

  test('a person decides one in a room without a worktree tab; an owner of a tab still names the tab', () => {
    const room = parseClientMsg(JSON.stringify({ t: 'card.decide', message: 'a:m1:scribe', decision: 'proceeded', chosen: ['item-1', 'item-2', 'item-1'] }));
    assert.deepEqual(room, { t: 'card.decide', message: 'a:m1:scribe', decision: 'proceeded', chosen: ['item-1', 'item-2'] });
    const tab = parseClientMsg(JSON.stringify({ t: 'card.decide', thread: 't1', message: 'm1', decision: 'dismissed', chosen: [] }));
    assert.equal(tab?.t === 'card.decide' ? tab.thread : null, 't1');
    assert.equal(parseClientMsg(JSON.stringify({ t: 'card.decide', thread: 'bad id', message: 'm1', decision: 'proceeded', chosen: [] })), null);
  });

  test('a worktree tab’s owner cannot post a proposal', () => {
    const msg = { t: 'thread.say', cid: 'c1', thread: 't1', agent: { handle: 'sarah', name: 'Sarah', look: { skin: '#efc29a', hair: '#1b1620', hairStyle: 2, outfit: '#7aa2f7', pants: '#2b3042', accessory: 0 } }, text: 'hi', ui: proposal() };
    assert.equal(parseClientMsg(JSON.stringify(msg)), null);
    assert.equal(parseClientMsg(JSON.stringify({ ...msg, ui: { kind: 'result', summary: 'done', status: 'done' } }))?.t, 'thread.say');
  });
});

describe('what an agent says it relied on', () => {
  test('known kinds and safe ids stay, once each, at most eight', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ kind: 'doc', id: `p-${i}`, title: `Doc ${i}` }));
    assert.equal(parseCitations(many).length, 8);
    assert.deepEqual(parseCitations([{ kind: 'ticket', id: '12', title: '#12 Offline', quote: 'q' }, { kind: 'ticket', id: '12', title: 'again' }, { kind: 'doc', id: '../etc', title: 'x' }, 'junk', { kind: 'doc', id: 'p-1', title: '   ' }]), [{ kind: 'ticket', id: '12', title: '#12 Offline', quote: 'q' }]);
    assert.deepEqual(parseCitations('nope'), []);
  });
});

describe('the agent service’s events', () => {
  test('a step is one safe line, an error code outside the known ones is internal', () => {
    assert.deepEqual(parseRunEvent('step', JSON.stringify({ tool: 'search_knowledge', summary: '3 passages\u0000' })), { event: 'step', data: { tool: 'search_knowledge', summary: '3 passages' } });
    assert.equal(parseRunEvent('step', JSON.stringify({ summary: 'no tool' })), null);
    assert.equal(parseRunEvent('error', JSON.stringify({ code: 'boom' }))?.event === 'error' && (parseRunEvent('error', JSON.stringify({ code: 'boom' })) as { data: { code: string } }).data.code, 'internal');
  });
});
