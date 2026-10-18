// What the Activity page shows, pure and unit-tested: the budget meters and one readable line per audit event.

import type { PipelineInfo } from '../pipeline/api.ts';
import type { AuditEvent } from '../shared/pipeline/types.ts';

export interface Meter {
  id: string;
  label: string;
  /** "4 of 30 left today". */
  text: string;
  /** How much is left, 0 to 100. */
  percent: number;
  /** Under a fifth left: the bar turns red. */
  low: boolean;
}

/** The daily caps the pipeline keeps (the pipeline service owns them; these are the demo's numbers, used only to draw the bars). */
export const DAILY = { jobs: 30, rollouts: 15, scans: 6, guestHour: 6 } as const;

const meter = (id: string, label: string, left: number, capped: number, unit: string): Meter => {
  // A server with a bigger allowance than the demo's is drawn full, not clipped.
  const cap = Math.max(capped, left);
  const l = Math.max(0, left);
  return { id, label, text: `${l} of ${cap} ${unit}`, percent: Math.round((l / cap) * 100), low: l / cap < 0.2 };
};

export function meters(info: Pick<PipelineInfo, 'jobsLeftToday' | 'jobsLeftThisHour' | 'rolloutsLeftToday' | 'scansLeftToday' | 'concurrent' | 'maxConcurrent'>): Meter[] {
  return [
    meter('jobs', 'Jobs today', info.jobsLeftToday, DAILY.jobs, 'left'),
    meter('hour', 'Your jobs this hour', info.jobsLeftThisHour, DAILY.guestHour, 'left'),
    meter('rollouts', 'Rollouts today', info.rolloutsLeftToday, DAILY.rollouts, 'left'),
    meter('scans', 'Scans today', info.scansLeftToday, DAILY.scans, 'left'),
    { id: 'running', label: 'Running now', text: `${info.concurrent} of ${info.maxConcurrent} at once`, percent: Math.round((1 - info.concurrent / Math.max(1, info.maxConcurrent)) * 100), low: info.concurrent >= info.maxConcurrent },
  ];
}

/** One sentence for an audit event: what the pipeline wrote, with the person’s role when it is not an ordinary member. */
export function activityLine(e: Pick<AuditEvent, 'detail' | 'by'>): string {
  return e.by.role === 'owner' || e.by.role === 'admin' ? `${e.detail} (${e.by.role})` : e.detail;
}

/** Newest first, whatever order the server keeps them in. */
export const newestFirst = (events: readonly AuditEvent[]): AuditEvent[] => [...events].sort((a, b) => b.at - a.at);
