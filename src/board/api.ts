import type { IssueInput, IssuePatch } from '../shared/board/protocol.ts';
import type { BoardSnapshot, Issue } from '../shared/board/types.ts';
import { teamRequest } from '../team/rest.ts';

/** What the screens ask of the board: each call is one REST request to the team server. */
export interface BoardApi {
  load(project: string, origin: string): Promise<BoardSnapshot>;
  createIssue(project: string, origin: string, input: IssueInput): Promise<Issue>;
  /** `ifUpdatedAt`: refuse the change if the issue was changed since the copy this edit was made on. */
  updateIssue(project: string, origin: string, id: string, patch: IssuePatch & { ifUpdatedAt?: number }): Promise<Issue>;
  deleteIssue(project: string, origin: string, id: string): Promise<void>;
  /** Keeps a picture on the team server (a PNG, JPEG, GIF or WebP of at most 1 MB, as base64). Resolves to its id. */
  uploadAsset(project: string, origin: string, mime: string, data: string): Promise<{ id: string }>;
  /** A picture as a `data:` URL. */
  asset(project: string, origin: string, id: string): Promise<string>;
}

const httpBoard: BoardApi = {
  load: (_project, origin) => teamRequest<BoardSnapshot>(origin, '/board'),
  createIssue: async (_project, origin, input) => (await teamRequest<{ issue: Issue }>(origin, '/board/issues', { method: 'POST', body: input })).issue,
  updateIssue: async (_project, origin, id, patch) => (await teamRequest<{ issue: Issue }>(origin, `/board/issues/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch })).issue,
  deleteIssue: async (_project, origin, id) => void (await teamRequest(origin, `/board/issues/${encodeURIComponent(id)}`, { method: 'DELETE' })),
  uploadAsset: async (_project, origin, mime, data) => await teamRequest<{ id: string }>(origin, '/assets', { method: 'POST', body: { mime, data } }),
  asset: async (_project, origin, id) => {
    const a = await teamRequest<{ mime: string; data: string }>(origin, `/assets/${encodeURIComponent(id)}`);
    return `data:${a.mime};base64,${a.data}`;
  },
};

/** What the screens call. */
export const boardApi: BoardApi = httpBoard;
