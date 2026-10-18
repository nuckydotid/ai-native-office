/*
 * The web app talks to the team server that served it. Nobody signs in: the server hands every visitor a guest token
 * (`POST /demo/guest`), and the agents run on the server. Everything here is plain TypeScript with no React, so the data layers
 * can use it too.
 */

import type { Project } from './project.ts';

/** The one project the app opens: a made-up team ("Northwind Field App"). Its path is only a key for the stores. */
export const DEMO_PROJECT: Project = {
  name: 'Northwind Field App',
  slug: 'northwind',
  path: 'demo:northwind',
  github: null,
};

type Where = Pick<Location, 'origin' | 'port' | 'protocol' | 'hostname'>;

/**
 * The team server's address: the page's own origin, because the server serves the web app. Two exceptions, both for running it
 * on a developer's machine: `VITE_TEAM_ORIGIN` names a server, and `npm run dev` (port 1420) finds the demo server next door on 8080.
 */
export function demoOrigin(where: Where | undefined = typeof location === 'undefined' ? undefined : location): string {
  const named = import.meta.env?.VITE_TEAM_ORIGIN;
  if (typeof named === 'string' && /^https?:\/\/[^\s/]+$/.test(named)) return named;
  if (!where) return '';
  if (import.meta.env?.DEV && where.port === '1420') return `${where.protocol}//${where.hostname}:8080`;
  return where.origin;
}

/* ───────────── the guest ───────────── */

/** What `POST /demo/guest` answers. `token` is the whole credential, `demo:<jwt>`. */
export interface Guest {
  token: string;
  uid: string;
  name: string;
}

/**
 * A guest token the server could not give. `code` is one of the credential problems the office knows
 * (`CREDENTIAL_PROBLEMS`, in `office/net/remote.ts`), both worth trying again; the message is the sentence for a person.
 */
export class GuestError extends Error {
  constructor(
    readonly code: 'demo_unreachable' | 'demo_refused',
    message: string,
  ) {
    super(message);
  }
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface GuestDeps {
  origin(): string;
  fetch?: typeof fetch;
  /** Where the guest is kept between visits. `null` or a failing store: a new guest every visit. */
  storage?(): Store | null;
  now?(): number;
}

const GUEST_KEY = 'wts-demo-guest';
/** A token this close to its end is replaced before it is used, so a long visit does not end in a refusal. */
const RENEW_BEFORE_MS = 60 * 60_000;

/** When a `demo:<jwt>` token ends, from the JWT's own `exp` (not checked: the server checks it). `null` when it can't be read. */
export function tokenExpiry(token: string): number | null {
  try {
    const payload = token.replace(/^demo:/, '').split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

const isGuest = (v: unknown): v is Guest => {
  const g = v as Partial<Guest> | null;
  return !!g && typeof g.token === 'string' && g.token.startsWith('demo:') && typeof g.uid === 'string' && !!g.uid && typeof g.name === 'string';
};

/** Asks the server for a guest once, keeps it for the next visit, and hands the same one to everything that needs a token. */
export function createGuestProvider(deps: GuestDeps) {
  const now = deps.now ?? Date.now;
  let current: Guest | null = null;
  let inflight: Promise<Guest> | null = null;

  const store = (): Store | null => {
    try {
      return deps.storage ? deps.storage() : null;
    } catch {
      return null;
    }
  };
  const fresh = (g: Guest) => {
    const end = tokenExpiry(g.token);
    return end === null || end - now() > RENEW_BEFORE_MS;
  };

  async function request(): Promise<Guest> {
    let response: Response;
    try {
      response = await (deps.fetch ?? fetch)(`${deps.origin().replace(/\/+$/, '')}/demo/guest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
    } catch {
      throw new GuestError('demo_unreachable', 'Couldn’t reach the demo server. Check your connection and try again.');
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok || !isGuest(body)) {
      const message = (body as { message?: unknown } | null)?.message;
      throw new GuestError('demo_refused', typeof message === 'string' && message ? message : 'The demo couldn’t let you in just now. Try again in a moment.');
    }
    const guest: Guest = { token: body.token, uid: body.uid, name: body.name };
    try {
      store()?.setItem(GUEST_KEY, JSON.stringify(guest));
    } catch {
      // A browser that keeps nothing gives the next visit a new guest. That is fine.
    }
    return guest;
  }

  /** The guest, from memory, from the last visit, or new. One request at a time. */
  async function guest(): Promise<Guest> {
    if (current && fresh(current)) return current;
    if (!current) {
      try {
        const kept = JSON.parse(store()?.getItem(GUEST_KEY) ?? 'null') as unknown;
        if (isGuest(kept) && fresh(kept)) return (current = kept);
      } catch {
        // Nothing usable was kept.
      }
    }
    return renew();
  }

  /** A new guest, whatever was kept (the server said the token is no good). */
  function renew(): Promise<Guest> {
    inflight ??= request()
      .then((g) => (current = g))
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  return { guest, renew, credential: async () => (await guest()).token };
}

const provider = createGuestProvider({
  origin: () => demoOrigin(),
  storage: () => localStorage,
});

/** The guest of this browser (asks the server the first time). */
export const currentGuest = provider.guest;
/** A new guest: for a token the server refused. */
export const renewGuest = provider.renew;
/** `demo:<jwt>`: what goes in `Authorization: Bearer` and in the socket's hello. */
export const guestCredential = provider.credential;

/* ───────────── what the demo says about itself ───────────── */

/** `GET /demo/status`. */
export interface DemoStatus {
  synthetic: true;
  /** AI runs this guest may still start this hour. */
  runsLeft: number;
  runsPerHour: number;
  /** When the workspace is put back as it was (epoch milliseconds, or a date string). */
  resetsAt: number | string;
}

export async function fetchDemoStatus(fetchImpl: typeof fetch = fetch): Promise<DemoStatus | null> {
  try {
    const guest = await currentGuest();
    const response = await fetchImpl(`${demoOrigin().replace(/\/+$/, '')}/demo/status`, { headers: { authorization: `Bearer ${guest.token}` } });
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as Partial<DemoStatus> | null;
    if (!body || typeof body.runsLeft !== 'number' || typeof body.runsPerHour !== 'number') return null;
    return { synthetic: true, runsLeft: Math.max(0, Math.floor(body.runsLeft)), runsPerHour: body.runsPerHour, resetsAt: body.resetsAt ?? '' };
  } catch {
    return null;
  }
}
