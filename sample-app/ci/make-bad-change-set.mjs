#!/usr/bin/env node
// Builds demo/bad-change-set.json: the change set that passes unit tests and then answers 5xx under load. Its `baseSha` is the sha256 of
// the current src/api/orders.ts, so it is always written against the baseline it is applied to.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const path = 'sample-app/src/api/orders.ts';
const content = readFileSync(resolve(root, 'demo/bad-orders.ts'), 'utf8');
const baseSha = createHash('sha256').update(readFileSync(resolve(root, 'src/api/orders.ts'))).digest('hex');
const change = {
  kind: 'change_set',
  title: 'Show a live stock badge',
  body: 'Adds a live stock count to the order book. It passes the unit tests; the load check is what catches it.',
  files: [{ path, op: 'write', role: 'src', content, baseSha }],
};
writeFileSync(resolve(root, 'demo/bad-change-set.json'), `${JSON.stringify(change, null, 2)}\n`);
console.log(`wrote demo/bad-change-set.json (baseSha ${baseSha.slice(0, 12)}…)`);
