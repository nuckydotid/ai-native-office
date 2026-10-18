import type { Collab } from '../collab.ts';
import type { CollabStore } from '../collab-store.ts';
import type { Config } from '../config.ts';
import { OFFICE_ID } from '../store.ts';
import type { Store } from '../store.ts';
import type { IndexItem, RunRequest } from '../shared/ai/types.ts';
import { AI_LIMITS } from '../shared/ai/types.ts';
import type { ProposalItem } from '../shared/workspace/types.ts';
import { AgentRegistry } from './agents.ts';
import { RunBudget } from './budget.ts';
import { HttpAgentClient, IdTokenSource, OfflineAgentClient } from './client.ts';
import type { AgentClient } from './client.ts';
import { DEFAULT_AGENTS } from './default-agents.ts';
import { KnowledgeSink, pageItem, ticketItem } from './knowledge.ts';

/** What the rooms need from the AI side: who the agents are, how to ask them, what they may spend, and what a person's "accept" creates. */
export interface AiServices {
  agents: AgentRegistry;
  client: AgentClient;
  budget: RunBudget;
  /** This server's own address, which the agent service's tools call back. */
  webBase: string;
  /** Null when no agent service is configured (nothing to keep current). */
  knowledge: KnowledgeSink | null;
  /** The board and the docs as a short list, for a run's context. */
  context(): Promise<RunRequest['context']>;
  /** Creates what a person accepted from a proposal. `ref` is `#12` for a ticket and the page id for a page. */
  apply(uid: string, item: ProposalItem): Promise<{ ref: string }>;
  /** Everything the agent may know, for a full reindex. */
  snapshot(): Promise<IndexItem[]>;
  /** A person's id to their name (tickets are assigned by id; the agent reads names). */
  people(): Promise<Map<string, string>>;
}

export interface AiServicesOptions {
  cfg: Config;
  collab: Collab;
  store: Store;
  collabStore: CollabStore;
  client?: AgentClient;
  agents?: AgentRegistry;
  budget?: RunBudget;
  knowledge?: KnowledgeSink | null;
  /** The `fetch` the agent client and the knowledge index use (tests pass a fake). */
  fetchFn?: typeof fetch;
}

/** The name of the page that proposals for documents land under. */
export const MEETINGS_TITLE = 'Meetings';

export function createAiServices(o: AiServicesOptions): AiServices {
  const { cfg, collab, store, collabStore } = o;
  const tokens = new IdTokenSource(o.fetchFn);
  const client = o.client ?? (cfg.agentServiceUrl ? new HttpAgentClient({ base: cfg.agentServiceUrl, auth: cfg.agentServiceAuth, tokens, fetchFn: o.fetchFn }) : new OfflineAgentClient());

  const people = async () => new Map((await store.listMembers(OFFICE_ID)).map((m) => [m.uid, m.name]));

  const knowledge =
    o.knowledge !== undefined
      ? o.knowledge
      : cfg.agentServiceUrl
        ? new KnowledgeSink({
            base: cfg.agentServiceUrl,
            auth: cfg.agentServiceAuth,
            tokens,
            fetchFn: o.fetchFn,
            backoff: o.fetchFn ? [10, 20] : undefined,
            source: {
              issue: async (id) => (await collabStore.listIssues(OFFICE_ID)).find((i) => i.id === id || String(i.key) === id) ?? null,
              page: (id) => collabStore.getPage(OFFICE_ID, id),
              people,
            },
          })
        : null;

  return {
    agents: o.agents ?? new AgentRegistry(DEFAULT_AGENTS),
    client,
    budget: o.budget ?? new RunBudget(cfg.runsPerGuestHour, cfg.runsPerDay),
    webBase: cfg.publicUrl || `http://127.0.0.1:${cfg.port}`,
    knowledge,
    people,

    async context() {
      const [{ issues }, pages, names] = await Promise.all([collab.board(OFFICE_ID), collab.pages(OFFICE_ID), people()]);
      const rank = { in_progress: 0, review: 1, todo: 2, done: 3 } as const;
      const board = [...issues]
        .sort((a, b) => rank[a.status] - rank[b.status] || b.key - a.key)
        .slice(0, AI_LIMITS.board)
        .map((i) => ({
          key: i.key,
          title: i.title,
          status: i.status,
          ...(i.assignee && names.get(i.assignee) ? { assignee: names.get(i.assignee) as string } : {}),
          ...(i.pr ? { pr: i.pr } : {}),
        }));
      const docs = pages.slice(0, AI_LIMITS.docs).map((p) => ({ id: p.id, title: p.title, ...(p.parent ? { parent: p.parent } : {}) }));
      return { board, docs };
    },

    async apply(uid, item) {
      // An artifact is accepted by the pipeline (it binds the approval to a digest), never turned into a page here.
      if (item.type === 'artifact') throw new Error('artifact items are accepted by the pipeline');
      if (item.type === 'ticket') {
        const issue = await collab.createIssue(OFFICE_ID, uid, {
          title: item.title,
          body: item.body,
          ...(item.labels?.length ? { labels: item.labels } : {}),
          ...(item.points ? { points: item.points } : {}),
        });
        return { ref: `#${issue.key}` };
      }
      const pages = await collab.pages(OFFICE_ID);
      const parent = pages.find((p) => p.parent === null && p.title === MEETINGS_TITLE) ?? (await collab.createPage(OFFICE_ID, uid, { title: MEETINGS_TITLE, body: 'Minutes and notes written with the team’s AI colleagues.' }));
      const page = await collab.createPage(OFFICE_ID, uid, { title: item.title, body: item.body, parent: parent.id });
      return { ref: page.id };
    },

    async snapshot() {
      const [issues, pages, names] = await Promise.all([collabStore.listIssues(OFFICE_ID), collabStore.listPages(OFFICE_ID), people()]);
      return [...pages.map(pageItem), ...issues.map((i) => ticketItem(i, names))];
    },
  };
}
