import { useState } from 'react';
import { Button, Checkbox, Chip, Divider } from '@heroui/react';
import type { ChatCard, Citation, ProposalItem } from '../shared/workspace/types.ts';
import { useNav } from '../sync/nav.ts';
import { ClipboardCheck, FileText, Kanban } from '../ui/lucide';
import { ARTIFACT_LABEL } from '../pipeline/core.ts';
import type { ArtifactKind } from '../shared/pipeline/types.ts';
import { Hint } from '../ui';

/** Where a cited source lives: a page opens in Docs, a ticket on the Board. A cited chat message stays where it is. */
function openCitation(c: Citation) {
  if (c.kind === 'doc') useNav.getState().open({ page: 'docs', id: c.id });
  else if (c.kind === 'ticket') useNav.getState().open({ page: 'board', issue: c.id });
}

/** The sources under an agent's answer, as small chips; the quote is the tooltip, a press opens the page or ticket. */
export function CitationChips({ citations }: { citations: Citation[] }) {
  if (citations.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 pt-0.5">
      {citations.map((c, i) => (
        <Hint key={`${c.kind}-${c.id}-${i}`} label={c.quote ? `“${c.quote}”` : c.title}>
          <Button
            size="sm"
            variant="flat"
            radius="full"
            className="h-6 min-w-0 px-2 text-tiny"
            startContent={c.kind === 'ticket' ? <Kanban size={12} /> : <FileText size={12} />}
            isDisabled={c.kind === 'chat'}
            onPress={() => openCitation(c)}
          >
            <span className="max-w-52 truncate">{c.title}</span>
          </Button>
        </Hint>
      ))}
    </div>
  );
}

/** What a proposal item is called in its chip: a ticket, a Docs page, or the kind of artifact (a spec, a change set…). */
const itemKind = (item: ProposalItem): string => (item.type === 'ticket' ? 'Ticket' : item.type === 'artifact' ? (ARTIFACT_LABEL[item.artifactKind as ArtifactKind] ?? 'Draft') : 'Docs page');

function ItemLine({ item, chosen, onToggle, decided }: { item: ProposalItem; chosen: string[]; onToggle: (id: boolean) => void; decided: boolean }) {
  return (
    <div className="flex items-start gap-2 rounded-medium bg-content1/60 px-2 py-1.5">
      {!decided ? (
        <Checkbox size="sm" isSelected={chosen.includes(item.id)} onValueChange={(on) => onToggle(on)} aria-label={item.title} className="pt-0.5" />
      ) : (
        <Chip size="sm" variant="flat" color={chosen.includes(item.id) ? 'success' : 'default'} classNames={{ base: 'mt-0.5 h-5', content: 'px-1 text-tiny' }}>
          {chosen.includes(item.id) ? 'Accepted' : 'Left out'}
        </Chip>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-small font-medium">{item.title}</span>
        <span className="flex flex-wrap items-center gap-1 text-tiny text-foreground-400">
          <Chip size="sm" variant="flat" classNames={{ base: 'h-4', content: 'px-1 text-tiny' }} startContent={item.type === 'ticket' ? <Kanban size={10} /> : item.type === 'artifact' ? <ClipboardCheck size={10} /> : <FileText size={10} />}>
            {itemKind(item)}
          </Chip>
          {item.points ? <span>{item.points} points</span> : null}
          {item.labels?.map((l) => (
            <span key={l}>· {l}</span>
          ))}
          {item.duplicateOf ? (
            <>
              <span>· already tracked</span>
              <Button size="sm" variant="light" className="h-4 px-1 text-tiny" onPress={() => useNav.getState().open({ page: 'board', issue: String(item.duplicateOf) })}>
                #{item.duplicateOf}
              </Button>
            </>
          ) : null}
        </span>
      </div>
    </div>
  );
}

export interface DecidePayload {
  decision: 'proceeded' | 'dismissed';
  chosen: string[];
}

/** What an agent proposed (tickets to create, minutes to save): a person ticks items and accepts, or dismisses the card. */
export function ProposalCardView({ card, canDecide, onDecide }: { card: Extract<ChatCard, { kind: 'proposal' }>; canDecide: boolean; onDecide: (p: DecidePayload) => void }) {
  const fresh = card.items.filter((i) => !i.duplicateOf).map((i) => i.id);
  const [chosen, setChosen] = useState<string[]>(fresh);
  const decided = card.decided;
  const toggle = (id: string) => (on: boolean) => setChosen((list) => (on ? [...new Set([...list, id])] : list.filter((x) => x !== id)));

  return (
    <div className="flex w-full min-w-0 flex-col gap-2 rounded-large bg-default-100/60 p-3 shadow-small">
      <div className="flex flex-wrap items-center gap-2">
        <Chip size="sm" variant="flat" color="secondary">
          Proposal
        </Chip>
        <span className="text-small font-semibold">{card.title}</span>
        {decided ? (
          <Chip size="sm" variant="flat" color={decided === 'proceeded' ? 'success' : 'default'}>
            {decided === 'proceeded' ? 'Accepted' : 'Dismissed'}
          </Chip>
        ) : null}
      </div>
      <p className="text-tiny text-foreground-400">Nothing exists until a person accepts. The agent only proposes.</p>
      <Divider className="opacity-60" />
      <div className="flex flex-col gap-1.5">
        {card.items.map((item) => (
          <ItemLine key={item.id} item={item} chosen={decided ? (card.chosen ?? []) : chosen} onToggle={toggle(item.id)} decided={!!decided} />
        ))}
      </div>
      {decided === 'proceeded' && (card.created?.length ?? 0) > 0 ? (
        <p className="flex flex-wrap items-center gap-1 text-tiny text-foreground-500">
          Created:
          {(card.created ?? []).map((c) => {
            const item = card.items.find((i) => i.id === c.item);
            const ticket = item?.type === 'ticket';
            if (item?.type === 'artifact') return <span key={c.item}>the {itemKind(item).toLowerCase()}, now in its stage’s list</span>;
            return ticket ? (
              <Button key={c.item} size="sm" variant="light" className="h-4 px-1 text-tiny" onPress={() => useNav.getState().open({ page: 'board', issue: c.ref.replace('#', '') })}>
                {c.ref}
              </Button>
            ) : (
              <span key={c.item}>the page “{item?.title ?? 'minutes'}”</span>
            );
          })}
        </p>
      ) : null}
      {!decided && canDecide ? (
        <div className="flex items-center gap-2 pt-0.5">
          <Button size="sm" color="primary" isDisabled={chosen.length === 0} onPress={() => onDecide({ decision: 'proceeded', chosen })}>
            Accept {chosen.length ? `${chosen.length} item${chosen.length === 1 ? '' : 's'}` : ''}
          </Button>
          <Button size="sm" variant="flat" onPress={() => onDecide({ decision: 'dismissed', chosen: [] })}>
            Dismiss
          </Button>
        </div>
      ) : !decided ? (
        <p className="text-tiny text-foreground-400">Only the person who asked can accept this.</p>
      ) : null}
    </div>
  );
}

/** A plan an agent wrote: read-only in the room, so nobody mistakes it for something that runs by itself. */
export function PlanCardView({ card, nameOf }: { card: Extract<ChatCard, { kind: 'plan' }>; nameOf: (handle: string) => string }) {
  const plan = card.plan;
  return (
    <div className="flex w-full min-w-0 flex-col gap-2 rounded-large bg-default-100/60 p-3 shadow-small">
      <div className="flex flex-wrap items-center gap-2">
        <Chip size="sm" variant="flat" color="secondary">
          Plan
        </Chip>
        {plan.ticket && 'link' in plan.ticket ? (
          <Chip size="sm" variant="flat">
            for #{plan.ticket.link}
          </Chip>
        ) : plan.ticket && 'create' in plan.ticket ? (
          <Chip size="sm" variant="flat">
            proposes “{plan.ticket.create.title}”
          </Chip>
        ) : null}
      </div>
      <p className="text-small">{plan.summary}</p>
      {plan.steps.length > 0 ? (
        <ol className="flex list-decimal flex-col gap-0.5 ps-4 text-small text-foreground-600">
          {plan.steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      ) : null}
      {plan.agents.length > 0 ? (
        <p className="flex flex-wrap items-center gap-1 text-tiny text-foreground-400">
          Colleagues:
          {plan.agents.map((a) => (
            <Chip key={a.handle} size="sm" variant="flat" classNames={{ base: 'h-4', content: 'px-1 text-tiny' }}>
              {nameOf(a.handle)}
            </Chip>
          ))}
        </p>
      ) : null}
      {plan.risks.length > 0 ? (
        <p className="text-tiny text-foreground-400">
          <span className="font-medium">Risks:</span> {plan.risks.join(' · ')}
        </p>
      ) : null}
      <p className="text-tiny text-foreground-400">A person decides: the plan becomes tickets in Plan, and each ticket walks the stages from there.</p>
    </div>
  );
}
