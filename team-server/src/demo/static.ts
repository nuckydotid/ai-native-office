import { stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

export interface WebApp {
  /** A file of the built web app, or null when the path is not one (so the API gets a turn). */
  file(req: Request): Promise<Response | null>;
  /** The app's `index.html` for a page address the browser asked for, so a reload on any page works. */
  index(req: Request): Promise<Response | null>;
}

const SECURITY = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } as const;

/**
 * Serves the built studio (`dist/`) from the same address as the API, so the hosted demo is one Cloud Run service: no CORS, no
 * second host, and the web app's socket is same-origin. Only files inside the folder are served (no `..`, no links followed out).
 */
export function createWebApp(dir: string): WebApp {
  const root = resolve(dir);

  async function open(rel: string, req: Request): Promise<Response | null> {
    const path = resolve(root, rel);
    if (path !== root && !path.startsWith(root + sep)) return null;
    try {
      const s = await stat(path);
      if (!s.isFile()) return null;
    } catch {
      return null;
    }
    const f = Bun.file(path);
    const isIndex = rel === 'index.html';
    const headers = {
      ...SECURITY,
      'content-type': f.type || 'application/octet-stream',
      // Built files carry a hash in their name, so they never change; the page that points at them always does.
      'cache-control': isIndex ? 'no-cache' : rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    };
    return new Response(req.method === 'HEAD' ? null : f, { headers });
  }

  return {
    async file(req) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return null;
      let path: string;
      try {
        path = decodeURIComponent(new URL(req.url).pathname);
      } catch {
        return null;
      }
      if (path.includes('\0')) return null;
      return open(path === '/' ? 'index.html' : path.replace(/^\/+/, ''), req);
    },
    async index(req) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return null;
      const last = new URL(req.url).pathname.split('/').pop() ?? '';
      if (last.includes('.') || !(req.headers.get('accept') ?? '').includes('text/html')) return null;
      return open(join('index.html'), req);
    },
  };
}
