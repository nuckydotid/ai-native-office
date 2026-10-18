import { idToken, TeamRequestError, sentence as credentialSentence } from '../office/team.ts';
import { renewGuest } from '../web.ts';

export { TeamRequestError };

/** The words for anything that went wrong on the way (a refusal from the server). */
export const sentence = credentialSentence;

/**
 * One JSON request to the team server. The guest credential is read fresh for every request, so nothing long-lived sits in a
 * store or a log. A refusal keeps the server's own sentence.
 */
export async function teamRequest<T>(origin: string, path: string, init: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown } = {}): Promise<T> {
  const send = async (): Promise<Response> => {
    let token: string;
    try {
      token = await idToken();
    } catch (e) {
      // The code stays, so a screen can say what to do.
      const code = e instanceof Error ? e.message : String(e);
      throw new TeamRequestError(code, credentialSentence(e));
    }
    try {
      return await fetch(`${origin.replace(/\/+$/, '')}${path}`, {
        method: init.method ?? 'GET',
        headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch {
      throw new TeamRequestError('offline', 'Couldn’t reach the team server. Check your connection and try again.');
    }
  };
  let response = await send();
  // A guest's token that the server no longer takes (it ended, or the demo was reset) is replaced once, then the request is made again.
  if (response.status === 401) {
    await renewGuest().catch(() => {});
    response = await send();
  }
  const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
  if (!response.ok) {
    throw new TeamRequestError(body?.error ?? 'failed', body?.message ?? 'The team server couldn’t do that just now. Try again in a moment.');
  }
  return body as T;
}
