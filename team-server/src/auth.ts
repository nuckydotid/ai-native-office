import { SignJWT, jwtVerify } from 'jose';
import { LIMITS, sanitizeText } from './shared/workspace/protocol.ts';
import type { WorkspaceRole } from './shared/workspace/types.ts';
import type { Config } from './config.ts';

export interface Identity {
  uid: string;
  name?: string;
  /** What the person may do in the one workspace. A guest owns it; a development token says. */
  role: WorkspaceRole;
  /** Which kind of sign-in proved this identity. */
  provider: 'dev' | 'guest';
}

/** A name from a token, made safe to show and to save: no control or invisible characters, no half emoji, at most `LIMITS.name` characters. */
const cleanName = (name: unknown): string | undefined => (typeof name === 'string' ? sanitizeText(name, LIMITS.name) || undefined : undefined);

export interface Authenticator {
  verify(token: string): Promise<Identity>;
}

/** A sign-in that does not check out (wrong token, expired, forged): the person's problem, not ours. */
export class TokenError extends Error {}

/** Thrown when someone signed in but may not use the office just now (it is full, or the account is not one that can join). */
export class AuthzError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Whether an error from `verify` says the token is bad. Anything else (a bug) is a problem on our side, which the app retries instead of giving up. */
export function isTokenProblem(e: unknown): boolean {
  if (e instanceof TokenError) return true;
  const code = typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : '';
  return /^ERR_(JWT_|JWS_)/.test(code) || ['ERR_JOSE_ALG_NOT_ALLOWED', 'ERR_JOSE_NOT_SUPPORTED'].includes(code);
}

/**
 * `dev:<uid>[@<role>][:<name>]` tokens (the role is `owner`, `admin` or `member`, owner when left out), for tests and a local run
 * without the demo. Never enabled in production (TEAM_DEV_AUTH).
 */
export class DevAuthenticator implements Authenticator {
  async verify(token: string): Promise<Identity> {
    const m = /^dev:([A-Za-z0-9_-]{1,64})(?:@(owner|admin|member))?(?::(.*))?$/.exec(token);
    if (!m) throw new TokenError('invalid dev token');
    return { uid: `dev-${m[1]}`, name: cleanName(m[3] || m[1]), role: (m[2] as WorkspaceRole | undefined) ?? 'owner', provider: 'dev' };
  }
}

/** Credential prefix for a guest of the hosted demo: `demo:<jwt>`. */
export const GUEST_PREFIX = 'demo:';
const GUEST_ISSUER = 'worktrees-studio-demo';
const GUEST_ID_RE = /^guest-[a-z0-9]{6,32}$/;

/**
 * Guests of the hosted demo. The server signs a short token for anyone who asks (`POST /demo/guest`), so a judge needs no account.
 * It is a signed name and an id, nothing more: a guest owns the demo's one synthetic workspace, and what a guest can break is
 * bounded by the nightly reset and the run budget.
 */
export class GuestAuthenticator implements Authenticator {
  private key: Uint8Array;
  constructor(secret: string) {
    if (secret.length < 16) throw new Error('GUEST_JWT_SECRET must be at least 16 characters');
    this.key = new TextEncoder().encode(secret);
  }

  /** A token for a new guest (or `uid` again, for the same guest on a new day). */
  async issue(name: string, uid = `guest-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`, days = 7): Promise<{ token: string; uid: string; name: string }> {
    const clean = cleanName(name) ?? 'Guest';
    const jwt = await new SignJWT({ name: clean })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(GUEST_ISSUER)
      .setSubject(uid)
      .setIssuedAt()
      .setExpirationTime(`${days}d`)
      .sign(this.key);
    return { token: GUEST_PREFIX + jwt, uid, name: clean };
  }

  async verify(token: string): Promise<Identity> {
    const jwt = token.startsWith(GUEST_PREFIX) ? token.slice(GUEST_PREFIX.length) : token;
    const { payload } = await jwtVerify(jwt, this.key, { issuer: GUEST_ISSUER, algorithms: ['HS256'] });
    const uid = String(payload.sub ?? '');
    if (!GUEST_ID_RE.test(uid)) throw new TokenError('bad guest id');
    return { uid, role: 'owner', provider: 'guest', name: cleanName(payload.name) ?? 'Guest' };
  }
}

/** The guest authenticator of a demo server: it signs the tokens too, so the routes can hand them out. */
export function createGuestAuthenticator(cfg: Pick<Config, 'demo' | 'guestJwtSecret'>): GuestAuthenticator | null {
  if (!cfg.demo) return null;
  // Without a secret in the environment, a random one lives as long as this process (fine for one local run; Cloud Run sets it).
  return new GuestAuthenticator(cfg.guestJwtSecret || crypto.randomUUID() + crypto.randomUUID());
}

/** Development sign-in when `TEAM_DEV_AUTH` is on; otherwise guests, or nobody (a server that is not the demo has no one to let in). */
export function createAuthenticator(cfg: Config, guest: GuestAuthenticator | null = createGuestAuthenticator(cfg)): Authenticator {
  if (cfg.devAuth) return new DevAuthenticator();
  return guest ?? { verify: () => Promise.reject(new TokenError('Sign-in is not available on this server')) };
}
