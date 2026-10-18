import { log } from '../log.ts';
import type { IdTokenSource } from '../ai/client.ts';
import { PipelineRefusal } from './driver.ts';
import type { JobLog, JobRequest, PipelineDriver, PipelineStatus, RepoFile, RolloutRequest } from './driver.ts';
import type { Job, Rollout } from '../shared/pipeline/types.ts';

export interface HttpPipelineDriverOptions {
  /** The private pipeline service's address. */
  base: string;
  auth: 'google' | 'none';
  tokens?: IdTokenSource;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/**
 * The web service's client for `studio-pipeline`: a small REST caller with an ID token for the service's own address. The service owns
 * jobs and rollouts; this only asks and reports, and every refusal it sends back arrives as a `PipelineRefusal` with a sentence.
 */
export class HttpPipelineDriver implements PipelineDriver {
  readonly kind = 'http' as const;
  private fetchFn: typeof fetch;
  private tokens: IdTokenSource;

  constructor(private opts: HttpPipelineDriverOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    // A driver with auth `google` is always built with a token source; the cast keeps the import from being a runtime cycle.
    this.tokens = opts.tokens ?? (undefined as unknown as IdTokenSource);
  }

  private async headers(): Promise<Record<string, string>> {
    const base: Record<string, string> = { 'content-type': 'application/json' };
    if (this.opts.auth === 'google') base.authorization = `Bearer ${await this.tokens.get(this.opts.base)}`;
    return base;
  }

  private async request<T>(method: string, path: string, body?: unknown, notFoundAsNull = false, timeoutMs = this.opts.timeoutMs ?? 60_000): Promise<T | null> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.opts.base}${path}`, {
        method,
        headers: await this.headers(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      log.warn('the pipeline service could not be reached', { err: String(e) });
      throw new PipelineRefusal('unavailable', 'The pipeline service could not be reached just now. Try again in a moment.', 503);
    }
    if (res.status === 404 && notFoundAsNull) return null;
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
      const code = (payload?.error ?? 'unavailable') as ConstructorParameters<typeof PipelineRefusal>[0];
      const status = (res.status >= 400 && res.status <= 599 ? res.status : 503) as ConstructorParameters<typeof PipelineRefusal>[2];
      throw new PipelineRefusal(code, payload?.message ?? `The pipeline service answered ${res.status}.`, status);
    }
    if (res.status === 204) return null;
    return (await res.json()) as T;
  }

  async repo() {
    return (await this.request<{ rev: string; files: RepoFile[] }>('GET', '/v1/repo'))!;
  }

  async readFile(path: string) {
    const answer = await this.request<{ path: string; content: string }>('GET', `/v1/repo/file?path=${encodeURIComponent(path)}`, undefined, true);
    return answer ? answer.content : null;
  }

  async startJob(req: JobRequest) {
    return (await this.request<{ job: Job }>('POST', '/v1/jobs', req))!.job;
  }

  async getJob(id: string) {
    const answer = await this.request<{ job: Job }>('GET', `/v1/jobs/${encodeURIComponent(id)}`, undefined, true);
    return answer ? answer.job : null;
  }

  async listJobs(ticket?: string) {
    return (await this.request<{ jobs: Job[] }>('GET', `/v1/jobs${ticket ? `?ticket=${encodeURIComponent(ticket)}` : ''}`))!.jobs;
  }

  async jobLog(id: string, from: number) {
    return this.request<JobLog>('GET', `/v1/jobs/${encodeURIComponent(id)}/log?from=${from}`, undefined, true);
  }

  async cancelJob(id: string) {
    const answer = await this.request<{ job: Job }>('POST', `/v1/jobs/${encodeURIComponent(id)}/cancel`, {}, true);
    return answer ? answer.job : null;
  }

  async startRollout(req: RolloutRequest) {
    // A staging rollout deploys a revision, waits for it to be ready and runs the smoke suite: give it room.
    return (await this.request<{ rollout: Rollout }>('POST', '/v1/rollouts', req, false, 240_000))!.rollout;
  }

  async stepRollout(id: string, by: { id: string; name: string }) {
    return (await this.request<{ rollout: Rollout }>('POST', `/v1/rollouts/${encodeURIComponent(id)}/step`, { by }))!.rollout;
  }

  async rollback(id: string, by: { id: string; name: string }) {
    return (await this.request<{ rollout: Rollout }>('POST', `/v1/rollouts/${encodeURIComponent(id)}/rollback`, { by }))!.rollout;
  }

  async getRollout(id: string) {
    const answer = await this.request<{ rollout: Rollout }>('GET', `/v1/rollouts/${encodeURIComponent(id)}`, undefined, true);
    return answer ? answer.rollout : null;
  }

  async listRollouts(ticket?: string) {
    return (await this.request<{ rollouts: Rollout[] }>('GET', `/v1/rollouts${ticket ? `?ticket=${encodeURIComponent(ticket)}` : ''}`))!.rollouts;
  }

  async status(uid: string): Promise<PipelineStatus> {
    return (await this.request<PipelineStatus>('GET', `/v1/status?uid=${encodeURIComponent(uid)}`))!;
  }

  async reset() {
    await this.request('POST', '/v1/reset', {});
  }
}
