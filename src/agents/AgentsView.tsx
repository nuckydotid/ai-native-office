import { useCallback, useEffect, useRef, useState } from 'react';
import { addToast, Alert, Button, Card, CardBody, Listbox, ListboxItem, ListboxSection, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Skeleton } from '@heroui/react';
import type { Project } from '../project.ts';
import { Bot, HeadAvatar, IconBubble } from '../ui';
import { AgentEditor } from './AgentEditor.tsx';
import { agentLook, findAgent } from './format.ts';
import type { AgentFile } from './format.ts';
import { useAgents } from './store.ts';

/** The agent being edited, by handle. */
type Selection = string | null;

/**
 * The workspace's chat agents: who they are and how they look. When someone calls an agent it runs on the server; changing its
 * instructions here changes its next answer.
 */
export function AgentsView({ project, visible }: { project: Project; visible: boolean }) {
  const listing = useAgents((s) => s.listing);
  const loading = useAgents((s) => s.loading);
  const error = useAgents((s) => s.error);

  const [selection, setSelection] = useState<Selection>(null);
  /** Where the person asked to go while there were unsaved changes. */
  const [asking, setAsking] = useState<{ to: Selection } | null>(null);
  const dirty = useRef(false);
  const onDirty = useCallback((d: boolean) => {
    dirty.current = d;
  }, []);

  // Read the agents whenever this page comes forward: someone may have changed one.
  useEffect(() => {
    if (visible) void useAgents.getState().refresh(project.path);
  }, [visible, project.path]);

  // Start on the first agent.
  useEffect(() => {
    if (loading) return;
    if (selection === null) {
      if (listing.agents[0]) setSelection(listing.agents[0].handle);
    } else if (!findAgent(listing, selection)) {
      setSelection(null);
    }
  }, [loading, listing, selection]);

  function select(to: Selection) {
    dirty.current = false;
    setSelection(to);
  }

  function go(to: Selection) {
    if (selection === to) return;
    if (dirty.current) setAsking({ to });
    else select(to);
  }

  async function saveAgent(agent: AgentFile) {
    await useAgents.getState().saveAgent(project.path, agent);
    dirty.current = false;
    setSelection(agent.handle);
    addToast({ title: 'Saved', color: 'success', timeout: 3000 });
  }

  const current = selection ? findAgent(listing, selection) : undefined;
  const empty = !loading && !error && listing.agents.length === 0;

  return (
    <div className={`min-h-0 flex-1 flex-col ${visible ? 'flex' : 'hidden'}`}>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="flex max-h-72 shrink-0 flex-col gap-3 overflow-y-auto bg-content1 p-3 shadow-small md:max-h-none md:w-72" aria-label="Agents">
          <div className="flex items-center justify-between gap-2 px-1">
            <h1 className="text-medium font-semibold">Agents</h1>
          </div>

          {loading ? (
            <div className="flex flex-col gap-2 px-1" aria-label="Reading the agents">
              <Skeleton className="h-10 rounded-medium" />
              <Skeleton className="h-10 rounded-medium" />
              <Skeleton className="h-10 rounded-medium" />
            </div>
          ) : (
            <Listbox
              aria-label="Agents"
              variant="flat"
              color="primary"
              selectionMode="single"
              disallowEmptySelection
              // HeroUI only tints a chosen row while it is hovered or focused; a list you pick from needs to show the choice.
              itemClasses={{ base: 'data-[selected=true]:bg-primary/20 data-[selected=true]:text-primary' }}
              selectedKeys={selection ? [`agent:${selection}`] : []}
              onSelectionChange={(keys) => {
                const next = String(Array.from(keys)[0] ?? '');
                if (next.startsWith('agent:')) go(next.slice(6));
              }}
              emptyContent={null}
            >
              <ListboxSection title="Agents" classNames={{ heading: 'px-2' }}>
                {listing.agents.map((agent) => (
                  <ListboxItem
                    key={`agent:${agent.handle}`}
                    textValue={agent.displayName}
                    startContent={<HeadAvatar look={agentLook(agent)} name={agent.displayName || agent.handle} size="sm" />}
                    description={agent.role || `@${agent.handle}`}
                    hideSelectedIcon
                  >
                    {agent.displayName || agent.handle}
                  </ListboxItem>
                ))}
              </ListboxSection>
            </Listbox>
          )}

          <div className="mt-auto rounded-medium bg-default-50 p-3">
            <p className="text-small font-medium">What agents can do</p>
            <p className="mt-1 text-tiny text-foreground-500">
              When someone calls an agent, it runs on the demo server with Gemini. It reads this workspace’s docs, tickets and chat, answers with the sources it used, and only proposes changes: a person accepts them. Change an agent’s instructions here and its next answer follows them.
            </p>
          </div>
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto p-4 md:p-6">
          {error ? (
            <Alert
              color="danger"
              variant="flat"
              title="Couldn’t read the agents"
              description={error}
              endContent={
                <Button size="sm" variant="flat" onPress={() => void useAgents.getState().refresh(project.path)}>
                  Try again
                </Button>
              }
            />
          ) : loading ? (
            <div className="flex max-w-2xl flex-col gap-3">
              <Skeleton className="h-16 rounded-large" />
              <Skeleton className="h-64 rounded-large" />
            </div>
          ) : current ? (
            <AgentEditor key={`agent:${current.handle}`} saved={current} listing={listing} onDirty={onDirty} onSave={saveAgent} />
          ) : (
            <Card shadow="md" className="mx-auto mt-6 max-w-xl">
              <CardBody className="items-center gap-4 p-8 text-center">
                <IconBubble color="primary" size="lg">
                  <Bot size={24} />
                </IconBubble>
                <div>
                  <h2 className="text-large font-semibold">{empty ? 'No agents in this workspace yet' : 'Pick an agent'}</h2>
                  <p className="mt-1 text-small text-foreground-500">
                    {empty ? 'Agents are teammates you can ask by name in the Office chat: type @ and their handle.' : 'Choose one on the left to change it.'}
                  </p>
                </div>
              </CardBody>
            </Card>
          )}
        </main>

        {asking && (
          <Modal isOpen onOpenChange={(open) => !open && setAsking(null)} placement="center">
            <ModalContent>
              <ModalHeader className="pe-10 text-medium font-semibold">Leave without saving?</ModalHeader>
              <ModalBody>
                <p className="text-small">What you changed here isn’t saved yet.</p>
              </ModalBody>
              <ModalFooter className="gap-2">
                <Button variant="flat" onPress={() => setAsking(null)}>
                  Keep editing
                </Button>
                <Button
                  color="danger"
                  onPress={() => {
                    const to = asking.to;
                    setAsking(null);
                    select(to);
                  }}
                >
                  Discard changes
                </Button>
              </ModalFooter>
            </ModalContent>
          </Modal>
        )}
      </div>
    </div>
  );
}
