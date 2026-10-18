import { Hono } from 'hono';
import type { Server, ServerWebSocket } from 'bun';
import { LIMITS, PROTOCOL_VERSION, parseClientMsg, rawRefs, sanitizeText } from './shared/workspace/protocol.ts';
import type { ServerMsg } from './shared/workspace/protocol.ts';
import { AuthzError, createAuthenticator, createGuestAuthenticator, isTokenProblem } from './auth.ts';
import type { Authenticator, GuestAuthenticator } from './auth.ts';
import { createAiServices } from './ai/services.ts';
import type { AiServices } from './ai/services.ts';
import { createInternalVerifier, registerInternalRoutes } from './ai/internal.ts';
import type { InternalVerifier } from './ai/internal.ts';
import { Demo } from './demo/demo.ts';
import { registerDemoRoutes } from './demo/routes.ts';
import type { SeedData } from './demo/seed.ts';
import { createWebApp } from './demo/static.ts';
import { Collab } from './collab.ts';
import { registerCollabRoutes } from './collab-routes.ts';
import { createPipelineDriver } from './pipeline/index.ts';
import type { PipelineDriver } from './pipeline/driver.ts';
import { registerPipelineRoutes } from './pipeline/routes.ts';
import { Pipeline } from './pipeline/service.ts';
import { createCollabStore } from './collab-store.ts';
import type { CollabStore } from './collab-store.ts';
import { loadConfig } from './config.ts';
import type { Config } from './config.ts';
import { originAllowed } from './http.ts';
import type { Env, Limit } from './http.ts';
import { log } from './log.ts';
import { Office } from './office.ts';
import { KeyedBuckets, PerKey, TokenBucket, ipKey } from './ratelimit.ts';
import type { Client, Room } from './room.ts';
import { OFFICE_ID, createStore } from './store.ts';
import type { Store } from './store.ts';
import { isLive } from './shared/workspace/threads.ts';

export interface ServerDeps {
  cfg?: Config;
  store?: Store;
  auth?: Authenticator;
  /** Observation point for tests: the board and docs store (defaults to one that fits `store`). */
  collabStore?: CollabStore;
  /** Budgets for the `/board` and `/pages` routes (tests loosen them). */
  collabLimits?: { ip?: Limit; writes?: Limit };
  /** Hands out guest tokens (the hosted demo). Defaults to one made from the config when `DEMO_MODE` is on and `auth` is not given. */
  guest?: GuestAuthenticator | null;
  /** Agents that run on the server. Defaults to the real ones when `DEMO_MODE` is on or `AGENT_SERVICE_URL` is set; `null` for none. */
  ai?: AiServices | null;
  /** How the server reaches the agent service (tests pass a fake), and the `fetch` it and the knowledge index use. */
  agentClient?: import('./ai/client.ts').AgentClient;
  agentFetch?: typeof fetch;
  /** Who may call `/internal/v1/*` (tests pass their own). */
  internalVerifier?: InternalVerifier;
  /** The demo workspace to seed, instead of reading `DEMO_DATA_DIR` (tests). */
  seed?: SeedData;
  /** The delivery pipeline: `null` for none, or one with a driver of the test's own. Defaults from `PIPELINE_ENABLED`. */
  pipeline?: Pipeline | null;
  pipelineDriver?: PipelineDriver;
  /** Budgets for the pipeline routes (tests loosen them). */
  pipelineLimits?: { ip?: Limit; writes?: Limit };
}

export interface TeamServer {
  app: Hono<Env>;
  office: Office;
  cfg: Config;
  /** Starts listening (port 0 = any free port) and resolves to the port. */
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
}

const HELLO_TIMEOUT_MS = 10_000;
const OFFICE_FRAME_MAX = 256 * 1024;
/** Answers that never need a sign-in, and may be read from any page. */
const PUBLIC_PATHS = new Set(['/', '/health', '/healthz', '/config']);
/** WebSocket close codes: the app does not reconnect after these (it says why instead). */
const CLOSE_AUTH = 4003;
const CLOSE_UPDATE = 4002;

/** Per-socket state, kept on `ws.data`. */
interface SocketData {
  inbound: TokenBucket;
  helloTimer?: ReturnType<typeof setTimeout>;
  client?: Client;
  room?: Room;
  /** Set once `hello` has been accepted for processing, so a second hello cannot start another sign-in. */
  helloSeen?: boolean;
}
type Sock = ServerWebSocket<SocketData>;

export function createTeamServer(deps: ServerDeps = {}): TeamServer {
  const cfg = deps.cfg ?? loadConfig();
  // Development sign-in accepts any name from anyone: it must never be switched on where the server is public (Cloud Run sets K_SERVICE).
  if (cfg.devAuth && process.env.K_SERVICE) throw new Error('TEAM_DEV_AUTH is on, but this looks like Cloud Run. Refusing to start.');
  const store = deps.store ?? createStore(cfg);
  const guest = deps.guest !== undefined ? deps.guest : deps.auth ? null : createGuestAuthenticator(cfg);
  const auth = deps.auth ?? createAuthenticator(cfg, guest);
  const office = new Office(store, cfg);
  // The board and the docs share the office store's connection when there is a database behind it.
  const collabStore = deps.collabStore ?? createCollabStore(store);
  const collab = new Collab(collabStore);
  // Agents that run here (Gemini through the agent service) rather than on a person's computer: on in the hosted demo, or when an
  // agent service is configured. Its internal door is only for that service, so it needs a way to prove who is calling.
  const ai = deps.ai !== undefined ? deps.ai : cfg.demo || cfg.agentServiceUrl ? createAiServices({ cfg, collab, store, collabStore, client: deps.agentClient, fetchFn: deps.agentFetch }) : null;
  if (ai && cfg.agentServiceAuth === 'none' && process.env.K_SERVICE) throw new Error('AGENT_SERVICE_AUTH=none is for local development only. Refusing to start on Cloud Run.');
  office.ai = ai;
  // The delivery pipeline: artifacts, gates, jobs and rollouts. A pipeline ticket's stage decides its status.
  const pipeline = deps.pipeline !== undefined ? deps.pipeline : cfg.pipelineEnabled ? new Pipeline(collab, collabStore, deps.pipelineDriver ?? createPipelineDriver(cfg)) : null;
  collab.pipelineTickets = pipeline !== null;
  office.pipeline = pipeline;
  if (pipeline) pipeline.onChange = (ids) => office.current()?.broadcastSync('pipeline', ids);
  const demo = cfg.demo ? new Demo({ store, collabStore, office, ai, pipeline, dataDir: cfg.demoDataDir || undefined, seed: deps.seed }) : null;
  const web = cfg.webDir ? createWebApp(cfg.webDir) : null;
  // Whoever is in the office is told when the board or the docs change, so their pages read them again (no polling), and the
  // agents' knowledge is kept current.
  collab.onChange = (kind, ids) => {
    office.current()?.broadcastSync(kind, ids);
    ai?.knowledge?.schedule(kind, ids);
  };
  // A ticket that a worktree tab is working on is not deleted while the tab is open.
  collab.isThreadLive = async (id) => {
    const threads = await store.listThreads(OFFICE_ID);
    const t = threads.find((x) => x.id === id);
    return !!t && isLive(t.state);
  };

  /* ───────────── HTTP ───────────── */

  const app = new Hono<Env>();
  // CORS: public answers are readable from anywhere; everything else only from the allowed origins (echoed, not `*`), because it
  // is called with a bearer token.
  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    const open = PUBLIC_PATHS.has(c.req.path);
    const allowed = open || !origin || originAllowed(origin, cfg);
    const cors = () => {
      if (open) c.header('access-control-allow-origin', '*');
      else if (origin && allowed) {
        c.header('access-control-allow-origin', origin);
        c.header('vary', 'origin');
      }
    };
    if (c.req.method === 'OPTIONS') {
      if (!allowed) return c.body(null, 403);
      cors();
      c.header('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      c.header('access-control-allow-headers', 'authorization, content-type');
      c.header('access-control-max-age', '600');
      return c.body(null, 204);
    }
    await next();
    c.header('cache-control', 'no-store');
    cors();
  });
  app.get('/', (c) => c.json({ name: 'worktrees-team-server', ws: '/ws' }));
  // `/health` is the one to use behind Cloud Run: its front end reserves `/healthz` on *.run.app and answers 404 itself.
  app.get('/health', (c) => c.json({ ok: true, ...office.stats() }));
  app.get('/healthz', (c) => c.json({ ok: true, ...office.stats() }));
  // Public, non-secret facts a client can use to check it is talking to the right server.
  app.get('/config', (c) => c.json({ name: cfg.projectName || undefined, protocol: PROTOCOL_VERSION, pipeline: cfg.pipelineEnabled }));
  registerCollabRoutes(app, { auth, collab, store, limits: deps.collabLimits });
  if (pipeline) registerPipelineRoutes(app, { auth, pipeline, limits: deps.pipelineLimits });
  if (ai) {
    registerInternalRoutes(app, { verifier: deps.internalVerifier ?? createInternalVerifier(cfg), collab, store, office, pipeline });
    registerDemoRoutes(app, { cfg, auth, guest, office, collab, ai, demo, pipeline });
  }
  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((e, c) => {
    log.error('request failed', { path: c.req.path, err: String(e) });
    return c.json({ error: 'internal' }, 500);
  });

  /* ───────────── WebSockets ───────────── */

  const sockets = new Set<Sock>();

  /** Tells the person why, then closes. `4003`: the app will not retry; `1013`: a problem on our side, so it will. */
  const reject = (ws: Sock, send: (m: { t: 'error'; code: string; message: string }) => void, e: unknown) => {
    if (e instanceof AuthzError) {
      send({ t: 'error', code: e.code, message: e.message });
      // A full office is not a refusal of the person: the app tries again.
      return ws.close(e.code === 'room_full' ? 1013 : CLOSE_AUTH, e.code);
    }
    // Only a token that does not check out is the person's problem. Everything else (the database, a bug) is ours.
    const ours = !isTokenProblem(e);
    log.warn('office sign-in failed', { err: String(e), ours });
    if (ours) {
      send({ t: 'error', code: 'unavailable', message: 'The team server couldn’t check your sign-in just now. It will try again.' });
      return ws.close(1013, 'unavailable');
    }
    send({ t: 'error', code: 'auth_failed', message: 'Sign-in failed.' });
    ws.close(CLOSE_AUTH, 'auth_failed');
  };

  /** Joins are limited: a reconnect loop would otherwise write the member row every time. */
  const joinsByUid = new KeyedBuckets(10, 10 / 60);
  /** What a person may do per second is theirs, not their connection's: reconnecting does not refill it. */
  const officeBuckets = new PerKey<Client['buckets']>();
  const makeBuckets = (): Client['buckets'] => ({
    move: new TokenBucket(40, 30),
    chat: new TokenBucket(5, 2.5),
    emote: new TokenBucket(3, 1),
    edit: new TokenBucket(200, 100),
    misc: new TokenBucket(10, 5),
    history: new TokenBucket(5, 1),
    agent: new TokenBucket(6, 0.1),
    session: new TokenBucket(5, 0.2),
  });

  async function officeMessage(ws: Sock, text: string) {
    const d = ws.data;
    const send = (m: ServerMsg) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(m));
    };
    const msg = parseClientMsg(text);
    if (!msg) return send({ t: 'error', code: 'bad_message', message: 'Malformed message.', ...rawRefs(text) });
    if (d.client && d.room) return d.room.handle(d.client, msg);
    if (msg.t !== 'hello' || d.helloSeen) return;
    d.helloSeen = true;
    clearTimeout(d.helloTimer);
    if (!msg.protocol || msg.protocol < PROTOCOL_VERSION) {
      send({ t: 'error', code: 'update_required', message: 'Your Worktrees Studio is older than this team server. Update the app.' });
      return ws.close(CLOSE_UPDATE, 'update_required');
    }
    let id;
    try {
      id = await auth.verify(msg.token);
    } catch (e) {
      return reject(ws, send, e);
    }
    if (id.uid.startsWith('agent:')) return reject(ws, send, new AuthzError('not_allowed', 'That account can’t join.'));
    try {
      if (!joinsByUid.take(id.uid)) {
        send({ t: 'error', code: 'rate_limited', message: 'You’re joining too often. Wait a minute and try again.' });
        return ws.close(1013, 'rate_limited');
      }
      // A reset of the demo is a second or two of an empty store: nobody enters the office while it is being written.
      await demo?.settled();
      // The display name comes from the verified sign-in; what the app sent is only a fallback. Every one is cleaned the same way.
      const name = sanitizeText(id.name ?? '', LIMITS.name) || msg.name || 'Guest';
      const room = await office.enter(id.uid);
      if (ws.readyState !== 1) return;
      d.room = room;
      d.client = {
        uid: id.uid,
        role: id.role,
        transport: { send: (s) => ws.readyState === 1 && ws.send(s), close: (c, r) => ws.close(c, r) },
        send,
        buckets: officeBuckets.get(id.uid, makeBuckets),
        lastMoveAt: Date.now(),
      };
      room.join(d.client, { uid: id.uid, name, look: msg.look, role: id.role });
    } catch (e) {
      reject(ws, send, e);
    }
  }

  const websocket = {
    maxPayloadLength: OFFICE_FRAME_MAX,
    idleTimeout: 60,
    sendPings: true,
    open(ws: Sock) {
      sockets.add(ws);
      ws.data.helloTimer = setTimeout(() => ws.close(4008, 'hello timeout'), HELLO_TIMEOUT_MS);
    },
    async message(ws: Sock, data: string | Buffer) {
      if (typeof data !== 'string') return; // binary frames are not part of the protocol
      if (data.length > OFFICE_FRAME_MAX) return void ws.close(1009, 'frame too large');
      if (!ws.data.inbound.take()) return void ws.close(1008, 'rate limit');
      await officeMessage(ws, data);
    },
    close(ws: Sock) {
      sockets.delete(ws);
      clearTimeout(ws.data.helloTimer);
      if (ws.data.client && ws.data.room) ws.data.room.leave(ws.data.client);
    },
  };

  /**
   * Whose address a request comes from. Behind Cloud Run (`K_SERVICE` is set) that is the last hop of `x-forwarded-for`: earlier
   * ones can be made up by the caller. Behind a proxy of your own, `TRUST_PROXY_HOPS` says how many hops from the right are yours.
   * With neither, the header is ignored (anyone could write anything in it) and the connection's own address is used.
   */
  const trustedHops = Number(process.env.TRUST_PROXY_HOPS ?? (process.env.K_SERVICE ? 1 : 0)) || 0;
  const clientIp = (req: Request, server: Server<SocketData>) => {
    const hops = (req.headers.get('x-forwarded-for') ?? '').split(',').map((h) => h.trim()).filter(Boolean);
    const forwarded = trustedHops > 0 ? hops[hops.length - trustedHops] : undefined;
    return ipKey(forwarded ?? server.requestIP(req)?.address ?? '');
  };
  /** Opening a socket costs the server something, so how often one address may is limited, signed in or not. */
  const upgradesByIp = new KeyedBuckets(30, 0.5);

  const fetch = (req: Request, server: Server<SocketData>): Response | undefined | Promise<Response> => {
    const path = new URL(req.url).pathname;
    if (path === '/ws' && req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      if (!upgradesByIp.take(clientIp(req, server) || 'unknown')) return new Response('too many connections', { status: 429 });
      if (!originAllowed(req.headers.get('origin'), cfg)) return new Response('forbidden', { status: 403 });
      const data: SocketData = { inbound: new TokenBucket(120, 90) };
      return server.upgrade(req, { data }) ? undefined : new Response('upgrade failed', { status: 400 });
    }
    return respond(req, server);
  };

  /** The web app's own files first (the API has no file by those names), then the API, then the web app's page for an address the browser asked for. */
  const respond = async (req: Request, server: Server<SocketData>): Promise<Response> => {
    const file = web ? await web.file(req) : null;
    if (file) return file;
    const res = await app.fetch(req, { ip: clientIp(req, server) });
    if (res.status === 404 && web) return (await web.index(req)) ?? res;
    return res;
  };

  let server: Server<SocketData> | null = null;
  return {
    app,
    office,
    cfg,
    async listen(port = cfg.port) {
      // The demo is seeded before the first visitor can arrive.
      await demo?.start();
      server = Bun.serve<SocketData>({ port, fetch, websocket, maxRequestBodySize: 2 * 1024 * 1024 });
      // Without a public address of its own (a local run), the agent service reaches this server where it is actually listening.
      if (ai && !cfg.publicUrl) ai.webBase = `http://127.0.0.1:${server.port ?? port}`;
      return server.port ?? port;
    },
    async close() {
      demo?.stop();
      await ai?.knowledge?.flush().catch(() => {});
      for (const ws of sockets) ws.close(1012, 'server restarting');
      await office.shutdown();
      await store.close();
      await server?.stop(true);
    },
  };
}
