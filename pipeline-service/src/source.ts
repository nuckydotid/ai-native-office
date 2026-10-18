import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import type { ChangeFile } from './shared/pipeline/types.ts';
import type { GcsClient } from './google.ts';
import type { StateStore } from './store.ts';

export interface RepoFile {
  path: string;
  sha: string;
  size: number;
}

export interface StagedSource {
  /** The GCS object Cloud Build reads. */
  object: string;
  /** sha256 of the staged file tree: what the build ran on. */
  digest: string;
}

export interface SourceStore {
  rev(): Promise<number>;
  files(): Promise<Map<string, string>>;
  repo(): Promise<RepoFile[]>;
  read(path: string): Promise<string | null>;
  /** Lays the trunk and the change set over each other and uploads the result for one build. */
  stage(jobId: string, changes: readonly ChangeFile[]): Promise<StagedSource>;
  /** Applies a shipped change set to the trunk and moves `main@<rev>` forward. */
  commit(changes: readonly ChangeFile[]): Promise<number>;
  reset(): Promise<void>;
}

export const sha256 = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex');

const fileSha = (files: Map<string, string>) =>
  sha256([...files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, content]) => `${path}:${sha256(content)}`).join('\n'));

const IGNORED = new Set(['node_modules', 'dist', 'coverage', 'test-results', 'playwright-report', '.git', '.DS_Store']);

async function walk(root: string, dir = root, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(root, path, out);
    else if (entry.isFile()) out.push(relative(root, path));
  }
  return out;
}

async function writeTree(root: string, files: Map<string, string>) {
  for (const [path, content] of files) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

async function readTree(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const path of await walk(root)) files.set(path, await readFile(join(root, path), 'utf8'));
  return files;
}

async function runTar(args: string[]): Promise<void> {
  const proc = Bun.spawn(['tar', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`tar failed: ${await new Response(proc.stderr).text()}`);
}

/**
 * The sample app's virtual trunk, in memory plus the bucket. `files()` maps repository paths (`sample-app/src/App.tsx`) to content; the
 * archive it writes has `sample-app/` as its root, which is what the Dockerfile and the build steps expect.
 */
export class GoogleSourceStore implements SourceStore {
  private cache: Map<string, string> | null = null;
  private currentRev = 0;

  constructor(
    private baselineDir: string,
    private gcs: GcsClient,
    private store: StateStore,
  ) {}

  private async baseline(): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    for (const path of await walk(this.baselineDir)) files.set(`sample-app/${path}`, await readFile(join(this.baselineDir, path), 'utf8'));
    return files;
  }

  private async trunk(): Promise<Map<string, string>> {
    if (this.cache) return this.cache;
    const meta = await this.store.get<{ rev: number }>('trunk', 'main');
    if (!meta) {
      this.currentRev = 0;
      this.cache = await this.baseline();
      return this.cache;
    }
    const archive = await this.gcs.get('trunk/main.tar.gz');
    if (!archive) {
      this.currentRev = meta.rev;
      this.cache = await this.baseline();
      return this.cache;
    }
    const dir = await mkdtemp(join(tmpdir(), 'trunk-'));
    try {
      const tarPath = join(dir, 'main.tar.gz');
      await writeFile(tarPath, archive);
      const out = join(dir, 'out');
      await mkdir(out, { recursive: true });
      await runTar(['-xzf', tarPath, '-C', out]);
      this.cache = await readTree(out);
      this.currentRev = meta.rev;
      return this.cache;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private apply(files: Map<string, string>, changes: readonly ChangeFile[]): Map<string, string> {
    const next = new Map(files);
    for (const change of changes) {
      if (!change.path.startsWith('sample-app/')) throw new Error(`a change set may only write inside sample-app/: ${change.path}`);
      if (change.op === 'delete') next.delete(change.path);
      else next.set(change.path, change.content);
    }
    return next;
  }

  async rev(): Promise<number> {
    await this.trunk();
    return this.currentRev;
  }

  async files(): Promise<Map<string, string>> {
    return new Map(await this.trunk());
  }

  async repo(): Promise<RepoFile[]> {
    return [...(await this.trunk())]
      .map(([path, content]) => ({ path, sha: sha256(content), size: Buffer.byteLength(content) }))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  async read(path: string): Promise<string | null> {
    if (!path.startsWith('sample-app/') || path.includes('..')) return null;
    return (await this.trunk()).get(path) ?? null;
  }

  async stage(jobId: string, changes: readonly ChangeFile[]): Promise<StagedSource> {
    const tree = this.apply(await this.trunk(), changes);
    const digest = fileSha(tree);
    const dir = await mkdtemp(join(tmpdir(), `stage-${jobId}-`));
    try {
      await writeTree(dir, tree);
      const tarPath = join(dir, 'source.tar.gz');
      await runTar(['-czf', tarPath, '-C', dir, 'sample-app']);
      const object = `sources/${jobId}.tar.gz`;
      await this.gcs.put(object, await readFile(tarPath), 'application/gzip');
      return { object, digest };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async commit(changes: readonly ChangeFile[]): Promise<number> {
    const tree = this.apply(await this.trunk(), changes);
    const dir = await mkdtemp(join(tmpdir(), 'commit-'));
    try {
      await writeTree(dir, tree);
      const tarPath = join(dir, 'main.tar.gz');
      await runTar(['-czf', tarPath, '-C', dir, 'sample-app']);
      await this.gcs.put('trunk/main.tar.gz', await readFile(tarPath), 'application/gzip');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    this.cache = tree;
    this.currentRev += 1;
    await this.store.set('trunk', 'main', { rev: this.currentRev, updatedAt: Date.now() });
    return this.currentRev;
  }

  async reset(): Promise<void> {
    await this.gcs.delete('trunk/main.tar.gz');
    await this.store.delete('trunk', 'main');
    this.cache = null;
    this.currentRev = 0;
  }
}

/** The trunk for tests and local work: no bucket, no tarballs. */
export class MemorySourceStore implements SourceStore {
  private baseline: Map<string, string>;
  private cache: Map<string, string>;
  private currentRev = 0;

  constructor(
    files: Record<string, string>,
    private store?: StateStore,
  ) {
    this.baseline = new Map(Object.entries(files));
    this.cache = new Map(this.baseline);
  }

  private apply(changes: readonly ChangeFile[]): Map<string, string> {
    const next = new Map(this.cache);
    for (const change of changes) {
      if (!change.path.startsWith('sample-app/')) throw new Error(`a change set may only write inside sample-app/: ${change.path}`);
      if (change.op === 'delete') next.delete(change.path);
      else next.set(change.path, change.content);
    }
    return next;
  }

  async rev() {
    return this.currentRev;
  }

  async files() {
    return new Map(this.cache);
  }

  async repo(): Promise<RepoFile[]> {
    return [...this.cache]
      .map(([path, content]) => ({ path, sha: sha256(content), size: Buffer.byteLength(content) }))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  async read(path: string) {
    if (!path.startsWith('sample-app/') || path.includes('..')) return null;
    return this.cache.get(path) ?? null;
  }

  async stage(_jobId: string, changes: readonly ChangeFile[]): Promise<StagedSource> {
    const tree = this.apply(changes);
    return { object: `fake://${_jobId}`, digest: fileSha(tree) };
  }

  async commit(changes: readonly ChangeFile[]): Promise<number> {
    this.cache = this.apply(changes);
    this.currentRev += 1;
    await this.store?.set('trunk', 'main', { rev: this.currentRev });
    return this.currentRev;
  }

  async reset(): Promise<void> {
    this.cache = new Map(this.baseline);
    this.currentRev = 0;
    await this.store?.delete('trunk', 'main');
  }
}
