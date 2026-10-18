import { loadSeed } from './seed.ts';

/**
 * Reads a seed folder the way the server does and says what it found and what it left out:
 *   bun src/demo/check.ts ../../../docs/demo-data
 */
const dir = process.argv[2];
if (!dir) {
  console.error('Usage: bun src/demo/check.ts <seed folder>');
  process.exit(2);
}
const warnings: string[] = [];
const seed = loadSeed(dir, (m) => warnings.push(m));
const byStatus = (s: string) => seed.tickets.filter((t) => t.status === s).length;
console.log(`Workspace: ${seed.name}`);
console.log(`People:    ${seed.members.map((m) => `${m.name} (${m.role})`).join(', ')}`);
console.log(`Pages:     ${seed.pages.length} (${seed.pages.filter((p) => !p.parent).length} at the top)`);
console.log(`Tickets:   ${seed.tickets.length} (todo ${byStatus('todo')}, in progress ${byStatus('in_progress')}, review ${byStatus('review')}, done ${byStatus('done')})`);
console.log(`Standup:   ${seed.standup.messages.length} lines, ${(seed.standup.messages.length * 1.8).toFixed(0)} s`);
console.log(`Agents:    ${seed.agents.map((a) => `@${a.handle}`).join(', ')}`);
const missing = ['studio', 'librarian', 'scribe', 'planner', 'reviewer', 'importer'].filter((h) => !seed.agents.some((a) => a.handle === h));
if (missing.length) warnings.push(`agents: the app looks these up by handle and they are missing: ${missing.map((h) => `@${h}`).join(', ')}`);
if (!seed.pages.some((p) => p.title === 'Meetings' && !p.parent)) warnings.push('pages: no top-level page titled exactly "Meetings" (minutes the Scribe proposes are saved under it; the server makes one if it is missing)');
for (const w of warnings) console.warn(`! ${w}`);
process.exit(warnings.some((w) => w.startsWith('no seed folder')) ? 1 : 0);
