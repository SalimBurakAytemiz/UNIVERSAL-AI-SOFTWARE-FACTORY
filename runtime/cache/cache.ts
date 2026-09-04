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
    if (entry.expiresAt !== undefined && entry.expiresAt < Date.now()) {
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
