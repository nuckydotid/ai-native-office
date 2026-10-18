import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '../../shared/workspace/protocol.ts';
import type { Appearance } from '../../shared/workspace/types.ts';
import { Emitter, type ConnStatus, type RoomConnection } from './room.ts';

/** The part of the browser's WebSocket this uses, so tests can stand in for it. */
export interface SocketLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface RemoteRoomOptions {
  /** `ws://…/ws` or `wss://…/ws` */
  url: string;
  /** Who is joining. Called again on every reconnect. */
  hello: () => { token?: string; name: string; look: Appearance; github?: string };
  /**
   * A fresh sign-in token for the team server. Awaited before each connection is opened, so the token is never older than the
   * attempt. Rejects with one of the codes in `CREDENTIAL_PROBLEMS` (or a sentence), which decide whether to try again.
   */
  credential?: () => Promise<string>;
  socket?: (url: string) => SocketLike;
  /** Runs `fn` once after `ms`; returns a way to cancel it. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** The wall clock, in milliseconds (the ping carries it, so the server's answer says how long the trip took). */
  now?: () => number;
  /** A clock that only moves forward, for judging how long something has taken. Defaults to `performance.now`. */
  monotonic?: () => number;
  /** 0..1, for spreading out reconnects. */
  random?: () => number;
}

const OPEN = 1;
const PING_EVERY_MS = 15_000;
/** The server answers a ping at once: one that is still unanswered after this long means the connection is dead. */
const PONG_WAIT_MS = 10_000;
/** From the socket opening to the welcome. The server checks the sign-in in between, which can stall. */
const HANDSHAKE_MS = 20_000;
const MAX_BACKOFF_MS = 15_000;
/** The server closes with these when it will not take the person back by itself: signed in elsewhere, refused, or too old. */
const FATAL = new Set([4001, 4002, 4003]);

/**
 * What a failed credential means. `retry` ones are tried again with the usual delay; the others are final until the person acts
 * (connecting to the team, answering the Keychain, updating), and say so in plain words.
 */
export const CREDENTIAL_PROBLEMS: Record<string, { retry: boolean; message: string }> = {
  offline: { retry: true, message: 'You’re offline. The office will rejoin when you’re back online.' },
  // The guest sign-in (`src/web.ts`).
  demo_unreachable: { retry: true, message: 'Couldn’t reach the demo server. Trying again in a moment.' },
  demo_refused: { retry: true, message: 'The demo couldn’t let you in just now. Trying again in a moment.' },
};

const defaultSchedule = (fn: () => void, ms: number) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

const defaultMonotonic = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** The real office: a WebSocket to the project's team server, speaking the protocol in `shared/workspace/protocol.ts`. */
export class RemoteRoom implements RoomConnection {
  readonly kind = 'remote' as const;
  private messages = new Emitter<ServerMsg>();
  private statuses = new Emitter<ConnStatus>();
  private ws: SocketLike | null = null;
  /** The server has accepted the person (sent its welcome) on the current socket. Until then it ignores everything but the hello. */
  private joined = false;
  private wanted = false;
  private attempt = 0;
  /** Goes up on every connect and on close, so a sign-in token that arrives after the room moved on is thrown away. */
  private generation = 0;
  private credentialInFlight: Promise<string> | null = null;
  private lastError = '';
  private lastCode = '';
  private latency: number | undefined;
  /** When the ping that has no answer yet was sent (on the monotonic clock). Any frame from the server clears it. */
  private pingSentAt: number | null = null;
  private cancelRetry: (() => void) | null = null;
  private cancelPing: (() => void) | null = null;
  private cancelHandshake: (() => void) | null = null;
  private readonly schedule: NonNullable<RemoteRoomOptions['schedule']>;
  private readonly now: () => number;
  private readonly monotonic: () => number;
  private readonly random: () => number;

  constructor(private opts: RemoteRoomOptions) {
    this.schedule = opts.schedule ?? defaultSchedule;
    this.now = opts.now ?? Date.now;
    this.monotonic = opts.monotonic ?? opts.now ?? defaultMonotonic;
    this.random = opts.random ?? Math.random;
  }

  onMessage(listener: (msg: ServerMsg) => void) {
    return this.messages.on(listener);
  }

  onStatus(listener: (status: ConnStatus) => void) {
    return this.statuses.on(listener);
  }

  /** Starts (or, after a final failure, starts again). */
  open() {
    this.wanted = true;
    this.attempt = 0;
    this.cancelRetry?.();
    this.cancelRetry = null;
    void this.connect();
  }

  close() {
    this.wanted = false;
    this.generation += 1;
    this.cancelRetry?.();
    this.cancelPing?.();
    this.cancelHandshake?.();
    this.cancelRetry = this.cancelPing = this.cancelHandshake = null;
    this.joined = false;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      ws.close(1000, 'leaving');
    }
    this.statuses.emit({ state: 'closed' });
  }

  /** True when the message went to a connection the server has accepted. (It can't tell that the server got it: see the pings.) */
  send(msg: ClientMsg): boolean {
    if (!this.ws || this.ws.readyState !== OPEN || !this.joined) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** One shared request for a token, so a reconnect that starts while one is being fetched waits for it instead of asking again. */
  private credential(): Promise<string> {
    const fetch = this.opts.credential;
    if (!fetch) return Promise.reject(new Error('no credential'));
    this.credentialInFlight ??= fetch().finally(() => {
      this.credentialInFlight = null;
    });
    return this.credentialInFlight;
  }

  private async connect() {
    this.cancelRetry = null;
    this.lastError = '';
    this.lastCode = '';
    const generation = ++this.generation;
    this.statuses.emit({ state: this.attempt === 0 ? 'connecting' : 'reconnecting' });

    let token: string | undefined;
    if (this.opts.credential) {
      try {
        token = await this.credential();
      } catch (e) {
        // Closed, or connected again, while the token was being fetched: this attempt is over.
        if (generation !== this.generation || !this.wanted) return;
        return this.credentialFailed(e);
      }
      if (generation !== this.generation || !this.wanted) return;
    }

    let ws: SocketLike;
    try {
      ws = (this.opts.socket ?? ((url) => new WebSocket(url) as unknown as SocketLike))(this.opts.url);
    } catch {
      this.statuses.emit({ state: 'failed', message: 'The team server address doesn’t look right.' });
      return;
    }
    this.ws = ws;
    this.joined = false;
    this.pingSentAt = null;
    ws.onopen = () => {
      const h = this.opts.hello();
      // The server answers a hello that takes the sign-in checks too long to answer with silence, so this waits for it only so long.
      this.cancelHandshake?.();
      this.cancelHandshake = this.schedule(() => {
        this.cancelHandshake = null;
        if (this.ws === ws && !this.joined) this.replaceQuietSocket();
      }, HANDSHAKE_MS);
      ws.send(JSON.stringify({ t: 'hello', workspaceId: 'main', token: token ?? h.token ?? '', name: h.name, look: h.look, github: h.github, protocol: PROTOCOL_VERSION }));
    };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMsg;
      } catch {
        return;
      }
      // Anything from the server shows the connection is alive.
      this.pingSentAt = null;
      if (msg.t === 'welcome') {
        this.attempt = 0;
        this.joined = true;
        this.cancelHandshake?.();
        this.cancelHandshake = null;
        this.statuses.emit({ state: 'online', latencyMs: this.latency });
        this.pingSoon();
      } else if (msg.t === 'error' && !msg.cid && !msg.reqId) {
        // An error about one request (a message that wasn't saved) is not why the connection ends; the others are.
        this.lastError = msg.message;
        this.lastCode = msg.code;
      } else if (msg.t === 'pong') {
        this.latency = Math.max(0, this.now() - msg.at);
        this.statuses.emit({ state: 'online', latencyMs: this.latency });
      }
      this.messages.emit(msg);
    };
    ws.onerror = () => {
      // The close that follows says what to do; an error alone carries nothing the person could act on.
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.joined = false;
      this.cancelPing?.();
      this.cancelHandshake?.();
      this.cancelPing = this.cancelHandshake = null;
      if (!this.wanted) return;
      if (FATAL.has(ev.code)) {
        this.wanted = false;
        const fallback = ev.code === 4001 ? 'You joined from another window.' : ev.code === 4002 ? 'This team server needs a newer Worktrees Studio. Update the app to join.' : 'The team server wouldn’t let you in.';
        this.statuses.emit({ state: 'failed', message: this.lastError || fallback, code: this.lastCode || (ev.code === 4002 ? 'update_required' : undefined) });
        return;
      }
      this.scheduleReconnect();
    };
  }

  /** Getting the token failed. Some of that is worth another try in a moment; the rest is for the person to fix. */
  private credentialFailed(e: unknown) {
    const code = e instanceof Error ? e.message : String(e);
    const problem = CREDENTIAL_PROBLEMS[code];
    if (problem?.retry) {
      this.lastError = problem.message;
      this.scheduleReconnect();
      return;
    }
    this.wanted = false;
    // A code gets its plain sentence; anything else is the text the failure carried for the person.
    this.statuses.emit({ state: 'failed', message: problem?.message ?? (code || 'Couldn’t sign in to the team server.'), code: problem ? code : 'credential' });
  }

  private scheduleReconnect() {
    // Spread out, so a server restart doesn't bring every window back in the same second.
    const delay = Math.round(Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempt) * (0.5 + 0.5 * this.random()));
    this.attempt += 1;
    this.statuses.emit({ state: 'reconnecting', message: this.lastError || undefined });
    this.cancelRetry = this.schedule(() => void this.connect(), delay);
  }

  private pingSoon() {
    this.cancelPing?.();
    this.cancelPing = this.schedule(() => {
      // Sending into a connection that has silently died looks like it worked. A ping the server hasn't answered after a while
      // means the connection is replaced, and what the app was waiting on (runs, unsent answers) is taken up again on the new one.
      // (Judged by the ping, not by the time since the last word: a timer that fires late says nothing about the server.)
      if (this.pingSentAt !== null && this.monotonic() - this.pingSentAt > PONG_WAIT_MS) return this.replaceQuietSocket();
      if (this.pingSentAt === null) this.pingSentAt = this.monotonic();
      this.send({ t: 'ping', at: this.now() });
      this.pingSoon();
    }, PING_EVERY_MS);
  }

  private replaceQuietSocket() {
    const ws = this.ws;
    this.cancelPing = null;
    this.cancelHandshake?.();
    this.cancelHandshake = null;
    if (!ws || !this.wanted) return;
    this.ws = null;
    this.joined = false;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close(4000, 'no answer');
    } catch {
      // Already gone.
    }
    this.scheduleReconnect();
  }
}
