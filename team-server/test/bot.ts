import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { lookFromSeed } from '../src/shared/workspace/looks.ts';
import type { AgentRef, ClientMsg, ServerMsg, WelcomeMsg } from '../src/shared/workspace/protocol.ts';
import type { ChatMessage, WorkspaceRole } from '../src/shared/workspace/types.ts';
import { loadConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { createTeamServer } from '../src/server.ts';
import type { ServerDeps, TeamServer } from '../src/server.ts';
import { MemoryStore } from '../src/store.ts';
import { PROTOCOL_VERSION } from '../src/shared/workspace/protocol.ts';

/** A WebSocket client that records everything the server says. */
export class Bot {
  ws!: WebSocket;
  inbox: ServerMsg[] = [];
  closed: { code: number } | null = null;
  welcome!: WelcomeMsg;
  private waiters: { pred: (m: ServerMsg) => boolean; res: (m: ServerMsg) => void }[] = [];

  constructor(
    readonly uid: string,
    private url: string,
    /** The role in the dev token: `dev:<uid>@<role>:<name>`. */
    private role: WorkspaceRole = 'member',
    /** The name in the dev token (and so the verified display name). */
    private name = uid,
  ) {}

  async connect(opts: { token?: string; expectWelcome?: boolean; protocol?: number | null } = {}) {
    this.ws = new WebSocket(this.url);
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as ServerMsg;
      this.inbox.push(m);
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(m)) {
          w.res(m);
          return false;
        }
        return true;
      });
    });
    this.ws.on('close', (code) => {
      this.closed = { code };
    });
    await new Promise<void>((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
    const protocol = opts.protocol === null ? undefined : (opts.protocol ?? PROTOCOL_VERSION);
    this.send({ t: 'hello', token: opts.token ?? `dev:${this.uid}@${this.role}:${this.name}`, workspaceId: 'main', name: this.name, look: lookFromSeed(this.uid), protocol });
    if (opts.expectWelcome !== false) this.welcome = (await this.waitFor((m) => m.t === 'welcome')) as WelcomeMsg;
    return this;
  }

  send(m: ClientMsg) {
    this.ws.send(JSON.stringify(m));
  }

  /** The first message (already received, or yet to come) that matches. */
  waitFor<T extends ServerMsg = ServerMsg>(pred: (m: ServerMsg) => boolean, ms = 2000): Promise<T> {
    const hit = this.inbox.find(pred);
    if (hit) return Promise.resolve(hit as T);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout waiting for message')), ms);
      this.waiters.push({
        pred,
        res: (m) => {
          clearTimeout(t);
          res(m as T);
        },
      });
    });
  }

  /** The next matching message that arrives after this call (ignores what is already in the inbox). */
  next<T extends ServerMsg = ServerMsg>(pred: (m: ServerMsg) => boolean, ms = 2000): Promise<T> {
    const seen = this.inbox.length;
    const later = (m: ServerMsg) => pred(m) && this.inbox.indexOf(m) >= seen;
    return this.waitFor<T>(later, ms);
  }

  /** Assert that no message matching pred arrives within ms. */
  async expectNone(pred: (m: ServerMsg) => boolean, ms = 250) {
    await new Promise((r) => setTimeout(r, ms));
    assert.equal(this.inbox.filter(pred).length, 0, 'unexpected message received');
  }

  /** Says something in the Room and resolves to the saved message (the sender's own copy). */
  async say(text: string, cid = `c${Math.random().toString(36).slice(2, 8)}`): Promise<ChatMessage> {
    this.send({ t: 'chat', text, cid });
    const echo = await this.waitFor<Extract<ServerMsg, { t: 'chat' }>>((m) => m.t === 'chat' && m.msg.cid === cid);
    return echo.msg;
  }

  close() {
    this.ws.close();
  }
}

export const agentRef = (handle: string, name = handle[0].toUpperCase() + handle.slice(1)): AgentRef => ({ handle, name, role: 'Helper', look: lookFromSeed(handle) });

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A server with development sign-in and an in-memory store, listening on a free port. */
export async function startDevServer(over: Partial<Config> = {}, deps: Partial<ServerDeps> = {}): Promise<{ server: TeamServer; store: MemoryStore; url: string; base: string }> {
  const store = (deps.store as MemoryStore | undefined) ?? new MemoryStore();
  const cfg = { ...loadConfig(), devAuth: true, store: 'memory' as const, projectName: 'Garden', allowedOrigins: ['*'], ...over };
  const server = createTeamServer({ cfg, store, ...deps });
  const port = await server.listen(0);
  return { server, store, url: `ws://127.0.0.1:${port}/ws`, base: `http://127.0.0.1:${port}` };
}
