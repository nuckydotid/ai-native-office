// ui-check-ignore-file: a map zone's colour is data in a test message, not app styling
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { allMentions, extractMentions, validHandle } from './chat.ts';
import { normalizeEmail, validEmail } from './identity.ts';
import { lookFromSeed } from './looks.ts';
import { LIMITS, cleanAgentText, parseClientMsg, rawRefs, sanitizeText } from './protocol.ts';
import { scrubSecrets } from './secrets.ts';
import { clampCodePoints, codePointLength, stripLoneSurrogates } from './text.ts';

const EMOJI = String.fromCodePoint(0x1f600);
const HIGH = String.fromCharCode(0xd83d);
const LOW = String.fromCharCode(0xde00);
const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
const LS = String.fromCharCode(0x2028);
/** No half of an emoji on its own (what Postgres refuses). */
const wellFormed = (s: string) => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

describe('text safety', () => {
  test('an emoji counts once and is never cut in half', () => {
    assert.equal(codePointLength(`a${EMOJI}b`), 3);
    assert.equal(clampCodePoints(`${'x'.repeat(499)}${EMOJI}${EMOJI}`, 500), `${'x'.repeat(499)}${EMOJI}`);
    assert.equal(clampCodePoints(`${'x'.repeat(5999)}${EMOJI}`, 6000), `${'x'.repeat(5999)}${EMOJI}`);
    const cut = sanitizeText(`${'x'.repeat(499)}${EMOJI}${EMOJI}`, 500);
    assert.equal(codePointLength(cut), 500);
    assert.equal(cut, `${'x'.repeat(499)}${EMOJI}`, 'cut between whole emoji, never through one');
    assert.ok(wellFormed(cut));
  });

  test('half emoji are dropped (Postgres refuses them)', () => {
    assert.equal(stripLoneSurrogates(`a${HIGH}b`), 'ab');
    assert.equal(stripLoneSurrogates(`a${LOW}b`), 'ab');
    assert.equal(stripLoneSurrogates(`a${HIGH}${LOW}b`), `a${HIGH}${LOW}b`);
    // sanitizeText itself drops them (JSON would happily write them as \\ud83d, and Postgres would refuse that).
    assert.equal(sanitizeText(`hi${HIGH}`, 50), 'hi');
    assert.equal(sanitizeText(`${LOW}x`, 50), 'x');
    assert.equal(sanitizeText(`a${HIGH}${LOW}${HIGH}`, 50), `a${HIGH}${LOW}`);
    assert.ok(wellFormed(sanitizeText(`${HIGH}${HIGH}${LOW}${LOW}${LOW}`, 50)));
  });

  test('joined emoji and words in scripts that need the joiners are left whole', () => {
    const ZWJ = String.fromCharCode(0x200d);
    const ZWNJ = String.fromCharCode(0x200c);
    const family = `${String.fromCodePoint(0x1f468)}${ZWJ}${String.fromCodePoint(0x1f469)}${ZWJ}${String.fromCodePoint(0x1f467)}`;
    assert.equal(sanitizeText(family, 50), family);
    const persian = `\u0645\u06cc${ZWNJ}\u062e\u0648\u0627\u0647\u0645`;
    assert.equal(sanitizeText(persian, 50), persian);
  });

  test('characters that hide text are removed: tags, the Arabic letter mark, the Mongolian vowel separator', () => {
    const tag = (c: string) => String.fromCodePoint(0xe0000 + c.charCodeAt(0));
    assert.equal(sanitizeText(`hi${tag('A')}${tag('B')}${String.fromCharCode(0x061c)}${String.fromCharCode(0x180e)}!`, 50), 'hi!');
  });

  test('control, invisible and direction-flipping characters are removed; newlines stay', () => {
    assert.equal(sanitizeText(`  a${RLO}b${ZWSP}c${LS}d\u0007e\nf\tg  `, 50), 'abcde\nf\tg');
  });
});

describe('mentions', () => {
  test('finds distinct handles after a space or at the start, lower case', () => {
    assert.deepEqual(allMentions('@John please ask @sarah and (@alex) and @John again.'), ['john', 'sarah', 'alex']);
    assert.deepEqual(extractMentions('@a1 @b2 @c3 @d4'), ['a1', 'b2', 'c3'], 'at most three');
    assert.deepEqual(allMentions('@a1 @b2 @c3 @d4'), ['a1', 'b2', 'c3', 'd4'], 'so the caller can say what was skipped');
  });

  test('emails, scoped packages and reserved words are not mentions', () => {
    assert.deepEqual(allMentions('mail ann@example.com or install @scope/pkg, hi @here and @everyone'), []);
    assert.deepEqual(allMentions('hello@john'), []);
    assert.equal(validHandle('here'), false);
    assert.equal(validHandle('john-2'), true);
    assert.equal(validHandle('John'), false);
  });
});

describe('secrets', () => {
  test('redacts common credential shapes and says how many', () => {
    const text = [
      'key AIzaSyA1234567890abcdefghijklmnopqrstuv and token ya29.a0AfH6SMBabcdefghijklmnop',
      'client: GOCSPX-abcdefghijklmnopqrstuvwxyz1',
      'repo ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'db postgres://admin:hunter2@db.example.com:5432/app',
      '"client_secret": "abcdefghijklmnop1234"',
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----',
    ].join('\n');
    const { text: out, hits } = scrubSecrets(text);
    assert.ok(hits >= 6, `hits ${hits}`);
    for (const secret of ['AIzaSyA1234567890', 'ya29.a0AfH6', 'GOCSPX-abc', 'ghp_abc', 'hunter2', 'abcdefghijklmnop1234', 'MIIEvQIBADANBgkq']) assert.ok(!out.includes(secret), secret);
    assert.ok(out.includes('db.example.com'), 'the host stays');
  });

  test('what is left is exactly the text around the secret, not a template', () => {
    const out = (t: string) => scrubSecrets(t).text;
    assert.equal(out('db is postgres://admin:hunter2@db.example.com/app'), 'db is postgres://[redacted]@db.example.com/app');
    assert.equal(out('"refresh_token": "1//0gAbCdEfGhIjKlMnOpQr"'), '"refresh_token": "[redacted]"');
    assert.equal(out("api_key = 'abcdefghijklmnop1234'"), "api_key = '[redacted]'");
    assert.equal(out('REDIS_URL=redis://:hunter2@cache:6379'), 'REDIS_URL=redis://[redacted]@cache:6379');
    assert.equal(out('postgres://u:p@ss@host/db'), 'postgres://[redacted]@host/db', 'a password with an @ in it');
    assert.equal(out('refresh_token=1//0gAbCdEfGhIjKlMnOpQrStUv'), 'refresh_token=[redacted]');
    assert.equal(out('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123'), 'Authorization: Bearer [redacted]');
    assert.equal(out('-----BEGIN PGP PRIVATE KEY BLOCK-----\nabc\n-----END PGP PRIVATE KEY BLOCK-----'), '[redacted key]');
    assert.equal(out('use sk-proj-abcdefghij1234567890klmn here'), 'use [redacted] here');
    assert.equal(out('class="sk-this-is-a-long-css-class-name"'), 'class="sk-this-is-a-long-css-class-name"', 'a hyphenated word is not a key');
    assert.equal(out('a key file starts with -----BEGIN PRIVATE KEY-----'), 'a key file starts with [redacted key]', 'cut off: to the end');
  });

  test('hostile text is scrubbed quickly', () => {
    const started = Date.now();
    for (const bad of ['a-'.repeat(3000), 'eyJ-'.repeat(1500), 'a://'.repeat(1500), 'sk-'.repeat(2000), 'refresh_token='.repeat(500), '-----BEGIN PRIVATE KEY-----'.repeat(200)]) scrubSecrets(bad);
    assert.ok(Date.now() - started < 1500, `${Date.now() - started} ms`);
  });

  test('ordinary talk about OAuth is left alone, and scrubbing twice changes nothing', () => {
    const talk = 'Set client_secret in your env, not in code. The refresh_token flow needs offline access.';
    assert.deepEqual(scrubSecrets(talk), { text: talk, hits: 0 });
    const once = scrubSecrets('token ya29.a0AfH6SMBabcdefghijklmnop').text;
    assert.deepEqual(scrubSecrets(once), { text: once, hits: 0 });
  });

  test('an unterminated private key is cut to the end', () => {
    assert.equal(scrubSecrets('x -----BEGIN RSA PRIVATE KEY-----\nabc\ndef').text, 'x [redacted key]');
  });
});

describe('email', () => {
  test('an address that is nothing but dots or a plus tag at Gmail is nobody’s', () => {
    for (const bad of ['+a@gmail.com', '...@gmail.com', '.+x@googlemail.com']) assert.equal(validEmail(bad), false, bad);
    assert.equal(normalizeEmail('+a@gmail.com'), '+a@gmail.com', 'kept as typed, not collapsed with other mistakes');
    assert.notEqual(normalizeEmail('+a@gmail.com'), normalizeEmail('...@gmail.com'));
    assert.equal(validEmail('a.b+c@gmail.com'), true);
    assert.equal(normalizeEmail('ann+dev@corp.com'), 'ann+dev@corp.com', 'other providers are only lower-cased');
  });

  test('Gmail dots, plus tags and googlemail are one mailbox; other domains only lose case', () => {
    assert.equal(normalizeEmail('First.Last+work@Googlemail.com'), 'firstlast@gmail.com');
    assert.equal(normalizeEmail('Ann.Lee@example.com'), 'ann.lee@example.com');
    assert.equal(normalizeEmail(undefined), '');
  });

  test('validates a plausible address', () => {
    assert.equal(validEmail('a@b.co'), true);
    assert.equal(validEmail('no-at-sign'), false);
    assert.equal(validEmail('a b@c.com'), false);
    assert.equal(validEmail(`${'a'.repeat(250)}@b.com`), false);
  });
});

describe('client messages', () => {
  const look = lookFromSeed('ann');
  const parse = (v: unknown) => parseClientMsg(JSON.stringify(v));

  test('chat is the Room only, with an optional client id', () => {
    assert.deepEqual(parse({ t: 'chat', text: '  hi  ', cid: 'c-1' }), { t: 'chat', text: 'hi', cid: 'c-1' });
    assert.deepEqual(parse({ t: 'chat', scope: 'room', text: 'hi' }), { t: 'chat', text: 'hi', cid: undefined });
    assert.deepEqual(parse({ t: 'chat', text: 'hi', room: 'design' }), { t: 'chat', text: 'hi', cid: undefined, room: 'design' });
    assert.equal(parse({ t: 'chat', scope: 'nearby', text: 'hi' }), null);
    assert.equal(parse({ t: 'chat', scope: 'dm', to: 'x', text: 'hi' }), null);
    assert.equal(parse({ t: 'chat', text: '   ' }), null);
    assert.equal(parse({ t: 'chat', text: 'hi', cid: 'bad id!' }), null);
    assert.equal(parse({ t: 'chat', text: 'hi', room: 'bad room!' }), null);
    assert.equal(codePointLength((parse({ t: 'chat', text: 'x'.repeat(900) }) as { text: string }).text), LIMITS.chatText);
  });

  test('the old agent messages are gone', () => {
    assert.equal(parse({ t: 'agent.chat', agentId: 'a', text: 'hi', reqId: 'r' }), null);
    assert.equal(parse({ t: 'agents.sync', agents: [] }), null);
  });

  test('history.get', () => {
    assert.deepEqual(parse({ t: 'history.get', reqId: 'r1' }), { t: 'history.get', reqId: 'r1', before: undefined, limit: undefined });
    assert.deepEqual(parse({ t: 'history.get', reqId: 'r1', before: { at: 5, id: 'x' }, limit: 30 }), { t: 'history.get', reqId: 'r1', before: { at: 5, id: 'x' }, limit: 30 });
    assert.deepEqual(parse({ t: 'history.get', reqId: 'r1', room: 'plaza', session: 's1' }), { t: 'history.get', reqId: 'r1', room: 'plaza', session: 's1', before: undefined, limit: undefined });
    assert.equal(parse({ t: 'history.get', reqId: 'r1', limit: 51 }), null);
    assert.equal(parse({ t: 'history.get', reqId: 'r1', before: { at: -1, id: 'x' } }), null);
    assert.equal(parse({ t: 'history.get', reqId: 'r1', room: 'bad room!' }), null);
    assert.equal(parse({ t: 'history.get', reqId: 'r1', session: 'bad session!' }), null);
  });

  test('session lifecycle messages', () => {
    assert.deepEqual(parse({ t: 'session.new', reqId: 'r1', room: 'design' }), { t: 'session.new', reqId: 'r1', room: 'design' });
    assert.deepEqual(parse({ t: 'session.archive', reqId: 'r2', room: 'design' }), { t: 'session.archive', reqId: 'r2', room: 'design' });
    assert.deepEqual(parse({ t: 'session.delete', reqId: 'r3', session: 'sess-1' }), { t: 'session.delete', reqId: 'r3', session: 'sess-1' });

    assert.equal(parse({ t: 'session.new', reqId: 'bad req', room: 'design' }), null);
    assert.equal(parse({ t: 'session.new', reqId: 'r1', room: 'bad room!' }), null);
    assert.equal(parse({ t: 'session.archive', reqId: 'r1', room: 'bad room!' }), null);
    assert.equal(parse({ t: 'session.delete', reqId: 'r1', session: 'bad session!' }), null);
  });

  test('agent.start validates and cleans the agent snapshot', () => {
    const ok = parse({ t: 'agent.start', reqId: 'r1', replyTo: 'm1', mode: 'fresh', agent: { handle: 'john', name: ` John${RLO} Carter `, role: 'Scout', look } });
    assert.deepEqual(ok, { t: 'agent.start', reqId: 'r1', replyTo: 'm1', mode: 'fresh', agent: { handle: 'john', name: 'John Carter', role: 'Scout', look } });
    assert.equal(parse({ t: 'agent.start', reqId: 'r1', replyTo: 'm1', mode: 'fresh', agent: { handle: 'here', name: 'x', look } }), null, 'reserved handle');
    assert.equal(parse({ t: 'agent.start', reqId: 'r1', replyTo: 'm1', mode: 'now', agent: { handle: 'john', name: 'x', look } }), null);
    assert.equal(parse({ t: 'agent.start', reqId: 'r1', replyTo: 'm1', mode: 'fresh', agent: { handle: 'john', name: 'x', look: { ...look, skin: 'red' } } }), null);
  });

  test('hello needs no invite and may carry the protocol version', () => {
    const hello = parse({ t: 'hello', token: 't', workspaceId: 'main', name: 'Ann', look, protocol: 3, invite: 'old' });
    assert.equal((hello as { protocol?: number }).protocol, 3);
    assert.equal('invite' in (hello as object), false);
  });

  test('a refused frame can still say which request it was', () => {
    assert.deepEqual(rawRefs('{"t":"chat","text":"","cid":"c-9"}'), { cid: 'c-9' });
    assert.deepEqual(rawRefs('{"t":"history.get","reqId":"r-2","limit":999}'), { reqId: 'r-2' });
    assert.deepEqual(rawRefs('not json'), {});
    assert.deepEqual(rawRefs('{"cid":"bad id"}'), {});
  });

  test('an agent reply is cleaned, and refused (not cut) when too long', () => {
    assert.equal(cleanAgentText('  Sure.  '), 'Sure.');
    assert.equal(cleanAgentText('   '), null);
    assert.equal(cleanAgentText('x'.repeat(LIMITS.agentText)), 'x'.repeat(LIMITS.agentText));
    assert.equal(cleanAgentText('x'.repeat(LIMITS.agentText + 1)), null);
    assert.equal(cleanAgentText(EMOJI.repeat(LIMITS.agentText)), EMOJI.repeat(LIMITS.agentText), 'counted in code points, not UTF-16 units');
  });

  test('a look is rebuilt from its known fields, so nothing extra is kept or broadcast', () => {
    const look = lookFromSeed('ann');
    const junk = { ...look, junk: 'x'.repeat(10_000), nested: { a: 1 } };
    const hello = parseClientMsg(JSON.stringify({ t: 'hello', token: 't', workspaceId: 'main', name: 'Ann', look: junk }));
    assert.deepEqual(hello && hello.t === 'hello' ? hello.look : null, look);
    const agent = parseClientMsg(JSON.stringify({ t: 'agent.start', reqId: 'r1', replyTo: 'm1', mode: 'fresh', agent: { handle: 'john', name: 'John', look: junk } }));
    assert.deepEqual(agent && agent.t === 'agent.start' ? agent.agent.look : null, look);
  });

  test('a history cursor and message ids that a database would refuse never get that far', () => {
    const get = (before: unknown) => parseClientMsg(JSON.stringify({ t: 'history.get', reqId: 'h1', before }));
    assert.ok(get({ at: 1_700_000_000_000, id: '0abc-def' }));
    for (const bad of [{ at: 1e20, id: 'a' }, { at: 1e21, id: 'a' }, { at: -1, id: 'a' }, { at: 1.5, id: 'a' }, { at: 1, id: 'a\u0000b' }, { at: 1, id: '' }, { at: 1, id: 'a b' }, { at: 1, id: 'x'.repeat(201) }]) assert.equal(get(bad), null, JSON.stringify(bad));
    assert.equal(parseClientMsg(JSON.stringify({ t: 'chat.delete', id: 'a\u0000b' })), null);
    assert.ok(parseClientMsg(JSON.stringify({ t: 'chat.delete', id: 'a:0abc-def:john' })));
    assert.equal(parseClientMsg(JSON.stringify({ t: 'agent.start', reqId: 'r1', replyTo: 'a\u0000', mode: 'fresh', agent: { handle: 'john', name: 'John', look: lookFromSeed('x') } })), null);
  });

  test('names and labels in map edits must already be clean text', () => {
    const zone = (name: string) => parseClientMsg(JSON.stringify({ t: 'edit', op: { op: 'zone.set', zone: { id: 'z1', name, kind: 'open', x: 0, y: 0, w: 2, h: 2, color: '#112233' } } }));
    assert.ok(zone('Frontend Lab'));
    assert.equal(zone('a\u0000b'), null);
    assert.equal(zone(`a${HIGH}`), null);
    assert.equal(zone(`a${ZWSP}b`), null);
    const prop = (label: string) => parseClientMsg(JSON.stringify({ t: 'edit', op: { op: 'prop.add', prop: { id: 'p1', kind: 'desk', x: 1, y: 1, label } } }));
    assert.ok(prop('Ann’s desk'));
    assert.equal(prop('a\u0000b'), null);
  });
});

