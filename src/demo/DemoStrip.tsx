import { useEffect } from 'react';
import { Hint, TextButton } from '../ui';
import { stripText, useDemo } from './store.ts';

const REFRESH_MS = 60_000;

/** When the workspace is put back, as a time of day: `resetsAt` is a number of milliseconds or a date string. */
function resetTime(resetsAt: number | string | undefined): string {
  const at = typeof resetsAt === 'number' || typeof resetsAt === 'string' ? new Date(resetsAt) : null;
  return at && Number.isFinite(at.getTime()) && resetsAt !== '' ? at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'tonight';
}

/** The honest line under the top bar of the hosted demo: the data is made up, it is put back every night, and AI runs are limited. */
export function DemoStrip() {
  const status = useDemo((s) => s.status);
  const guideOpen = useDemo((s) => s.guideOpen);
  const openGuide = useDemo((s) => s.openGuide);

  useEffect(() => {
    void useDemo.getState().refresh();
    const id = setInterval(() => void useDemo.getState().refresh(), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const detail = status
    ? `Every visitor may start ${status.runsPerHour} AI runs an hour. The workspace is put back as it was at ${resetTime(status.resetsAt)}, so nothing you type here is kept.`
    : 'Everything here is made up, and the workspace is put back as it was every night.';

  return (
    <div role="status" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5 bg-primary/10 px-4 py-1.5 text-center text-tiny text-foreground-600">
      <Hint label={detail} placement="bottom">
        <span className="cursor-default">{stripText(status)}</span>
      </Hint>
      {!guideOpen && <TextButton onPress={openGuide}>Judge’s 3-minute path</TextButton>}
    </div>
  );
}
