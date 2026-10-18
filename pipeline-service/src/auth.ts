import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import type { PipelineConfig } from './config.ts';

const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';

/** Whether a request to `/v1/*` is from a caller we trust (studio-web, or the Pub/Sub push identity). */
export interface CallerVerifier {
  verify(authorization: string | undefined): Promise<boolean>;
}

/** Cloud Run to Cloud Run (and Pub/Sub push): a Google ID token, signed by a service account, for this service's own address. */
export class GoogleCallerVerifier implements CallerVerifier {
  private allowed: Set<string>;

  constructor(
    private audience: string,
    callers: string[],
    private jwks: JWTVerifyGetKey = createRemoteJWKSet(new URL(GOOGLE_JWKS)),
  ) {
    this.allowed = new Set(callers.map((c) => c.toLowerCase()));
    // The service must boot before Cloud Run knows its own URL; until SERVICE_URL is set, every call is refused (fail closed).
    if (!audience || this.allowed.size === 0) console.warn('SERVICE_URL and PIPELINE_CALLERS are not set: every call will be refused');
  }

  async verify(authorization: string | undefined): Promise<boolean> {
    if (!this.audience || this.allowed.size === 0) return false;
    const bearer = /^Bearer (.+)$/i.exec(authorization ?? '')?.[1];
    if (!bearer) return false;
    try {
      const { payload } = await jwtVerify(bearer, this.jwks, { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: this.audience });
      return payload.email_verified === true && typeof payload.email === 'string' && this.allowed.has(payload.email.toLowerCase());
    } catch {
      return false;
    }
  }
}

/** Local development and tests only. `loadConfig` refuses this on Cloud Run. */
export class OpenCallerVerifier implements CallerVerifier {
  async verify(): Promise<boolean> {
    return true;
  }
}

export function createVerifier(cfg: Pick<PipelineConfig, 'auth' | 'serviceUrl' | 'callers'>): CallerVerifier {
  return cfg.auth === 'none' ? new OpenCallerVerifier() : new GoogleCallerVerifier(cfg.serviceUrl, cfg.callers);
}

/** Google ID tokens for calling Cloud Run services and the web service, from the metadata server (no key file). */
export class IdTokenSource {
  private cache = new Map<string, { token: string; exp: number }>();

  constructor(
    private fetchFn: typeof fetch = fetch,
    /** A stand-in for tests: never reaches the metadata server. */
    private fixed: string | null = null,
  ) {}

  async get(audience: string): Promise<string> {
    if (this.fixed) return this.fixed;
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

/** The access token for Google APIs (Cloud Build, Cloud Run, Storage, Firestore, Container Analysis) from the runtime service account. */
export class AccessTokenSource {
  private cache: { token: string; exp: number } | null = null;

  constructor(
    private fetchFn: typeof fetch = fetch,
    /** A stand-in for tests: never reaches the metadata server. */
    private fixed: string | null = null,
  ) {}

  async get(): Promise<string> {
    if (this.fixed) return this.fixed;
    if (this.cache && this.cache.exp - Date.now() > 5 * 60_000) return this.cache.token;
    const res = await this.fetchFn('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`the metadata server refused an access token (${res.status})`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('the metadata server sent no access token');
    this.cache = { token: body.access_token, exp: Date.now() + Math.max(60, (body.expires_in ?? 3600) - 300) * 1000 };
    return this.cache.token;
  }
}
