import { useEffect, useState } from 'react';
import { Button, Chip, Modal, ModalBody, ModalContent, ModalHeader, Spinner } from '@heroui/react';
import type { Artifact, ArtifactState, ChangeFile } from '../shared/pipeline/types.ts';
import { teamOrigin } from '../team/connect.ts';
import { CodeDiff, Hint, MarkdownDoc, PrototypeFrame } from '../ui';
import { Bot, Eye, Maximize2, UserCheck } from '../ui/lucide';
import { repoFile } from './api.ts';
import { ARTIFACT_LABEL, shortDigest } from './core.ts';
import { usePipeline } from './store.ts';

const STATE_CHIP: Record<ArtifactState, { label: string; color: 'default' | 'warning' | 'success' }> = {
  draft: { label: 'Waiting for you', color: 'warning' },
  accepted: { label: 'Accepted', color: 'success' },
  rejected: { label: 'Rejected', color: 'default' },
  superseded: { label: 'Replaced', color: 'default' },
};

/** The trunk's version of each file a change set touches, so the diff shows what really changes. `undefined` while it loads. */
function useBases(files: ChangeFile[] | undefined): Record<string, string | null> | undefined {
  const [bases, setBases] = useState<Record<string, string | null> | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const origin = teamOrigin();
    const need = (files ?? []).filter((f) => f.baseSha !== null);
    void Promise.all(need.map(async (f) => [f.path, await repoFile(origin, f.path)] as const)).then((pairs) => {
      if (live) setBases(Object.fromEntries(pairs));
    });
    return () => {
      live = false;
    };
  }, [files]);
  return bases;
}

function ChangeSetView({ artifact }: { artifact: Artifact }) {
  const files = artifact.files ?? [];
  const bases = useBases(files);
  const needsBase = files.some((f) => f.baseSha !== null);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {artifact.body ? <MarkdownDoc text={artifact.body} /> : null}
      {needsBase && bases === undefined ? (
        <div className="flex items-center gap-2 text-tiny text-foreground-500">
          <Spinner size="sm" /> Reading the files this changes…
        </div>
      ) : (
        files.map((f, i) => (
          <CodeDiff key={f.path} path={f.path} before={f.baseSha === null ? null : (bases?.[f.path] ?? '')} after={f.op === 'delete' ? '' : f.content} defaultOpen={i === 0} />
        ))
      )}
    </div>
  );
}

/** What an artifact says, by kind: a change set as diffs, a design as a sandboxed page, everything else as a document. */
export function ArtifactBody({ artifact }: { artifact: Artifact }) {
  if (artifact.kind === 'change_set') return <ChangeSetView artifact={artifact} />;
  if (artifact.kind === 'design') {
    if (artifact.meta?.noUi === true) return <p className="text-small text-foreground-600">{artifact.body}</p>;
    return <PrototypeFrame html={artifact.body} title={artifact.title} />;
  }
  return <MarkdownDoc text={artifact.body} />;
}

/** The big view of an artifact: a change set's whole diff, a prototype at its real size, a document with room to read. */
export function ArtifactModal({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  return (
    <Modal isOpen onOpenChange={(open) => !open && onClose()} placement="center" size="4xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex flex-wrap items-center gap-2 pe-10 text-medium font-semibold">
          <span>{artifact.title}</span>
          <Chip size="sm" variant="flat">
            {ARTIFACT_LABEL[artifact.kind]} v{artifact.version}
          </Chip>
        </ModalHeader>
        <ModalBody className="pb-6">
          <ArtifactBody artifact={artifact} />
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}

/**
 * One thing an agent (or a person) put forward for a ticket. A draft waits for a person: Accept ties the approval to this exact
 * content (its digest), Reject sets it aside. Nothing later in the pipeline uses a draft.
 */
export function ArtifactCard({ artifact, canDecide }: { artifact: Artifact; canDecide: boolean }) {
  const [open, setOpen] = useState(artifact.state === 'draft');
  const [big, setBig] = useState(false);
  const busy = usePipeline((s) => s.busy.includes(`decide:${artifact.id}`));
  const state = STATE_CHIP[artifact.state];
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-medium bg-default-50 p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Chip size="sm" variant="flat" color="secondary">
          {ARTIFACT_LABEL[artifact.kind]}
        </Chip>
        <Chip size="sm" variant="flat">
          v{artifact.version}
        </Chip>
        <Chip size="sm" variant="flat" color={state.color}>
          {state.label}
        </Chip>
        <span className="flex-1" />
        <Hint label="The approval is tied to exactly this content">
          <span className="font-mono text-tiny text-foreground-400">{shortDigest(artifact.digest)}</span>
        </Hint>
      </div>
      <p className="text-small font-medium leading-5">{artifact.title}</p>
      <p className="flex items-center gap-1 text-tiny text-foreground-500">
        {artifact.by.agent ? <Bot size={12} /> : <UserCheck size={12} />}
        {artifact.by.name}
      </p>
      {open && (
        <div className="min-w-0 max-h-[28rem] overflow-y-auto">
          <ArtifactBody artifact={artifact} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="flat" startContent={<Eye size={14} />} onPress={() => setOpen((v) => !v)}>
          {open ? 'Hide' : 'Show'}
        </Button>
        <Button size="sm" variant="flat" startContent={<Maximize2 size={14} />} onPress={() => setBig(true)}>
          Open
        </Button>
        <span className="flex-1" />
        {artifact.state === 'draft' && canDecide && (
          <>
            <Button size="sm" variant="flat" isDisabled={busy} onPress={() => void usePipeline.getState().decide(artifact.id, 'rejected')}>
              Reject
            </Button>
            <Button size="sm" color="primary" isLoading={busy} onPress={() => void usePipeline.getState().decide(artifact.id, 'accepted')}>
              Accept
            </Button>
          </>
        )}
      </div>
      {big && <ArtifactModal artifact={artifact} onClose={() => setBig(false)} />}
    </div>
  );
}
