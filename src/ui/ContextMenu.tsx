import { Card, Listbox, ListboxItem, ListboxSection, tv } from '@heroui/react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronRight } from './lucide';

export type ContextMenuAction = {
  kind?: 'item';
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  danger?: boolean;
  isDisabled?: boolean;
  /** Same as `isDisabled`; the shorter name the first screens used. */
  disabled?: boolean;
  checked?: boolean;
  onClick?: () => void;
  children?: ContextMenuItem[];
};

export type ContextMenuItem = ContextMenuAction | { kind: 'separator' } | { kind: 'header'; label: string };

const isAction = (item: ContextMenuItem): item is ContextMenuAction => item.kind === undefined || item.kind === 'item';

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

const panel = tv({
  base: 'fixed z-50 min-w-56 max-w-80 rounded-medium bg-content1 p-1',
});

const SUBMENU_GAP = 2;
const EDGE = 8;

/** Groups the flat list into the sections a Listbox wants: a header names a section, a separator starts a new one. */
function sections(items: ContextMenuItem[]) {
  const out: { title?: string; items: { item: ContextMenuAction; index: number }[] }[] = [{ items: [] }];
  items.forEach((item, index) => {
    if (item.kind === 'separator') {
      if (out[out.length - 1].items.length > 0) out.push({ items: [] });
    } else if (item.kind === 'header') {
      if (out[out.length - 1].items.length > 0) out.push({ items: [] });
      out[out.length - 1].title = item.label;
    } else if (isAction(item)) {
      out[out.length - 1].items.push({ item, index });
    }
  });
  return out.filter((s) => s.items.length > 0);
}

type Level = { items: ContextMenuItem[]; x: number; y: number; from?: DOMRect };

function Panel({ level, depth, onHover, onRun, onClose }: { level: Level; depth: number; onHover: (depth: number, index: number | null, rect?: DOMRect) => void; onRun: (item: ContextMenuAction) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: level.x, y: level.y });

  // Keep the panel inside the window; a submenu opens to the left of its parent when there is no room on the right.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let x = level.x;
    if (level.from && x + rect.width > window.innerWidth - EDGE) x = level.from.left - rect.width - SUBMENU_GAP;
    x = Math.max(EDGE, Math.min(x, window.innerWidth - rect.width - EDGE));
    const y = Math.max(EDGE, Math.min(level.y, window.innerHeight - rect.height - EDGE));
    setPos({ x, y });
  }, [level]);

  return (
    <Card
      shadow="lg"
      radius="md"
      ref={ref}
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      className={panel()}
    >
      <Listbox
        aria-label="Actions"
        variant="flat"
        autoFocus={depth === 0}
        onAction={(key) => {
          const index = Number(key);
          const found = sections(level.items)
            .flatMap((s) => s.items)
            .find((x) => x.index === index);
          if (found) onRun(found.item);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
        itemClasses={{ base: 'gap-2 px-2 py-1.5 text-tiny' }}
      >
        {sections(level.items).map((section, s, all) => (
          <ListboxSection key={s} title={section.title} showDivider={s < all.length - 1} classNames={{ heading: 'text-tiny font-semibold uppercase tracking-wider text-foreground-400' }}>
            {section.items.map(({ item, index }) => {
              const hasChildren = Boolean(item.children && item.children.length > 0);
              const disabled = item.isDisabled ?? item.disabled ?? false;
              return (
                <ListboxItem
                  key={String(index)}
                  textValue={item.label}
                  color={item.danger ? 'danger' : 'default'}
                  className={item.danger ? 'text-danger' : undefined}
                  isDisabled={disabled}
                  startContent={
                    item.icon !== undefined ? (
                      <span className="flex w-4 shrink-0 items-center justify-center text-foreground-500">{item.icon}</span>
                    ) : item.checked !== undefined ? (
                      <span className="flex w-4 shrink-0 items-center justify-center text-primary">{item.checked ? <Check size={12} /> : null}</span>
                    ) : null
                  }
                  endContent={
                    hasChildren ? (
                      <ChevronRight size={12} className="shrink-0 text-foreground-400" />
                    ) : item.shortcut ? (
                      <span className="ml-3 shrink-0 font-mono text-tiny text-foreground-400">{item.shortcut}</span>
                    ) : null
                  }
                  onMouseEnter={(e: React.MouseEvent<HTMLElement>) => onHover(depth, hasChildren && !disabled ? index : null, e.currentTarget.getBoundingClientRect())}
                >
                  <span className="truncate">{item.label}</span>
                </ListboxItem>
              );
            })}
          </ListboxSection>
        ))}
      </Listbox>
    </Card>
  );
}

/**
 * A right-click menu that opens at the pointer (HeroUI has no context menu, only menus that hang from a button). It is
 * HeroUI's Listbox in a floating Card, with submenus, and closes on Escape, a click outside, or when the window changes.
 */
export function ContextMenu({ menu, onClose }: { menu: ContextMenuState | null; onClose: () => void }) {
  const [levels, setLevels] = useState<Level[]>([]);

  useEffect(() => {
    setLevels(menu ? [{ items: menu.items, x: menu.x, y: menu.y }] : []);
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [menu, onClose]);

  if (!menu || levels.length === 0) return null;

  const onHover = (depth: number, index: number | null, rect?: DOMRect) => {
    setLevels((prev) => {
      const kept = prev.slice(0, depth + 1);
      if (index === null || !rect) return kept.length === prev.length ? prev : kept;
      const children = (kept[depth].items[index] as ContextMenuAction).children!;
      return [...kept, { items: children, x: rect.right + SUBMENU_GAP, y: rect.top - 4, from: rect }];
    });
  };

  const onRun = (item: ContextMenuAction) => {
    if (item.children?.length) return;
    onClose();
    item.onClick?.();
  };

  return (
    <div
      className="fixed inset-0 z-50"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {levels.map((level, depth) => (
        <Panel key={depth} level={level} depth={depth} onHover={onHover} onRun={onRun} onClose={onClose} />
      ))}
    </div>
  );
}
