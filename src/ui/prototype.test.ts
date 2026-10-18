// ui-check-ignore-file: the test feeds hostile HTML strings to the cleaner; none of it is rendered
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOTYPE_CSP, hardenHtml, prototypeDocument } from './prototype.ts';

test('a prototype loses everything that can run, load or navigate', () => {
  const dirty =
    '<h1 onclick="steal()">Orders</h1><script>fetch("//evil")</script><script src="x.js"></script><iframe src="//evil"></iframe>' +
    '<meta http-equiv="refresh" content="0;url=//evil"><link rel="stylesheet" href="//evil/x.css"><base href="//evil/">' +
    '<form action="//evil"><input name="x"></form><a href="javascript:alert(1)">go</a><object data="x"></object><embed src="x">';
  const clean = hardenHtml(dirty);
  for (const bad of ['<script', 'onclick', 'iframe', 'refresh', '<link', '<base', '<form', 'javascript:', '<object', '<embed', 'evil/x.css']) assert.ok(!clean.toLowerCase().includes(bad), `${bad} is gone`);
  assert.match(clean, /<h1>Orders<\/h1>/);
  assert.match(clean, /<a>go<\/a>/);
});

test('plain markup and styles stay', () => {
  const ok = '<style>.a{color:red}</style><main class="a"><h1>Orders</h1><img src="data:image/png;base64,AAAA" alt=""></main>';
  assert.equal(hardenHtml(ok), ok);
});

test('the frame’s document carries the policy before anything else', () => {
  const doc = prototypeDocument('<p>Hi</p>');
  assert.ok(doc.includes(`content="${PROTOTYPE_CSP}"`));
  assert.ok(doc.indexOf('Content-Security-Policy') < doc.indexOf('<p>Hi</p>'));
  assert.match(PROTOTYPE_CSP, /default-src 'none'/);
  assert.ok(!PROTOTYPE_CSP.includes('script-src'), 'no script is ever allowed');
});

test('a page cannot take the policy off by writing its own', () => {
  const doc = prototypeDocument('<meta http-equiv="Content-Security-Policy" content="default-src *"><p>x</p>');
  assert.ok(!doc.includes('default-src *'));
});

test('pieces that join into a tag after one is removed are removed too', () => {
  assert.ok(!hardenHtml('<scr<script></script>ipt>alert(1)</script>').toLowerCase().includes('<script'));
  assert.ok(!hardenHtml('<p on<b onclick=x>click=alert(1)>x</p>').toLowerCase().includes('onclick'));
});
