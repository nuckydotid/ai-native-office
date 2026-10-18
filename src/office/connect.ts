import type { Appearance } from '../shared/workspace/types.ts';
import { demoOrigin } from '../web.ts';
import { socketUrl } from './team.ts';

/** The office is the server that served the page: nothing to confirm. */
export function officeAddress(origin: string = demoOrigin()): { origin: string; url: string } {
  return { origin, url: socketUrl(origin) };
}

export type Identity = { uid: string; name: string; look: Appearance };

/** What the person can press when joining the office failed with `code`: `retry` asks again; nothing, when asking again would change nothing. */
export function joinAction(code: string | undefined): 'retry' | null {
  return code === 'update_required' ? null : 'retry';
}
