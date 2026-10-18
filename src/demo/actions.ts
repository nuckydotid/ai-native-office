import { TeamRequestError, teamRequest } from '../team/rest.ts';
import { demoOrigin } from '../web.ts';
import { useDemo } from './store.ts';

/** How a button of the demo turned out: done, or a sentence for the person. */
export type ActionResult = { ok: true } | { ok: false; message: string };

async function post(path: string, body: unknown): Promise<ActionResult> {
  try {
    await teamRequest(demoOrigin(), path, { method: 'POST', body });
    // A run was started (or refused for want of runs left): the strip's count is out of date.
    void useDemo.getState().refresh();
    return { ok: true };
  } catch (e) {
    void useDemo.getState().refresh();
    return { ok: false, message: e instanceof TeamRequestError || e instanceof Error ? e.message : 'The demo couldn’t do that just now. Try again in a moment.' };
  }
}

/** "Run a sample standup": the server plays a scripted team standup into the room's chat, a line at a time. */
export const runSampleStandup = (room: string) => post('/demo/sample-standup', { room });

/** "End meeting": the Scribe writes the minutes of the room's active conversation and proposes tickets for what is still open. */
export const endMeeting = (room: string, session: string) => post('/ai/minutes', { room, session });

/** "Import with AI": a PDF or a picture becomes a Docs page; the server waits for the run, then creates the page. */
export async function importWithAi(file: { name: string; mime: string; dataBase64: string }): Promise<{ ok: true; pageId: string; title: string } | { ok: false; message: string }> {
  try {
    const page = await teamRequest<{ pageId: string; title: string }>(demoOrigin(), '/ai/import', { method: 'POST', body: file });
    void useDemo.getState().refresh();
    return { ok: true, pageId: page.pageId, title: page.title };
  } catch (e) {
    void useDemo.getState().refresh();
    return { ok: false, message: e instanceof TeamRequestError || e instanceof Error ? e.message : 'The importer could not read that file just now. Try again in a moment.' };
  }
}
