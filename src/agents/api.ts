import { teamRequest } from '../team/rest.ts';
import { demoOrigin } from '../web.ts';
import type { AgentFile, Listing } from './format.ts';
import { EMPTY_LISTING } from './format.ts';
import { listingFromWire, wireFromAgent } from './wire.ts';

/** What the screens ask of the agents. They live on the team server (`GET /agents`, `PUT /agents/:handle`): they can be changed, not added or removed. */
export interface AgentsApi {
  list(project: string): Promise<Listing>;
  saveAgent(project: string, agent: AgentFile): Promise<void>;
}

let lastListing: Listing = EMPTY_LISTING;
const webAgents: AgentsApi = {
  list: async () => (lastListing = listingFromWire((await teamRequest<{ agents?: unknown }>(demoOrigin(), '/agents')).agents)),
  saveAgent: async (_project, agent) => {
    await teamRequest(demoOrigin(), `/agents/${encodeURIComponent(agent.handle)}`, { method: 'PUT', body: wireFromAgent(agent, lastListing) });
  },
};

let current: AgentsApi = webAgents;

/** Swaps what the screens talk to (tests bring their own). */
export function setAgentsApi(next: AgentsApi | null) {
  current = next ?? webAgents;
}

/** What the screens call: it forwards to whichever implementation is current. */
export const agentsApi: AgentsApi = {
  list: (p) => current.list(p),
  saveAgent: (p, a) => current.saveAgent(p, a),
};
