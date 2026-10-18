/** Runtime configuration, all from environment variables (Cloud Run friendly). Provisioned by infra/terraform. */
const env = process.env;

const bool = (v: string | undefined, d = false) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(v));
const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export interface Config {
  port: number;
  /** Accept `dev:<uid>[@<role>][:<name>]` tokens (tests and local development only). */
  devAuth: boolean;
  /** `memory` (no persistence) or `postgres` (the project's Cloud SQL, database `team`). */
  store: 'memory' | 'postgres';
  /** Postgres connection string when `store` is `postgres` (the Cloud Run Cloud SQL socket URL). */
  databaseUrl: string;
  /** The office's name. */
  projectName: string;
  /** The browser pages that may call the API and open the office socket. */
  allowedOrigins: string[];
  maxPlayers: number;
  /** Delete chat older than this many days; 0 keeps the whole conversation. */
  chatRetentionDays: number;
  /** The hosted demo: guests sign in without an account, the workspace is seeded and reset, the web app is served from here. */
  demo: boolean;
  /** Signs guest tokens (HS256). Comes from Secret Manager; a random one per start is used when it is not set (tokens end with the start). */
  guestJwtSecret: string;
  /** The agent service (Python, ADK) that thinks for the server-run agents. Empty: no server-run agents. */
  agentServiceUrl: string;
  /** `google`: calls carry a Google ID token (Cloud Run to Cloud Run). `none`: local development only. */
  agentServiceAuth: 'google' | 'none';
  /** The agent service's own service account email: one of the callers `/internal/v1/*` accepts. */
  internalCaller: string;
  /** The pipeline service's service account email: the other caller `/internal/v1/*` accepts (job and rollout events). */
  pipelineCaller: string;
  /** This server's public address (also the audience of the ID tokens the agent service sends). */
  publicUrl: string;
  /** The built web app to serve (`dist` of the studio), or empty. */
  webDir: string;
  /** The demo workspace's seed (`docs/demo-data`), or empty for the built-in minimal one. */
  demoDataDir: string;
  /** Lets Cloud Scheduler reset the demo (`POST /demo/reset` with this in `x-reset-token`). Empty: no remote reset. */
  resetToken: string;
  /** Whether a guest may change an agent's instructions (the Agents page). Off by default: the agents are shared by every visitor. */
  agentEdits: boolean;
  /** How many agent runs one guest may start per hour, and all guests together per day (the demo's Gemini budget). */
  runsPerGuestHour: number;
  runsPerDay: number;
  /** The delivery pipeline (artifacts, jobs, rollouts) is switched on. Off: the stage pages say it is not connected. */
  pipelineEnabled: boolean;
  /** `http`: the private `studio-pipeline` service (ID-token calls). `fake`: an in-process stand-in for local work and tests. */
  pipelineDriver: 'off' | 'fake' | 'http';
  /** The pipeline service's address; also the audience of the ID tokens sent to it. */
  pipelineServiceUrl: string;
}

const origin = (v: string | undefined): string => {
  try {
    return v ? new URL(v).origin : '';
  } catch {
    return '';
  }
};

export function loadConfig(): Config {
  const devAuth = bool(env.TEAM_DEV_AUTH, false);
  const databaseUrl = env.DATABASE_URL ?? '';
  const publicUrl = origin(env.PUBLIC_URL);
  const allowed = list(env.ALLOWED_ORIGINS);
  const pipelineEnabled = bool(env.PIPELINE_ENABLED, false);
  return {
    port: Number(env.PORT ?? 8080),
    devAuth,
    store: (env.TEAM_STORE as Config['store'] | undefined) ?? (databaseUrl && !devAuth ? 'postgres' : 'memory'),
    databaseUrl,
    projectName: env.PROJECT_NAME ?? '',
    // The server's own address is always allowed: the hosted web app opens its sockets from there. Without `ALLOWED_ORIGINS`, so is
    // `npm run dev` (the Vite server on port 1420, which finds this server on 8080).
    allowedOrigins: [
      ...(allowed.length ? allowed : ['http://localhost:1420', 'http://127.0.0.1:1420']),
      ...(publicUrl && !allowed.includes(publicUrl) ? [publicUrl] : []),
    ],
    maxPlayers: Number(env.MAX_PLAYERS ?? 100),
    chatRetentionDays: Math.max(0, Number(env.CHAT_RETENTION_DAYS ?? 0) || 0),
    demo: bool(env.DEMO_MODE, false),
    guestJwtSecret: env.GUEST_JWT_SECRET ?? '',
    agentServiceUrl: origin(env.AGENT_SERVICE_URL),
    agentServiceAuth: env.AGENT_SERVICE_AUTH === 'none' ? 'none' : env.AGENT_SERVICE_AUTH === 'google' ? 'google' : env.K_SERVICE ? 'google' : 'none',
    internalCaller: (env.INTERNAL_CALLER ?? '').trim().toLowerCase(),
    pipelineCaller: (env.PIPELINE_CALLER ?? '').trim().toLowerCase(),
    publicUrl,
    webDir: env.WEB_DIR ?? '',
    demoDataDir: env.DEMO_DATA_DIR ?? '',
    resetToken: env.DEMO_RESET_TOKEN ?? '',
    agentEdits: bool(env.DEMO_AGENT_EDITS, false),
    runsPerGuestHour: Math.max(1, Number(env.DEMO_RUNS_PER_GUEST_HOUR ?? 20) || 20),
    runsPerDay: Math.max(1, Number(env.DEMO_RUNS_PER_DAY ?? 1500) || 1500),
    pipelineEnabled,
    pipelineDriver: pipelineEnabled ? (env.PIPELINE_DRIVER === 'fake' ? 'fake' : env.PIPELINE_DRIVER === 'http' ? 'http' : env.PIPELINE_SERVICE_URL ? 'http' : 'fake') : 'off',
    pipelineServiceUrl: origin(env.PIPELINE_SERVICE_URL),
  };
}
