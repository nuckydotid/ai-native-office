/** Token bucket: `capacity` burst, refilled at `perSec` tokens per second. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private capacity: number,
    private perSec: number,
    now = Date.now(),
  ) {
    this.tokens = capacity;
    this.last = now;
  }
  take(n = 1, now = Date.now()): boolean {
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.perSec);
    this.last = now;
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }
}

/** One token bucket per key (an address, a user id), forgetting the least recently used keys so the map cannot grow without bound. */
export class KeyedBuckets {
  private buckets = new Map<string, TokenBucket>();
  constructor(
    private capacity: number,
    private perSec: number,
    private maxKeys = 2000,
  ) {}
  take(key: string, n = 1, now = Date.now()): boolean {
    let b = this.buckets.get(key);
    if (b) this.buckets.delete(key);
    else b = new TokenBucket(this.capacity, this.perSec, now);
    this.buckets.set(key, b);
    if (this.buckets.size > this.maxKeys) this.buckets.delete(this.buckets.keys().next().value as string);
    return b.take(n, now);
  }
}

/**
 * Something kept per key (a person) that must survive their reconnecting, so a reconnect can't be used to get fresh budgets.
 * The least recently used keys are forgotten, so the map cannot grow without bound.
 */
export class PerKey<T> {
  private items = new Map<string, T>();
  constructor(private maxKeys = 2000) {}
  get(key: string, make: () => T): T {
    let v = this.items.get(key);
    if (v !== undefined) this.items.delete(key);
    else v = make();
    this.items.set(key, v);
    if (this.items.size > this.maxKeys) this.items.delete(this.items.keys().next().value as string);
    return v;
  }
}

/**
 * The unit a caller's address is counted by: an IPv4 address as it is, an IPv6 address by its /64 (one person can use any address in
 * theirs), and an IPv4 address written the IPv6 way as the IPv4 one.
 */
export function ipKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.split('::');
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
