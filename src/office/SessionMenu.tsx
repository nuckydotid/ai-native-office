import { useState } from 'react';
import { addToast, Button, Chip, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@heroui/react';
import type { SessionInfo } from '../shared/workspace/types.ts';
import { Archive, Ellipsis, FileText, History, Plus, Trash2 } from '../ui';
import { endMeeting } from '../demo/actions.ts';
import type { OfficeSession } from './session';
import { useOffice } from './store';

const when = (at: number) =>
  new Date(at).toLocaleDateString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function SessionMenu({ session }: { session: OfficeSession }) {
  const roomId = useOffice((s) => s.roomId);
  const zone = useOffice((s) => s.zone);
  const sessions = useOffice((s) => s.sessions);
  const role = useOffice((s) => s.role);
  const serverProtocol = useOffice((s) => s.serverProtocol);
  const viewingSessionId = useOffice((s) => s.viewingSessionId);

  const [deleting, setDeleting] = useState<SessionInfo | null>(null);
  const [pastOpen, setPastOpen] = useState(false);

  if (role !== 'owner' || serverProtocol < 3) return null;

  const roomName = zone || (roomId === 'lobby' ? 'Lobby' : roomId);
  const activeSession = sessions.find((s) => s.room === roomId && s.state === 'active');
  const pastSessions = sessions.filter((s) => s.room === roomId && s.state === 'archived');

  const onAction = (key: string) => {
    switch (key) {
      case 'new':
        session.newSession(roomId);
        break;
      case 'minutes':
        if (activeSession) void closeMeeting(activeSession);
        break;
      case 'archive':
        if (activeSession) session.archiveSession(roomId);
        break;
      case 'delete-active':
        if (activeSession) setDeleting(activeSession);
        break;
      case 'past':
        setPastOpen(true);
        break;
    }
  };

  /** "End meeting" (the hosted demo): the Scribe writes the minutes of this conversation and proposes tickets for what is still open. */
  const closeMeeting = async (active: SessionInfo) => {
    const result = await endMeeting(roomId, active.id);
    if (!result.ok) return void addToast({ title: 'Couldn’t end the meeting', description: result.message, color: 'danger' });
    addToast({ title: 'The Scribe is writing the minutes', description: 'They appear in the chat in a moment, with the tickets it proposes. Nothing is created until you accept.', color: 'success', timeout: 6000 });
  };

  const confirmDelete = () => {
    if (!deleting) return;
    session.deleteSession(deleting.id);
    setDeleting(null);
  };

  return (
    <>
      <Dropdown placement="bottom-end">
        <DropdownTrigger>
          <Button size="sm" variant="flat" isIconOnly aria-label="Session options">
            <Ellipsis size={15} />
          </Button>
        </DropdownTrigger>
        <DropdownMenu aria-label="Session actions" onAction={(key) => onAction(String(key))}>
          <DropdownItem key="new" startContent={<Plus size={16} />} textValue="New session">
            New session
          </DropdownItem>
          <DropdownItem key="minutes" startContent={<FileText size={16} />} isDisabled={!activeSession} description="The Scribe writes minutes and proposes tickets" textValue="End meeting">
            End meeting
          </DropdownItem>
          <DropdownItem key="archive" startContent={<Archive size={16} />} isDisabled={!activeSession} textValue="Archive room">
            Archive room
          </DropdownItem>
          <DropdownItem
            key="delete-active"
            startContent={<Trash2 size={16} className="text-danger" />}
            className="text-danger"
            color="danger"
            isDisabled={!activeSession}
            textValue="Delete active session"
          >
            Delete active session
          </DropdownItem>
          <DropdownItem key="past" startContent={<History size={16} />} textValue="Past sessions">
            Past sessions {pastSessions.length > 0 ? `(${pastSessions.length})` : ''}
          </DropdownItem>
        </DropdownMenu>
      </Dropdown>

      {/* Past sessions modal */}
      {pastOpen && (
        <Modal isOpen onOpenChange={(open) => !open && setPastOpen(false)} placement="center" size="lg">
          <ModalContent>
            <ModalHeader className="pe-10 text-medium font-semibold">Past sessions · {roomName}</ModalHeader>
            <ModalBody className="gap-2">
              {pastSessions.length === 0 ? (
                <p className="py-4 text-center text-small text-foreground-400">No past sessions in this room.</p>
              ) : (
                <div className="flex max-h-80 flex-col gap-2 overflow-y-auto">
                  {pastSessions.map((s) => {
                    const isViewing = viewingSessionId === s.id;
                    return (
                      <div key={s.id} className="flex items-center justify-between gap-3 rounded-medium bg-default-50 px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-small font-semibold">
                              {s.legacy ? 'Earlier chat' : `Session from ${when(s.createdAt)}`}
                            </p>
                            {isViewing && (
                              <Chip size="sm" color="primary" variant="flat">
                                Viewing
                              </Chip>
                            )}
                          </div>
                          <p className="truncate text-tiny text-foreground-400">
                            {s.archivedAt ? `Archived ${when(s.archivedAt)}` : 'Archived'}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="flat"
                            color={isViewing ? 'primary' : 'default'}
                            onPress={() => {
                              if (isViewing) {
                                session.viewArchivedSession(null);
                              } else {
                                session.viewArchivedSession(s.id);
                              }
                              setPastOpen(false);
                            }}
                          >
                            {isViewing ? 'Back to live' : 'View'}
                          </Button>
                          <Button
                            size="sm"
                            variant="flat"
                            isIconOnly
                            color="danger"
                            aria-label="Delete session"
                            onPress={() => setDeleting(s)}
                          >
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </ModalBody>
            <ModalFooter>
              <Button variant="flat" onPress={() => setPastOpen(false)}>
                Close
              </Button>
            </ModalFooter>
          </ModalContent>
        </Modal>
      )}

      {/* Delete confirm modal */}
      {deleting && (
        <Modal isOpen onOpenChange={(open) => !open && setDeleting(null)} placement="center">
          <ModalContent>
            <ModalHeader className="pe-10 text-medium font-semibold">
              Delete {deleting.legacy ? 'Earlier chat' : 'session'}?
            </ModalHeader>
            <ModalBody className="gap-2">
              <p className="text-small">
                This removes {deleting.legacy ? 'earlier chat' : `the session from ${when(deleting.createdAt)}`} and all of its messages for good. This cannot be undone.
              </p>
            </ModalBody>
            <ModalFooter className="gap-2">
              <Button variant="flat" onPress={() => setDeleting(null)}>
                Cancel
              </Button>
              <Button color="danger" onPress={confirmDelete}>
                Delete
              </Button>
            </ModalFooter>
          </ModalContent>
        </Modal>
      )}
    </>
  );
}
