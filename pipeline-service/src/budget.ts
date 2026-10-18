import { ServiceError } from './errors.ts';
import type { JobKind } from './shared/pipeline/types.ts';
import type { PipelineConfig } from './config.ts';
import type { StateStore } from './store.ts';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

interface DayBook {
  /** Every job started today, for the day cap, the guest-hour cap and the scan cap. */
  jobs: { at: number; uid: string; kind: JobKind }[];
  rollouts: { at: number }[];
  explores: { at: number }[];
}

/** The day the counters belong to, in UTC. The demo resets at 03:00 Singapore; the counters simply roll with the clock. */
const dayKey = (at: number) => new Date(at).toISOString().slice(0, 10);

export interface BudgetStatus {
  jobsLeftToday: number;
  jobsLeftThisHour: number;
  rolloutsLeftToday: number;
  scansLeftToday: number;
  exploresLeftToday: number;
}

/**
 * The caps a guest-triggered build system needs: a day cap and a per-guest hour cap on jobs, a scan cap (Artifact Analysis bills per
 * image) and a rollout cap. The counters live in the same store as the jobs, so a restart does not forget what was spent today.
 */
export class Budget {
  constructor(
    private store: StateStore,
    private limits: PipelineConfig['limits'],
    private now: () => number = Date.now,
    /** The environment kill switch (`KILL_SWITCH=1`); the Firestore flag can stop it too. */
    private killedByEnv = false,
  ) {}

  private async book(at: number): Promise<DayBook> {
    return (await this.store.get<DayBook>('budget', dayKey(at))) ?? { jobs: [], rollouts: [], explores: [] };
  }

  async isKilled(): Promise<boolean> {
    if (this.killedByEnv) return true;
    const control = await this.store.get<{ killSwitch?: boolean }>('control', 'state');
    return control?.killSwitch === true;
  }

  async setKillSwitch(on: boolean): Promise<void> {
    const control = (await this.store.get<Record<string, unknown>>('control', 'state')) ?? {};
    await this.store.set('control', 'state', { ...control, killSwitch: on });
  }

  private async save(at: number, book: DayBook) {
    // Keep a few days so a late request cannot use a stale document; the reset drops them all.
    book.jobs = book.jobs.filter((j) => at - j.at < DAY_MS);
    book.rollouts = book.rollouts.filter((r) => at - r.at < DAY_MS);
    book.explores = book.explores.filter((e) => at - e.at < DAY_MS);
    await this.store.set('budget', dayKey(at), book);
  }

  /** Takes the place of one job (or rollout or exploration) or refuses, with the sentence the person sees. */
  async reserveJob(kind: JobKind, uid: string): Promise<void> {
    if (await this.isKilled()) throw new ServiceError('killed', 'The pipeline is switched off for now. The demo resets itself overnight.', 403);
    const at = this.now();
    const book = await this.book(at);
    if (book.jobs.length >= this.limits.jobsPerDay) throw new ServiceError('budget', 'The demo’s build budget for today is used up. It refills after the nightly reset.');
    if (book.jobs.filter((j) => j.uid === uid && at - j.at < HOUR_MS).length >= this.limits.jobsPerGuestHour) throw new ServiceError('budget', 'You have used your pipeline runs for this hour. They come back soon.');
    if (kind === 'scan' && book.jobs.filter((j) => j.kind === 'scan').length >= this.limits.scansPerDay) throw new ServiceError('budget', 'The vulnerability scans for today are used up.');
    if (kind === 'explore' && book.explores.length >= this.limits.exploresPerDay) throw new ServiceError('budget', 'The exploratory runs for today are used up.');
    book.jobs.push({ at, uid, kind });
    await this.save(at, book);
  }

  async reserveRollout(): Promise<void> {
    if (await this.isKilled()) throw new ServiceError('killed', 'The pipeline is switched off for now. The demo resets itself overnight.', 403);
    const at = this.now();
    const book = await this.book(at);
    if (book.rollouts.length >= this.limits.rolloutsPerDay) throw new ServiceError('budget', 'The demo’s rollouts for today are used up.');
    book.rollouts.push({ at });
    await this.save(at, book);
  }

  async status(uid: string): Promise<BudgetStatus> {
    const at = this.now();
    const book = await this.book(at);
    const hour = book.jobs.filter((j) => j.uid === uid && at - j.at < HOUR_MS);
    return {
      jobsLeftToday: Math.max(0, this.limits.jobsPerDay - book.jobs.length),
      jobsLeftThisHour: Math.max(0, this.limits.jobsPerGuestHour - hour.length),
      rolloutsLeftToday: Math.max(0, this.limits.rolloutsPerDay - book.rollouts.length),
      scansLeftToday: Math.max(0, this.limits.scansPerDay - book.jobs.filter((j) => j.kind === 'scan').length),
      exploresLeftToday: Math.max(0, this.limits.exploresPerDay - book.explores.length),
    };
  }

  async reset(): Promise<void> {
    await this.store.clear('budget');
  }
}
