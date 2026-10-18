/** Thin REST clients for the Google services the pipeline uses. No SDK: a token from the metadata server and `fetch`. */
import type { AccessTokenSource } from './auth.ts';

export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body = '',
  ) {
    super(message);
  }
}

async function readError(res: Response): Promise<GoogleApiError> {
  const body = await res.text().catch(() => '');
  let message = `Google answered ${res.status}`;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) message = parsed.error.message;
  } catch {
    // Keep the plain status.
  }
  return new GoogleApiError(res.status, message, body.slice(0, 1000));
}

export class GoogleRest {
  constructor(
    private tokens: AccessTokenSource,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async request(url: string, init: RequestInit = {}, retry = true): Promise<Response> {
    const token = await this.tokens.get();
    const res = await this.fetchFn(url, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      signal: init.signal ?? AbortSignal.timeout(60_000),
    });
    if ((res.status === 429 || res.status === 503) && retry) {
      await new Promise((r) => setTimeout(r, 800));
      return this.request(url, init, false);
    }
    if (!res.ok) throw await readError(res);
    return res;
  }

  async json<T>(url: string, init: RequestInit = {}): Promise<T> {
    return (await this.request(url, init)).json() as Promise<T>;
  }
}

/* ───────────── Google Cloud Storage ───────────── */

export interface GcsObject {
  name: string;
  size?: string;
  updated?: string;
}

export class GcsClient {
  constructor(
    private rest: GoogleRest,
    private bucket: string,
  ) {}

  private base(): string {
    return `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o`;
  }

  async put(name: string, data: Uint8Array, contentType = 'application/octet-stream'): Promise<void> {
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?uploadType=media&name=${encodeURIComponent(name)}`;
    await this.rest.request(url, { method: 'POST', headers: { 'content-type': contentType }, body: data as unknown as BodyInit });
  }

  async get(name: string, range?: { from: number }): Promise<Uint8Array | null> {
    try {
      const headers: Record<string, string> = {};
      if (range) headers.range = `bytes=${range.from}-`;
      const res = await this.rest.request(`${this.base()}/${encodeURIComponent(name)}?alt=media`, { headers });
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (e instanceof GoogleApiError && e.status === 404) return null;
      throw e;
    }
  }

  async getText(name: string, range?: { from: number }): Promise<string | null> {
    const bytes = await this.get(name, range);
    return bytes === null ? null : new TextDecoder().decode(bytes);
  }

  async delete(name: string): Promise<void> {
    try {
      await this.rest.request(`${this.base()}/${encodeURIComponent(name)}`, { method: 'DELETE' });
    } catch (e) {
      if (!(e instanceof GoogleApiError && e.status === 404)) throw e;
    }
  }

  async list(prefix: string): Promise<GcsObject[]> {
    const out: GcsObject[] = [];
    let pageToken = '';
    do {
      const url = `${this.base()}?prefix=${encodeURIComponent(prefix)}&pageSize=500${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const body = await this.rest.json<{ items?: GcsObject[]; nextPageToken?: string }>(url);
      out.push(...(body.items ?? []));
      pageToken = body.nextPageToken ?? '';
    } while (pageToken);
    return out;
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const object of await this.list(prefix)) await this.delete(object.name);
  }
}

/* ───────────── Cloud Build ───────────── */

export interface CloudBuildStep {
  name: string;
  id?: string;
  entrypoint?: string;
  args?: string[];
  dir?: string;
  env?: string[];
  waitFor?: string[];
  allowFailure?: boolean;
}

export interface CloudBuildOptions {
  logging: 'GCS_ONLY' | 'CLOUD_LOGGING_ONLY';
  machineType?: string;
  diskSizeGb?: number;
}

export interface CloudBuildRequest {
  steps: CloudBuildStep[];
  timeout: string;
  serviceAccount?: string;
  /** Where Cloud Build writes `log-<buildId>.txt`; a build-level field, not an option. */
  logsBucket?: string;
  images?: string[];
  tags?: string[];
  options?: CloudBuildOptions;
  substitutions?: Record<string, string>;
  source: { storageSource: { bucket: string; object: string } };
}

export interface BuildInfo {
  id?: string;
  /** On create this is the operation name (`operations/build/<project>/<base64>`); on get it is the build's resource name. */
  name?: string;
  /** On create the real build is here. */
  metadata?: { build?: { id?: string } };
  status: 'QUEUED' | 'WORKING' | 'SUCCESS' | 'FAILURE' | 'INTERNAL_ERROR' | 'TIMEOUT' | 'CANCELLED' | string;
  createTime?: string;
  startTime?: string;
  finishTime?: string;
  results?: { images?: { name: string; digest: string }[] };
  statusDetail?: string;
}

export class CloudBuildClient {
  constructor(
    private rest: GoogleRest,
    private projectId: string,
    private bucket: string,
  ) {}

  async create(build: CloudBuildRequest): Promise<BuildInfo> {
    const url = `https://cloudbuild.googleapis.com/v1/projects/${this.projectId}/builds`;
    return this.rest.json<BuildInfo>(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(build) });
  }

  async get(id: string): Promise<BuildInfo> {
    return this.rest.json<BuildInfo>(`https://cloudbuild.googleapis.com/v1/projects/${this.projectId}/builds/${id}`);
  }

  async cancel(id: string): Promise<void> {
    await this.rest.request(`https://cloudbuild.googleapis.com/v1/projects/${this.projectId}/builds/${id}:cancel`, { method: 'POST' });
  }

  /** The build's log, from the bucket Cloud Build writes it to (`log-<buildId>.txt`). A running build's log grows. */
  async log(buildId: string, from = 0): Promise<{ text: string; next: number; done: boolean }> {
    const gcs = new GcsClient(this.rest, this.bucket);
    const objects = await gcs.list(`log-${buildId}`);
    const object = objects[0]?.name;
    if (!object) {
      const build = await this.get(buildId).catch(() => null);
      const done = !!build && !['QUEUED', 'WORKING'].includes(build.status);
      return { text: '', next: from, done };
    }
    const text = (await gcs.getText(object, { from })) ?? '';
    const build = await this.get(buildId).catch(() => null);
    const done = !!build && !['QUEUED', 'WORKING'].includes(build.status);
    return { text, next: from + text.length, done };
  }
}

/* ───────────── Cloud Run Admin API ───────────── */

export interface RunTraffic {
  type?: string;
  revision?: string;
  percent?: number;
  tag?: string;
  url?: string;
  latestRevision?: boolean;
}

export interface RunContainer {
  name?: string;
  image?: string;
  env?: { name: string; value: string }[];
}

export interface RunTemplate {
  containers?: RunContainer[];
  labels?: Record<string, string>;
}

export interface RunService {
  name: string;
  uid?: string;
  generation?: string;
  labels?: Record<string, string>;
  template?: RunTemplate;
  traffic?: RunTraffic[];
  trafficStatuses?: RunTraffic[];
  latestReadyRevision?: string;
  latestCreatedRevision?: string;
  /** The public address of the service. The v2 API calls it `uri`; `gcloud` shows it as `status.url`. */
  uri?: string;
  status?: { url?: string; latestReadyRevision?: string; traffic?: RunTraffic[] };
  terminalCondition?: { type: string; state: string; message?: string };
}

export const serviceUrl = (service: Pick<RunService, 'uri' | 'status'>): string => service.uri ?? service.status?.url ?? '';

export const serviceTraffic = (service: Pick<RunService, 'traffic' | 'status'>): RunTraffic[] => service.traffic ?? service.status?.traffic ?? [];

export interface RunRevision {
  name: string;
  labels?: Record<string, string>;
  createTime?: string;
  terminalCondition?: { type: string; state: string; message?: string };
  conditions?: { type: string; state: string; message?: string }[];
}

export interface RunOperation {
  name: string;
  done?: boolean;
  error?: { code: number; message: string };
  response?: unknown;
}

export class CloudRunClient {
  constructor(
    private rest: GoogleRest,
    private projectId: string,
    private region: string,
  ) {}

  private base(): string {
    return `https://run.googleapis.com/v2/projects/${this.projectId}/locations/${this.region}`;
  }

  async getService(name: string): Promise<RunService> {
    return this.rest.json<RunService>(`${this.base()}/services/${name}`);
  }

  async patchService(name: string, service: Partial<RunService>, updateMask: string): Promise<RunOperation> {
    const url = `${this.base()}/services/${name}?updateMask=${encodeURIComponent(updateMask)}&allowMissing=false`;
    return this.rest.json<RunOperation>(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(service) });
  }

  async getRevision(service: string, name: string): Promise<RunRevision> {
    const short = name.split('/').pop() ?? name;
    return this.rest.json<RunRevision>(`${this.base()}/services/${service}/revisions/${short}`);
  }

  async getOperation(name: string): Promise<RunOperation> {
    const url = name.startsWith('projects/') ? `https://run.googleapis.com/v2/${name}` : `${this.base()}/operations/${name}`;
    return this.rest.json<RunOperation>(url);
  }

  /** Waits for a long-running operation, polling politely. */
  async wait(operation: RunOperation, timeoutMs = 300_000): Promise<RunOperation> {
    const started = Date.now();
    let op = operation;
    while (!op.done) {
      if (Date.now() - started > timeoutMs) throw new Error(`the operation ${op.name} did not finish in ${Math.round(timeoutMs / 1000)}s`);
      await new Promise((r) => setTimeout(r, 1500));
      op = await this.getOperation(op.name);
    }
    if (op.error) throw new Error(`Cloud Run refused the change: ${op.error.message}`);
    return op;
  }

  /** The URL a tagged revision can be reached at (`https://<tag>---<host>`). */
  tagUrl(serviceUrl: string, tag: string): string {
    return serviceUrl.replace('https://', `https://${tag}---`);
  }
}

/* ───────────── Container Analysis (vulnerability scans) ───────────── */

export interface VulnerabilityFinding {
  severity: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export class ContainerAnalysisClient {
  constructor(
    private rest: GoogleRest,
    private projectId: string,
  ) {}

  /**
   * The findings for one image digest, read page by page and reduced to their severities as they arrive, so a big scan cannot fill the
   * instance's memory. The scan is started by the Cloud Build scan job; this only reads what it left behind, retrying while the
   * analysis finishes. No occurrences at all is a clean scan, not a failure.
   */
  async findings(imageUrl: string, attempts = 8): Promise<VulnerabilityFinding[]> {
    // Artifact Analysis records the resource as an https address; Cloud Build's image name has no scheme.
    const resource = imageUrl.startsWith('http') ? imageUrl : `https://${imageUrl}`;
    const filter = `kind="VULNERABILITY" AND resourceUrl="${resource}"`;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const severities: VulnerabilityFinding[] = [];
      let pageToken = '';
      let pages = 0;
      try {
        do {
          const url = `https://containeranalysis.googleapis.com/v1/projects/${this.projectId}/occurrences?filter=${encodeURIComponent(filter)}&pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
          const body = await this.rest.json<{ occurrences?: { vulnerability?: { severity?: string } }[]; nextPageToken?: string }>(url);
          for (const occurrence of body.occurrences ?? []) {
            severities.push({ severity: (occurrence.vulnerability?.severity?.toUpperCase() as VulnerabilityFinding['severity']) ?? 'NONE' });
          }
          pageToken = body.nextPageToken ?? '';
          pages += 1;
          // The worst severity is all a gate needs; once something critical is there, more pages cannot change the answer.
          if (severities.some((s) => s.severity === 'CRITICAL') || pages >= 20) break;
        } while (pageToken);
      } catch {
        // A page that fails leaves what was read so far; the retry below tries again.
      }
      if (severities.length || !pageToken) return severities;
      if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, 5000));
    }
    return [];
  }
}

/* ───────────── Firestore (named database, REST) ───────────── */

type FirestoreValue = { stringValue?: string; integerValue?: string; doubleValue?: number; booleanValue?: boolean; nullValue?: null };
export interface FirestoreDocument {
  name: string;
  fields?: Record<string, FirestoreValue>;
}

export class FirestoreClient {
  constructor(
    private rest: GoogleRest,
    private projectId: string,
    private database: string,
  ) {}

  private base(): string {
    return `https://firestore.googleapis.com/v1/projects/${this.projectId}/databases/${this.database}/documents`;
  }

  private toFields(data: unknown): Record<string, FirestoreValue> {
    // The pipeline's records are small JSON: one string field, so nothing has to be mapped by hand and nothing is lost.
    return { data: { stringValue: JSON.stringify(data) }, updatedAt: { integerValue: String(Date.now()) } };
  }

  private fromFields(doc: FirestoreDocument): unknown | null {
    const raw = doc.fields?.data?.stringValue;
    if (typeof raw !== 'string') return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async get<T>(path: string): Promise<T | null> {
    try {
      const doc = await this.rest.json<FirestoreDocument>(`${this.base()}/${path}`);
      return this.fromFields(doc) as T | null;
    } catch (e) {
      if (e instanceof GoogleApiError && e.status === 404) return null;
      throw e;
    }
  }

  async set(path: string, data: unknown): Promise<void> {
    const url = `${this.base()}/${path}`;
    const body = { fields: this.toFields(data) };
    await this.rest.json(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  async delete(path: string): Promise<void> {
    try {
      await this.rest.request(`${this.base()}/${path}`, { method: 'DELETE' });
    } catch (e) {
      if (!(e instanceof GoogleApiError && e.status === 404)) throw e;
    }
  }

  /** All documents of a collection. The demo's state is small; the caller filters in memory. */
  async list<T>(collection: string): Promise<{ id: string; value: T }[]> {
    const out: { id: string; value: T }[] = [];
    let pageToken = '';
    do {
      const url = `${this.base()}/${collection}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const body = await this.rest.json<{ documents?: FirestoreDocument[]; nextPageToken?: string }>(url);
      for (const doc of body.documents ?? []) {
        const value = this.fromFields(doc);
        if (value !== null) out.push({ id: doc.name.split('/').pop() ?? '', value: value as T });
      }
      pageToken = body.nextPageToken ?? '';
    } while (pageToken);
    return out;
  }

  async clear(collection: string): Promise<void> {
    for (const { id } of await this.list(collection)) await this.delete(`${collection}/${id}`);
  }
}
