import { useMemo } from 'react';
import { Button } from '@heroui/react';
import { agentReplyId } from '../shared/workspace/chat.ts';
import { LIMITS } from '../shared/workspace/protocol.ts';
import { findAgent } from '../agents/format.ts';
import { useAgents } from '../agents/store.ts';
import { Building2 } from '../ui';
import { Composer } from './Composer';
import { kindOf } from './core/chatlog.ts';
import { MessageRow, PendingRow, Thread, ThreadSkeleton, UndoBar } from './chatParts';
import type { OfficeSession } from './session';
import { useOffice } from './store';

const oneLine = (text: string, max = 80) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/** The Room: everything the team has said here, saved in the team database, newest at the bottom. */
export function RoomChat({ session, project }: { session: OfficeSession; project: string }) {
  const chat = useOffice((s) => s.chat);
  const you = useOffice((s) => s.you);
  const role = useOffice((s) => s.role);
  const loaded = useOffice((s) => s.loaded);
  const more = useOffice((s) => s.historyHasMore);
  const loadingEarlier = useOffice((s) => s.loadingEarlier);
  const restarts = useOffice((s) => s.restarts);
  const pending = useOffice((s) => s.pending);
  const online = useOffice((s) => s.status.state === 'online');
  const myRuns = useOffice((s) => s.myRuns);
  const undo = useOffice((s) => s.undo);
  const setUndo = useOffice((s) => s.setUndo);
  const roomId = useOffice((s) => s.roomId);
  const sessions = useOffice((s) => s.sessions);
  const viewingSessionId = useOffice((s) => s.viewingSessionId);
  const agents = useAgents((s) => s.listing);

  const activeSession = sessions.find((s) => s.room === roomId && s.state === 'active');
  const viewingSession = viewingSessionId ? sessions.find((s) => s.id === viewingSessionId) : null;
  const isClosed = !activeSession && !viewingSession && sessions.some((s) => s.room === roomId && s.state === 'archived');

  const ids = useMemo(() => chat.map((m) => m.id), [chat]);
  const byId = useMemo(() => new Map(chat.map((m) => [m.id, m])), [chat]);
  const last = chat[chat.length - 1];
  const admin = role === 'owner' || role === 'admin';
  const nameOf = (handle: string) => findAgent(agents, handle)?.displayName ?? handle;

  if (!loaded) return <ThreadSkeleton />;

  /** Agents my message called that have not answered, are not working on it, and can still be asked (the server's limit is a day). */
  const unansweredFor = (m: (typeof chat)[number]) => {
    if (kindOf(m) !== 'human' || m.from !== you || m.deleted || Date.now() - m.at > 24 * 3600_000) return undefined;
    const out: { handle: string; name: string }[] = [];
    for (const handle of m.mentions ?? []) {
      const agent = findAgent(agents, handle);
      const working = myRuns.includes(`${m.id}:${handle}`) || pending.some((p) => p.replyTo === m.id && p.agent.handle === handle);
      // An answer that was taken back counts as no answer: the asker may ask again (the server saves the new answer under the same id).
      const reply = byId.get(agentReplyId(m.id, handle));
      if (agent && !working && (!reply || reply.deleted)) out.push({ handle, name: agent.displayName });
    }
    return out.length ? out : undefined;
  };

  return (
    <>
      <Thread
        ids={ids}
        restarts={restarts}
        lastIsMine={!!last && kindOf(last) === 'human' && last.from === you}
        top={
          more ? (
            <Button size="sm" variant="flat" className="self-center" isLoading={loadingEarlier} onPress={() => session.loadEarlier()}>
              Load earlier messages
            </Button>
          ) : chat.length > 0 ? (
            <p className="self-center text-tiny text-foreground-400">This is the start of the conversation.</p>
          ) : null
        }
        bottom={
          <>
            {pending.map((p) => (
              <PendingRow key={p.runId} status={p} you={you} onStop={p.by === you && myRuns.includes(`${p.replyTo}:${p.agent.handle}`) && session.runner?.canStop?.(p.replyTo, p.agent.handle) !== false ? () => session.runner?.stopRun(p.replyTo, p.agent.handle) : undefined} />
            ))}
          </>
        }
      >
        {chat.length === 0 ? (
          <div className="m-auto flex max-w-56 flex-col items-center gap-2 rounded-medium bg-default-100/60 px-4 py-3 text-center text-small text-foreground-500">
            <Building2 size={20} />
            {viewingSession
              ? 'Nothing in this archived session.'
              : isClosed
                ? 'This room’s chat is closed. The owner can start a new session.'
                : 'Nothing here yet. Say hello to the team, or mention an agent with @.'}
          </div>
        ) : (
          chat.map((m) => {
            const target = m.replyTo ? byId.get(m.replyTo) : undefined;
            return (
              <MessageRow
                key={m.id}
                m={m}
                you={you}
                unanswered={unansweredFor(m)}
                onRerun={(handle) => session.runner?.rerun(m, handle)}
                quote={m.replyTo ? (target && !target.deleted ? `${target.fromName}: ${oneLine(target.text)}` : 'a message') : undefined}
                // The person who asked may take an agent's answer back for a minute (the server's rule); admins may remove anything.
                canDelete={admin || (kindOf(m) === 'agent' && m.via === you && Date.now() - m.at <= LIMITS.undoMs)}
                onDelete={(id) => session.deleteMessage(id)}
                // What an agent proposed here: the person who asked (or an admin) accepts; the server creates it as them.
                canDecide={admin || m.via === you}
                onDecide={(id, p) => session.decideProposal(id, p.decision, p.chosen)}
                nameOf={nameOf}
              />
            );
          })
        )}
      </Thread>
      {undo && <UndoBar key={undo.id} name={undo.name} until={undo.until} onUndo={() => (session.deleteMessage(undo.id), setUndo(null))} onExpire={() => setUndo(null)} />}
      {viewingSession && (
        <div className="mx-3 mb-1 flex items-center justify-between gap-2 rounded-medium bg-default-100/60 px-3 py-2 text-small">
          <span className="text-foreground-500">
            Viewing archived session from {new Date(viewingSession.createdAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}.
          </span>
          <Button size="sm" variant="flat" onPress={() => session.viewArchivedSession(null)}>
            Back to live chat
          </Button>
        </div>
      )}
      {isClosed && (
        <div className="mx-3 mb-1 flex items-center justify-between gap-2 rounded-medium bg-default-100/60 px-3 py-2 text-small">
          <span className="text-foreground-500">
            This room’s chat is closed. The owner can start a new session.
          </span>
          {role === 'owner' && (
            <Button size="sm" color="primary" variant="flat" onPress={() => session.newSession(roomId)}>
              Start a new session
            </Button>
          )}
        </div>
      )}
      <Composer
        session={session}
        project={project}
        isDisabled={!online || isClosed || !!viewingSession}
        placeholder={isClosed ? 'This room’s chat is closed' : viewingSession ? 'Viewing archived session (read-only)' : 'Message the team (@ to ask an agent)'}
      />
    </>
  );
}
