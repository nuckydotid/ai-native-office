import { parseRunEvent } from '../shared/ai/protocol.ts';
import type { RunEvent, RunRequest } from '../shared/ai/types.ts';
import { log } from '../log.ts';

/** How the server asks the agent service to think. Events are handed over one by one; the promise ends with the stream. */
export interface AgentClient {
  run(req: RunRequest, on: (ev: RunEvent) => void, signal: AbortSignal): Promise<void>;
}

/** One event of a `text/event-stream`, as raw text. */
export interface SseBlock {
  event: string;
  data: string;
}

const MAX_STREAM_BYTES = 2 * 1024 * 1024;

/** Reads a `text/event-stream` body: blocks end at a blank line, `:` lines are comments (keep-alives), several `data:` lines join with newlines. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseBlock> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_STREAM_BYTES) throw new Error('the agent service sent too much');
      // A `\r` at the very end may be the first half of a `\r\n` split across two chunks: it waits for the next one.
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n').replace(/\r(?!$)/g, '\n');
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const block = parseBlock(raw);
        if (block) yield block;
      }
    }
    const tail = parseBlock(buffer.replace(/\r\n?/g, '\n'));
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function parseBlock(raw: string): SseBlock | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length ? { event, data: data.join('\n') } : null;
}

/** Google ID tokens for calling another Cloud Run service, from the metadata server (no key file, no library). Cached until near expiry. */
export class IdTokenSource {
  private cache = new Map<string, { token: string; exp: number }>();

  constructor(private fetchFn: typeof fetch = fetch) {}

  async get(audience: string): Promise<string> {
    const hit = this.cache.get(audience);
    if (hit && hit.exp - Date.now() > 5 * 60_000) return hit.token;
    const url = `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}&format=full`;
    const res = await this.fetchFn(url, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`the metadata server refused an ID token (${res.status})`);
    const token = (await res.text()).trim();
    let exp = Date.now() + 30 * 60_000;
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: number };
      if (typeof payload.exp === 'number') exp = payload.exp * 1000;
    } catch {
      // Keep the default: a token of an unknown age is used for half an hour at most.
    }
    this.cache.set(audience, { token, exp });
    return token;
  }
}

export interface HttpAgentClientOptions {
  base: string;
  auth: 'google' | 'none';
  fetchFn?: typeof fetch;
  tokens?: IdTokenSource;
  /** The longest a run may take before the server gives up (the agent service has its own, shorter limit). */
  timeoutMs?: number;
}

/** The real thing: `POST {agent-service}/v1/run`, answered as a stream of events. */
export class HttpAgentClient implements AgentClient {
  private fetchFn: typeof fetch;
  private tokens: IdTokenSource;
  constructor(private opts: HttpAgentClientOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.tokens = opts.tokens ?? new IdTokenSource(this.fetchFn);
  }

  /** The headers that prove who is calling (an ID token for the agent service's own address). */
  async headers(): Promise<Record<string, string>> {
    return this.opts.auth === 'google' ? { authorization: `Bearer ${await this.tokens.get(this.opts.base)}` } : {};
  }

  async run(req: RunRequest, on: (ev: RunEvent) => void, signal: AbortSignal): Promise<void> {
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(this.opts.timeoutMs ?? 5 * 60_000)]);
    let res: Response;
    try {
      res = await this.fetchFn(`${this.opts.base}/v1/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(await this.headers()) },
        body: JSON.stringify(req),
        signal: timeout,
      });
    } catch (e) {
      if (signal.aborted) throw e;
      log.warn('the agent service could not be reached', { err: String(e) });
      return on({ event: 'error', data: { code: 'model_unavailable', message: 'The AI service could not be reached.' } });
    }
    if (!res.ok || !res.body) {
      log.warn('the agent service refused a run', { status: res.status });
      const code = res.status === 429 ? 'budget' : res.status === 400 || res.status === 422 ? 'invalid' : res.status >= 500 ? 'model_unavailable' : 'internal';
      return on({ event: 'error', data: { code, message: `The AI service answered ${res.status}.` } });
    }
    let ended = false;
    try {
      for await (const block of readSse(res.body)) {
        const ev = parseRunEvent(block.event, block.data);
        if (!ev) continue;
        on(ev);
        if (ev.event === 'final' || ev.event === 'error') {
          ended = true;
          break;
        }
      }
    } catch (e) {
      if (signal.aborted) throw e;
      log.warn('the agent service stream failed', { err: String(e) });
      if (!ended) return on({ event: 'error', data: { code: 'model_unavailable', message: 'The AI service stopped answering.' } });
    }
    if (!ended) on({ event: 'error', data: { code: 'internal', message: 'The AI service ended without an answer.' } });
  }
}

/** For a demo with no agent service behind it (local, or not deployed yet): every run says so, plainly. */
export class OfflineAgentClient implements AgentClient {
  async run(_req: RunRequest, on: (ev: RunEvent) => void): Promise<void> {
    on({ event: 'error', data: { code: 'model_unavailable', message: 'The AI service is not connected to this server.' } });
  }
}
