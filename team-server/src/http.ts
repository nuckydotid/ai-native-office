import type { Config } from './config.ts';

/** What the server hands every request besides the request itself. */
export type Env = { Bindings: { ip: string } };

/** [burst, refill per second] */
export type Limit = [number, number];

/** Why a request was refused, in words for the person (and the HTTP status to answer with). */
export class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 503 = 400,
  ) {
    super(message);
  }
}

/** Whether a browser page on `origin` may call this server. Non-browser clients send no Origin. */
export function originAllowed(origin: string | null | undefined, cfg: Pick<Config, 'allowedOrigins'>): boolean {
  if (!origin) return true;
  return cfg.allowedOrigins.includes('*') || cfg.allowedOrigins.includes(origin);
}
