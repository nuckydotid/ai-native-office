/**
 * The Northwind Customer Portal's server. It is ours, not the AI's: a change set may edit `src/api/orders.ts` (what the portal shows), but
 * never this file, the Dockerfile, the lockfile or the CI scripts.
 *
 * It serves the built portal, a small read-only API, `/healthz`, and the `x-revision` header Cloud Run's canary checks read. It also puts
 * the synthetic-demo banner and `noindex` into the page at serve time, so a change set that edits the page cannot remove them.
 */
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { findOrder, listOrders, orderTotal, ordersSummary } from '../src/api/orders';

const PORT = Number(process.env.PORT ?? 8080);
const DIST = resolve(process.env.DIST_DIR ?? 'dist');
const REVISION = process.env.K_REVISION ?? 'local';
const SERVICE = 'northwind-customer-portal';
const BANNER =
  '<div class="demo-banner">Synthetic demo — Northwind Commerce is fictional, the portal resets nightly, and nothing here is real customer data.</div>';

const app = new Hono();

app.use('*', async (c, next) => {
  await next();
  c.header('x-revision', REVISION);
  c.header('x-robots-tag', 'noindex, nofollow');
  if (c.res.headers.get('content-type')?.includes('text/html')) c.header('cache-control', 'no-store');
});

// `/healthz` is reserved by Google's front end for Cloud Run; the health door is `/health` (kept as well for local checks).
app.get('/health', (c) => c.json({ ok: true, service: SERVICE, revision: REVISION }));
app.get('/healthz', (c) => c.json({ ok: true, service: SERVICE, revision: REVISION }));

app.get('/api/summary', (c) => {
  try {
    const summary = ordersSummary(listOrders());
    return c.json({ ...summary, revision: REVISION });
  } catch {
    return c.json({ error: 'unavailable', message: 'The order service is not available.' }, 500);
  }
});

app.get('/api/orders', (c) => {
  try {
    const orders = listOrders().map((order) => ({
      id: order.id,
      customer: order.customer,
      placedAt: order.placedAt,
      status: order.status,
      units: order.lines.reduce((sum, line) => sum + line.quantity, 0),
      total: orderTotal(order),
    }));
    return c.json({ orders, count: orders.length, revision: REVISION });
  } catch {
    return c.json({ error: 'unavailable', message: 'The order service is not available.' }, 500);
  }
});

app.get('/api/orders/:id', (c) => {
  try {
    const order = findOrder(c.req.param('id'));
    if (!order) return c.json({ error: 'not_found', message: 'That order is not here.' }, 404);
    return c.json({ order, total: orderTotal(order), revision: REVISION });
  } catch {
    return c.json({ error: 'unavailable', message: 'The order service is not available.' }, 500);
  }
});

// The built assets (hashed by Vite); the page itself is served below so the banner can be put in.
app.get('/assets/*', serveStatic({ root: './dist' }));
app.get('/favicon.svg', serveStatic({ root: './dist' }));

app.get('*', async (c) => {
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'not_found' }, 404);
  if (extname(c.req.path) && c.req.path !== '/index.html') return c.notFound();
  try {
    const html = await readFile(join(DIST, 'index.html'), 'utf8');
    return c.html(withDemoBanner(html));
  } catch {
    return c.text(`The portal is not built. Run: npm run build\n`, 503);
  }
});

app.onError((err, c) => {
  console.error(`${SERVICE}: ${err instanceof Error ? err.message : String(err)}`);
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'unavailable', message: 'The order service is not available.' }, 500);
  return c.text('The portal hit an unexpected problem.\n', 500);
});

/** The page with the banner and `noindex`; both survive whatever a change set does to the React app. */
export function withDemoBanner(html: string): string {
  const withRobots = /<meta\s+name=["']robots["']/i.test(html)
    ? html
    : html.replace(/<head([^>]*)>/i, '<head$1><meta name="robots" content="noindex, nofollow">');
  if (/<\/body>/i.test(withRobots)) return withRobots.replace(/<\/body>/i, `${BANNER}</body>`);
  return `${BANNER}${withRobots}`;
}

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (info) => {
  console.log(`${SERVICE} listening on :${info.port} (revision ${REVISION})`);
});
