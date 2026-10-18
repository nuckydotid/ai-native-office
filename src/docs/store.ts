import { create } from 'zustand';
import type { PageInput, PagePatch } from '../shared/pages/protocol.ts';
import type { Page } from '../shared/pages/types.ts';
import { teamOrigin } from '../team/connect.ts';
import { sentence, TeamRequestError } from '../team/rest.ts';
import { docsApi } from './api.ts';

interface DocsState {
  project: string | null;
  pages: Page[] | null;
  loading: boolean;
  /** A change is in flight. */
  busy: boolean;
  error: string | null;
  /** The server's code for `error`, when it had one. */
  errorCode: string | null;

  /** Reads the pages. A slower answer for another project never replaces a newer one. */
  load(project: string): Promise<void>;
  createPage(input: PageInput): Promise<Page>;
  updatePage(id: string, patch: PagePatch & { ifUpdatedAt?: number }): Promise<void>;
  deletePage(id: string): Promise<void>;
  reset(): void;
}

let latest = 0;

export const useDocs = create<DocsState>((set, get) => {
  const change = async (run: (project: string, origin: string) => Promise<unknown>) => {
    const { project } = get();
    if (!project) throw new Error('The docs aren’t open yet.');
    set({ busy: true, error: null });
    try {
      await run(project, teamOrigin());
      const pages = await docsApi.load(project, teamOrigin());
      if (get().project === project) set({ pages });
    } finally {
      set({ busy: false });
    }
  };

  return {
    project: null,
    pages: null,
    loading: false,
    busy: false,
    error: null,
    errorCode: null,

    async load(project) {
      const ticket = ++latest;
      if (get().project !== project) set({ project, pages: null, loading: true, error: null, errorCode: null });
      else set({ loading: true, error: null, errorCode: null });
      try {
        const pages = await docsApi.load(project, teamOrigin());
        if (ticket === latest) set({ pages, loading: false });
      } catch (e) {
        if (ticket === latest) set({ loading: false, error: sentence(e), errorCode: e instanceof TeamRequestError ? e.code : null });
      }
    },

    async createPage(input) {
      let created: Page | null = null;
      await change(async (project, origin) => {
        created = await docsApi.createPage(project, origin, input);
      });
      if (!created) throw new Error('The page was not created.');
      return created;
    },
    updatePage: (id, patch) => change((project, origin) => docsApi.updatePage(project, origin, id, patch)),
    deletePage: (id) => change((project, origin) => docsApi.deletePage(project, origin, id)),

    reset() {
      latest++;
      set({ project: null, pages: null, loading: false, busy: false, error: null, errorCode: null });
    },
  };
});
