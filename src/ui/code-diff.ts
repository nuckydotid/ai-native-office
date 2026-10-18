// Line diffs for showing a changed file, pure and unit-tested (the CodeDiff component draws them).

export interface DiffLine {
  kind: 'same' | 'add' | 'remove';
  text: string;
  /** Line numbers in the old and in the new file (absent where the line is not in that file). */
  before?: number;
  after?: number;
}

/**
 * A line diff of two files, from the longest common run of lines. A change set holds whole files of at most 400 lines each, so the
 * quadratic table is small. `before` is `null` for a new file.
 */
export function diffLines(before: string | null, after: string): DiffLine[] {
  const a = before === null ? [] : before.replace(/\n$/, '').split('\n');
  const b = after === '' ? [] : after.replace(/\n$/, '').split('\n');
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i], before: i + 1, after: j + 1 });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ kind: 'remove', text: a[i], before: i + 1 });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j], after: j + 1 });
      j++;
    }
  }
  while (i < n) out.push({ kind: 'remove', text: a[i], before: ++i });
  while (j < m) out.push({ kind: 'add', text: b[j], after: ++j });
  return out;
}

/** How many lines a diff adds and removes. */
export function diffStat(lines: readonly DiffLine[]): { added: number; removed: number } {
  return { added: lines.filter((l) => l.kind === 'add').length, removed: lines.filter((l) => l.kind === 'remove').length };
}

/**
 * Only the changed lines and `context` lines around them, with a marker where lines were left out, so a 400-line file with a
 * three-line change reads in a few lines.
 */
export function collapseDiff(lines: readonly DiffLine[], context = 3): (DiffLine | { kind: 'gap'; hidden: number })[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind === 'same') return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: (DiffLine | { kind: 'gap'; hidden: number })[] = [];
  let hidden = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (hidden > 0) out.push({ kind: 'gap', hidden });
      hidden = 0;
      out.push(l);
    } else hidden++;
  });
  if (hidden > 0 && out.length > 0) out.push({ kind: 'gap', hidden });
  return out;
}
