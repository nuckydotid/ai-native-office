import { useEffect, useRef, useState } from 'react';
import { Chip, Spinner } from '@heroui/react';
import { attachAgents } from '../ai/cloud.ts';
import { useAgents } from '../agents/store.ts';
import { lookFromSeed } from '../shared/workspace/looks.ts';
import { deskSeat } from '../shared/workspace/props.ts';
import { useChatBridge } from '../sync/chat.ts';
import type { Project } from '../project.ts';
import { Hint, IconButton, Laptop, Minus, Plus, Resizer } from '../ui';
import { ChatPanel } from './ChatPanel';
import { officeAddress } from './connect.ts';
import { idToken } from './team.ts';
import { clampPanel, PANEL_DEFAULT, PANEL_MAX, PANEL_MIN, useOfficeLayout } from './layout';
import { RemoteRoom } from './net/remote.ts';
import { OfficeSession } from './session';
import { useOffice } from './store';
import { WorldCanvas } from './WorldCanvas';
import type { OfficeEngine } from './world/engine';

type Visitor = { email: string; name: string | null };

function connectionChip(state: string, latencyMs?: number) {
  if (state === 'online') return { label: latencyMs === undefined ? 'Team server' : `Team server · ${latencyMs} ms`, color: 'success' as const, hint: 'Connected to the team server.' };
  if (state === 'failed') return { label: 'Disconnected', color: 'danger' as const, hint: 'The team server wouldn’t let you in.' };
  if (state === 'closed') return { label: 'Disconnected', color: 'default' as const, hint: '' };
  return { label: state === 'reconnecting' ? 'Reconnecting…' : 'Connecting…', color: 'warning' as const, hint: 'Reaching the team server.' };
}

// In a development build (`npm run dev`), `__office` lets you look at the office without walking there:
// `__office.teleport(6, 7)` puts you in the lobby, by the reception desk. It is left out of the production build.
function installDevTools(session: OfficeSession) {
  (window as unknown as { __office?: unknown }).__office = {
    session,
    teleport(x: number, y: number) {
      const me = session.world.me;
      if (!me) return;
      me.x = x;
      me.y = y;
      me.sitting = null;
      session.room.send({ t: 'move', x, y, dir: me.dir, moving: false });
    },
  };
}

/** The virtual office: a little pixel world you walk around, and a panel to chat with the people and teammates in it. */
export function OfficeView({ project, user, visible = true, page = 'progress' }: { project: Project; user?: Visitor; visible?: boolean; page?: 'plan' | 'progress' | 'review' }) {
  const email = user?.email ?? project.slug;
  const name = (user?.name || user?.email.split('@')[0] || 'You').slice(0, 32);
  const [session, setSession] = useState<OfficeSession | null>(null);
  const engine = useRef<OfficeEngine | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(1000);
  const panelW = useOfficeLayout((s) => s.panelW);
  const setPanelW = useOfficeLayout((s) => s.setPanelW);
  const status = useOffice((s) => s.status);
  const you = useOffice((s) => s.you);
  const zone = useOffice((s) => s.zone);

  useEffect(() => {
    const look = lookFromSeed(email);
    const room = new RemoteRoom({ url: officeAddress().url, hello: () => ({ name, look }), credential: () => idToken() });
    const next = new OfficeSession({ room });
    // The team server runs the agents; this window shows what they do and walks them around the office.
    const ai = attachAgents(next);
    void useAgents.getState().refresh(project.path);
    next.start();
    setSession(next);
    // A page outside the Office (the demo's guide) can say something in the room through this.
    useChatBridge.getState().setSend(async (text) => {
      const sent = await next.sendChat(text);
      return sent.ok ? { ok: true } : { ok: false, message: sent.message };
    });
    if (import.meta.env.DEV) installDevTools(next);
    return () => {
      useChatBridge.getState().setSend(null);
      ai.stop();
      next.stop();
      setSession(null);
    };
  }, [email, name, project.path]);

  // The sidebar counts what arrives while the page is hidden.
  useEffect(() => {
    useOffice.getState().setVisible(visible);
  }, [visible]);

  // The page the person is on: they are seen there, their character walks to its room, and the chat follows.
  useEffect(() => {
    session?.setPage(page);
  }, [session, page]);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const watch = new ResizeObserver(() => setAvailable(el.clientWidth));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  // The room grows with the team, so the way back to your own zone is a button: it walks there the way a click would.
  const goToMyDesk = () => {
    const world = session?.world;
    const me = world?.me;
    const desk = world?.map?.props.find((p) => p.kind === 'desk' && world.deskOwners.get(p.id) === me?.id);
    if (!desk) return;
    const seat = deskSeat(desk);
    engine.current?.walkTo(seat.x + 0.5, seat.y + 0.5);
  };

  // On a narrow window the chat goes under the picture instead of beside it.
  const stacked = available < 720;
  const width = clampPanel(panelW, available);
  const chip = connectionChip(status.state, status.latencyMs);

  return (
    <div ref={root} className={`flex min-h-0 min-w-0 flex-1 ${stacked ? 'flex-col' : ''} ${visible ? '' : 'hidden'}`}>
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-default-100">
        {session && <WorldCanvas session={session} visible={visible} onZoom={() => {}} onEngine={(e) => (engine.current = e)} />}

        <div className="pointer-events-none absolute left-3 top-3 z-10 flex max-w-[calc(100%-7rem)] flex-wrap items-center gap-2">
          <Hint label={chip.hint} isHidden={!chip.hint} placement="bottom-start">
            <Chip size="sm" variant={chip.color === 'default' ? 'flat' : 'solid'} color={chip.color} className={`pointer-events-auto shadow-small ${chip.color === 'default' ? 'bg-content1' : ''}`}>
              {chip.label}
            </Chip>
          </Hint>
          {zone && (
            <Chip size="sm" variant="solid" color="primary" className="shadow-small">
              {zone}
            </Chip>
          )}
        </div>

        <div className="absolute right-3 top-3 z-10 flex gap-1 rounded-medium bg-content1/90 p-1 shadow-medium">
          <IconButton label="Go to my desk" size="md" onPress={goToMyDesk}>
            <Laptop size={16} />
          </IconButton>
          <IconButton label="Zoom in" keys="+" size="md" onPress={() => engine.current?.zoomBy(1)}>
            <Plus size={16} />
          </IconButton>
          <IconButton label="Zoom out" keys="-" size="md" onPress={() => engine.current?.zoomBy(-1)}>
            <Minus size={16} />
          </IconButton>
        </div>

        <div className="pointer-events-none absolute inset-x-3 bottom-3 z-10 flex flex-wrap items-end justify-between gap-2">
          <Chip size="sm" variant="flat" className="bg-content1/90 shadow-small">
            WASD or arrows to walk · click to go there · E to sit
          </Chip>
        </div>

        {!you && status.state !== 'failed' && (
          <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 text-small text-foreground-500">
            <Spinner size="sm" /> Opening the office…
          </div>
        )}
      </div>
      {!stacked && <Resizer size={width} min={PANEL_MIN} max={PANEL_MAX} panel="after" label="Chat panel" onChange={(w) => setPanelW(clampPanel(w, available))} onReset={() => setPanelW(PANEL_DEFAULT)} />}
      <aside style={stacked ? { height: '48%' } : { width }} className="relative z-10 flex shrink-0 flex-col bg-content1 shadow-medium" aria-label="Office chat">
        {session && <ChatPanel session={session} project={project.path} />}
      </aside>
    </div>
  );
}
