import { create } from 'zustand';
import type { IssueInput, IssuePatch } from '../shared/board/protocol.ts';
import type { BoardSnapshot } from '../shared/board/types.ts';
import { teamOrigin } from '../team/connect.ts';
import { sentence, TeamRequestError } from '../team/rest.ts';
import { boardApi } from './api.ts';

interface BoardState {
  /** The project the board belongs to. */
  project: string | null;
  snapshot: BoardSnapshot | null;
  loading: boolean;
  /** A change is in flight. */
  busy: boolean;
  error: string | null;
  /** The server's code for `error`, when it had one. */
  errorCode: string | null;

  /** Reads the board. A slower answer for another project never replaces a newer one. */
  load(project: string): Promise<void>;
  createIssue(input: IssueInput): Promise<void>;
  updateIssue(id: string, patch: IssuePatch & { ifUpdatedAt?: number }): Promise<void>;
  deleteIssue(id: string): Promise<void>;
  /** Keeps a picture a person attached; resolves to its id. */
  uploadImage(mime: string, base64: string): Promise<string>;
  imageUrl(id: string): Promise<string>;
  reset(): void;
}

let latest = 0;

export const useBoard = create<BoardState>((set, get) => {
  /** Runs a change, then reads the board again. Throws so a dialog can stay open and say why. */
  const change = async (run: (project: string, origin: string) => Promise<unknown>) => {
    const { project } = get();
    if (!project) throw new Error('The board isn’t open yet.');
    set({ busy: true, error: null });
    try {
      await run(project, teamOrigin());
      const snapshot = await boardApi.load(project, teamOrigin());
      if (get().project === project) set({ snapshot });
    } finally {
      set({ busy: false });
    }
  };

  return {
    project: null,
    snapshot: null,
    loading: false,
    busy: false,
    error: null,
    errorCode: null,

    async load(project) {
      const ticket = ++latest;
      if (get().project !== project) set({ project, snapshot: null, loading: true, error: null, errorCode: null });
      else set({ loading: true, error: null, errorCode: null });
      try {
        const snapshot = await boardApi.load(project, teamOrigin());
        if (ticket === latest) set({ snapshot, loading: false });
      } catch (e) {
        if (ticket === latest) set({ loading: false, error: sentence(e), errorCode: e instanceof TeamRequestError ? e.code : null });
      }
    },

    createIssue: (input) => change((project, origin) => boardApi.createIssue(project, origin, input)),
    updateIssue: (id, patch) => change((project, origin) => boardApi.updateIssue(project, origin, id, patch)),
    deleteIssue: (id) => change((project, origin) => boardApi.deleteIssue(project, origin, id)),

    async uploadImage(mime, base64) {
      const { project } = get();
      if (!project) throw new Error('The board isn’t open yet.');
      return (await boardApi.uploadAsset(project, teamOrigin(), mime, base64)).id;
    },
    async imageUrl(id) {
      const { project } = get();
      if (!project) throw new Error('The board isn’t open yet.');
      return boardApi.asset(project, teamOrigin(), id);
    },
    reset() {
      latest++;
      set({ project: null, snapshot: null, loading: false, busy: false, error: null, errorCode: null });
    },
  };
});
