/** Singapore time is UTC+8; the demo resets at 03:00 there, and a day of runs ends with it. */
const SGT_MS = 8 * 3600_000;
const RESET_HOUR_SGT = 3;
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

/** The next 03:00 Singapore time after `now`. */
export function nextResetAt(now: number): number {
  const local = now + SGT_MS;
  const day = Math.floor(local / DAY_MS) * DAY_MS;
  const today = day + RESET_HOUR_SGT * HOUR_MS;
  return (local < today ? today : today + DAY_MS) - SGT_MS;
}

export interface BudgetStatus {
  runsLeft: number;
  runsPerHour: number;
  resetsAt: string;
}

/**
 * What the open demo may spend on Gemini: a number of agent runs per guest per hour, and a total per day (the day ends at the
 * nightly reset). Counting runs rather than tokens is deliberate: each run is capped in tokens by the agent service, so the cost
 * of a day is bounded by `perDay`.
 */
export class RunBudget {
  private guests = new Map<string, { start: number; used: number }>();
  private day = { index: -1, used: 0 };

  constructor(
    private perGuestHour: number,
    private perDay: number,
    private now: () => number = Date.now,
  ) {}

  private dayIndex(t: number) {
    return Math.floor((t + SGT_MS - RESET_HOUR_SGT * HOUR_MS) / DAY_MS);
  }

  private roll(t: number) {
    const idx = this.dayIndex(t);
    if (this.day.index !== idx) this.day = { index: idx, used: 0 };
  }

  private window(uid: string, t: number) {
    let w = this.guests.get(uid);
    if (!w || t - w.start > HOUR_MS) {
      w = { start: t, used: 0 };
      this.guests.delete(uid);
      this.guests.set(uid, w);
      if (this.guests.size > 5000) this.guests.delete(this.guests.keys().next().value as string);
    }
    return w;
  }

  /** Counts one run, or says which limit stopped it. */
  take(uid: string): { ok: true } | { ok: false; reason: 'guest' | 'day' } {
    const t = this.now();
    this.roll(t);
    const w = this.window(uid, t);
    if (this.day.used >= this.perDay) return { ok: false, reason: 'day' };
    if (w.used >= this.perGuestHour) return { ok: false, reason: 'guest' };
    w.used += 1;
    this.day.used += 1;
    return { ok: true };
  }

  /** Gives a run back (the model never answered: that is not the guest's doing). */
  refund(uid: string) {
    const t = this.now();
    this.roll(t);
    const w = this.guests.get(uid);
    if (w && w.used > 0) w.used -= 1;
    if (this.day.used > 0) this.day.used -= 1;
  }

  status(uid: string): BudgetStatus {
    const t = this.now();
    this.roll(t);
    const w = this.guests.get(uid);
    const used = w && t - w.start <= HOUR_MS ? w.used : 0;
    return {
      runsLeft: Math.max(0, Math.min(this.perGuestHour - used, this.perDay - this.day.used)),
      runsPerHour: this.perGuestHour,
      resetsAt: new Date(nextResetAt(t)).toISOString(),
    };
  }

  /** After the nightly reset everything starts over. */
  reset() {
    this.guests.clear();
    this.day = { index: this.dayIndex(this.now()), used: 0 };
  }
}
