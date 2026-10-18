import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fileNameOf, inlineText, parseInline, parseMarkdown, type Block } from './markdown-doc.ts';

const kinds = (blocks: Block[]) => blocks.map((b) => b.t);

describe('reading a plan document', () => {
  test('headings, paragraphs, rules and code', () => {
    const doc = parseMarkdown('# Title\n\nSome **bold** words\nover two lines.\n\n---\n\n```python\ndef add(a, b):\n    return a + b\n```\n');
    assert.deepEqual(kinds(doc), ['heading', 'p', 'hr', 'code']);
    const [h, p, , code] = doc;
    assert.equal(h.t === 'heading' && h.level, 1);
    assert.equal(p.t === 'p' && inlineText(p.c), 'Some bold words\nover two lines.');
    assert.deepEqual(code.t === 'code' && [code.lang, code.v], ['python', 'def add(a, b):\n    return a + b']);
  });

  test('lists nest, number, and carry task boxes', () => {
    const doc = parseMarkdown('- [ ] first\n- [x] second\n  - nested one\n  - nested two\n- third\n\n1. one\n2. two\n');
    assert.deepEqual(kinds(doc), ['list', 'list']);
    const [bullets, numbers] = doc;
    assert.ok(bullets.t === 'list' && !bullets.ordered && bullets.items.length === 3);
    assert.deepEqual(bullets.t === 'list' && bullets.items.map((i) => i.task), [false, true, null]);
    const nested = bullets.t === 'list' ? bullets.items[1].c : [];
    assert.deepEqual(kinds(nested), ['p', 'list']);
    assert.ok(numbers.t === 'list' && numbers.ordered && numbers.items.length === 2);
  });

  test('a table keeps its header, rows and alignment, and short rows are padded', () => {
    const doc = parseMarkdown('| Name | Qty |\n|:--|--:|\n| a | 1 |\n| b |\n');
    const t = doc[0];
    assert.ok(t.t === 'table');
    assert.deepEqual(t.t === 'table' && t.align, ['left', 'right']);
    assert.equal(t.t === 'table' && t.rows.length, 2);
    assert.equal(t.t === 'table' && t.rows[1].length, 2);
  });

  test('notes and quotes', () => {
    const doc = parseMarkdown('> [!WARNING]\n> Do not **skip** this.\n\n> plain quote\n');
    assert.ok(doc[0].t === 'quote' && doc[0].note === 'WARNING');
    assert.ok(doc[1].t === 'quote' && doc[1].note === null);
    const inner = doc[0].t === 'quote' ? doc[0].c : [];
    assert.equal(inner[0].t === 'p' && inlineText(inner[0].c), 'Do not skip this.');
  });

  test('links keep their label and never become anything to follow; images are their description', () => {
    const inline = parseInline('See [the docs](https://x.example/a) and ![a chart](http://evil/p.png) and [main.py](file:///a/b/main.py).');
    assert.equal(inlineText(inline), 'See the docs and a chart and main.py.');
    const link = inline.find((n) => n.t === 'link');
    assert.ok(link && link.t === 'link' && link.href === 'https://x.example/a');
    assert.equal(fileNameOf('file:///a/b/My%20File.md'), 'My File.md');
    assert.equal(fileNameOf('https://x.example/a'), null);
  });

  test('only a picture the team keeps is a picture; any other image is its description', () => {
    const inline = parseInline('See ![the chart](asset:a-123) and ![evil](https://evil.test/p.png) and ![x](asset:../etc)');
    assert.deepEqual(inline.filter((n) => n.t === 'image'), [{ t: 'image', alt: 'the chart', id: 'a-123' }]);
    assert.equal(inlineText(inline), 'See the chart and evil and x');
  });

  test('HTML stays text, and snake_case and lone marks are left alone', () => {
    assert.equal(inlineText(parseInline('<script>alert(1)</script> and a_b_c and 2 * 3 * 4')), '<script>alert(1)</script> and a_b_c and 2 * 3 * 4');
    const [p] = parseMarkdown('<img src=x onerror=alert(1)>');
    assert.ok(p.t === 'p' && inlineText(p.c) === '<img src=x onerror=alert(1)>');
  });

  test('an escaped mark is the mark, code is verbatim, and an unclosed mark is text', () => {
    assert.equal(inlineText(parseInline('\\*not italic\\* and `a * b` and **open')), '*not italic* and a * b and **open');
  });

  test('nothing pathological hangs: deep nesting and huge input are cut', () => {
    const deep = `${'> '.repeat(40)}x\n${'['.repeat(500)}`;
    assert.ok(parseMarkdown(deep).length >= 1);
    const big = parseMarkdown('word '.repeat(200_000));
    assert.ok(big.length >= 1);
    assert.ok(parseMarkdown(Array.from({ length: 5000 }, (_, i) => `- item ${i}`).join('\n')).length >= 1);
  });
});
