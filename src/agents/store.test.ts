import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { setAgentsApi } from './api.ts';
import type { AgentsApi } from './api.ts';
import { newAgent } from './format.ts';
import type { Listing } from './format.ts';
import { useAgents } from './store.ts';

const listingOf = (...handles: string[]): Listing => ({ agents: handles.map((h) => newAgent(h, h)), skills: [], problems: [] });

function fake(over: Partial<AgentsApi> = {}): AgentsApi {
  return {
    list: async () => listingOf(),
    saveAgent: async () => {},
    ...over,
  };
}

/** Lets the calls started so far reach the fake API (the real one looks up its implementation first). */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  setAgentsApi(null);
  useAgents.getState().reset();
});

describe('the agents store', () => {
  test('reads the agents and keeps them', async () => {
    setAgentsApi(fake({ list: async () => listingOf('john', 'planner') }));
    const pending = useAgents.getState().refresh('/p');
    assert.equal(useAgents.getState().loading, true);
    await pending;
    const s = useAgents.getState();
    assert.deepEqual(s.listing.agents.map((a) => a.handle), ['john', 'planner']);
    assert.equal(s.loading, false);
    assert.equal(s.project, '/p');
  });

  test('a slow older answer never replaces a newer one', async () => {
    const waiting: Array<(l: Listing) => void> = [];
    setAgentsApi(fake({ list: () => new Promise<Listing>((resolve) => waiting.push(resolve)) }));
    const first = useAgents.getState().refresh('/p');
    const second = useAgents.getState().refresh('/p');
    await settle();
    waiting[1](listingOf('new'));
    await second;
    waiting[0](listingOf('old'));
    await first;
    assert.deepEqual(useAgents.getState().listing.agents.map((a) => a.handle), ['new']);
  });

  test('switching project clears the old agents at once, and an answer for the old project is dropped', async () => {
    const waiting: Array<(l: Listing) => void> = [];
    setAgentsApi(fake({ list: () => new Promise<Listing>((resolve) => waiting.push(resolve)) }));
    const a = useAgents.getState().refresh('/a');
    await settle();
    waiting[0](listingOf('from-a'));
    await a;
    const b = useAgents.getState().refresh('/b');
    assert.deepEqual(useAgents.getState().listing.agents, [], 'the other project’s agents are not shown meanwhile');
    await settle();
    waiting[1](listingOf('from-b'));
    await b;
    assert.deepEqual(useAgents.getState().listing.agents.map((x) => x.handle), ['from-b']);
  });

  test('a failure is kept as a message and the previous listing stays', async () => {
    setAgentsApi(fake({ list: async () => listingOf('john') }));
    await useAgents.getState().refresh('/p');
    setAgentsApi(fake({ list: async () => Promise.reject(new Error('not one of your projects')) }));
    await useAgents.getState().refresh('/p');
    const s = useAgents.getState();
    assert.equal(s.error, 'not one of your projects');
    assert.equal(s.listing.agents.length, 1);
  });

  test('saving reads the agents again, and a refused save is passed on', async () => {
    let saved = 0;
    let files = listingOf();
    setAgentsApi(
      fake({
        list: async () => files,
        saveAgent: async (_p, agent) => {
          if (agent.handle === 'bad') throw new Error('The handle is not allowed');
          saved++;
          files = listingOf(agent.handle);
        },
      }),
    );
    await useAgents.getState().saveAgent('/p', newAgent('john', 'John'));
    assert.equal(saved, 1);
    assert.deepEqual(useAgents.getState().listing.agents.map((a) => a.handle), ['john']);
    await assert.rejects(useAgents.getState().saveAgent('/p', newAgent('bad', 'Bad')), /not allowed/);
  });
});
