import { currentListing } from '../agents/store.ts';
import { agentLook, findAgent } from '../agents/format.ts';
import { useDemo } from '../demo/store.ts';
import { AgentCast } from '../office/cast.ts';
import { kindOf } from '../office/core/chatlog.ts';
import type { OfficeSession, RunControls } from '../office/session.ts';
import { useOffice } from '../office/store.ts';
import { MAX_MENTIONS } from '../shared/workspace/chat.ts';
import { lookFromSeed } from '../shared/workspace/looks.ts';
import type { AgentRef, AgentStartMode, AgentStatus } from '../shared/workspace/protocol.ts';
import type { ChatMessage } from '../shared/workspace/types.ts';

/**
 * Starts an agent that the team server runs. The browser sends the `agent.start` of the protocol and then only watches: the server
 * says what the agent is doing (`agent.status`) and posts the answer as a chat message, citations and cards included. Nothing runs
 * in this window, and nothing about the agent goes through it.
 */
export class ServerRunner implements RunControls {
  /** The runs this window asked for and the server has not finished: `<question id>:<handle>` → its request id and agent. */
  private runs = new Map<string, { reqId: string; name: string }>();
  /** Messages already turned into runs, so an echo seen twice (or a reconnect) does not start them again. */
  private handled = new Set<string>();
  private off: (() => void)[] = [];

  constructor(private session: OfficeSession) {
    const { events } = session;
    this.off.push(
      events.chat.on((m) => this.onChat(m)),
      events.status.on((s) => this.onStatus(s)),
      events.error.on((e) => this.onError(e)),
      // After a reconnect the server tells everything it is still running (`thinking`); what this window remembers is let go.
      events.welcome.on(() => {
        this.runs.clear();
        this.publish();
      }),
    );
  }

  stop() {
    for (const off of this.off.splice(0)) off();
    this.runs.clear();
    this.publish();
  }

  /** A run on the server is the server's: this window has nothing to stop. */
  canStop(): boolean {
    return false;
  }

  stopRun() {}

  /** "Run again" on one of the person's older questions. */
  rerun(message: ChatMessage, handle: string): boolean {
    const you = useOffice.getState().you;
    if (kindOf(message) !== 'human' || message.from !== you || message.deleted || !(message.mentions ?? []).includes(handle)) return false;
    if (this.runs.has(`${message.id}:${handle}`)) return false;
    return this.begin(message, handle, 'rerun');
  }

  private onChat(m: ChatMessage) {
    const store = useOffice.getState();
    if (kindOf(m) !== 'human' || m.from !== store.you || m.deleted || !this.session.sentHere(m.cid) || this.handled.has(m.id)) return;
    this.handled.add(m.id);
    for (const handle of (m.mentions ?? []).slice(0, MAX_MENTIONS)) this.begin(m, handle, 'fresh');
  }

  private begin(m: ChatMessage, handle: string, mode: Extract<AgentStartMode, 'fresh' | 'rerun'>): boolean {
    const agent = findAgent(currentListing(), handle);
    // The roster may not be here yet; the server knows the agent by its handle and fills in the rest.
    const ref: AgentRef = agent
      ? { handle, name: agent.displayName.trim() || handle, ...(agent.role.trim() ? { role: agent.role.trim() } : {}), look: agentLook(agent) }
      : { handle, name: handle, look: lookFromSeed(`agent:${handle}`) };
    const reqId = `q${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    if (!this.session.room.send({ t: 'agent.start', reqId, replyTo: m.id, agent: ref, mode })) {
      useOffice.getState().setNotice('You’re not connected to the office right now.');
      return false;
    }
    this.runs.set(`${m.id}:${handle}`, { reqId, name: ref.name });
    this.publish();
    return true;
  }

  private onStatus(s: AgentStatus) {
    if (s.by !== useOffice.getState().you || !s.reqId) return;
    const key = `${s.replyTo}:${s.agent.handle}`;
    if (this.runs.get(key)?.reqId !== s.reqId) return;
    if (s.state === 'queued' || s.state === 'thinking') return;
    this.runs.delete(key);
    this.publish();
    // The runs left have changed: the strip at the top says how many remain.
    void useDemo.getState().refresh();
    // A run that failed has already said why in the chat (the server posts a line for it, and "Run again" is offered).
    if (s.state === 'expired') useOffice.getState().setNotice(`${s.agent.name} ran out of time answering. Use Run again to ask once more.`);
  }

  private onError(e: { code: string; message: string; reqId?: string }) {
    const found = [...this.runs.entries()].find(([, r]) => r.reqId === e.reqId);
    if (!found) return;
    this.runs.delete(found[0]);
    this.publish();
    void useDemo.getState().refresh();
    // The server's own sentence (the demo's budget, too many runs at once, busy): it is already worded for a person.
    useOffice.getState().setNotice(e.message);
  }

  private publish() {
    useOffice.getState().setMyRuns([...this.runs.keys()]);
  }
}

/**
 * The agents: the team server runs them on Gemini (through its agent service) and this window only shows what happens. The agents
 * are also characters in the office: they walk to the room a question was asked in while they work on it.
 */
export function attachAgents(session: OfficeSession): { stop(): void } {
  const runner = new ServerRunner(session);
  session.runner = runner;
  const cast = new AgentCast(session);
  cast.start();
  return {
    stop: () => {
      runner.stop();
      cast.stop();
    },
  };
}
