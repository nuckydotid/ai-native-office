import { fileURLToPath } from 'node:url';
import type { AiServices } from '../ai/services.ts';
import type { CollabStore } from '../collab-store.ts';
import { log } from '../log.ts';
import type { Office } from '../office.ts';
import type { Pipeline } from '../pipeline/service.ts';
import { OFFICE_ID } from '../store.ts';
import type { Store } from '../store.ts';
import { loadSeed, writeSeed } from './seed.ts';
import type { SeedData } from './seed.ts';

/** The repository's own seed folder, for a run from a checkout (a container is told where its copy is with `DEMO_DATA_DIR`). */
const CHECKOUT_SEED = fileURLToPath(new URL('../../../../../docs/demo-data/', import.meta.url));

const GUEST_IDLE_MS = 45 * 60_000;
const MAX_GUEST_MEMBERS = 60;
const PRUNE_EVERY_MS = 5 * 60_000;

export interface DemoOptions {
  store: Store;
  collabStore: CollabStore;
  office: Office;
  ai: AiServices | null;
  /** The delivery pipeline, when it is on: seeded tickets join it, and a reset puts its side back too. */
  pipeline?: Pipeline | null;
  /** The seed folder (`docs/demo-data`), or undefined for the built-in one. Tests pass the data itself. */
  dataDir?: string;
  seed?: SeedData;
  now?: () => number;
}

/**
 * The hosted demo's keeper: puts the synthetic workspace in an empty store, takes it back to that state on request (the nightly
 * reset), and sends away the guests who have not been seen for a while, so the office does not fill with rooms nobody uses.
 */
export class Demo {
  private seed: SeedData;
  private standup: { uid: string; text: string }[] = [];
  private busy: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private now: () => number;

  constructor(private o: DemoOptions) {
    this.seed = o.seed ?? loadSeed(o.dataDir ?? CHECKOUT_SEED);
    this.now = o.now ?? Date.now;
  }

  /** The scripted standup, as the lines to play into a room. */
  standupLines() {
    return this.standup;
  }

  /** Resolves when no seed or reset is running (a person who joins during a reset waits for it). */
  settled(): Promise<void> {
    return this.busy;
  }

  /** Seeds an empty store and starts the guest sweep. Resolves before the agent service has indexed anything (it may be asleep). */
  async start() {
    const [ws, members] = await Promise.all([this.o.store.getWorkspace(OFFICE_ID), this.o.store.listMembers(OFFICE_ID)]);
    if (!ws || members.length === 0) await this.run(() => this.populate());
    else {
      // A restart that kept the data (a database behind it): the agents are the seed's, and the index is brought up to date.
      this.o.ai?.agents.replaceAll(this.seed.agents);
      this.standup = this.lines();
      void this.reindex();
    }
    this.timer ??= setInterval(() => void this.prune().catch((e) => log.warn('sweeping guests failed', { err: String(e) })), PRUNE_EVERY_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Back to the seed: everyone is sent away (they come back to a fresh office), the stores are emptied and written again. */
  async reset() {
    await this.run(async () => {
      await this.o.office.reset();
      await this.o.store.clearAll();
      await this.o.collabStore.clearAll();
      this.o.ai?.budget.reset();
      await this.o.pipeline?.reset();
      await this.populate();
    });
    log.info('the demo was reset');
  }

  private run(job: () => Promise<void>): Promise<void> {
    const next = this.busy.then(job, job);
    this.busy = next.catch(() => {});
    return next;
  }

  private lines() {
    return this.seed.standup.messages.filter((m) => this.seed.members.some((x) => x.handle === m.who)).map((m) => ({ uid: `seed-${m.who}`, text: m.text }));
  }

  private async populate() {
    const done = await writeSeed(this.o.store, this.o.collabStore, this.seed, this.now(), { pipeline: !!this.o.pipeline });
    this.standup = done.standup;
    this.o.ai?.agents.replaceAll(this.seed.agents);
    void this.reindex();
  }

  /** Gives the agent service everything the agents may know. In the background: it may need a minute to wake up. */
  private async reindex() {
    const ai = this.o.ai;
    if (!ai?.knowledge) return;
    try {
      const n = await ai.knowledge.reindex(await ai.snapshot());
      log.info('the knowledge index was rebuilt', { items: n });
    } catch (e) {
      log.warn('rebuilding the knowledge index failed', { err: String(e) });
    }
  }

  /** Removes guests who left a while ago, and the oldest ones when there are too many. Never someone who is connected. */
  async prune() {
    const room = this.o.office.current();
    if (!room) return;
    const t = this.now();
    const guests = room.listMembers().filter((m) => m.uid.startsWith('guest-') && !m.online).sort((a, b) => a.lastSeen - b.lastSeen);
    const all = room.listMembers().filter((m) => m.uid.startsWith('guest-')).length;
    let excess = Math.max(0, all - MAX_GUEST_MEMBERS);
    for (const g of guests) {
      if (t - g.lastSeen > GUEST_IDLE_MS || excess > 0) {
        if (excess > 0) excess -= 1;
        await room.removeMember(g.uid).catch((e) => log.warn('removing a guest failed', { err: String(e) }));
      }
    }
  }
}
