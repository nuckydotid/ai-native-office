/**
 * A small, safe Markdown reader for documents an agent wrote (plans, task lists, walkthroughs). It turns text into a tree and
 * never into HTML: raw HTML stays text, links are never followed (their label is kept), and images are their description.
 * What it knows: headings, paragraphs, bullet and numbered lists (nested, with task boxes), fenced code, block quotes (and
 * `> [!NOTE]` style notes), rules, pipe tables, and inline code, bold, italic, strike-through and links.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong' | 'em' | 'del'; c: Inline[] }
  | { t: 'link'; c: Inline[]; href: string }
  /** A picture the team server keeps (`![alt](asset:<id>)`). Any other image is only its description. */
  | { t: 'image'; alt: string; id: string };

export type Block =
  | { t: 'heading'; level: number; c: Inline[] }
  | { t: 'p'; c: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'quote'; note: string | null; c: Block[] }
  | { t: 'list'; ordered: boolean; items: { task: boolean | null; c: Block[] }[] }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][]; align: ('left' | 'center' | 'right' | null)[] }
  | { t: 'hr' };

/** More than this is not read (the rest is dropped), and nesting goes no deeper than `MAX_DEPTH`. */
export const MAX_CHARS = 256 * 1024;
const MAX_DEPTH = 6;
const MAX_BLOCKS = 2000;

/* ───────────── inline ───────────── */

const SPECIAL = /[`*_~[!\\]/;

export function parseInline(text: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (!SPECIAL.test(c)) {
      buf += c;
      i += 1;
      continue;
    }
    if (c === '\\' && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!~|>]/.test(text[i + 1])) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      const run = /^`+/.exec(text.slice(i))![0];
      const end = text.indexOf(run, i + run.length);
      if (end > i + run.length - 1 && end !== -1) {
        flush();
        out.push({ t: 'code', v: text.slice(i + run.length, end).replace(/^ (.*) $/, '$1') });
        i = end + run.length;
        continue;
      }
      buf += run;
      i += run.length;
      continue;
    }
    if ((c === '[' || (c === '!' && text[i + 1] === '[')) && depth < MAX_DEPTH) {
      const image = c === '!';
      const open = image ? i + 1 : i;
      const close = findClosing(text, open);
      if (close !== -1 && text[close + 1] === '(') {
        const end = text.indexOf(')', close + 2);
        if (end !== -1) {
          flush();
          const label = text.slice(open + 1, close);
          const href = text.slice(close + 2, end).trim().split(/\s+/)[0] ?? '';
          // An image is only what it describes.
          const asset = /^asset:([A-Za-z0-9_-]{1,100})$/.exec(href);
          out.push(image ? (asset ? { t: 'image', alt: label || 'picture', id: asset[1] } : { t: 'text', v: label || 'image' }) : { t: 'link', c: parseInline(label, depth + 1), href });
          i = end + 1;
          continue;
        }
      }
    }
    if ((c === '*' || c === '_' || c === '~') && depth < MAX_DEPTH) {
      const double = text[i + 1] === c;
      const mark = c === '~' ? (double ? '~~' : '') : double ? c + c : c;
      if (mark) {
        const start = i + mark.length;
        const end = text.indexOf(mark, start);
        // Not an emphasis when it is empty, or when the closing mark is glued to a word on a `_` (snake_case_names).
        if (end > start && !/^\s/.test(text.slice(start, start + 1)) && !(c === '_' && /\w/.test(text[i - 1] ?? ' '))) {
          flush();
          const c2 = parseInline(text.slice(start, end), depth + 1);
          out.push({ t: c === '~' ? 'del' : double ? 'strong' : 'em', c: c2 });
          i = end + mark.length;
          continue;
        }
      }
    }
    buf += c;
    i += 1;
  }
  flush();
  return out;
}

/** The `]` that closes the `[` at `open`, counting nested brackets. */
function findClosing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === '[') depth += 1;
    else if (text[i] === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/* ───────────── blocks ───────────── */

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$|^\s*\|\s*:?-{1,}:?\s*\|?\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const NOTE = /^\[!([A-Za-z]+)\]\s*$/;

const indentOf = (line: string) => /^\s*/.exec(line)![0].replace(/\t/g, '    ').length;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i += 1;
    } else if (s[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

const startsBlock = (line: string) => FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || ITEM.test(line);

function parseBlocks(lines: string[], depth: number, budget: { n: number }): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length && budget.n > 0) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    budget.n -= 1;

    const fence = FENCE.exec(line);
    if (fence) {
      const [, marks, lang] = fence;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i].trim().startsWith(marks[0].repeat(marks.length)) && /^\s*[`~]+\s*$/.test(lines[i]))) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      out.push({ t: 'code', lang, v: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ t: 'heading', level: heading[1].length, c: parseInline(heading[2]) });
      i += 1;
      continue;
    }
    if (HR.test(line)) {
      out.push({ t: 'hr' });
      i += 1;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const cells = splitRow(lines[i]);
        rows.push(head.map((_, k) => parseInline(cells[k] ?? '')));
        i += 1;
      }
      out.push({ t: 'table', head: head.map((h) => parseInline(h)), rows, align: align.slice(0, head.length) as never });
      continue;
    }
    if (QUOTE.test(line) && depth < MAX_DEPTH) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        inner.push(QUOTE.exec(lines[i])![1]);
        i += 1;
      }
      const note = NOTE.exec(inner[0] ?? '');
      out.push({ t: 'quote', note: note ? note[1].toUpperCase() : null, c: parseBlocks(note ? inner.slice(1) : inner, depth + 1, budget) });
      continue;
    }
    const item = ITEM.exec(line);
    if (item && depth < MAX_DEPTH) {
      const base = indentOf(line);
      const ordered = /\d/.test(item[2]);
      const items: { task: boolean | null; c: Block[] }[] = [];
      while (i < lines.length) {
        const m = ITEM.exec(lines[i]);
        if (!m || indentOf(lines[i]) !== base || /\d/.test(m[2]) !== ordered) break;
        let first = m[3];
        let task: boolean | null = null;
        const box = /^\[([ xX])\]\s+(.*)$/.exec(first);
        if (box) {
          task = box[1] !== ' ';
          first = box[2];
        }
        const content = [first];
        i += 1;
        // The item goes on while lines are indented further (or blank, followed by such a line).
        while (i < lines.length) {
          const next = lines[i];
          if (!next.trim()) {
            let j = i;
            while (j < lines.length && !lines[j].trim()) j += 1;
            if (j < lines.length && indentOf(lines[j]) > base) {
              for (; i < j; i++) content.push('');
              continue;
            }
            break;
          }
          if (indentOf(next) > base) {
            content.push(next.slice(Math.min(indentOf(next), base + 2)).replace(/^\s{0,2}/, (s) => (indentOf(next) > base + 2 ? s : '')));
            i += 1;
            continue;
          }
          // A line that is not a new block continues the item's paragraph (lazy continuation).
          if (!ITEM.test(next) && !startsBlock(next)) {
            content.push(next.trim());
            i += 1;
            continue;
          }
          break;
        }
        items.push({ task, c: parseBlocks(content, depth + 1, budget) });
      }
      out.push({ t: 'list', ordered, items });
      continue;
    }
    // A paragraph runs until a blank line or the start of another kind of block.
    const para = [line.trim()];
    i += 1;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]))) {
      para.push(lines[i].trim());
      i += 1;
    }
    // A line break inside a paragraph is kept: agents (and people) write lists and addresses that way in a chat.
    out.push({ t: 'p', c: parseInline(para.join('\n')) });
  }
  return out;
}

export function parseMarkdown(text: string): Block[] {
  const clipped = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
  return parseBlocks(clipped.replace(/\r\n?/g, '\n').split('\n'), 0, { n: MAX_BLOCKS });
}

/** The words of some inline nodes, with no markup (for names and previews). */
export function inlineText(nodes: Inline[]): string {
  return nodes.map((n) => (n.t === 'text' || n.t === 'code' ? n.v : n.t === 'image' ? n.alt : inlineText(n.c))).join('');
}

/** A link to a file on the author’s computer (`file:///…`): what the person reads is its name, not the link. */
export const fileNameOf = (href: string): string | null => {
  if (!/^file:\/\//i.test(href)) return null;
  const path = decodeURIComponent(href.replace(/^file:\/\//i, '').split(/[?#]/)[0]);
  return path.split('/').filter(Boolean).pop() ?? null;
};
