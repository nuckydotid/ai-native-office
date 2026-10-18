import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Chip, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger, Skeleton, Spinner } from '@heroui/react';
import { safeLook } from '../pixel/avatar.ts';
import type { AgentStatus } from '../shared/workspace/protocol.ts';
import type { ChatMessage } from '../shared/workspace/types.ts';
import { ArrowDown, CornerDownRight, Ellipsis, HeadAvatar, MarkdownDoc, TextButton, Trash2 } from '../ui';
import { CitationChips, PlanCardView, ProposalCardView, type DecidePayload } from './RoomCards';
import { kindOf } from './core/chatlog.ts';
import { useOffice } from './store';
import { countAfter, nearBottom, planScroll, type Before } from './core/scroll.ts';

export const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/* ───────────── the scrolling list ───────────── */

interface Seen extends Before {
  /** Height of the content when it was last looked at: what an anchored scroll moves by. */
  height: number;
  restarts: number;
}

/**
 * The conversation's scrolling box. It keeps the newest message in view while the person is reading the newest messages,
 * keeps what they are reading where it is when older messages are added above, and offers "New messages" when something
 * arrives while they are reading further up. (`overflow-anchor` is off: the browser's own anchoring would do this twice.)
 */
export function Thread({
  ids,
  lastIsMine,
  restarts,
  top,
  bottom,
  children,
}: {
  /** The message ids in order: what changed tells where the scroll should go. */
  ids: string[];
  lastIsMine: boolean;
  /** Goes up when the whole list was replaced. */
  restarts: number;
  /** Above the first message ("Load earlier"). */
  top?: ReactNode;
  /** Below the last message (agents that are preparing an answer). */
  bottom?: ReactNode;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const seen = useRef<Seen>({ firstId: null, lastId: null, nearBottom: true, height: 0, restarts });
  const [unread, setUnread] = useState(0);
  const first = ids[0] ?? null;
  const last = ids[ids.length - 1] ?? null;
  /** What the list is now, for the part that runs when the page comes back on screen. */
  const now = useRef({ ids, first, last, lastIsMine, restarts });
  now.current = { ids, first, last, lastIsMine, restarts };
  /** The list changed while the page was hidden (a hidden box has no size to measure), so what to do about it waits for the page to show. */
  const waiting = useRef(false);
  /** Where the person was reading, kept because a box that is hidden and shown again starts from the top. */
  const readingAt = useRef(0);

  const plan = () => {
    const el = box.current;
    if (!el) return;
    const { ids: list, first: f, last: l, lastIsMine: mine, restarts: r } = now.current;
    const prev = seen.current;
    const how = planScroll(prev, { firstId: f, lastId: l }, { replaced: r !== prev.restarts, lastIsMine: mine });
    if (how === 'bottom') {
      el.scrollTop = el.scrollHeight;
      setUnread(0);
    } else if (how === 'anchor') {
      el.scrollTop += el.scrollHeight - prev.height;
    } else if (how === 'unread') {
      setUnread((n) => n + countAfter(list, prev.lastId));
    }
    seen.current = { firstId: f, lastId: l, nearBottom: how === 'bottom' ? true : nearBottom(el), height: el.scrollHeight, restarts: r };
    readingAt.current = el.scrollTop;
    useOffice.getState().setAtBottom(seen.current.nearBottom);
  };

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    // Hidden (another page is showing): the box measures as empty, which would look like "at the bottom". Wait until it shows.
    if (el.clientHeight === 0) {
      waiting.current = true;
      return;
    }
    plan();
    // `ids` itself is a new array every render; what matters is the ends of it.
  }, [first, last, ids.length, restarts]);

  // Things that change height without a new message (an agent starts preparing an answer, a long answer is expanded):
  // someone at the bottom stays at the bottom. The same watcher notices the page coming back on screen.
  useEffect(() => {
    const inner = content.current;
    const el = box.current;
    if (!inner || !el) return;
    const watch = new ResizeObserver(() => {
      if (el.clientHeight === 0) return;
      if (waiting.current) {
        waiting.current = false;
        const wasReading = !seen.current.nearBottom;
        const top = readingAt.current;
        plan();
        // Back where they were reading, unless they were at the bottom or the plan moved them on purpose.
        if (wasReading && seen.current.nearBottom === false) el.scrollTop = Math.max(0, top + (el.scrollHeight - seen.current.height));
      } else if (seen.current.nearBottom) el.scrollTop = el.scrollHeight;
      seen.current.height = el.scrollHeight;
    });
    watch.observe(inner);
    watch.observe(el);
    return () => watch.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `plan` reads refs only
  }, []);

  const toBottom = () => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
    setUnread(0);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={box}
        className="wts-no-anchor flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3"
        onScroll={(e) => {
          const el = e.currentTarget;
          // A hidden box reports a scroll to the top; that is not the person reading.
          if (el.clientHeight === 0) return;
          seen.current.nearBottom = nearBottom(el);
          seen.current.height = el.scrollHeight;
          readingAt.current = el.scrollTop;
          useOffice.getState().setAtBottom(seen.current.nearBottom);
          if (seen.current.nearBottom) setUnread(0);
        }}
      >
        <div ref={content} className="flex flex-col gap-3">
          {top}
          {children}
          {bottom}
        </div>
      </div>
      {unread > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
          <Button size="sm" color="primary" variant="shadow" className="pointer-events-auto" startContent={<ArrowDown size={14} />} onPress={toBottom}>
            {unread === 1 ? 'New message' : 'New messages'}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Stands in for the conversation while it is on its way. */
export function ThreadSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-4 px-4 py-4" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex gap-2">
          <Skeleton className="h-9 w-9 shrink-0 rounded-medium" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3 w-24 rounded-small" />
            <Skeleton className="h-8 w-full rounded-medium" />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ───────────── messages ───────────── */

/** A note from the office itself, not from a person. */
export function Note({ children }: { children: ReactNode }) {
  return <p className="mx-auto max-w-72 rounded-medium bg-default-100/60 px-3 py-2 text-center text-tiny text-foreground-500">{children}</p>;
}

/** The text of a message with the agents it called picked out. Only handles the server accepted are highlighted. */
function Words({ text, mentions }: { text: string; mentions: string[] }) {
  if (mentions.length === 0) return <>{text}</>;
  const pattern = new RegExp(`(^|[\\s(])(@(?:${mentions.map((m) => m.replace(/[^a-z0-9-]/g, '')).join('|')}))(?=$|[\\s.,;:!?)])`, 'gi');
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(pattern)) {
    const start = (m.index ?? 0) + m[1].length;
    out.push(<Fragment key={`t${start}`}>{text.slice(at, start)}</Fragment>);
    out.push(
      <span key={`m${start}`} className="rounded-small bg-primary/15 px-1 font-medium text-primary">
        {m[2]}
      </span>,
    );
    at = start + m[2].length;
  }
  out.push(<Fragment key="rest">{text.slice(at)}</Fragment>);
  return <>{out}</>;
}

const LONG = 700;

/** An agent's answer: the words as text, and a "Show more" for a very long one. */
function Answer({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > LONG || text.split('\n').length > 14;
  return (
    <div className="relative">
      <div className={long && !open ? 'max-h-60 overflow-hidden' : ''}>
        <MarkdownDoc text={text} />
      </div>
      {long && !open && <div className="pointer-events-none absolute inset-x-0 bottom-5 h-10 bg-linear-to-t from-default-100 to-transparent" />}
      {long && (
        <div className="mt-1">
          <TextButton onPress={() => setOpen(!open)}>{open ? 'Show less' : 'Show more'}</TextButton>
        </div>
      )}
    </div>
  );
}

export interface MessageRowProps {
  m: ChatMessage;
  you: string | null;
  /** Agents this message called that never answered, with a way to ask them again. */
  unanswered?: { handle: string; name: string }[];
  onRerun?: (handle: string) => void;
  /** One line of the message this one answers (an agent's reply), when it is known. */
  quote?: string;
  canDelete: boolean;
  onDelete: (id: string) => void;
  /** Whether this person may accept or dismiss what an agent proposed here. */
  canDecide?: boolean;
  onDecide?: (id: string, p: DecidePayload) => void;
  /** An agent's display name by handle, for the colleagues a plan names. */
  nameOf?: (handle: string) => string;
}

/** One line of the Room: the author's pixel head and name, the time, and the words in a bubble. */
export function MessageRow({ m, you, unanswered, onRerun, quote, canDelete, onDelete, canDecide = false, onDecide, nameOf = (h) => h }: MessageRowProps) {
  const kind = kindOf(m);
  if (kind === 'system') return <Note>{m.text}</Note>;
  const agent = kind === 'agent';
  const own = !agent && m.from === you;
  const look = safeLook(m.look, m.from);
  return (
    <div className={`group flex gap-2 ${own ? 'flex-row-reverse' : ''}`}>
      <HeadAvatar look={look} name={m.fromName} size="md" />
      <div className={`flex min-w-0 max-w-[85%] flex-col gap-0.5 ${own ? 'items-end' : 'items-start'}`}>
        <div className="flex flex-wrap items-center gap-1 text-tiny text-foreground-400">
          <span className="font-medium text-foreground-600">{own ? 'You' : m.fromName}</span>
          {agent && (
            <Chip size="sm" variant="flat" color="secondary" classNames={{ base: 'h-4', content: 'px-1 text-tiny' }}>
              Agent
            </Chip>
          )}
          <span>· {clock(m.at)}</span>
          {agent && m.viaName && <span>· started by {m.via === you ? 'you' : m.viaName}</span>}
        </div>
        {agent && quote && (
          <p className="flex max-w-full items-center gap-1 text-tiny text-foreground-400">
            <CornerDownRight size={12} className="shrink-0" />
            <span className="truncate">{quote}</span>
          </p>
        )}
        {m.deleted ? (
          <p className="rounded-medium bg-default-100/60 px-3 py-2 text-small italic text-foreground-400">Message deleted</p>
        ) : (
          <>
            <div className={`min-w-0 max-w-full break-words rounded-medium px-3 py-2 text-small ${own ? 'bg-primary/15' : agent ? 'bg-secondary/10' : 'bg-default-100'}`}>
              {agent ? <Answer text={m.text} /> : <p className="whitespace-pre-wrap break-words"><Words text={m.text} mentions={m.mentions ?? []} /></p>}
            </div>
            {m.citations?.length ? <CitationChips citations={m.citations} /> : null}
            {m.ui?.kind === 'proposal' ? <div className="w-full"><ProposalCardView card={m.ui} canDecide={canDecide} onDecide={(p) => onDecide?.(m.id, p)} /></div> : null}
            {m.ui?.kind === 'plan' ? <div className="w-full"><PlanCardView card={m.ui} nameOf={nameOf} /></div> : null}
          </>
        )}
        {own &&
          unanswered?.map((u) => (
            <p key={u.handle} className="flex flex-wrap items-center gap-1 text-tiny text-foreground-400">
              {u.name} hasn’t answered ·
              <TextButton onPress={() => onRerun?.(u.handle)}>Run again</TextButton>
            </p>
          ))}
      </div>
      {canDelete && !m.deleted && (
        <Dropdown placement="bottom-end">
          <DropdownTrigger>
            <Button isIconOnly size="sm" variant="light" aria-label="Message actions" className="self-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[open=true]:opacity-100">
              <Ellipsis size={16} />
            </Button>
          </DropdownTrigger>
          <DropdownMenu aria-label="Message actions" onAction={() => onDelete(m.id)}>
            <DropdownItem key="delete" color="danger" className="text-danger" startContent={<Trash2 size={14} />}>
              Delete message
            </DropdownItem>
          </DropdownMenu>
        </Dropdown>
      )}
    </div>
  );
}

/** A server-run agent's own words for what it is doing, shown under "preparing the answer". */
const PHASE_WORDS: Record<string, string> = {
  queued: 'Waiting its turn',
  thinking: 'Thinking',
  searching: 'Searching the team’s knowledge',
  writing: 'Writing',
  verifying: 'Checking the draft against its sources',
};

/** An agent that has been called and is working on its answer, in the place its answer will appear. */
export function PendingRow({ status, you, onStop }: { status: AgentStatus; you: string | null; onStop?: () => void }) {
  const asker = status.by === you ? 'you' : status.byName;
  const text = status.offline
    ? `${status.byName} is offline, so ${status.agent.name} is waiting`
    : status.state === 'queued'
      ? `${status.agent.name} is waiting for ${asker === 'you' ? 'your' : `${asker}’s`} earlier question`
      : `${status.agent.name} is preparing the answer for ${asker}`;
  const doing = status.step ?? (status.phase ? PHASE_WORDS[status.phase] ?? status.phase : undefined);
  return (
    <div className="flex gap-2" role="status" aria-live="polite">
      <HeadAvatar look={status.agent.look} name={status.agent.name} size="md" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-1 text-tiny text-foreground-400">
          <span className="font-medium text-foreground-600">{status.agent.name}</span>
          <Chip size="sm" variant="flat" color="secondary" classNames={{ base: 'h-4', content: 'px-1 text-tiny' }}>
            Agent
          </Chip>
        </div>
        <div className="flex items-center gap-2 rounded-medium bg-secondary/10 px-3 py-2 text-small text-foreground-500">
          <Spinner variant="dots" size="sm" color="secondary" />
          <span>{text}…</span>
          {onStop && <TextButton onPress={onStop}>Stop</TextButton>}
        </div>
        {doing && !status.offline ? <p className="max-w-full truncate px-1 text-tiny text-foreground-400">{doing}</p> : null}
      </div>
    </div>
  );
}

/** After the person's agent posted its answer: a short time to take it back. */
export function UndoBar({ name, until, onUndo, onExpire }: { name: string; until: number; onUndo: () => void; onExpire: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const left = Math.ceil((until - now) / 1000);
  useEffect(() => {
    if (left <= 0) onExpire();
  }, [left, onExpire]);
  if (left <= 0) return null;
  return (
    <div className="mx-3 mb-1 flex items-center justify-between gap-2 rounded-medium bg-default-100 px-3 py-1.5 text-tiny text-foreground-500" role="status">
      <span>{name}’s answer was posted to the room</span>
      <TextButton onPress={onUndo}>Undo ({left} s)</TextButton>
    </div>
  );
}
