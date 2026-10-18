import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, CardBody, Chip, Input, Listbox, ListboxItem, Spinner, Tab, Tabs, Textarea } from '@heroui/react';
import type { Project } from '../project.ts';
import { MarkdownDoc, IconButton } from '../ui';
import { useBoard } from '../board/store.ts';
import { BookOpen, FileText, Plus, RefreshCw, Sparkles, Trash2 } from '../ui/lucide';
import { sentence } from '../team/rest.ts';
import { importWithAi } from '../demo/actions.ts';
import { useNav } from '../sync/nav.ts';
import { useSync } from '../sync/store.ts';
import { flattenPages, reconcileDraft } from './core.ts';
import { useDocs } from './store.ts';

/**
 * The project's docs: a tree of Markdown pages the whole team edits, kept on the project's team server. The tree is a
 * sidebar; the page is title, text and a preview of how it reads.
 */
export function DocsView({ project, visible }: { project: Project; visible: boolean }) {
  const { pages, loading, busy, error } = useDocs();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ title: string; body: string } | null>(null);
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [importing, setImporting] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (visible) void useDocs.getState().load(project.path);
  }, [visible, project.path]);

  // Someone changed the docs (the server tells everyone in the office): read them again while this page is on screen.
  const changes = useSync((s) => s.pages);
  useEffect(() => {
    if (changes > 0 && visible) void useDocs.getState().load(project.path);
    // Only a new change reads again; being shown is handled above.
  }, [changes]);

  // A link from another page (a ticket's doc, a worktree's doc) selects it.
  const target = useNav((s) => s.target);
  useEffect(() => {
    if (target?.page !== 'docs') return;
    setSelectedId(target.id);
    useNav.getState().clear();
  }, [target]);

  // The tickets that draw on the page open selected: the board is read here if it has not been opened yet.
  const tickets = useBoard((st) => st.snapshot?.issues);
  useEffect(() => {
    if (visible && useBoard.getState().snapshot === null && !useBoard.getState().loading) void useBoard.getState().load(project.path);
  }, [visible, project.path]);
  const usedBy = selectedId ? (tickets ?? []).filter((i) => (i.docs ?? []).includes(selectedId)) : [];

  const rows = flattenPages(pages ?? []);
  const selected = (pages ?? []).find((p) => p.id === selectedId) ?? null;

  // Opening another page (or the same one after a save) starts the fields from what is stored. When someone else changed the page
  // while there are unsaved words here, the words stay, and the person chooses (see the notice below).
  const base = useRef<{ id: string; title: string; body: string; at: number } | null>(null);
  const [theirs, setTheirs] = useState(false);
  useEffect(() => {
    const stored = selected ? { id: selected.id, title: selected.title, body: selected.body, at: selected.updatedAt } : null;
    setConfirmingDelete(false);
    const next = reconcileDraft(base.current, stored, draft);
    base.current = next.base;
    setDraft(next.draft);
    setTheirs(next.theirs);
    if (!next.keptTab) setTab('write');
  }, [selectedId, selected?.updatedAt]);

  const run = async (what: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await what();
    } catch (e) {
      setActionError(sentence(e));
    }
  };

  const dirty = draft !== null && selected !== null && (draft.title !== (base.current?.title ?? selected.title) || draft.body !== (base.current?.body ?? selected.body));

  const createPage = (parent: string | null) =>
    run(async () => {
      const page = await useDocs.getState().createPage({ title: 'Untitled page', parent });
      setSelectedId(page.id);
    });

  // "Import with AI": the file goes to the agent service (Gemini reads it), and the page it drafts is created for this person.
  const importFile = async (file: File) => {
    setActionError(null);
    if (file.size > 4 * 1024 * 1024) {
      setActionError('That file is too big. The limit is 4 MB.');
      return;
    }
    const guessed = file.name.toLowerCase();
    const mime =
      file.type ||
      (guessed.endsWith('.pdf') ? 'application/pdf' : guessed.endsWith('.md') ? 'text/markdown' : guessed.endsWith('.txt') ? 'text/plain' : guessed.endsWith('.png') ? 'image/png' : guessed.endsWith('.jpg') || guessed.endsWith('.jpeg') ? 'image/jpeg' : guessed.endsWith('.webp') ? 'image/webp' : '');
    if (!mime) {
      setActionError('Send a PDF, a picture or a text file.');
      return;
    }
    setImporting(true);
    try {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
        reader.onerror = () => reject(new Error('Could not read that file.'));
        reader.readAsDataURL(file);
      });
      const res = await importWithAi({ name: file.name, mime, dataBase64 });
      if (!res.ok) {
        setActionError(res.message);
        return;
      }
      await useDocs.getState().load(project.path);
      setSelectedId(res.pageId);
    } catch (e) {
      setActionError(sentence(e));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className={`min-h-0 flex-1 flex-col ${visible ? 'flex' : 'hidden'}`}>
      <div className="flex flex-wrap items-center gap-3 px-3 pb-3 pt-4 sm:px-6 sm:pb-4 sm:pt-6">
        <div className="flex items-center gap-2">
          <BookOpen size={20} className="text-primary" />
          <h1 className="text-xl font-semibold">Docs</h1>
        </div>
        <div className="ms-auto flex items-center gap-2">
          <IconButton label="Read the pages again" isLoading={loading && pages !== null} onPress={() => useDocs.getState().load(project.path)}>
            <RefreshCw size={15} />
          </IconButton>
          <Button size="sm" variant="flat" startContent={<Sparkles size={15} />} isLoading={importing} onPress={() => importInput.current?.click()}>
            Import with AI
          </Button>
          <Input
            ref={importInput}
            className="hidden"
            type="file"
            aria-label="Import a PDF, a picture or a text file"
            accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.md"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void importFile(file);
            }}
          />
          <Button size="sm" color="primary" startContent={<Plus size={16} />} onPress={() => void createPage(null)} isLoading={busy}>
            New page
          </Button>
        </div>
      </div>

      {(actionError || error) && (
        <div className="px-6 pb-2">
          <Alert color="danger" variant="flat" hideIcon description={actionError ?? error} />
        </div>
      )}

      {loading && pages === null ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-small text-foreground-500">
          <Spinner size="sm" /> Reading the pages…
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 px-3 pb-3 sm:px-6 sm:pb-6 md:flex-row">
          <Card shadow="md" className="flex max-h-48 w-full shrink-0 flex-col md:max-h-none md:w-72">
            <CardBody className="min-h-0 gap-1 overflow-y-auto p-2">
              {rows.length === 0 ? (
                <p className="rounded-medium bg-default-50 px-3 py-8 text-center text-tiny text-foreground-400">No pages yet. Make the first one.</p>
              ) : (
                <Listbox
                  aria-label="Pages"
                  variant="flat"
                  color="primary"
                  selectionMode="single"
                  disallowEmptySelection={false}
                  selectedKeys={selectedId ? [selectedId] : []}
                  onSelectionChange={(keys) => setSelectedId((Array.from(keys)[0] as string) ?? null)}
                  itemClasses={{ base: 'data-[selected=true]:bg-primary/20 data-[selected=true]:text-primary' }}
                >
                  {rows.map(({ page, depth }) => (
                    <ListboxItem key={page.id} startContent={<FileText size={16} />} hideSelectedIcon style={{ paddingInlineStart: 12 + depth * 16 }}>
                      <span className="truncate">{page.title}</span>
                    </ListboxItem>
                  ))}
                </Listbox>
              )}
            </CardBody>
          </Card>

          <Card shadow="md" className="flex min-w-0 flex-1 flex-col">
            <CardBody className="min-h-0 gap-4 overflow-y-auto p-5">
              {!selected || !draft ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-medium bg-default-50 p-10 text-center">
                  <BookOpen size={28} className="text-foreground-300" />
                  <p className="text-small text-foreground-500">Pick a page on the left, or make a new one. Everything here is shared with your team.</p>
                </div>
              ) : (
                <>
                  {theirs && (
                    <Alert
                      color="warning"
                      variant="flat"
                      title="Someone else changed this page"
                      description="Your words are not saved yet. Use their version, or keep yours and replace theirs when you save."
                      endContent={
                        <div className="flex shrink-0 gap-2">
                          <Button
                            size="sm"
                            variant="flat"
                            onPress={() => {
                              base.current = { id: selected.id, title: selected.title, body: selected.body, at: selected.updatedAt };
                              setDraft({ title: selected.title, body: selected.body });
                              setTheirs(false);
                            }}
                          >
                            Use theirs
                          </Button>
                          <Button
                            size="sm"
                            color="warning"
                            onPress={() => {
                              if (base.current) base.current = { ...base.current, at: selected.updatedAt };
                              setTheirs(false);
                            }}
                          >
                            Keep mine
                          </Button>
                        </div>
                      }
                    />
                  )}
                  <Input label="Title" value={draft.title} onValueChange={(title) => setDraft({ ...draft, title })} maxLength={200} />
                  <Tabs aria-label="Write or read" size="sm" selectedKey={tab} onSelectionChange={(key) => setTab(key as 'write' | 'preview')}>
                    <Tab key="write" title="Write" />
                    <Tab key="preview" title="Preview" />
                  </Tabs>
                  {tab === 'write' ? (
                    <Textarea
                      aria-label="Page text"
                      value={draft.body}
                      onValueChange={(body) => setDraft({ ...draft, body })}
                      minRows={14}
                      maxRows={30}
                      description="Markdown: headings, lists, **bold** and fenced code."
                    />
                  ) : (
                    <div className="min-h-40 rounded-medium bg-default-50 p-4">
                      <MarkdownDoc text={draft.body} />
                    </div>
                  )}
                  {usedBy.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-tiny text-foreground-400">Used by</span>
                      {usedBy.map((i) => (
                        <Chip key={i.id} size="sm" variant="flat" color="primary" className="cursor-pointer" onClick={() => useNav.getState().open({ page: 'board', issue: i.id })}>
                          {i.key > 0 ? `#${i.key} ` : ''}
                          {i.title}
                        </Chip>
                      ))}
                    </div>
                  )}
                  {confirmingDelete && (
                    <Alert
                      color="danger"
                      variant="flat"
                      title="Delete this page?"
                      description="Its subpages move up to where it was. The text itself is gone for everyone."
                      endContent={
                        <div className="flex shrink-0 gap-2">
                          <Button size="sm" variant="flat" onPress={() => setConfirmingDelete(false)} isDisabled={busy}>
                            Keep
                          </Button>
                          <Button
                            size="sm"
                            color="danger"
                            isLoading={busy}
                            onPress={() =>
                              void run(async () => {
                                await useDocs.getState().deletePage(selected.id);
                                setSelectedId(selected.parent);
                              })
                            }
                          >
                            Delete
                          </Button>
                        </div>
                      }
                    />
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="flat" startContent={<Plus size={16} />} onPress={() => void createPage(selected.id)} isLoading={busy}>
                      Add subpage
                    </Button>
                    <Button size="sm" variant="light" color="danger" startContent={<Trash2 size={16} />} onPress={() => setConfirmingDelete(true)} isDisabled={busy || confirmingDelete} className="mr-auto">
                      Delete
                    </Button>
                    <span className="text-tiny text-foreground-400">{dirty ? 'Unsaved changes' : selected.updatedAt > 0 ? 'Saved' : ''}</span>
                    <Button size="sm" color="primary" isDisabled={!dirty || !draft.title.trim()} isLoading={busy} onPress={() => void run(() => useDocs.getState().updatePage(selected.id, { ...draft, ifUpdatedAt: base.current?.at ?? selected.updatedAt }))}>
                      Save
                    </Button>
                  </div>
                </>
              )}
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  );
}
