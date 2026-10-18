import { useEffect, useRef, useState, type ClipboardEvent } from 'react';
import { Alert, Button, Chip, Image, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Select, SelectItem, Spinner, Tab, Tabs, Textarea } from '@heroui/react';
import { ExternalLink, GitPullRequest, Plus, Trash2, X } from '../ui/lucide';
import { MarkdownDoc } from '../ui';
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from '../shared/board/types.ts';
import type { Issue, IssueLink, IssueStatus } from '../shared/board/types.ts';
import { stageLabel } from '../flow.ts';
import { openExternal } from '../openExternal.ts';
import { sentence } from '../team/rest.ts';
import { useDocs } from '../docs/store.ts';
import { useNav } from '../sync/nav.ts';
import { PRIORITY_META, STATUS_LABELS } from './core.ts';
import { useBoard } from './store.ts';

const MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_IMAGE = 1024 * 1024;
const PR_COLOR = { draft: 'default', open: 'success', merged: 'secondary', closed: 'danger' } as const;

/** Pictures already read from the server in this window, by id. */
const pictures = new Map<string, string>();

/** A picture a ticket keeps, read from the team server when it is shown. */
function Picture({ id, alt }: { id: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(pictures.get(id) ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (src) return;
    let alive = true;
    useBoard
      .getState()
      .imageUrl(id)
      .then((url) => {
        pictures.set(id, url);
        if (alive) setSrc(url);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [id, src]);
  if (failed) return <span className="italic text-foreground-500">{alt} (couldn’t be loaded)</span>;
  if (!src) return <Spinner size="sm" aria-label="Loading the picture" />;
  return <Image src={src} alt={alt} isZoomed radius="md" className="max-h-72 w-auto max-w-full object-contain" />;
}

/** The ticket: what it says and means, what it draws on and what it is connected to. */
export function IssueDialog({ issue, initialStatus, onClose }: { issue: Issue | null; initialStatus: IssueStatus; onClose: () => void }) {
  const { snapshot, busy } = useBoard();
  const project = useBoard((s) => s.project);
  const people = snapshot?.people ?? [];
  const you = snapshot?.you ?? '';
  const canModerate = snapshot?.canModerate ?? false;

  const [title, setTitle] = useState(issue?.title ?? '');
  const [body, setBody] = useState(issue?.body ?? '');
  const [status, setStatus] = useState<IssueStatus>(issue?.status ?? initialStatus);
  /** A ticket in the delivery pipeline: its stage decides its status, so the dialog neither shows nor sends one. */
  const piped = !!issue?.pipeline;
  const [priority, setPriority] = useState(issue?.priority ?? 'medium');
  const [assignee, setAssignee] = useState(issue?.assignee ?? 'none');
  const [labels, setLabels] = useState(issue?.labels.join(', ') ?? '');
  const [points, setPoints] = useState(String(issue?.points ?? 0));
  const [docs, setDocs] = useState<string[]>(issue?.docs ?? []);
  const [links, setLinks] = useState<IssueLink[]>(issue?.links ?? []);
  const [images, setImages] = useState<string[]>(issue?.images ?? []);
  const [newLink, setNewLink] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [view, setView] = useState<'write' | 'read'>(issue && issue.body ? 'read' : 'write');
  const bodyRef = useRef(body);
  bodyRef.current = body;

  const canDelete = issue !== null && (issue.createdBy === you || canModerate);

  // The docs a ticket can draw on: the project's pages (read here if the Docs page has not been opened yet).
  const pages = useDocs((s) => s.pages) ?? [];
  useEffect(() => {
    if (project && useDocs.getState().pages === null) void useDocs.getState().load(project);
  }, [project]);

  const addPictures = async (files: File[]) => {
    setError(null);
    setUploading(true);
    try {
      for (const file of files) {
        if (!MIMES.includes(file.type)) {
          setError('Only PNG, JPEG, GIF and WebP pictures can be attached.');
          continue;
        }
        if (file.size > MAX_IMAGE) {
          setError(`${file.name || 'That picture'} is bigger than 1 MB.`);
          continue;
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        const id = await useBoard.getState().uploadImage(file.type, btoa(binary));
        setImages((list) => (list.includes(id) ? list : [...list, id].slice(0, 10)));
        // The picture is part of the description where it was added.
        const alt = (file.name || 'picture').replace(/\.[a-z0-9]+$/i, '').replace(/[[\]()]/g, '');
        setBody(`${bodyRef.current}${bodyRef.current && !bodyRef.current.endsWith('\n') ? '\n\n' : ''}![${alt}](asset:${id})\n`);
      }
    } catch (e) {
      setError(sentence(e));
    } finally {
      setUploading(false);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => MIMES.includes(f.type));
    if (files.length === 0) return;
    e.preventDefault();
    void addPictures(files);
  };

  const addLink = () => {
    const url = newLink.trim();
    if (!/^https:\/\/[^\s<>"']+$/.test(url) || url.length > 300) {
      setError('A link must start with https:// and have no spaces.');
      return;
    }
    setError(null);
    if (links.length < 10 && !links.some((l) => l.url === url)) setLinks([...links, { url, title: url.replace(/^https:\/\//, '').slice(0, 80) }]);
    setNewLink('');
  };

  const save = async () => {
    setError(null);
    if (!title.trim()) {
      setError('An issue needs a title.');
      return;
    }
    const nextAssignee = assignee === 'none' ? null : assignee;
    // The two rules, said here so the dialog explains instead of the server refusing: In Progress needs an assignee, In Review needs a pull request.
    // (A ticket in the delivery pipeline is not held to them: its stage decides its status, and the gates decide the stage.)
    if (!piped && status === 'in_progress' && !nextAssignee) {
      setError('In Progress needs an assignee. Pick the person it is for.');
      return;
    }
    if (!piped && status === 'review' && !issue?.pr) {
      setError('In Review means a pull request is open. Open one from this ticket first.');
      return;
    }
    const patch = {
      title,
      body,
      ...(piped ? {} : { status }),
      priority,
      assignee: nextAssignee,
      labels: labels
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      points: Number.parseInt(points, 10) || 0,
      docs,
      links,
      images,
    };
    try {
      // The copy this edit was made on: if someone changed the ticket meanwhile the server says so instead of replacing their change.
      if (issue) await useBoard.getState().updateIssue(issue.id, { ...patch, ifUpdatedAt: issue.updatedAt });
      else await useBoard.getState().createIssue(patch);
      onClose();
    } catch (e) {
      setError(sentence(e));
    }
  };

  const remove = async () => {
    if (!issue) return;
    setError(null);
    try {
      await useBoard.getState().deleteIssue(issue.id);
      onClose();
    } catch (e) {
      setError(sentence(e));
    }
  };

  const unreferenced = images.filter((id) => !body.includes(`asset:${id}`));

  return (
    <Modal isOpen onOpenChange={(open) => !open && onClose()} placement="center" size="5xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex items-center gap-2 pe-10 text-medium font-semibold">
          {issue ? `Ticket${issue.key > 0 ? ` #${issue.key}` : ''}` : 'New ticket'}
          {issue?.prInfo && (
            <Chip size="sm" variant="flat" color={PR_COLOR[issue.prInfo.state]} startContent={<GitPullRequest size={12} />}>
              #{issue.prInfo.number} {issue.prInfo.state}
            </Chip>
          )}
        </ModalHeader>
        <ModalBody className="gap-4" onPaste={onPaste}>
          {error && <Alert color="danger" variant="flat" hideIcon description={error} />}
          <div className="grid gap-6 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            {/* What it says */}
            <div className="flex min-w-0 flex-col gap-4">
              <Input label="Title" value={title} onValueChange={setTitle} isRequired autoFocus={!issue} maxLength={200} />
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-small font-medium">Description</p>
                  <Tabs size="sm" variant="light" aria-label="Description" selectedKey={view} onSelectionChange={(k) => setView(k === 'read' ? 'read' : 'write')}>
                    <Tab key="write" title="Write" />
                    <Tab key="read" title="Read" />
                  </Tabs>
                </div>
                {view === 'write' ? (
                  <Textarea
                    aria-label="Description"
                    value={body}
                    onValueChange={setBody}
                    minRows={6}
                    maxRows={16}
                    description="Markdown. Paste a picture to add it here."
                  />
                ) : body.trim() ? (
                  <div className="rounded-medium bg-default-100/60 p-3">
                    <MarkdownDoc text={body} renderImage={(id, alt) => <Picture id={id} alt={alt} />} />
                  </div>
                ) : (
                  <p className="text-small text-foreground-400">Nothing written yet.</p>
                )}
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-small font-medium">Pictures</p>
                  {uploading && <Spinner size="sm" aria-label="Uploading" />}
                </div>
                {unreferenced.length > 0 && (
                  <div className="flex flex-wrap gap-3">
                    {unreferenced.map((id) => (
                      <div key={id} className="flex flex-col items-start gap-1">
                        <Picture id={id} alt="picture" />
                        <Button size="sm" variant="light" onPress={() => setImages(images.filter((i) => i !== id))}>
                          Remove
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                <Input
                  type="file"
                  size="sm"
                  accept={MIMES.join(',')}
                  aria-label="Add a picture"
                  description="PNG, JPEG, GIF or WebP, up to 1 MB. They are kept on your team server."
                  isDisabled={uploading || images.length >= 10}
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = '';
                    if (files.length) void addPictures(files);
                  }}
                />
              </div>

            </div>

            {/* Where it sits and what it is connected to */}
            <div className="flex min-w-0 flex-col gap-4">
              <div className="grid gap-3 sm:grid-cols-2">
                {issue?.pipeline ? (
                  <Input size="sm" label="Stage" isReadOnly value={stageLabel(issue.pipeline.stage)} description="Moves with Approve & advance" />
                ) : (
                  <Select size="sm" label="Status" disallowEmptySelection selectedKeys={[status]} onSelectionChange={(keys) => setStatus(Array.from(keys)[0] as IssueStatus)}>
                    {ISSUE_STATUSES.map((s) => (
                      <SelectItem key={s}>{STATUS_LABELS[s]}</SelectItem>
                    ))}
                  </Select>
                )}
                <Select size="sm" label="Priority" disallowEmptySelection selectedKeys={[priority]} onSelectionChange={(keys) => setPriority(Array.from(keys)[0] as typeof priority)}>
                  {ISSUE_PRIORITIES.map((p) => (
                    <SelectItem key={p}>{PRIORITY_META[p].label}</SelectItem>
                  ))}
                </Select>
                <Select size="sm" label="Assignee" disallowEmptySelection selectedKeys={[assignee]} onSelectionChange={(keys) => setAssignee(Array.from(keys)[0] as string)}>
                  {[{ key: 'none', label: 'Nobody' }, ...people.map((p) => ({ key: p.uid, label: p.name }))].map((p) => (
                    <SelectItem key={p.key}>{p.label}</SelectItem>
                  ))}
                </Select>
                <Input size="sm" label="Labels" value={labels} onValueChange={setLabels} description="Commas. A bug, docs or test label sets the commit type." />
                <Input size="sm" label="Points" value={points} onValueChange={setPoints} type="number" min={0} max={100} />
              </div>

              {pages.length > 0 && (
                <div className="flex flex-col gap-2">
                  <Select
                    size="sm"
                    label="Docs"
                    selectionMode="multiple"
                    selectedKeys={docs.filter((d) => pages.some((p) => p.id === d))}
                    onSelectionChange={(keys) => setDocs(Array.from(keys) as string[])}
                    description="Pages this work draws on. The project manager reads them."
                  >
                    {pages.map((p) => (
                      <SelectItem key={p.id}>{p.title}</SelectItem>
                    ))}
                  </Select>
                  {docs.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {docs
                        .filter((d) => pages.some((p) => p.id === d))
                        .map((d) => (
                          <Chip
                            key={d}
                            size="sm"
                            variant="flat"
                            className="cursor-pointer"
                            onClick={() => {
                              useNav.getState().open({ page: 'docs', id: d });
                              onClose();
                            }}
                          >
                            {pages.find((p) => p.id === d)?.title}
                          </Chip>
                        ))}
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-col gap-2">
                <p className="text-small font-medium">Links</p>
                {links.map((l) => (
                  <div key={l.url} className="flex items-center gap-2 rounded-medium bg-default-100/60 px-2 py-1 text-small">
                    <ExternalLink size={14} className="shrink-0 text-foreground-400" />
                    <span className="min-w-0 flex-1 truncate">{l.title}</span>
                    <Button size="sm" variant="light" isIconOnly aria-label="Open the link" onPress={() => void openExternal(l.url).catch(() => navigator.clipboard?.writeText(l.url))}>
                      <ExternalLink size={14} />
                    </Button>
                    <Button size="sm" variant="light" isIconOnly aria-label="Remove the link" onPress={() => setLinks(links.filter((x) => x.url !== l.url))}>
                      <X size={14} />
                    </Button>
                  </div>
                ))}
                <div className="flex items-end gap-2">
                  <Input
                    size="sm"
                    aria-label="Add a link"
                    placeholder="https://…"
                    value={newLink}
                    onValueChange={setNewLink}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addLink();
                      }
                    }}
                  />
                  <Button size="sm" variant="flat" isIconOnly aria-label="Add the link" onPress={addLink} isDisabled={!newLink.trim() || links.length >= 10}>
                    <Plus size={14} />
                  </Button>
                </div>
              </div>

              {issue?.pr && (
                <div className="flex items-center gap-2 rounded-medium bg-default-100/60 px-3 py-2 text-small">
                  <GitPullRequest size={16} className="text-secondary" />
                  <span className="min-w-0 flex-1 truncate">{issue.prInfo ? `#${issue.prInfo.number} ${issue.prInfo.title}` : 'Pull request'}</span>
                  <Button size="sm" variant="flat" onPress={() => void openExternal(issue.pr as string).catch(() => navigator.clipboard?.writeText(issue.pr as string))}>
                    Open on GitHub
                  </Button>
                </div>
              )}
            </div>
          </div>

          {confirming && issue && (
            <Alert
              color="danger"
              variant="flat"
              title="Delete this issue?"
              description="It is gone for everyone. To keep it, move it to Done instead."
              endContent={
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" variant="flat" onPress={() => setConfirming(false)} isDisabled={busy}>
                    Keep
                  </Button>
                  <Button size="sm" color="danger" onPress={() => void remove()} isLoading={busy}>
                    Delete
                  </Button>
                </div>
              }
            />
          )}
        </ModalBody>
        <ModalFooter className="gap-2">
          {canDelete && !confirming && (
            <Button size="sm" variant="light" color="danger" startContent={<Trash2 size={16} />} onPress={() => setConfirming(true)} className="mr-auto">
              Delete
            </Button>
          )}
          <Button size="sm" variant="flat" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button size="sm" color="primary" onPress={() => void save()} isLoading={busy} isDisabled={!title.trim() || uploading}>
            {issue ? 'Save' : 'Create'}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
