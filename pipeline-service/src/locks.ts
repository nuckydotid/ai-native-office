import { ServiceError } from './errors.ts';
import type { StateStore } from './store.ts';

interface Lock {
  holder: string;
  at: number;
  expiresAt: number;
}

/** One live rollout per environment at a time, so two guests cannot move the same service's traffic at once. */
export class Locks {
  private held = new Map<string, Promise<void>>();

  constructor(
    private store: StateStore,
    private now: () => number = Date.now,
    private ttlMs = 10 * 60_000,
  ) {}

  async get(name: string): Promise<Lock | null> {
    const lock = await this.store.get<Lock>('locks', name);
    if (!lock) return null;
    if (lock.expiresAt < this.now()) {
      await this.store.delete('locks', name);
      return null;
    }
    return lock;
  }

  async acquire(name: string, holder: string): Promise<void> {
    const current = await this.get(name);
    if (current && current.holder !== holder) throw new ServiceError('locked', 'Another rollout is still going. Finish it or roll it back first.', 409);
    const at = this.now();
    await this.store.set('locks', name, { holder, at, expiresAt: at + this.ttlMs });
    this.held.set(name, Promise.resolve());
  }

  async release(name: string, holder: string): Promise<void> {
    const current = await this.get(name);
    if (current && current.holder !== holder) return;
    await this.store.delete('locks', name);
    this.held.delete(name);
  }

  async clear(): Promise<void> {
    await this.store.clear('locks');
    this.held.clear();
  }
}
