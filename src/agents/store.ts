import { create } from 'zustand';
import { agentsApi } from './api.ts';
import { EMPTY_LISTING } from './format.ts';
import type { AgentFile, Listing } from './format.ts';

interface AgentsState {
  /** The project the listing is for. */
  project: string | null;
  listing: Listing;
  /** True until the first listing of a project has arrived. */
  loading: boolean;
  /** Why the agents couldn't be read. */
  error: string | null;

  /** Reads the agents again. A slower answer for a project (or an earlier call) never replaces a newer one. */
  refresh(project: string): Promise<void>;
  saveAgent(project: string, agent: AgentFile): Promise<void>;
  reset(): void;
}

let latest = 0;

export const useAgents = create<AgentsState>((set, get) => ({
  project: null,
  listing: EMPTY_LISTING,
  loading: false,
  error: null,

  async refresh(project) {
    const ticket = ++latest;
    if (get().project !== project) set({ project, listing: EMPTY_LISTING, loading: true, error: null });
    try {
      const listing = await agentsApi.list(project);
      if (ticket === latest) set({ project, listing, loading: false, error: null });
    } catch (e) {
      if (ticket === latest) set({ project, loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },
  async saveAgent(project, agent) {
    await agentsApi.saveAgent(project, agent);
    await get().refresh(project);
  },
  reset() {
    latest++;
    set({ project: null, listing: EMPTY_LISTING, loading: false, error: null });
  },
}));

/** The agents right now, for code outside React (the mention runner). */
export const currentListing = (): Listing => useAgents.getState().listing;
