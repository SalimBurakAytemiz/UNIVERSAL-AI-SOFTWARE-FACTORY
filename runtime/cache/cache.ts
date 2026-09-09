// Baseline section 77 (Cache/Reuse Policy) + 78 (Do Not Repeat Completed
// Work): pahalı bir işlemi tekrar hesaplamadan önce "bu daha önce
// hesaplandı mı ve hâlâ geçerli mi?" sorusu sorulur. Bu basit TTL'li
// önbellek, o kontrolü somutlaştırır (Proof G, bölüm 306).

export interface CacheEntry<T> {
  readonly value: T;
  readonly computedAt: number;
  readonly expiresAt?: number;
}

/**
 * P2 fix (34th independent review round, finding 10, "distinguish cached
 * undefined from cache miss"): `get(key): T | undefined` (below) cannot,
 * on its own, tell a caller "no entry exists" apart from "an entry exists
 * and its cached value genuinely IS `undefined`" (`Cache<T>` is generic —
 * nothing prevents a caller from caching a legitimately-`undefined`
 * result, e.g. memoizing a lookup that found nothing). `has()`/
 * `computeWithCache()` used to derive their own hit/miss decision from
 * exactly that same ambiguous `!== undefined` check — meaning a cached
 * `undefined` was previously indistinguishable from a miss and would be
 * unconditionally, silently recomputed on EVERY call, never actually
 * "cached" at all (the exact failure this finding names: "compute returns
 * undefined -> behavior is deterministic and does not accidentally
 * recompute forever" was violated). `lookup()` is the ONE place presence
 * is decided (`found`) — `get()`/`has()`/`computeWithCache()` all read
 * their answer from it, never a separate `!== undefined` check again.
 */
export interface CacheLookupResult<T> {
  readonly found: boolean;
  readonly value: T | undefined;
}

/**
 * P2 fix (34th independent review round, finding 11, "validate TTL values
 * before persisting"): `set()` used to pass `ttlMs` straight into
 * `Date.now() + ttlMs` with no validation at all. A `NaN`/`Infinity`
 * `ttlMs` produces `expiresAt: NaN`/`Infinity` — and since ANY comparison
 * against `NaN` is `false` and `Date.now() >= Infinity` is also always
 * `false`, `get()`'s own expiration check (`now >= expiresAt`) can then
 * NEVER be true for that entry: it silently becomes a PERMANENT entry that
 * never expires, exactly the "no silent architectural" contract violation
 * baseline section 147 forbids for something the caller explicitly asked
 * to be short-lived. A negative `ttlMs` produces a nonsensical backdated
 * `expiresAt` (functionally harmless — the entry is just immediately
 * expired — but still not a value any caller intentionally means). `0` is
 * explicitly NOT rejected: it is this codebase's own established, already-
 * tested "expires immediately" semantic (bkz. the 26th round's "cache must
 * expire at the deadline" fix above) — only genuinely invalid numeric
 * configuration (non-finite or negative) is rejected, fail-closed, BEFORE
 * any entry is stored.
 */
export class InvalidTtlError extends Error {
  constructor(ttlMs: number) {
    super(
      `Invalid ttlMs '${String(ttlMs)}': must be a finite, nonnegative number of milliseconds. 0 is valid (an ` +
        `immediately-expiring entry) — NaN, Infinity, -Infinity, and negative values are rejected outright rather ` +
        `than silently producing an entry that never expires (NaN/Infinity) or is nonsensically backdated (negative).`
    );
    this.name = "InvalidTtlError";
  }
}

/**
 * Shared by both `Cache` (this file) and `FileCache` (file-cache.ts) — bkz.
 * `InvalidTtlError`'ın fix notu, "Memory cache and durable cache must use
 * the SAME TTL semantics" gereksinimi. A single source of truth for what
 * counts as a valid `ttlMs` means the two implementations cannot silently
 * drift apart on this boundary.
 */
export function assertValidTtl(ttlMs: number | undefined): void {
  if (ttlMs === undefined) return;
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new InvalidTtlError(ttlMs);
  }
}

export class Cache<T = unknown> {
  private readonly store = new Map<string, CacheEntry<T>>();

  /**
   * The one authoritative lookup — bkz. `CacheLookupResult`'ın fix notu.
   */
  lookup(key: string): CacheLookupResult<T> {
    const entry = this.store.get(key);
    if (!entry) return { found: false, value: undefined };
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
      return { found: false, value: undefined };
    }
    return { found: true, value: entry.value };
  }

  get(key: string): T | undefined {
    return this.lookup(key).value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    assertValidTtl(ttlMs);
    this.store.set(key, {
      value,
      computedAt: Date.now(),
      expiresAt: ttlMs !== undefined ? Date.now() + ttlMs : undefined
    });
  }

  has(key: string): boolean {
    return this.lookup(key).found;
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
  // P2 fix (34th independent review round, finding 10): reads `found`
  // from `lookup()`'s discriminated result, never a `!== undefined` check
  // on the VALUE — a previously-cached, legitimately-`undefined` result is
  // now correctly reported as a cache hit, instead of being silently
  // recomputed on every single call.
  const lookup = cache.lookup(key);
  if (lookup.found) {
    return { value: lookup.value as T, cached: true };
  }
  const value = await compute();
  cache.set(key, value, ttlMs);
  return { value, cached: false };
}
