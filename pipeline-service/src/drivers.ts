import type { ChangeFile, JobKind, ScanSeverity } from './shared/pipeline/types.ts';
import type { PipelineConfig } from './config.ts';
import type { AccessTokenSource } from './auth.ts';
import { CloudBuildClient, ContainerAnalysisClient, GoogleRest } from './google.ts';
import type { CloudBuildStep } from './google.ts';

export interface BuildRequest {
  jobId: string;
  kind: JobKind;
  ticket: string;
  ticketKey: number;
  inputDigest: string;
  sourceObject: string;
  /** For a scan: the release image (with digest) to scan. */
  imageRef?: string;
  /** For the in-process stand-in only: the change set's files, with the `// fake:fail` / `// fake:5xx` markers. */
  files?: readonly ChangeFile[];
}

export type BuildState = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled' | 'timed_out';

export interface BuildStatus {
  state: BuildState;
  startedAt?: number;
  endedAt?: number;
  /** The image a release build produced (or, for a scan, the release image that was scanned). */
  imageDigest?: string;
  imageUrl?: string;
  statusDetail?: string;
}

export interface BuildResult {
  passed?: number;
  failed?: number;
  skipped?: number;
  durationMs?: number;
  coveragePct?: number;
  scanSeverity?: ScanSeverity;
  text?: string;
}

/** Everything the job service asks of Cloud Build (and of the in-process stand-in in tests). */
export interface BuildDriver {
  start(req: BuildRequest): Promise<{ buildId: string }>;
  status(buildId: string): Promise<BuildStatus>;
  log(buildId: string, from: number): Promise<{ text: string; next: number; done: boolean }>;
  cancel(buildId: string): Promise<void>;
  /** The vulnerability findings for one image, after the scan job ran. */
  findings(imageUrl: string): Promise<{ severity: ScanSeverity }[]>;
}

export const shortDigest = (digest: string): string => digest.slice(0, 12);

export const parseMarker = <T>(text: string, name: string): T | null => {
  const marker = `${name}:`;
  const at = text.lastIndexOf(marker);
  if (at < 0) return null;
  const rest = text.slice(at + marker.length);
  const line = rest.split('\n')[0]?.trim();
  if (!line) return null;
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
};

const severityRank: ScanSeverity[] = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
export const worstSeverity = (severities: ScanSeverity[]): ScanSeverity =>
  severities.reduce<ScanSeverity>((worst, s) => (severityRank.indexOf(s) > severityRank.indexOf(worst) ? s : worst), 'NONE');

/** The real thing: a Cloud Build build per job. The Dockerfile and the CI script are ours; the build never deploys. */
export class CloudBuildDriver implements BuildDriver {
  private client: CloudBuildClient;
  private analysis: ContainerAnalysisClient;

  constructor(
    private cfg: PipelineConfig,
    tokens: AccessTokenSource,
    fetchFn: typeof fetch = fetch,
  ) {
    const rest = new GoogleRest(tokens, fetchFn);
    this.client = new CloudBuildClient(rest, cfg.projectId, cfg.bucket);
    this.analysis = new ContainerAnalysisClient(rest, cfg.projectId);
  }

  private arBase(): string {
    return `${this.cfg.region}-docker.pkg.dev/${this.cfg.projectId}/${this.cfg.artifactRepo}`;
  }

  private images(kind: JobKind, digest: string, ticketKey: number): { test: string; runtime: string } {
    return {
      test: `${this.arBase()}/portal-test:${shortDigest(digest)}`,
      runtime: `${this.arBase()}/northwind-portal:${ticketKey}-${shortDigest(digest)}`,
    };
  }

  private steps(req: BuildRequest, images: { test: string; runtime: string }): { steps: CloudBuildStep[]; images?: string[] } {
    const docker = 'gcr.io/cloud-builders/docker';
    if (req.kind === 'release_build') {
      return { steps: [{ name: docker, id: 'release', args: ['build', '--target', 'runtime', '-t', images.runtime, 'sample-app'] }], images: [images.runtime] };
    }
    if (req.kind === 'scan') {
      return {
        steps: [
          {
            // The full SDK image carries the local-extract component the scan needs; the slim one does not.
            name: 'gcr.io/google.com/cloudsdktool/cloud-sdk:latest',
            id: 'scan',
            entrypoint: 'bash',
            args: ['-c', `gcloud artifacts docker images scan "${req.imageRef ?? ''}" --remote --format=json 2>&1 | tail -c 4000`],
          },
        ],
      };
    }
    const mode = req.kind === 'build' ? 'build' : req.kind;
    return {
      steps: [
        { name: docker, id: 'pull', entrypoint: 'bash', args: ['-c', `docker pull "${images.test}" || true`] },
        { name: docker, id: 'image', args: ['build', '--cache-from', images.test, '--target', 'test', '-t', images.test, 'sample-app'] },
        { name: docker, id: 'push', args: ['push', images.test] },
        { name: docker, id: 'test', args: ['run', '--rm', '--network', 'none', images.test, mode] },
      ],
    };
  }

  async start(req: BuildRequest): Promise<{ buildId: string }> {
    const images = this.images(req.kind, req.inputDigest, req.ticketKey);
    const { steps, images: pushImages } = this.steps(req, images);
    const build = await this.client.create({
      steps,
      ...(pushImages ? { images: pushImages } : {}),
      timeout: `${this.cfg.limits.jobTimeoutSeconds}s`,
      ...(this.cfg.buildServiceAccount ? { serviceAccount: `projects/${this.cfg.projectId}/serviceAccounts/${this.cfg.buildServiceAccount}` } : {}),
      tags: ['pipeline', req.ticket, req.kind, shortDigest(req.inputDigest)],
      logsBucket: `gs://${this.cfg.bucket}`,
      options: { logging: 'GCS_ONLY', machineType: 'E2_HIGHCPU_8', diskSizeGb: 60 },
      source: { storageSource: { bucket: this.cfg.bucket, object: req.sourceObject } },
    });
    // `POST /builds` answers with an operation: the build itself is in its metadata (the name is a base64 operation id).
    const buildId = build.id ?? build.metadata?.build?.id;
    if (!buildId) throw new Error('Cloud Build created a build without an id');
    return { buildId };
  }

  async status(buildId: string): Promise<BuildStatus> {
    const build = await this.client.get(buildId);
    const state: BuildState =
      build.status === 'SUCCESS'
        ? 'passed'
        : build.status === 'FAILURE' || build.status === 'INTERNAL_ERROR'
          ? 'failed'
          : build.status === 'CANCELLED'
            ? 'cancelled'
            : build.status === 'TIMEOUT'
              ? 'timed_out'
              : build.status === 'WORKING'
                ? 'running'
                : 'queued';
    const image = build.results?.images?.[0];
    const time = (value?: string) => (value ? Date.parse(value) : undefined);
    return {
      state,
      ...(build.startTime ? { startedAt: time(build.startTime) } : {}),
      ...(build.finishTime ? { endedAt: time(build.finishTime) } : {}),
      ...(image?.digest ? { imageDigest: image.digest } : {}),
      ...(image?.name ? { imageUrl: `${image.name.split(':').slice(0, -1).join(':')}@${image.digest}` } : {}),
      ...(build.statusDetail ? { statusDetail: build.statusDetail } : {}),
    };
  }

  log(buildId: string, from: number) {
    return this.client.log(buildId, from);
  }

  async cancel(buildId: string): Promise<void> {
    await this.client.cancel(buildId);
  }

  async findings(imageUrl: string): Promise<{ severity: ScanSeverity }[]> {
    return (await this.analysis.findings(imageUrl)).map((f) => ({ severity: f.severity }));
  }
}

export interface FakeBuildOptions {
  now?: () => number;
  /** How long a job takes, in milliseconds (a quarter of it is spent queued). */
  buildMs?: number;
  /** The marker that makes a build fail: any file contains `// fake:fail`. */
  failMarker?: string;
  /** The severity a scan finds. */
  scanSeverity?: ScanSeverity;
}

interface FakeBuild {
  id: string;
  req: BuildRequest;
  willFail: boolean;
  createdAt: number;
  cancelled?: boolean;
}

/**
 * The in-process Cloud Build, for the pipeline service's own tests and local work: jobs move queued → running → passed over a clock,
 * a change set that carries a marker fails, and a release build gets a deterministic image digest.
 */
export class FakeBuildDriver implements BuildDriver {
  private builds = new Map<string, FakeBuild>();
  private counter = 0;
  private now: () => number;
  private buildMs: number;
  private failMarker: string;
  private scanSeverity: ScanSeverity;

  constructor(options: FakeBuildOptions = {}) {
    this.now = options.now ?? Date.now;
    this.buildMs = options.buildMs ?? 800;
    this.failMarker = options.failMarker ?? '// fake:fail';
    this.scanSeverity = options.scanSeverity ?? 'LOW';
  }

  async start(req: BuildRequest): Promise<{ buildId: string }> {
    const id = `fake-build-${++this.counter}`;
    const willFail = (req.files ?? []).some((f) => f.op === 'write' && f.content.includes(this.failMarker));
    this.builds.set(id, { id, req, willFail, createdAt: this.now() });
    return { buildId: id };
  }

  private statusOf(build: FakeBuild): BuildStatus {
    if (build.cancelled) return { state: 'cancelled', endedAt: this.now() };
    const age = this.now() - build.createdAt;
    if (age >= this.buildMs) {
      return {
        state: build.willFail ? 'failed' : 'passed',
        startedAt: build.createdAt + Math.round(this.buildMs / 4),
        endedAt: build.createdAt + this.buildMs,
        ...(build.req.kind === 'release_build' ? { imageDigest: `sha256:${'a'.repeat(64)}`, imageUrl: `fake://northwind-portal@sha256:${'a'.repeat(64)}` } : {}),
        statusDetail: build.willFail ? 'a test did not pass' : undefined,
      };
    }
    if (age >= this.buildMs / 4) return { state: 'running', startedAt: build.createdAt + Math.round(this.buildMs / 4) };
    return { state: 'queued' };
  }

  async status(buildId: string): Promise<BuildStatus> {
    const build = this.builds.get(buildId);
    if (!build) return { state: 'failed', statusDetail: 'no such build' };
    return this.statusOf(build);
  }

  private linesFor(req: BuildRequest): string[] {
    if (req.kind === 'release_build') return ['docker build --target runtime', 'pushing to Artifact Registry', 'provenance recorded'];
    if (req.kind === 'scan') return ['scanning the image', 'no findings above the policy'];
    if (req.kind === 'unit') return ['docker run --network none (unit)', 'vitest run --coverage', 'PIPELINE_RESULT: {"ok":true,"kind":"unit","passed":13,"failed":0,"skipped":0,"coveragePct":82}'];
    if (req.kind === 'e2e') return ['docker run --network none (e2e)', 'playwright test', 'PIPELINE_RESULT: {"ok":true,"kind":"e2e","passed":4,"failed":0,"skipped":0}'];
    return ['docker build --target deps', 'npx tsc --noEmit', 'npm run lint', 'npm run build', 'PIPELINE_RESULT: {"ok":true,"kind":"build","passed":0,"failed":0,"skipped":0}'];
  }

  async log(buildId: string, from: number): Promise<{ text: string; next: number; done: boolean }> {
    const build = this.builds.get(buildId);
    if (!build) return { text: '', next: from, done: true };
    const status = this.statusOf(build);
    const lines = this.linesFor(build.req);
    const all = `${lines.join('\n')}\n${status.state === 'failed' ? 'FAILED: a test did not pass' : status.state === 'passed' ? 'passed' : ''}`;
    const upto = status.state === 'queued' ? 0 : status.state === 'running' ? Math.floor(all.length / 2) : all.length;
    const start = Math.max(0, Math.min(from, upto));
    return { text: all.slice(start, upto), next: upto, done: status.state !== 'queued' && status.state !== 'running' };
  }

  async cancel(buildId: string): Promise<void> {
    const build = this.builds.get(buildId);
    if (build) build.cancelled = true;
  }

  async findings(): Promise<{ severity: ScanSeverity }[]> {
    return [{ severity: this.scanSeverity }];
  }
}
