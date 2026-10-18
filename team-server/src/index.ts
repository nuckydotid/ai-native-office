import { loadConfig } from './config.ts';
import { log } from './log.ts';
import { createTeamServer } from './server.ts';

import { createStore, PostgresStore } from './store.ts';

const cfg = loadConfig();
if (!cfg.devAuth && !cfg.demo) log.warn('Neither DEMO_MODE nor TEAM_DEV_AUTH is on: nobody can sign in to this server');
if (cfg.demo && !cfg.guestJwtSecret) log.warn('GUEST_JWT_SECRET is not set: guest tokens end whenever this server restarts');
if (cfg.demo && !cfg.agentServiceUrl) log.warn('AGENT_SERVICE_URL is not set: the demo will open, but its agents cannot answer');
if (cfg.demo && !cfg.resetToken) log.warn('DEMO_RESET_TOKEN is not set: the demo cannot be reset from outside');
if (cfg.store === 'postgres' && !cfg.databaseUrl) throw new Error('DATABASE_URL is required when the store is postgres');
const store = createStore(cfg);
// Fail at start-up, where Cloud Run shows it, if the database cannot be reached.
if (store instanceof PostgresStore) await store.whenReady();
const server = createTeamServer({ cfg, store });

server.listen().then((port) => {
  log.info('team server listening', { port, store: cfg.store, devAuth: cfg.devAuth, demo: cfg.demo, agents: cfg.agentServiceUrl || undefined, web: cfg.webDir || undefined });
  if (cfg.devAuth) log.warn('TEAM_DEV_AUTH is enabled — any client can impersonate any user. Never use in production.');
});

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  log.info('shutting down', { signal });
  const t = setTimeout(() => process.exit(0), 8000);
  await server.close().catch((e) => log.error('shutdown error', { err: String(e) }));
  clearTimeout(t);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (e) => log.error('unhandledRejection', { err: String(e) }));
