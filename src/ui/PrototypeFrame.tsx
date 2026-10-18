import { useEffect, useMemo, useRef, useState } from 'react';
import { Tab, Tabs } from '@heroui/react';
import { prototypeDocument } from './prototype.ts';

const WIDTH = { phone: 390, desktop: 1100 } as const;
const HEIGHT = { phone: 640, desktop: 700 } as const;

export type PrototypeFrameProps = {
  /** The page's HTML, as the Designer Agent wrote it. It is cleaned and shown with no scripts and no network. */
  html: string;
  /** Names the frame for screen readers. */
  title: string;
  /** Which screen size it opens on. */
  device?: keyof typeof WIDTH;
  className?: string;
};

/**
 * A designed page, shown safely: HTML an agent wrote is never put in the app's own page. It goes in an `iframe` with an empty
 * `sandbox` (no scripts, no forms, no same-origin access) and a policy that allows its own styles and inline pictures only, after
 * `hardenHtml` took out anything that could run or fetch. The frame is drawn at a real screen size and scaled to fit its place.
 */
export function PrototypeFrame({ html, title, device: first = 'phone', className }: PrototypeFrameProps) {
  const [device, setDevice] = useState<keyof typeof WIDTH>(first);
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(0);
  const doc = useMemo(() => prototypeDocument(html), [html]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const watch = new ResizeObserver(() => setRoom(el.clientWidth));
    watch.observe(el);
    setRoom(el.clientWidth);
    return () => watch.disconnect();
  }, []);

  const width = WIDTH[device];
  const height = HEIGHT[device];
  const scale = room > 0 ? Math.min(1, room / width) : 1;
  return (
    <div className={`flex min-w-0 flex-col gap-2 ${className ?? ''}`}>
      <Tabs size="sm" aria-label="Screen size" selectedKey={device} onSelectionChange={(key) => setDevice(key as keyof typeof WIDTH)} classNames={{ tabList: 'h-7', tab: 'h-6 px-2 text-tiny', cursor: 'rounded-small' }}>
        <Tab key="phone" title="Phone" />
        <Tab key="desktop" title="Desktop" />
      </Tabs>
      <div ref={box} className="min-w-0 overflow-hidden rounded-medium bg-default-100 shadow-small" style={{ height: height * scale }}>
        <iframe
          title={title}
          sandbox=""
          srcDoc={doc}
          referrerPolicy="no-referrer"
          loading="lazy"
          className="block bg-white"
          style={{ width, height, transform: `scale(${scale})`, transformOrigin: 'top left' }}
        />
      </div>
    </div>
  );
}
