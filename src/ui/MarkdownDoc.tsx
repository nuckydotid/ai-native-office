import { createContext, Fragment, useContext, useMemo, type ReactNode } from 'react';
import { Checkbox, Table, TableBody, TableCell, TableColumn, TableHeader, TableRow } from '@heroui/react';
import { fileNameOf, parseMarkdown, type Block, type Inline } from './markdown-doc.ts';
import { TextButton } from './TextButton';

/**
 * A document an agent wrote (a plan, a task list, a walkthrough), laid out. Everything is React text: nothing in it can become
 * HTML, a link to follow, or an image that loads (see `markdown-doc.ts`). For chat answers use `Markdown`, which is lighter.
 */
export function MarkdownDoc({
  text,
  renderImage,
  onOpenFile,
}: {
  text: string;
  /** Shows a picture the team server keeps (`asset:<id>`); without it a picture is its description. */
  renderImage?: (id: string, alt: string) => ReactNode;
  /** Opens a Markdown file that a link points at on the author’s computer; without it such a link is just the file's name. */
  onOpenFile?: (path: string) => void;
}) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <ImageContext.Provider value={renderImage ?? null}>
      <OpenContext.Provider value={onOpenFile ?? null}>
      <div className="flex flex-col gap-3 text-small leading-6 text-foreground-700">
        {blocks.map((b, i) => (
          <BlockView key={i} block={b} />
        ))}
      </div>
      </OpenContext.Provider>
    </ImageContext.Provider>
  );
}

const ImageContext = createContext<((id: string, alt: string) => ReactNode) | null>(null);
const OpenContext = createContext<((path: string) => void) | null>(null);

/** A link to a file on the author’s computer: its name, and a press that opens it when it is a Markdown file and there is a viewer. */
function FileLink({ href, name }: { href: string; name: string }) {
  const open = useContext(OpenContext);
  const path = decodeURIComponent(href.replace(/^file:\/\//i, '').split(/[?#]/)[0]);
  if (open && /\.(md|markdown)$/i.test(path)) {
    return (
      <TextButton onPress={() => open(path)}>
        {name}
      </TextButton>
    );
  }
  return (
    <code className="rounded-small bg-default-200 px-1 py-0.5 font-mono text-tiny text-primary">
      {name}
    </code>
  );
}

function PictureView({ id, alt }: { id: string; alt: string }) {
  const render = useContext(ImageContext);
  return <>{render ? render(id, alt) : <span className="italic text-foreground-500">{alt}</span>}</>;
}

function InlineView({ nodes }: { nodes: Inline[] }): ReactNode {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case 'text':
            return <Fragment key={i}>{n.v}</Fragment>;
          case 'code':
            return (
              <code key={i} className="rounded-small bg-default-200 px-1 py-0.5 font-mono text-tiny">
                {n.v}
              </code>
            );
          case 'strong':
            return (
              <strong key={i} className="font-semibold text-foreground">
                <InlineView nodes={n.c} />
              </strong>
            );
          case 'em':
            return (
              <em key={i}>
                <InlineView nodes={n.c} />
              </em>
            );
          case 'del':
            return (
              <del key={i} className="text-foreground-400">
                <InlineView nodes={n.c} />
              </del>
            );
          case 'image':
            return <PictureView key={i} id={n.id} alt={n.alt} />;
          case 'link': {
            // A link to a file on the author’s computer is shown as that file; any other link is its label, underlined, and nothing to press.
            const file = fileNameOf(n.href);
            return file ? (
              <FileLink key={i} href={n.href} name={file} />
            ) : (
              <span key={i} className="text-primary underline decoration-dotted">
                <InlineView nodes={n.c} />
              </span>
            );
          }
        }
      })}
    </>
  );
}

const HEADING_CLASS: Record<number, string> = {
  1: 'text-large font-semibold text-foreground',
  2: 'mt-1 text-medium font-semibold text-foreground',
  3: 'text-small font-semibold text-foreground',
  4: 'text-small font-medium text-foreground-600',
  5: 'text-small font-medium text-foreground-500',
  6: 'text-tiny font-medium uppercase text-foreground-500',
};

const NOTE_CLASS: Record<string, string> = {
  NOTE: 'bg-primary/10',
  TIP: 'bg-success/10',
  IMPORTANT: 'bg-secondary/10',
  WARNING: 'bg-warning/10',
  CAUTION: 'bg-danger/10',
};

function BlockView({ block }: { block: Block }): ReactNode {
  switch (block.t) {
    case 'heading':
      return (
        <p role="heading" aria-level={Math.min(6, block.level + 1)} className={HEADING_CLASS[block.level] ?? HEADING_CLASS[6]}>
          <InlineView nodes={block.c} />
        </p>
      );
    case 'p':
      return (
        <p className="whitespace-pre-wrap break-words">
          <InlineView nodes={block.c} />
        </p>
      );
    case 'hr':
      return <hr className="h-px border-0 bg-default-200" />;
    case 'code':
      return (
        <pre className="max-w-full overflow-x-auto rounded-medium bg-default-200 p-3 font-mono text-tiny leading-5">
          <code>{block.v}</code>
        </pre>
      );
    case 'quote':
      return (
        <div className={`flex flex-col gap-2 rounded-medium px-3 py-2 ${block.note ? (NOTE_CLASS[block.note] ?? 'bg-default-100') : 'bg-default-100'}`}>
          {block.note && <p className="text-tiny font-semibold uppercase text-foreground-500">{block.note.toLowerCase()}</p>}
          {block.c.map((b, i) => (
            <BlockView key={i} block={b} />
          ))}
        </div>
      );
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return (
        <Tag className={`flex flex-col gap-1.5 pl-5 ${block.ordered ? 'list-decimal' : 'list-disc'}`}>
          {block.items.map((item, i) => (
            <li key={i} className={`pl-1 ${item.task !== null ? 'list-none' : ''}`}>
              <div className="flex flex-col gap-1.5">
                {item.task !== null ? (
                  <div className="-ml-5 flex items-start gap-2">
                    <Checkbox size="sm" isReadOnly isSelected={item.task} aria-label={item.task ? 'Done' : 'Not done'} className="mt-0.5" />
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      {item.c.map((b, k) => (
                        <BlockView key={k} block={b} />
                      ))}
                    </div>
                  </div>
                ) : (
                  item.c.map((b, k) => <BlockView key={k} block={b} />)
                )}
              </div>
            </li>
          ))}
        </Tag>
      );
    }
    case 'table':
      return (
        <Table aria-label="Table in the document" removeWrapper isCompact isStriped className="max-w-full overflow-x-auto">
          <TableHeader>
            {block.head.map((h, i) => (
              <TableColumn key={i} align={block.align[i] === 'center' ? 'center' : block.align[i] === 'right' ? 'end' : 'start'}>
                <InlineView nodes={h} />
              </TableColumn>
            ))}
          </TableHeader>
          <TableBody emptyContent=" ">
            {block.rows.map((row, r) => (
              <TableRow key={r}>
                {row.map((cell, c) => (
                  <TableCell key={c}>
                    <InlineView nodes={cell} />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      );
  }
}
