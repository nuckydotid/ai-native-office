import type { PageInput, PagePatch } from '../shared/pages/protocol.ts';
import type { Page } from '../shared/pages/types.ts';
import { teamRequest } from '../team/rest.ts';

/** What the screens ask of the docs: each call is one REST request to the team server. */
export interface DocsApi {
  load(project: string, origin: string): Promise<Page[]>;
  createPage(project: string, origin: string, input: PageInput): Promise<Page>;
  /** `ifUpdatedAt`: refuse the change if the page was changed since the copy this edit was made on. */
  updatePage(project: string, origin: string, id: string, patch: PagePatch & { ifUpdatedAt?: number }): Promise<Page>;
  /** Deleting a page re-parents its subpages; resolves to the whole tree afterwards. */
  deletePage(project: string, origin: string, id: string): Promise<Page[]>;
}

const httpDocs: DocsApi = {
  load: async (_project, origin) => (await teamRequest<{ pages: Page[] }>(origin, '/pages')).pages,
  createPage: async (_project, origin, input) => (await teamRequest<{ page: Page }>(origin, '/pages', { method: 'POST', body: input })).page,
  updatePage: async (_project, origin, id, patch) => (await teamRequest<{ page: Page }>(origin, `/pages/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch })).page,
  deletePage: async (_project, origin, id) => (await teamRequest<{ pages: Page[] }>(origin, `/pages/${encodeURIComponent(id)}`, { method: 'DELETE' })).pages,
};

/** What the screens call. */
export const docsApi: DocsApi = httpDocs;
