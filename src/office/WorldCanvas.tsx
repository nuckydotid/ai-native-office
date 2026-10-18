import { useEffect, useRef, useState } from 'react';
import { Alert } from '@heroui/react';
import type { OfficeSession } from './session';
import type { OfficeEngine } from './world/engine';

/** Hosts the Pixi picture of the office. It stops drawing while the page is hidden. */
export function WorldCanvas({
  session,
  visible,
  onZoom,
  onEngine,
}: {
  session: OfficeSession;
  visible: boolean;
  onZoom: (zoom: number) => void;
  onEngine: (engine: OfficeEngine | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<OfficeEngine | null>(null);
  const latest = useRef({ visible, onZoom, onEngine });
  latest.current = { visible, onZoom, onEngine };
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let cancelled = false;
    setFailed(false);
    // The engine (and Pixi with it) is loaded here, so it only costs anything once the Office page is opened.
    void import('./world/engine')
      .then(({ OfficeEngine }) => OfficeEngine.create(el, session, (zoom) => latest.current.onZoom(zoom)))
      .then((created) => {
        if (cancelled) return created.destroy();
        engine.current = created;
        created.setVisible(latest.current.visible);
        latest.current.onEngine(created);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      engine.current?.destroy();
      engine.current = null;
      latest.current.onEngine(null);
    };
  }, [session]);

  useEffect(() => {
    engine.current?.setVisible(visible);
  }, [visible]);

  return (
    <>
      <div ref={host} className="absolute inset-0" />
      {failed && (
        <div className="absolute inset-x-4 top-16 z-10">
          <Alert color="danger" variant="flat" title="The office picture couldn’t start" description="This browser couldn’t start the graphics. Reload the page, or try another browser." />
        </div>
      )}
    </>
  );
}
