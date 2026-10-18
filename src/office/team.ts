import { GuestError, guestCredential } from '../web.ts';
import { CREDENTIAL_PROBLEMS } from './net/remote.ts';

/** The credential the team server reads: the guest token (`demo:<jwt>`, the only sign-in). Rejects with a code (see `CREDENTIAL_PROBLEMS`). */
export async function idToken(): Promise<string> {
  try {
    return await guestCredential();
  } catch (e) {
    throw new Error(e instanceof GuestError ? e.code : 'demo_refused');
  }
}

/** The room's WebSocket address for a server (`https://x.run.app` → `wss://x.run.app/ws`; a local `http://` one is `ws://`). */
export const socketUrl = (origin: string) => `${origin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:').replace(/\/+$/, '')}/ws`;

/** The words for something that went wrong getting in: a known code becomes its plain sentence. */
export const sentence = (e: unknown) => {
  const text = e instanceof Error ? e.message : String(e);
  return CREDENTIAL_PROBLEMS[text]?.message ?? text;
};

/** A refusal from the team server, with its own sentence. */
export class TeamRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
