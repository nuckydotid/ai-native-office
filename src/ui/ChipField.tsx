import { useEffect, useImperativeHandle, useRef, useState, type FocusEventHandler, type KeyboardEvent, type Ref } from 'react';
import { tv, type VariantProps } from '@heroui/react';

/**
 * A text field whose words can include chips: small inline pieces such as `@Marco` that are one thing, not letters. Backspace next to
 * one removes it whole, the caret never lands inside it, and what is copied, sent or counted is plain text where each chip is its
 * `token` (`@marco`). HeroUI's Textarea can't show anything but text, so this is the one leaf that is a `contenteditable` element.
 * It is built the way HeroUI builds its own: `tv` variants named `size` and `isInvalid`, theme tokens only, `isDisabled`, `isReadOnly`.
 *
 * It is uncontrolled: the words live in the page, and `onValueChange` says what they are whenever they or the caret change. The
 * parent changes them through the handle (`clear`, `insertChip`), never by passing a value.
 */
const chipField = tv({
  slots: {
    base: 'relative w-full cursor-text transition-colors',
    field: 'block w-full overflow-y-auto whitespace-pre-wrap break-words text-small text-foreground outline-none',
    placeholder: 'pointer-events-none absolute inset-x-0 top-0 truncate text-small text-foreground-500',
    chip: 'mx-px cursor-default rounded-small bg-primary/15 px-1 font-medium text-primary',
  },
  variants: {
    size: {
      sm: { base: 'rounded-small', field: 'max-h-32 min-h-8 px-2 py-1.5', placeholder: 'px-2 py-1.5' },
      md: { base: 'rounded-medium', field: 'max-h-40 min-h-10 px-3 py-2', placeholder: 'px-3 py-2' },
    },
    isInvalid: {
      false: { base: 'bg-default-100 hover:bg-default-200 focus-within:bg-default-100' },
      true: { base: 'bg-danger-50 hover:bg-danger-100 focus-within:bg-danger-50' },
    },
    isDisabled: { true: { base: 'pointer-events-none opacity-disabled' } },
  },
  defaultVariants: { size: 'md', isInvalid: false },
});

/** Stands for a chip in `probe`, so a word typed beside one is never read as part of it. */
export const CHIP_CHAR = '￼';

export interface Chip {
  /** What the chip is in the plain text: `@marco`. */
  token: string;
  /** What the chip shows: `@Marco`. */
  label: string;
}

export interface ChipFieldState {
  /** The words with every chip written as its token. This is what is sent, counted and kept. */
  value: string;
  /** The same words with every chip as one `CHIP_CHAR`, and `caret` is an offset into it. Same length as `value` where there are no chips. */
  probe: string;
  caret: number;
}

export interface ChipFieldHandle {
  focus(): void;
  /** Whether `node` is the field or something in it. */
  contains(node: Node | null): boolean;
  /** Empties the field. */
  clear(): void;
  /** Puts `chip` and a space where `probe` has `start..end`, and the caret after it. */
  insertChip(start: number, end: number, chip: Chip): void;
}

export type ChipFieldProps = VariantProps<typeof chipField> & {
  ref?: Ref<ChipFieldHandle>;
  'aria-label': string;
  placeholder?: string;
  isReadOnly?: boolean;
  className?: string;
  /** The words or the caret changed. */
  onValueChange?: (value: string, state: ChipFieldState) => void;
  /** Called first. A key it handles with `preventDefault` is left alone (Enter and Tab for a list that is open). */
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  onFocus?: FocusEventHandler<HTMLDivElement>;
  onBlur?: FocusEventHandler<HTMLDivElement>;
};

/* ───────────── reading the page ───────────── */

/**
 * Kept after a line break that ends the words, so the caret has a place on the new line (a browser puts it back before a trailing
 * line break otherwise). It is never part of the words.
 */
const LINE_END = '\u200B';
const NO_BREAK_SPACE = '\u00A0';

/** The words under `root`: with chips as tokens (`value`) and as one character each (`probe`). A no-break space is a space. */
function readNodes(root: Node): { value: string; probe: string } {
  let value = '';
  let probe = '';
  const visit = (parent: Node) => {
    parent.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = (child as Text).data.replaceAll(NO_BREAK_SPACE, ' ').replaceAll(LINE_END, '');
        value += text;
        probe += text;
      } else if (child instanceof HTMLElement) {
        if (child.dataset.chip !== undefined) {
          value += child.dataset.chip;
          probe += CHIP_CHAR;
        } else if (child.tagName === 'BR') {
          value += '\n';
          probe += '\n';
        } else {
          // A browser that made a block of a line (Enter somewhere we didn't catch): a line break before it, unless one is there.
          if ((child.tagName === 'DIV' || child.tagName === 'P') && value && !value.endsWith('\n')) {
            value += '\n';
            probe += '\n';
          }
          visit(child);
        }
      }
    });
  };
  visit(root);
  return { value, probe };
}

/** Where the caret (the start of the selection) is in `probe`, or `fallback` when the selection is somewhere else. */
function caretIn(root: HTMLElement, fallback: number): number {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return fallback;
  const at = selection.getRangeAt(0);
  if (!root.contains(at.startContainer)) return fallback;
  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(at.startContainer, at.startOffset);
  return readNodes(before.cloneContents()).probe.length;
}

/** The place in the page for an offset into `probe`. */
function positionAt(root: HTMLElement, offset: number): { node: Node; offset: number } {
  let left = offset;
  const find = (parent: Node): { node: Node; offset: number } | null => {
    const kids = Array.from(parent.childNodes);
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      if (child.nodeType === Node.TEXT_NODE) {
        const length = (child as Text).data.length;
        if (left <= length) return { node: child, offset: left };
        left -= length;
      } else if (child instanceof HTMLElement) {
        if (child.dataset.chip !== undefined || child.tagName === 'BR') {
          if (left === 0) return { node: parent, offset: i };
          left -= 1;
        } else {
          const inside = find(child);
          if (inside) return inside;
        }
      }
    }
    return null;
  };
  return find(root) ?? { node: root, offset: root.childNodes.length };
}

/** The chip right before (or after) a collapsed caret, if there is one. */
function chipBesideCaret(root: HTMLElement, forward: boolean): HTMLElement | null {
  const selection = window.getSelection();
  if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return null;
  const { startContainer: container, startOffset: offset } = selection.getRangeAt(0);
  if (!root.contains(container)) return null;
  let node: Node | null = null;
  if (container.nodeType === Node.TEXT_NODE) {
    const atEdge = forward ? offset === (container as Text).data.length : offset === 0;
    if (atEdge) node = forward ? container.nextSibling : container.previousSibling;
  } else {
    node = forward ? (container.childNodes[offset] ?? null) : (container.childNodes[offset - 1] ?? null);
  }
  while (node && node.nodeType === Node.TEXT_NODE && (node as Text).data === '') node = forward ? node.nextSibling : node.previousSibling;
  return node instanceof HTMLElement && node.dataset.chip !== undefined ? node : null;
}

/** Gives a line break that ends the words something after it, so the caret can be on the new line. */
function keepLineEnd(text: Text) {
  if (text.data.endsWith('\n') && !text.nextSibling) text.appendData(LINE_END);
}

/**
 * Puts plain `text` at the caret (over the selection). A line break is written into the text itself, never made into a block or a
 * `<br>`, so what the page holds stays one run of words and chips; other text goes through the browser's editing, so undo understands it.
 */
function insertText(text: string) {
  if (!text.includes('\n') && document.execCommand('insertText', false, text)) return;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  let node = range.startContainer;
  let offset = range.startOffset;
  if (node.nodeType !== Node.TEXT_NODE) {
    const fresh = document.createTextNode('');
    range.insertNode(fresh);
    node = fresh;
    offset = 0;
  }
  (node as Text).insertData(offset, text);
  keepLineEnd(node as Text);
  range.setStart(node, offset + text.length);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

/* ───────────── the component ───────────── */

export function ChipField({ ref, 'aria-label': label, placeholder, size, isInvalid, isDisabled, isReadOnly, className, onValueChange, onKeyDown, onFocus, onBlur }: ChipFieldProps) {
  const field = useRef<HTMLDivElement>(null);
  const last = useRef<ChipFieldState>({ value: '', probe: '', caret: 0 });
  const [empty, setEmpty] = useState(true);
  const notify = useRef(onValueChange);
  const slots = chipField({ size, isInvalid: Boolean(isInvalid), isDisabled: Boolean(isDisabled) });

  /** Reads the page, and tells the parent if the words or the caret are not what it was last told. */
  const emit = (force = false) => {
    const root = field.current;
    if (!root) return;
    // Emptying the field (select all, delete) leaves the browser's own `<br>` behind: that is no line break of ours.
    if (root.firstChild && Array.from(root.childNodes).every((n) => n.nodeName === 'BR')) root.textContent = '';
    if (root.lastChild?.nodeType === Node.TEXT_NODE) keepLineEnd(root.lastChild as Text);
    const { value, probe } = readNodes(root);
    const caret = caretIn(root, probe.length);
    const before = last.current;
    if (!force && before.value === value && before.probe === probe && before.caret === caret) return;
    const next = { value, probe, caret };
    last.current = next;
    setEmpty(value === '');
    notify.current?.(value, next);
  };

  // The latest `emit` and callback, so the one page-wide listener below is added once and never goes stale.
  const latest = useRef(emit);
  useEffect(() => {
    latest.current = emit;
    notify.current = onValueChange;
  });

  // A caret that moves (a click, the arrow keys) changes what the parent offers; the page says so with `selectionchange` only.
  useEffect(() => {
    const onSelection = () => {
      const anchor = window.getSelection()?.anchorNode;
      if (anchor && field.current?.contains(anchor)) latest.current();
    };
    document.addEventListener('selectionchange', onSelection);
    return () => document.removeEventListener('selectionchange', onSelection);
  }, []);

  useImperativeHandle(ref, () => ({
    focus: () => field.current?.focus(),
    contains: (node) => Boolean(node && field.current?.contains(node)),
    clear: () => {
      if (field.current) field.current.textContent = '';
      emit(true);
    },
    insertChip: (start, end, chip) => {
      const root = field.current;
      if (!root) return;
      const range = document.createRange();
      const from = positionAt(root, start);
      const to = positionAt(root, end);
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
      root.focus();
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      const piece = document.createElement('span');
      piece.dataset.chip = chip.token;
      piece.contentEditable = 'false';
      piece.className = slots.chip();
      piece.textContent = chip.label;
      // Through the browser's own editing, so undo takes the chip back; by hand where it won't.
      if (!document.execCommand('insertHTML', false, `${piece.outerHTML}&nbsp;`)) {
        range.deleteContents();
        const space = document.createTextNode(' ');
        range.insertNode(space);
        range.insertNode(piece);
        range.setStartAfter(space);
        range.collapse(true);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      emit(true);
    },
  }));

  const keyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented || e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      insertText('\n');
      emit();
      return;
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.metaKey && !e.altKey && !e.ctrlKey && field.current) {
      const chip = chipBesideCaret(field.current, e.key === 'Delete');
      if (chip) {
        e.preventDefault();
        chip.remove();
        emit();
      }
    }
  };

  const editable = !isDisabled && !isReadOnly;

  return (
    <div className={slots.base({ className })}>
      {empty && placeholder && (
        <span aria-hidden className={slots.placeholder()}>
          {placeholder}
        </span>
      )}
      <div
        ref={field}
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        aria-invalid={isInvalid || undefined}
        aria-disabled={isDisabled || undefined}
        aria-readonly={isReadOnly || undefined}
        contentEditable={editable}
        suppressContentEditableWarning
        className={slots.field()}
        onInput={() => emit()}
        onKeyDown={keyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        onPaste={(e) => {
          // Words only: what a page or a document brings with it (fonts, colors, links) isn't wanted in a message.
          e.preventDefault();
          insertText(e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n').replace(/￼/g, ''));
          emit();
        }}
        onCopy={(e) => {
          const selection = window.getSelection();
          if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
          e.preventDefault();
          const holder = document.createElement('div');
          holder.append(selection.getRangeAt(0).cloneContents());
          e.clipboardData.setData('text/plain', readNodes(holder).value);
        }}
        onCut={(e) => {
          const selection = window.getSelection();
          if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
          e.preventDefault();
          const range = selection.getRangeAt(0);
          const holder = document.createElement('div');
          holder.append(range.cloneContents());
          e.clipboardData.setData('text/plain', readNodes(holder).value);
          range.deleteContents();
          emit();
        }}
        onDrop={(e) => e.preventDefault()}
      />
    </div>
  );
}
