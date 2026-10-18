import { sanitizeText } from '../workspace/protocol.ts';
import { ARTIFACT_KINDS, DEFAULT_POLICY, PIPELINE_LIMITS, PIPELINE_STAGES, SCAN_SEVERITIES } from './types.ts';
import type { ArtifactDraft, ArtifactKind, ChangeFile, PipelinePolicy, PipelineStage } from './types.ts';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The only places an AI-written change may touch. Everything else (config, Dockerfile, lockfile, CI, the server shell) is ours. */
export const WRITABLE_ROOTS = [
  { prefix: 'sample-app/src/', role: 'src' },
  { prefix: 'sample-app/tests/', role: 'unit_test' },
  { prefix: 'sample-app/e2e/', role: 'e2e_test' },
] as const;

const FILE_EXT = /\.(ts|tsx|css|html|json|svg|md)$/;

/** The role a path would have, or null when the path is not in a place an agent may write. */
export function roleOfPath(path: unknown): ChangeFile['role'] | null {
  if (typeof path !== 'string' || path.length === 0 || path.length > PIPELINE_LIMITS.path) return null;
  if (path.includes('\\') || path.includes('\0') || path.startsWith('/') || /(^|\/)\.\.?(\/|$)/.test(path) || path.includes('//')) return null;
  // No hidden files, and only text a web app is made of.
  if (path.split('/').some((part) => part.startsWith('.'))) return null;
  if (!FILE_EXT.test(path)) return null;
  const root = WRITABLE_ROOTS.find((r) => path.startsWith(r.prefix) && path.length > r.prefix.length);
  return root ? root.role : null;
}

const SHA = /^[0-9a-f]{64}$/;
const countLines = (s: string) => (s === '' ? 0 : s.split('\n').length);
const byteLength = (s: string) => new TextEncoder().encode(s).length;

/** A change set from an untrusted source, cleaned. `null` when anything in it is not allowed (nothing is repaired). */
export function parseChangeSet(v: unknown): ChangeFile[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > PIPELINE_LIMITS.files) return null;
  const out: ChangeFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const f of v) {
    if (!isObj(f)) return null;
    const expected = roleOfPath(f.path);
    if (!expected || f.role !== expected || (f.op !== 'write' && f.op !== 'delete')) return null;
    const path = f.path as string;
    if (seen.has(path)) return null;
    seen.add(path);
    if (f.baseSha !== null && f.baseSha !== undefined && !(typeof f.baseSha === 'string' && SHA.test(f.baseSha))) return null;
    let content = '';
    if (f.op === 'write') {
      if (typeof f.content !== 'string') return null;
      // Line endings are normalised and invisible characters removed; indentation inside the file is kept.
      content = sanitizeText(f.content.replace(/\r\n?/g, '\n'), PIPELINE_LIMITS.fileBytes);
      if (!content || countLines(content) > PIPELINE_LIMITS.fileLines || byteLength(content) > PIPELINE_LIMITS.fileBytes) return null;
      content += '\n';
    } else if (typeof f.content === 'string' && f.content !== '') return null;
    total += byteLength(content);
    if (total > PIPELINE_LIMITS.changeSetBytes) return null;
    out.push({ path, op: f.op, role: expected, content, baseSha: (f.baseSha as string | null | undefined) ?? null });
  }
  return out;
}

export interface DenyFinding {
  path: string;
  line: number;
  rule: string;
  text: string;
}

/** What AI-written code may not do, by pattern: reach the network or the machine, run strings as code, handle passwords, link out. */
const DENY: { rule: string; test: RegExp }[] = [
  { rule: 'child_process', test: /\b(?:child_process|worker_threads|cluster)\b/ },
  { rule: 'node network or file modules', test: /(?:from\s+|require\(\s*|import\(\s*)['"](?:node:)?(?:net|dgram|http|https|http2|tls|dns|fs|fs\/promises|vm)['"]/ },
  { rule: 'network call to an absolute address', test: /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b[^\n]{0,120}https?:\/\// },
  { rule: 'WebSocket', test: /\bnew\s+WebSocket\b/ },
  { rule: 'eval or Function constructor', test: /\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(/ },
  { rule: 'dynamic import', test: /\bimport\s*\(/ },
  { rule: 'process.env', test: /\bprocess\s*\.\s*env\b/ },
  { rule: 'password field', test: /type\s*=\s*\{?\s*['"`]password|autoComplete\s*=\s*\{?\s*['"`](?:current|new)-password|autocomplete\s*=\s*['"`](?:current|new)-password/i },
  { rule: 'external link or asset', test: /\b(?:href|src|action|formAction|poster)\s*=\s*\{?\s*['"`]https?:\/\//i },
  { rule: 'navigation to an absolute address', test: /\b(?:window\.open|location\.(?:href|assign|replace))\b[^\n]{0,80}https?:\/\//i },
  { rule: 'raw HTML injection', test: /\b(?:dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML)\b|document\.write\s*\(/ },
  { rule: 'cookies', test: /\bdocument\s*\.\s*cookie\b/ },
];

/** Scans the files a change set writes. Deleted files have no content. A finding blocks the change set; nothing is rewritten. */
export function denyScan(files: readonly Pick<ChangeFile, 'path' | 'op' | 'content'>[]): DenyFinding[] {
  const findings: DenyFinding[] = [];
  for (const f of files) {
    if (f.op !== 'write') continue;
    f.content.split('\n').forEach((line, i) => {
      for (const d of DENY) if (d.test.test(line)) findings.push({ path: f.path, line: i + 1, rule: d.rule, text: line.trim().slice(0, 120) });
    });
  }
  return findings;
}

const META_KEY = /^[a-z][A-Za-z0-9_]{0,39}$/;

function cleanMeta(v: unknown): Record<string, string | number | boolean> | undefined {
  if (!isObj(v)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, val] of Object.entries(v)) {
    if (Object.keys(out).length >= PIPELINE_LIMITS.metaKeys) break;
    if (!META_KEY.test(k)) continue;
    if (typeof val === 'boolean') out[k] = val;
    else if (typeof val === 'number' && Number.isFinite(val)) out[k] = val;
    else if (typeof val === 'string') out[k] = sanitizeText(val, PIPELINE_LIMITS.metaValue);
  }
  return Object.keys(out).length ? out : undefined;
}

export const isArtifactKind = (v: unknown): v is ArtifactKind => typeof v === 'string' && (ARTIFACT_KINDS as readonly string[]).includes(v);
export const isStage = (v: unknown): v is PipelineStage => typeof v === 'string' && (PIPELINE_STAGES as readonly string[]).includes(v);

/**
 * An artifact an agent handed back, cleaned. `null` when it is not one. A `change_set` must carry a valid, scan-clean set of files
 * (the scan result is the caller's to act on: `denyScan`); the other kinds carry no files.
 */
export function parseArtifactDraft(v: unknown): ArtifactDraft | null {
  if (!isObj(v) || !isArtifactKind(v.kind)) return null;
  const title = typeof v.title === 'string' ? sanitizeText(v.title, PIPELINE_LIMITS.title) : '';
  const body = typeof v.body === 'string' ? sanitizeText(v.body, PIPELINE_LIMITS.body) : '';
  if (!title || !body) return null;
  const meta = cleanMeta(v.meta);
  if (v.kind === 'change_set') {
    const files = parseChangeSet(v.files);
    if (!files) return null;
    return { kind: v.kind, title, body, files, ...(meta ? { meta } : {}) };
  }
  if (v.files !== undefined && !(Array.isArray(v.files) && v.files.length === 0)) return null;
  return { kind: v.kind, title, body, ...(meta ? { meta } : {}) };
}

/** What a client may ask for when it decides an artifact. */
export function parseDecision(v: unknown): 'accepted' | 'rejected' | null {
  if (!isObj(v)) return null;
  return v.decision === 'accepted' || v.decision === 'rejected' ? v.decision : null;
}

const num = (v: unknown, lo: number, hi: number): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);

/**
 * The thresholds an owner sets, cleaned. Anything left out keeps its default; anything out of range or of the wrong kind refuses the
 * whole thing (`null`), so a typo never loosens a gate quietly.
 */
export function parsePolicy(v: unknown): PipelinePolicy | null {
  if (!isObj(v)) return null;
  const out: PipelinePolicy = { ...DEFAULT_POLICY, rolloutPlan: [...DEFAULT_POLICY.rolloutPlan] };
  if (v.coverageMin !== undefined) {
    const n = num(v.coverageMin, 0, 100);
    if (n === null) return null;
    out.coverageMin = n;
  }
  if (v.errorRateMax !== undefined) {
    const n = num(v.errorRateMax, 0, 1);
    if (n === null) return null;
    out.errorRateMax = n;
  }
  if (v.p95MsMax !== undefined) {
    const n = num(v.p95MsMax, 50, 60_000);
    if (n === null) return null;
    out.p95MsMax = Math.round(n);
  }
  if (v.scanMaxSeverity !== undefined) {
    if (typeof v.scanMaxSeverity !== 'string' || !(SCAN_SEVERITIES as readonly string[]).includes(v.scanMaxSeverity)) return null;
    out.scanMaxSeverity = v.scanMaxSeverity as PipelinePolicy['scanMaxSeverity'];
  }
  if (v.scanRequired !== undefined) {
    if (typeof v.scanRequired !== 'boolean') return null;
    out.scanRequired = v.scanRequired;
  }
  if (v.separationOfDuties !== undefined) {
    if (typeof v.separationOfDuties !== 'boolean') return null;
    out.separationOfDuties = v.separationOfDuties;
  }
  if (v.rolloutPlan !== undefined) {
    const plan = v.rolloutPlan;
    if (!Array.isArray(plan) || plan.length < 1 || plan.length > 6 || !plan.every((p) => Number.isInteger(p) && p >= 1 && p <= 100)) return null;
    const steps = plan as number[];
    if (steps[steps.length - 1] !== 100 || steps.some((p, i) => i > 0 && p <= steps[i - 1])) return null;
    out.rolloutPlan = steps;
  }
  return out;
}
