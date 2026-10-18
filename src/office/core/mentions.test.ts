import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkMentions, mentionAtCaret, mentionNotice, stripMentions, suggestAgents } from './mentions.ts';

const agents = [
  { handle: 'john', displayName: 'John', role: 'Shopping advisor' },
  { handle: 'sarah', displayName: 'Sarah Chen' },
  { handle: 'jo-ann', displayName: 'Jo Ann' },
  { handle: 'alex', displayName: 'Alex Rivera' },
];

describe('the @name being typed', () => {
  test('found at the caret, after a space, a new line, a bracket or the start', () => {
    assert.deepEqual(mentionAtCaret('hi @jo', 6), { start: 3, end: 6, query: 'jo' });
    assert.deepEqual(mentionAtCaret('@', 1), { start: 0, end: 1, query: '' });
    assert.deepEqual(mentionAtCaret('line\n@al', 8), { start: 5, end: 8, query: 'al' });
    assert.deepEqual(mentionAtCaret('(@sa', 4), { start: 1, end: 4, query: 'sa' });
    assert.deepEqual(mentionAtCaret('ask @john please', 9), { start: 4, end: 9, query: 'john' }, 'the caret in the middle of the text');
  });

  test('not in an email, a scoped package, or after the name has ended', () => {
    assert.equal(mentionAtCaret('ann@example', 11), null);
    assert.equal(mentionAtCaret('@scope/pkg', 10), null);
    assert.equal(mentionAtCaret('@john hello', 11), null, 'the caret is past the name');
    assert.equal(mentionAtCaret('hello', 5), null);
    assert.equal(mentionAtCaret(`@${'a'.repeat(41)}`, 42), null);
  });
});

describe('suggestions', () => {
  test('names that start with what is typed come first, then ones that contain it', () => {
    assert.deepEqual(suggestAgents(agents, 'jo').map((a) => a.handle), ['jo-ann', 'john']);
    assert.deepEqual(suggestAgents(agents, 'chen').map((a) => a.handle), ['sarah'], 'a word of the name counts');
    assert.deepEqual(suggestAgents(agents, 'RIV').map((a) => a.handle), ['alex']);
    assert.deepEqual(suggestAgents(agents, 'zzz'), []);
  });

  test('nothing typed yet lists everyone, by handle, up to the limit', () => {
    assert.deepEqual(suggestAgents(agents, '').map((a) => a.handle), ['alex', 'jo-ann', 'john', 'sarah']);
    assert.equal(suggestAgents(agents, '', 2).length, 2);
  });
});

describe('next to a chip', () => {
  // The field hands over its words with every chip as one U+FFFC, so a chip is never read as letters of a name.
  const chip = '\uFFFC';

  test('a new mention after a chip and a space is found', () => {
    assert.deepEqual(mentionAtCaret(`${chip} @jo`, 5), { start: 2, end: 5, query: 'jo' });
  });

  test('nothing is offered right after a chip, or for an @ stuck to one', () => {
    assert.equal(mentionAtCaret(`hi ${chip}`, 4), null);
    assert.equal(mentionAtCaret(`${chip}@jo`, 4), null);
  });
});

describe('mentions the project cannot answer', () => {
  test('unknown handles and the ones beyond three are named', () => {
    const check = checkMentions('@john @ghost @sarah @alex @jo-ann', ['john', 'sarah', 'alex', 'jo-ann']);
    assert.deepEqual(check, { unknown: ['ghost'], skipped: ['alex', 'jo-ann'] });
    assert.match(mentionNotice(check)!, /No agent named ghost in this project\. Pull the latest, or create it in Agents\./);
    assert.match(mentionNotice(check)!, /can call three agents; alex, jo-ann were left out/);
    assert.equal(mentionNotice(checkMentions('@john hi', ['john'])), null);
    assert.match(mentionNotice(checkMentions('@a1 @b2', []))!, /No agents named a1, b2/);
  });

  test('emails and reserved words are not mentions at all', () => {
    assert.deepEqual(checkMentions('mail ann@example.com, hi @all', []), { unknown: [], skipped: [] });
  });
});

describe('the question', () => {
  test('is the message without the names of the agents it called', () => {
    assert.equal(stripMentions('@john please show me a phone', ['john']), 'please show me a phone');
    assert.equal(stripMentions('hey @John, what about @sarah?', ['john', 'sarah']), 'hey, what about?');
    assert.equal(stripMentions('@john', ['john']), '');
    assert.equal(stripMentions('contact ann@john.example', ['john']), 'contact ann@john.example', 'an address is left alone');
  });
});

describe('the question an agent is asked', () => {
  test('keeps line breaks, and only closes the gap a removed handle left', () => {
    assert.equal(stripMentions('@john which of these is secret?\n.env\n.gitignore\n?? status', ['john']), 'which of these is secret?\n.env\n.gitignore\n?? status');
    assert.equal(stripMentions('what does\n\n...\nmean @john', ['john']), 'what does\n\n...\nmean');
    assert.equal(stripMentions('hey @john, please help', ['john']), 'hey, please help');
    assert.equal(stripMentions('(@john) what now?', ['john']), 'what now?');
    assert.equal(stripMentions('line one\n@john line two', ['john']), 'line one\nline two');
  });

  test('text with no handle in it is left exactly as it was', () => {
    assert.equal(stripMentions('what is 1 + 1 ?', ['john']), 'what is 1 + 1 ?');
    assert.equal(stripMentions('  padded  ', ['john']), 'padded');
  });
});
