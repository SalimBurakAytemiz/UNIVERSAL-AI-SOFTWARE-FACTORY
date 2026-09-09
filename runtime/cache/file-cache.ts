// Baseline section 77 (Cache/Reuse Policy) + 275/277 (State Store / Durable
// State). `Cache` (cache.ts) yalnızca process-içi bir Map'tir: süreç yeniden
// başladığında tüm girdiler kaybolur. UASF-REQ-0036 "durable cache" der;
// bunu gerçek kılmak için FileCache, girdi haritasının tamamını her yazışta
// StateStore aracılığıyla diske yazar ve her okumada oradan yükler — böylece
// ayrı bir process/instance önceden hesaplanmış bir sonucu yeniden kullanabilir
// (Proof G'nin "restart sonrası da geçerli" kanıtı, bölüm 306).

import type { StateStore } from "../state/file-store.js";
import type { CacheEntry, CacheLookupResult } from "./cache.js";
import { assertValidTtl } from "./cache.js";
import { acquireFileLock, type FileLockOptions } from "./file-lock.js";

/**
 * P2 fix (6th independent review round, "durable cache loses __proto__
 * keys"): eskiden bu, kalıcı hale (disk) `Record<string, CacheEntry<T>>`
 * — yani düz bir JavaScript nesnesi — olarak yazılıyor ve `all[key] = ...`
 * / `all[key]` şeklinde ERİŞİLİYORDU. Cache API'si RASTGELE string
 * anahtarları kabul ettiğinden, `key = "__proto__"` verildiğinde bu asla
 * sıradan bir "own property" OLUŞTURMAZ — `Object.prototype.__proto__`
 * bir accessor (getter/setter) olduğundan, `all["__proto__"] = entry`
 * yazması nesnenin PROTOTİPİNİ değiştirmeye ÇALIŞIR (prototype pollution
 * riski) ve kaydı asla gerçek bir "own" alan olarak SAKLAMAZ — bu yüzden
 * `get("__proto__")` her zaman `undefined` dönerdi ve kalıcı gösterim
 * sessizce `{}` olarak kalırdı. Artık kalıcı gösterim bir DİZİ
 * (`[key, entry]` çiftlerinden oluşan) ve bellek-içi yapı bir `Map`'tir —
 * ikisi de anahtar adının HİÇBİR ÖZEL anlamı olmadığı, salt veri
 * yapılarıdır; `"__proto__"`, `"constructor"`, `"prototype"` dahil HER
 * string, sıradan bir anahtar olarak davranır (Map.set/get, nesne
 * özelliği erişimi/ataması KULLANMAZ, dolayısıyla prototip zincirine asla
 * dokunmaz).
 */
type PersistedEntry<T> = readonly [key: string, entry: CacheEntry<T>];
type PersistedEntries<T> = readonly PersistedEntry<T>[];

export class FileCache<T = unknown> {
  constructor(
    private readonly stateStore: StateStore,
    private readonly path: string,
    private readonly lockOptions?: FileLockOptions
  ) {}

  /**
   * P2 fix (16th independent review round, "durable cache read-modify-
   * write is not safe across processes"): `set()` and expired-entry
   * cleanup used to read the WHOLE persisted map, mutate a private
   * in-memory copy, then atomically REPLACE the file — but "replace the
   * file atomically" only protects that ONE write from partial/corrupt
   * content; it does nothing to stop TWO processes from both reading the
   * SAME snapshot, both mutating their own copy, and the second one's
   * write silently overwriting (losing) the first one's successfully
   * applied change (classic cross-process lost-update race, bkz.
   * runtime/cache/file-lock.ts'in üstündeki fix notu). Every mutating
   * read-modify-write cycle below now runs entirely inside
   * `acquireFileLock()`'s critical section AND re-reads the latest
   * persisted contents AFTER the lock is held (never reusing a snapshot
   * taken before acquiring it) — so a concurrent process's already-
   * completed write is always seen and preserved, never clobbered.
   * `loadAll()`/`size()` remain lock-free: they are pure reads of an
   * atomically-written file (StateStore's rename-based write guarantees
   * a reader always sees either the fully-old or fully-new content,
   * never a partial one), which is safe without serialization — only
   * the MUTATION path needs the lock.
   */
  private lockPath(): string {
    return `${this.path}.lock`;
  }

  private withLock<R>(fn: () => R): R {
    const release = acquireFileLock(this.lockPath(), this.lockOptions);
    try {
      return fn();
    } finally {
      release();
    }
  }

  private loadAll(): Map<string, CacheEntry<T>> {
    const persisted = this.stateStore.read<PersistedEntries<T>>(this.path) ?? [];
    return new Map(persisted);
  }

  private saveAll(all: Map<string, CacheEntry<T>>): void {
    // Her set() çağrısında TÜM harita diske yazılır — kalıcılığın
    // yalnızca bu sürecin belleğine değil, dosyaya bağlı olması için
    // (bir sonraki process'in aynı in-memory nesneyi paylaşmasına gerek yok).
    this.stateStore.write(this.path, [...all.entries()]);
  }

  /**
   * P2 fix (34th independent review round, finding 10, "distinguish
   * cached undefined from cache miss"): the one authoritative lookup — bkz.
   * cache.ts'in `CacheLookupResult`'ının fix notu, identical rationale
   * applied here so memory and file cache behave identically. `get()`/
   * `has()`/`computeWithFileCache()` all read their answer from this,
   * never a separate `!== undefined` check again.
   */
  lookup(key: string): CacheLookupResult<T> {
    const all = this.loadAll();
    const entry = all.get(key);
    if (!entry) return { found: false, value: undefined };
    // P2 fix (26th independent review round, finding 7, "cache must expire
    // at the deadline"): identical boundary fix as cache.ts's Cache.get() —
    // `now >= expiresAt`, not strict `<`, so `ttlMs: 0` and an exact
    // now===expiresAt read are both correctly treated as already expired.
    if (entry.expiresAt !== undefined && Date.now() >= entry.expiresAt) {
      // Süresi dolmuş girdi diskte de asla sessizce yeniden kullanılmaz —
      // ama bu bir MUTASYONdur, bu yüzden set() ile AYNI kilitli,
      // yeniden-okuyan yola gider (bkz. yukarıdaki sınıf fix notu): kilit
      // altında en güncel harita yeniden okunur ve girdi HÂLÂ süresi
      // dolmuş görünüyorsa (başka bir process bu arada onu tazelemediyse)
      // silinir — aksi halde, kilit alınmadan önce okunmuş BAYAT bir
      // haritayı geri yazmak, tam da bu ikinci finding'in tarif ettiği
      // gibi, o process'in az önce başarıyla yazdığı tazelenmiş girdiyi
      // (veya tamamen alakasız başka bir anahtarı) sessizce silebilirdi.
      //
      // P2 fix (31st independent review round, finding 5, "return a
      // concurrently refreshed cache entry"): this used to unconditionally
      // `return undefined;` after the locked re-check above, regardless of
      // what that re-check actually found. Codex reproduced: this
      // process's initial (unlocked) read sees an expired entry; while
      // this process waits to acquire the lock, ANOTHER process calls
      // `set()` for the SAME key with a freshly-computed, non-expired
      // value; once this process finally acquires the lock and re-reads,
      // `latestEntry` correctly reflects that fresh value (so the
      // `if (... expired ...)` guard above correctly does NOT delete it)
      // — but the caller still received `undefined` regardless, forcing an
      // unnecessary recomputation of a value another process JUST
      // computed. Fixed: the locked re-check now returns EXACTLY what the
      // authoritative re-read found — `latestEntry`'s value if it exists
      // and is genuinely not expired (a concurrent refresh this process
      // should reuse, not discard), a miss if it is still expired (and
      // gets deleted, as before) or has meanwhile been removed entirely by
      // another process.
      return this.withLock((): CacheLookupResult<T> => {
        const latest = this.loadAll();
        const latestEntry = latest.get(key);
        if (!latestEntry) return { found: false, value: undefined };
        // Same >= boundary as the initial check above and cache.ts's
        // Cache.get() — bkz. bu dosyadaki fix notu.
        if (latestEntry.expiresAt !== undefined && Date.now() >= latestEntry.expiresAt) {
          latest.delete(key);
          this.saveAll(latest);
          return { found: false, value: undefined };
        }
        // Another process already refreshed this exact key to a fresh,
        // non-expired value while this process was waiting for the lock —
        // reuse it instead of telling the caller to recompute.
        return { found: true, value: latestEntry.value };
      });
    }
    return { found: true, value: entry.value };
  }

  get(key: string): T | undefined {
    return this.lookup(key).value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    // P2 fix (34th independent review round, finding 11, "validate TTL
    // values before persisting"): bkz. cache.ts'in `assertValidTtl`'ının
    // fix notu — validated BEFORE the lock is even acquired, so an invalid
    // ttlMs never reaches disk at all (fail closed before any mutation).
    assertValidTtl(ttlMs);
    this.withLock(() => {
      // Kilit ALINDIKTAN SONRA en güncel içerik yeniden okunur — kilit
      // beklerken başka bir process'in tamamladığı yazma burada asla
      // görünmez kalmaz (bkz. yukarıdaki sınıf fix notu).
      const all = this.loadAll();
      all.set(key, {
        value,
        computedAt: Date.now(),
        expiresAt: ttlMs !== undefined ? Date.now() + ttlMs : undefined
      });
      this.saveAll(all);
    });
  }

  has(key: string): boolean {
    return this.lookup(key).found;
  }

  size(): number {
    return this.loadAll().size;
  }
}

export interface ComputeWithFileCacheResult<T> {
  readonly value: T;
  readonly cached: boolean;
}

/**
 * `computeWithCache`'in FileCache karşılığı: kalıcı önbellekte geçerli bir
 * girdi varsa yeniden hesaplamaz, yoksa hesaplar ve diske yazar.
 */
export async function computeWithFileCache<T>(
  cache: FileCache<T>,
  key: string,
  compute: () => Promise<T> | T,
  ttlMs?: number
): Promise<ComputeWithFileCacheResult<T>> {
  // P2 fix (34th independent review round, finding 10): bkz. cache.ts'in
  // `computeWithCache`'inin fix notu — reads `found` from `lookup()`'s
  // discriminated result, never a `!== undefined` check on the VALUE.
  const lookup = cache.lookup(key);
  if (lookup.found) {
    return { value: lookup.value as T, cached: true };
  }
  const value = await compute();
  cache.set(key, value, ttlMs);
  return { value, cached: false };
}
