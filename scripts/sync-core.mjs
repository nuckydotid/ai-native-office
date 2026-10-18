#!/usr/bin/env node
// Copies the shared code (src/shared/workspace, board, pages, ai) into the team server, which runs it without this app's tooling. The copies get a "do not edit" header naming their source, and the
// `ui-check-ignore-file` lines (they only matter to this app's UI check) are left out. Copies of files that no longer exist
// in the source are deleted, and so are folders of the team server's `shared` that no source folder feeds any more.
//   npm run sync-core                     copy
//   node scripts/sync-core.mjs --check    only compare: exits 1 when a copy is out of date (runs in `npm run check`)
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Every source folder and the team server folders that must carry an exact copy of it. */
const COPIES = [
  { from: '../src/shared/workspace/', to: '../team-server/src/shared/workspace/' },
  { from: '../src/shared/board/', to: '../team-server/src/shared/board/' },
  { from: '../src/shared/pages/', to: '../team-server/src/shared/pages/' },
  { from: '../src/shared/ai/', to: '../team-server/src/shared/ai/' },
  { from: '../src/shared/pipeline/', to: '../team-server/src/shared/pipeline/' },
  { from: '../src/shared/pipeline/', to: '../pipeline-service/src/shared/pipeline/' },
  // `pipeline/protocol.ts` uses the workspace's text cleaning, so the pipeline service needs that copy too.
  { from: '../src/shared/workspace/', to: '../pipeline-service/src/shared/workspace/' },
];
const check = process.argv.includes('--check');

const isShared = (name) => name.endsWith('.ts') && !name.endsWith('.test.ts');
const problems = [];
let copied = 0;

for (const { from, to } of COPIES) {
  // fileURLToPath, not `.pathname`: a folder name with a space in it comes out percent-encoded from the latter.
  const fromDir = fileURLToPath(new URL(from, import.meta.url));
  const toDir = fileURLToPath(new URL(to, import.meta.url));
  const source = from.replace('../', '').replace(/\/$/, '');
  const header = `// Copied from Worktrees Studio (${source}) by \`npm run sync-core\`. Do not edit here.\n`;

  const wanted = new Map();
  for (const name of readdirSync(fromDir).filter(isShared)) {
    const body = readFileSync(join(fromDir, name), 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('// ui-check-ignore-file:'))
      .join('\n');
    wanted.set(name, header + body);
  }

  if (!existsSync(toDir)) {
    if (check) problems.push(`missing folder ${toDir}`);
    else mkdirSync(toDir, { recursive: true });
  }
  for (const [name, text] of wanted) {
    const file = join(toDir, name);
    const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (current === text) continue;
    if (check) problems.push(`${source} → ${name} ${current === null ? 'is missing from' : 'differs in'} ${to}`);
    else {
      writeFileSync(file, text);
      copied += 1;
    }
  }
  for (const name of existsSync(toDir) ? readdirSync(toDir).filter(isShared) : []) {
    if (wanted.has(name)) continue;
    if (check) problems.push(`${name} is a stale copy (no longer in ${source})`);
    else {
      unlinkSync(join(toDir, name));
      copied += 1;
    }
  }
}

// A folder whose source was removed (the design room's, once) is not in COPIES, so the loop above never looks at it.
const sharedDir = fileURLToPath(new URL('../team-server/src/shared/', import.meta.url));
const fed = new Set(COPIES.map(({ to }) => to.replace(/\/$/, '').split('/').pop()));
for (const entry of existsSync(sharedDir) ? readdirSync(sharedDir, { withFileTypes: true }) : []) {
  if (!entry.isDirectory() || fed.has(entry.name)) continue;
  if (check) problems.push(`team-server/src/shared/${entry.name}/ is a stale copy (no source folder feeds it)`);
  else {
    rmSync(join(sharedDir, entry.name), { recursive: true });
    copied += 1;
  }
}

if (check) {
  if (problems.length) {
    console.log(`The team server copies of the shared code are out of date:\n  ${problems.join('\n  ')}\nRun: npm run sync-core`);
    process.exit(1);
  }
  console.log('Team server copies of the shared code: up to date.');
} else {
  console.log(`Synced ${copied} file${copied === 1 ? '' : 's'} into the team server.`);
}
