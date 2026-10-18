#!/usr/bin/env node
// Applies a change set (the same JSON the Developer Agent hands back) to this checkout. It exists so a person, a test or an eval can
// reproduce exactly what a build would see:
//   node ci/apply-change-set.mjs demo/good-change-set.json
// Paths are the repository paths (`sample-app/src/...`); this script strips the `sample-app/` prefix.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const [file] = process.argv.slice(2);
if (!file) {
  console.error('usage: node ci/apply-change-set.mjs <change-set.json>');
  process.exit(2);
}

const root = resolve(import.meta.dirname, '..');
const change = JSON.parse(readFileSync(file, 'utf8'));
const files = Array.isArray(change) ? change : change.files;
if (!Array.isArray(files) || files.length === 0) {
  console.error('the change set has no files');
  process.exit(1);
}

for (const file of files) {
  if (typeof file.path !== 'string' || !file.path.startsWith('sample-app/')) {
    console.error(`refusing a path outside sample-app/: ${String(file.path)}`);
    process.exit(1);
  }
  const target = join(root, file.path.slice('sample-app/'.length));
  if (file.op === 'delete') {
    rmSync(target, { force: true });
    console.log(`deleted ${file.path}`);
    continue;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, file.content);
  console.log(`wrote ${file.path}`);
}
