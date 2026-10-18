import type { AgentPhase, AgentRef, AgentStatus } from './shared/workspace/protocol.ts';

/** How long an agent run may last in all, and how long a run whose person's app went away is kept before it is given up. */
export const RUN_HARD_CAP_MS = 15 * 60 * 1000;
export const RUN_ORPHAN_MS = 5 * 60 * 1000;
export const MAX_RUNS_PER_USER = 3;
/**
 * How many of one person's runs are `thinking` at once. Their app decides what really runs together (it has three slots, and one
 * agent at a time in a folder it writes to), so this only has to let the runs it can start begin.
 */
export const RUN_CONCURRENCY = 3;
export const MAX_RUNS_PER_ROOM = 8;

export interface Run {
  runId: string;
  uid: string;
  byName: string;
  reqId: string;
  replyTo: string;
  room?: string;
  session?: string;
  agent: AgentRef;
  startedAt: number;
  /** The order runs arrived in: a person's runs are started in this order. */
  seq: number;
  state: 'queued' | 'thinking';
  /** The connection that is working on it. null: that app is gone, and may come back and take it over. */
  owner: object | null;
  offlineSince: number | null;
  /** Failed attempts to save the reply. */
  failures: number;
  /** Set on a run the server itself drives (an agent on the agent service): stopping it aborts the call. `owner` is nobody's connection then. */
  server?: AbortController;
  /** What a server-run agent is doing now, and one safe line about it. */
  phase?: AgentPhase;
  step?: string;
}

const keyOf = (uid: string, reqId: string) => `${uid}\n${reqId}`;

/**
 * The agent runs in progress, in memory. Of one person's runs the earliest `concurrency` are `thinking` and the rest are `queued`,
 * and the next one is promoted when one ends. Nothing here talks to the network or the database.
 */
export class RunBook {
  private runs = new Map<string, Run>();
  private nextSeq = 1;

  constructor(private concurrency = RUN_CONCURRENCY) {}

  get size() {
    return this.runs.size;
  }

  get(uid: string, reqId: string): Run | undefined {
    return this.runs.get(keyOf(uid, reqId));
  }

  /** A person's runs in the order they will be worked on. */
  byUser(uid: string): Run[] {
    return [...this.runs.values()].filter((r) => r.uid === uid).sort((a, b) => a.seq - b.seq);
  }

  count(uid: string): number {
    return this.byUser(uid).length;
  }

  ownedBy(owner: object): Run[] {
    return [...this.runs.values()].filter((r) => r.owner === owner);
  }

  all(): Run[] {
    return [...this.runs.values()];
  }

  /** Adds a run. Returns the runs whose state changed (including the new one). */
  add(run: Omit<Run, 'state' | 'seq'>): Run[] {
    const r: Run = { ...run, seq: this.nextSeq++, state: 'queued' };
    this.runs.set(keyOf(r.uid, r.reqId), r);
    return this.reorder(r.uid, r);
  }

  /**
   * Removes a run and promotes the next one of that person. Returns the runs whose state changed, or `null` when this run was not
   * the registered one any more (it had already ended): then nothing happens, so ending a run twice is harmless.
   */
  remove(run: Run): Run[] | null {
    const key = keyOf(run.uid, run.reqId);
    if (this.runs.get(key) !== run) return null;
    this.runs.delete(key);
    return this.reorder(run.uid);
  }

  /** Drops all live runs that belong to a session (e.g. when the session is deleted). */
  dropSession(sessionId: string): Run[] {
    const dropped: Run[] = [];
    for (const [key, run] of this.runs) {
      if (run.session === sessionId) {
        this.runs.delete(key);
        dropped.push(run);
      }
    }
    const userIds = new Set(dropped.map((r) => r.uid));
    for (const uid of userIds) this.reorder(uid);
    return dropped;
  }

  /** Makes the first of a person's runs `thinking` (up to the concurrency) and the rest `queued`. `include` is returned even if its state did not change (a new run). */
  private reorder(uid: string, include?: Run): Run[] {
    const changed: Run[] = [];
    this.byUser(uid).forEach((r, i) => {
      const state = i < this.concurrency ? 'thinking' : 'queued';
      if (r.state !== state || r === include) changed.push(r);
      r.state = state;
    });
    return changed;
  }

  /** Runs that have taken too long, or whose app has been gone too long. */
  expired(now: number): { run: Run; reason: 'too_long' | 'offline' }[] {
    const out: { run: Run; reason: 'too_long' | 'offline' }[] = [];
    for (const run of this.runs.values()) {
      if (now - run.startedAt > RUN_HARD_CAP_MS) out.push({ run, reason: 'too_long' });
      else if (run.offlineSince !== null && now - run.offlineSince > RUN_ORPHAN_MS) out.push({ run, reason: 'offline' });
    }
    return out;
  }

  /** What everyone is told about a run. The request id is only for the person who started it (see `statusFor`). */
  status(run: Run, state: AgentStatus['state'] = run.state, reason?: string): AgentStatus {
    return {
      runId: run.runId,
      agent: run.agent,
      by: run.uid,
      byName: run.byName,
      replyTo: run.replyTo,
      state,
      ...(run.room ? { room: run.room } : {}),
      ...(run.session ? { session: run.session } : {}),
      ...(run.offlineSince !== null && (state === 'queued' || state === 'thinking') ? { offline: true } : {}),
      ...(reason ? { reason } : {}),
      ...(run.phase && (state === 'queued' || state === 'thinking') ? { phase: run.phase } : {}),
      ...(run.step && (state === 'queued' || state === 'thinking') ? { step: run.step } : {}),
    };
  }

  /** The same, with the request id, for the person who started the run. */
  statusFor(run: Run, state?: AgentStatus['state'], reason?: string): AgentStatus {
    return { ...this.status(run, state, reason), reqId: run.reqId };
  }

  /** For a person who has just joined: everyone's agents that are still working (request ids only on their own). */
  statuses(forUid?: string): AgentStatus[] {
    return [...this.runs.values()].map((r) => (r.uid === forUid ? this.statusFor(r) : this.status(r)));
  }
}
