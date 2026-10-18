import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Card, Listbox, ListboxItem } from '@heroui/react';
import { useAgents } from '../agents/store.ts';
import { agentLook } from '../agents/format.ts';
import { LIMITS, codePointLength } from '../shared/workspace/protocol.ts';
import { ArrowUp, ChipField, HeadAvatar, type ChipFieldHandle, type ChipFieldState } from '../ui';
import { checkMentions, mentionAtCaret, mentionNotice, suggestAgents } from './core/mentions.ts';
import type { OfficeSession } from './session';
import { useOffice } from './store';

/** Show the count once the message is this close to the limit. */
const COUNT_FROM = LIMITS.chatText - 100;

/**
 * The message field. Enter sends, Shift+Enter starts a new line, and Enter while an input method is composing (Japanese, Chinese,
 * Korean...) only confirms the word. The field is cleared when the server has saved the message, not before: if it can't be saved,
 * the words are still here and the reason is shown.
 *
 * Typing `@` offers the project's agents: arrows move, Enter, Tab or a click chooses, Escape closes it. The chosen agent becomes a
 * chip in the field (one piece: Backspace removes it whole); the message is still plain text with `@handle` in it, which is what the
 * server, the limits and the mention rules read.
 */
export function Composer({ session, project, isDisabled, placeholder }: { session: OfficeSession; project: string; isDisabled: boolean; placeholder: string }) {
  const agents = useAgents((s) => s.listing.agents);
  const [view, setView] = useState<ChipFieldState>({ value: '', probe: '', caret: 0 });
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  /** The suggestions are only offered while the field has focus (a panel left floating after the person moved on would be in the way). */
  const [focused, setFocused] = useState(false);
  const field = useRef<ChipFieldHandle>(null);
  /** The id of a send that didn't come back, with its words: sending the same words again reuses it, so the server can tell it already saved them. */
  const retry = useRef<{ cid: string; text: string } | null>(null);
  /** The words as they are sent: each chip is its `@handle`. */
  const draft = view.value;
  const length = codePointLength(draft);
  const tooLong = length > LIMITS.chatText;
  const blocked = isDisabled || sending || tooLong || !draft.trim();

  // Read from the probe, where a chip is one character: a word typed beside a chip is a new mention, never a part of the chip.
  const mention = useMemo(() => mentionAtCaret(view.probe, view.caret), [view.probe, view.caret]);
  const options = useMemo(() => (mention && dismissedAt !== mention.start ? suggestAgents(agents, mention.query) : []), [agents, mention, dismissedAt]);
  const open = focused && options.length > 0;
  const current = options[Math.min(active, options.length - 1)];

  // Whoever wrote the agents last (a pull, a save in the Agents page) is what is offered: read the files again when the person starts typing.
  const refresh = () => void useAgents.getState().refresh(project);

  useEffect(() => setActive(0), [mention?.query, mention?.start]);

  const choose = (handle: string) => {
    if (!mention) return;
    const agent = agents.find((a) => a.handle === handle);
    setDismissedAt(null);
    field.current?.insertChip(mention.start, mention.end, { token: `@${handle}`, label: `@${agent?.displayName ?? handle}` });
  };

  const send = async () => {
    if (blocked) return;
    setSending(true);
    setProblem(null);
    const text = draft;
    const again = retry.current?.text === text ? retry.current.cid : undefined;
    const result = await session.sendChat(text, again);
    setSending(false);
    retry.current = result.ok ? null : { cid: result.cid, text };
    if (result.ok) {
      field.current?.clear();
      setDismissedAt(null);
      // Said once, after it was sent: a message that calls something this project doesn't have is still a message.
      const note = mentionNotice(checkMentions(text, useAgents.getState().listing.agents.map((a) => a.handle)));
      if (note) useOffice.getState().setNotice(note);
    } else setProblem(result.message);
    // The field was read-only while waiting, which takes focus away from it.
    requestAnimationFrame(() => field.current?.focus());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // `keyCode 229` is how some browsers report a key pressed to confirm an input-method word.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
        return;
      }
      // Shift+Tab is how focus goes backwards: it is left alone.
      if ((e.key === 'Enter' && !e.shiftKey) || (e.key === 'Tab' && !e.shiftKey)) {
        e.preventDefault();
        if (current) choose(current.handle);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (mention) setDismissedAt(mention.start);
        return;
      }
    }
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    void send();
  };

  return (
    <div className="relative flex flex-col gap-1 px-3 pb-4 pt-1">
      {open && (
        <Card shadow="md" radius="md" data-chip-suggestions className="absolute inset-x-3 bottom-full z-20 mb-1 max-h-60 overflow-y-auto bg-content1">
          {/* A press on a row moves focus to the row for a moment: the list stays open while focus is in it, and the field gets it back
              when an agent is chosen. */}
          <div
            onMouseDown={(e) => e.preventDefault()}
            onBlur={(e) => {
              const to = e.relatedTarget as Node | null;
              if (!e.currentTarget.contains(to) && !field.current?.contains(to)) setFocused(false);
            }}
          >
            <Listbox
              aria-label="Agents you can ask"
              variant="flat"
              color="primary"
              onAction={(key) => choose(String(key))}
            >
              {options.map((a) => (
                <ListboxItem
                  key={a.handle}
                  textValue={a.displayName}
                  description={a.role || undefined}
                  // The row the arrow keys are on. No selection mode: with one, a click only selects and `onAction` waits for a double click.
                  className={a.handle === current?.handle ? 'bg-primary/15' : undefined}
                  startContent={<HeadAvatar look={agentLook(a)} name={a.displayName} size="sm" />}
                >
                  {a.displayName} <span className="text-foreground-400">@{a.handle}</span>
                </ListboxItem>
              ))}
            </Listbox>
          </div>
        </Card>
      )}
      <div className="flex items-end gap-2">
        <ChipField
          ref={field}
          aria-label="Message the room"
          size="sm"
          placeholder={placeholder}
          onValueChange={(_, next) => {
            // Escape closes the list for this `@`; moving the caret doesn't open it again, new words do.
            if (next.value !== view.value) setDismissedAt(null);
            setView(next);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => {
            setFocused(true);
            refresh();
          }}
          onBlur={(e) => {
            // Focus going to the list of agents (a click on one) is not the person leaving.
            if (!(e.relatedTarget instanceof Node && e.relatedTarget.closest('[data-chip-suggestions]'))) setFocused(false);
          }}
          isReadOnly={sending}
          isDisabled={isDisabled}
          isInvalid={tooLong}
          className="min-w-0 flex-1"
        />
        <Button isIconOnly color="primary" size="md" aria-label="Send" isLoading={sending} isDisabled={blocked} onPress={() => void send()}>
          <ArrowUp size={16} />
        </Button>
      </div>
      {(problem || length >= COUNT_FROM) && (
        <p className={`px-1 text-tiny ${problem || tooLong ? 'text-danger' : 'text-foreground-400'}`} role={problem ? 'alert' : undefined}>
          {problem ?? `${length} / ${LIMITS.chatText}`}
        </p>
      )}
    </div>
  );
}
