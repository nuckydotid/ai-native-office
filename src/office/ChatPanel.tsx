import { useEffect } from 'react';
import { Alert, Button, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger } from '@heroui/react';
import type { PresenceStatus } from '../shared/workspace/types.ts';
import { Building2, ChevronDown, IconBubble } from '../ui';
import { zoneAt } from '../shared/workspace/layout.ts';
import { isAgentId } from './cast';
import { joinAction } from './connect';
import { RoomChat } from './RoomChat';
import { SessionMenu } from './SessionMenu';
import type { OfficeSession } from './session';
import { useOffice } from './store';

const STATUSES: { id: PresenceStatus; label: string; dot: string }[] = [
  { id: 'available', label: 'Available', dot: 'bg-success' },
  { id: 'focus', label: 'Focusing', dot: 'bg-warning' },
  { id: 'meeting', label: 'In a meeting', dot: 'bg-danger' },
  { id: 'away', label: 'Away', dot: 'bg-default-400' },
];

/** What to tell the person when the team server turned them away. */
function whyFailed(code: string | undefined, message: string | undefined): { title: string; text: string } {
  switch (code) {
    case 'update_required':
      return { title: 'Reload the page', text: message ?? 'This team server needs a newer version of the app.' };
    case 'removed':
      return { title: 'You were removed from this team', text: message ?? 'Ask the team’s owner to invite you again.' };
    case 'not_a_member':
      return { title: 'You’re not on this team yet', text: message ?? 'Ask the team’s founder to invite you.' };
    default:
      return { title: 'Couldn’t join the office', text: message ?? 'Try again in a moment.' };
  }
}

/** The right-hand side of the Office page: who is here, and the Room conversation. */
export function ChatPanel({ session, project }: { session: OfficeSession; project: string }) {
  const people = useOffice((s) => s.people);
  const you = useOffice((s) => s.you);
  const status = useOffice((s) => s.status);
  const notice = useOffice((s) => s.notice);
  const setNotice = useOffice((s) => s.setNotice);
  const roomId = useOffice((s) => s.roomId);
  const zone = useOffice((s) => s.zone);
  const sessions = useOffice((s) => s.sessions);
  const viewingSessionId = useOffice((s) => s.viewingSessionId);
  const mine = people.find((p) => p.id === you);
  const current = STATUSES.find((s) => s.id === (mine?.status ?? 'available')) ?? STATUSES[0];

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(id);
  }, [notice, setNotice]);

  const failed = status.state === 'failed' ? whyFailed(status.code, status.message) : null;

  const map = session.world.map;
  const roomZone = map?.zones.find((z) => z.id === roomId);
  const roomName = zone ?? roomZone?.name ?? (roomId === 'lobby' ? 'Lobby' : roomId);

  const inRoom = people.filter((p) => {
    // The team's agents walk around the office too, but they are not people.
    if (!map || isAgentId(p.id)) return false;
    const z = zoneAt(map, p.x, p.y);
    return z ? z.id === roomId : roomId === 'lobby';
  }).length;

  const activeSession = sessions.find((s) => s.room === roomId && s.state === 'active');
  const viewingSession = viewingSessionId ? sessions.find((s) => s.id === viewingSessionId) : null;
  const isClosed = !activeSession && !viewingSession && sessions.some((s) => s.room === roomId && s.state === 'archived');

  const sessionSubtitle = viewingSession
    ? `session from ${new Date(viewingSession.createdAt).toLocaleDateString([], { day: 'numeric', month: 'short' })} (archived)`
    : activeSession
      ? `session since ${new Date(activeSession.createdAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}`
      : isClosed
        ? 'chat closed'
        : '';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 px-4 pb-2 pt-4">
        <IconBubble color="primary" size="md">
          <Building2 size={18} />
        </IconBubble>
        <div className="min-w-0 flex-1">
          <p className="truncate text-small font-semibold leading-4">{roomName}</p>
          <p className="truncate text-tiny text-foreground-400">
            {inRoom} {inRoom === 1 ? 'person' : 'people'} here{sessionSubtitle ? ` · ${sessionSubtitle}` : ''}
          </p>
        </div>
        <SessionMenu session={session} />
        <Dropdown placement="bottom-end">
          <DropdownTrigger>
            <Button size="sm" variant="flat" startContent={<span className={`h-2 w-2 rounded-full ${current.dot}`} />} endContent={<ChevronDown size={14} />} isDisabled={!mine}>
              {current.label}
            </Button>
          </DropdownTrigger>
          <DropdownMenu aria-label="Your status" selectionMode="single" disallowEmptySelection selectedKeys={[current.id]} onAction={(key) => session.setStatus(String(key) as PresenceStatus)}>
            {STATUSES.map((s) => (
              <DropdownItem key={s.id} startContent={<span className={`h-2 w-2 rounded-full ${s.dot}`} />}>
                {s.label}
              </DropdownItem>
            ))}
          </DropdownMenu>
        </Dropdown>
      </header>

      {failed && (
        <div className="flex flex-col gap-2 px-3 pb-2">
          <Alert color="danger" variant="flat" title={failed.title} description={failed.text} />
          {joinAction(status.code) && (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="flat" onPress={() => session.room.open()}>
                Try again
              </Button>
            </div>
          )}
        </div>
      )}
      {notice && (
        <div className="px-3 pb-2">
          <Alert color="warning" variant="flat" description={notice} isClosable onClose={() => setNotice(null)} />
        </div>
      )}

      <RoomChat session={session} project={project} />
    </div>
  );
}
