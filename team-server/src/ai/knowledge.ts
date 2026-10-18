import type { Issue } from '../shared/board/types.ts';
import type { Page } from '../shared/pages/types.ts';
import type { IndexItem } from '../shared/ai/types.ts';
import { log } from '../log.ts';
import type { IdTokenSource } from './client.ts';

/** A ticket as the agent reads it: the words, plus where it stands, so "what is in review?" can be answered from it. */
export function ticketItem(i: Issue, people: ReadonlyMap<string, string>): IndexItem {
  const state = i.status.replace('_', ' ');
  const who = i.assignee ? (people.get(i.assignee) ?? 'someone') : 'nobody yet';
  const lines = [
    `Ticket #${i.key}: ${i.title}`,
    `Status: ${state}. Priority: ${i.priority}. Assigned to: ${who}. Points: ${i.points || 'not estimated'}.`,
    ...(i.labels.length ? [`Labels: ${i.labels.join(', ')}.`] : []),
    ...(i.pr ? [`Pull request: ${i.pr}`] : []),
    '',
    i.body,
  ];
  return { kind: 'ticket', id: String(i.key), title: `#${i.key} ${i.title}`, body: lines.join('\n'), updatedAt: i.updatedAt };
}

export const pageItem = (p: Page): IndexItem => ({ kind: 'doc', id: p.id, title: p.title, body: p.body, updatedAt: p.updatedAt });

export interface KnowledgeSource {
  issue(id: string): Promise<Issue | null>;
  page(id: string): Promise<Page | null>;
  people(): Promise<Map<string, string>>;
}

export interface KnowledgeSinkOptions {
  base: string;
  auth: 'google' | 'none';
  tokens: IdTokenSource;
  source: KnowledgeSource;
  fetchFn?: typeof fetch;
  /** Waits (ms) between attempts; tests shorten them. */
  backoff?: number[];
}

/**
 * Keeps the agent service's knowledge index current: every change to a ticket or a page is sent after a short pause (several edits of
 * one page are one send). It never blocks or fails the change that caused it; a send that keeps failing is logged and the nightly
 * reset's full reindex puts things right.
 */
export class KnowledgeSink {
  private pending = new Map<string, 'board' | 'pages'>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private fetchFn: typeof fetch;
  private backoff: number[];
  /** How many sends are in flight, for tests and for `flush`. */
  private inflight = new Set<Promise<void>>();

  constructor(private o: KnowledgeSinkOptions) {
    this.fetchFn = o.fetchFn ?? fetch;
    this.backoff = o.backoff ?? [500, 2000, 8000];
  }

  /** Called after a change: `ids` of tickets (`board`) or pages (`pages`). */
  schedule(kind: 'board' | 'pages', ids: string[]) {
    for (const id of ids) this.pending.set(`${kind}\n${id}`, kind);
    this.timer ??= setTimeout(() => {
      this.timer = null;
      const batch = [...this.pending.keys()];
      this.pending.clear();
      this.track(this.sendBatch(batch));
    }, 300);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Everything sent so far has been tried (tests wait on this). */
  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      const batch = [...this.pending.keys()];
      this.pending.clear();
      this.track(this.sendBatch(batch));
    }
    await Promise.allSettled([...this.inflight]);
  }

  private track(p: Promise<void>) {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  private async sendBatch(keys: string[]) {
    const people = await this.o.source.people().catch(() => new Map<string, string>());
    for (const key of keys) {
      const [kind, id] = key.split('\n');
      try {
        const item = await this.load(kind as 'board' | 'pages', id, people);
        await this.post('/v1/index', item);
      } catch (e) {
        log.warn('indexing a change failed', { kind, id, err: String(e) });
      }
    }
  }

  private async load(kind: 'board' | 'pages', id: string, people: Map<string, string>): Promise<IndexItem> {
    if (kind === 'pages') {
      const page = await this.o.source.page(id);
      return page ? pageItem(page) : { kind: 'doc', id, title: '', body: '', updatedAt: Date.now(), deleted: true };
    }
    const issue = await this.o.source.issue(id);
    return issue ? ticketItem(issue, people) : { kind: 'ticket', id, title: '', body: '', updatedAt: Date.now(), deleted: true };
  }

  /** Replaces the whole index (after a reset or a seed). Returns how many items the service says it indexed. */
  async reindex(items: IndexItem[]): Promise<number> {
    const res = await this.post('/v1/reindex', { items, replaceAll: true });
    const n = (res as { indexed?: unknown } | null)?.indexed;
    return typeof n === 'number' ? n : items.length;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    let last: unknown;
    for (let attempt = 0; attempt <= this.backoff.length; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, this.backoff[attempt - 1]));
      try {
        const res = await this.fetchFn(`${this.o.base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(this.o.auth === 'google' ? { authorization: `Bearer ${await this.o.tokens.get(this.o.base)}` } : {}) },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
        if (res.ok) return await res.json().catch(() => null);
        last = new Error(`status ${res.status}`);
        // A request the service refuses as wrong will not get better by being sent again.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
      } catch (e) {
        last = e;
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }
}
