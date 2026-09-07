// Baseline section 77 (Cache/Reuse Policy) + 78 (Do Not Repeat Completed
// Work): pahalı bir işlemi tekrar hesaplamadan önce "bu daha önce
// hesaplandı mı ve hâlâ geçerli mi?" sorusu sorulur. Bu basit TTL'li
// önbellek, o kontrolü somutlaştırır (Proof G, bölüm 306).

export interface CacheEntry<T> {
  readonly value: T;
  readonly computedAt: number;
  readonly expiresAt?: number;
}

export class Cache<T = unknown> {
  private readonly store = new Map<string, CacheEntry<T>>();

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    // P2 fix (26th independent review round, finding 7, "cache must expire
    // at the deadline"): this used to compare with strict `<`, so an entry
    // whose `expiresAt` exactly equalled `Date.now()` (including a
    // `ttlMs: 0` entry read back within the same millisecond it was set)
    // was judged NOT yet expired and served one more time. The stated
    // guarantee is "expired at the deadline", not "expired strictly after
    // it" — `expiresAt` IS the instant the entry stops being valid, so
    // `now >= expiresAt` (not `now > expiresAt`) is the correct boundary.
    if (entry.expiresAt !== undefined && Date.now() >= entry.expiresAt) {
      this.store.delete(key); // stale entries are never silently reused (section 77)
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    this.store.set(key, {
      value,
      computedAt: Date.now(),
      expiresAt: ttlMs !== undefined ? Date.now() + ttlMs : undefined
    });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  size(): number {
    return this.store.size;
  }
}

export interface ComputeWithCacheResult<T> {
  readonly value: T;
  readonly cached: boolean;
}

/**
 * Geçerli bir önbellek girdisi varsa yeniden hesaplamaz (section 78,
 * "do not repeat completed valid work"); yoksa hesaplar ve saklar.
 */
export async function computeWithCache<T>(
  cache: Cache<T>,
  key: string,
  compute: () => Promise<T> | T,
  ttlMs?: number
): Promise<ComputeWithCacheResult<T>> {
  const existing = cache.get(key);
  if (existing !== undefined) {
    return { value: existing, cached: true };
  }
  const value = await compute();
  cache.set(key, value, ttlMs);
  return { value, cached: false };
}
