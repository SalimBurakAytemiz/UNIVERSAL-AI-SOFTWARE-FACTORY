// Baseline section 77 (Cache/Reuse Policy) + 275/277 (State Store / Durable
// State). `Cache` (cache.ts) yalnızca process-içi bir Map'tir: süreç yeniden
// başladığında tüm girdiler kaybolur. UASF-REQ-0036 "durable cache" der;
// bunu gerçek kılmak için FileCache, girdi haritasının tamamını her yazışta
// StateStore aracılığıyla diske yazar ve her okumada oradan yükler — böylece
// ayrı bir process/instance önceden hesaplanmış bir sonucu yeniden kullanabilir
// (Proof G'nin "restart sonrası da geçerli" kanıtı, bölüm 306).

import { createHash, randomBytes } from "node:crypto";
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

const DEFAULT_COMPUTE_LEASE_TTL_MS = 30_000;
const COMPUTE_LEASE_POLL_INTERVAL_MS = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * P1 fix (P0 final closure remediation, finding 11, "invalid lease timing
 * configuration"): reproduced — `computeLeaseTtlMs` (constructor parameter
 * below) was accepted completely unvalidated. `assertValidTtl()`
 * (cache.ts) exists for ORDINARY cache-entry TTLs, where 0 is a legitimate
 * ("immediately-expiring entry") value — but a compute LEASE is not an
 * ordinary entry: its entire purpose is mutual exclusion between
 * concurrent `computeAndSet()` callers (bkz.
 * `negotiateComputeOwnership()`'in fix notu), and `Date.now() + 0` grants a
 * lease that is already expired the instant it is written — every
 * concurrent contender's `negotiateComputeOwnership()` would see it as
 * immediately reclaimable and proceed to compute too, exactly the
 * duplicate-real-charge race this whole lease mechanism exists to prevent.
 * Two `FileCache` instances sharing one path with `computeLeaseTtlMs: 0`
 * therefore both concurrently compute the same key. NaN/Infinity/negative
 * values are equally nonsensical for a real wall-clock deadline (bkz.
 * `assertValidTtl()`'in kendi InvalidTtlError notu — the same class of bug,
 * a stricter threshold for a different field). Separately, the *renewal*
 * interval `#computeCrossProcess()` derives from this TTL
 * (`Math.max(1, Math.floor(ttlMs / 3))`, bkz. aşağısı) must fire strictly
 * BEFORE the lease it renews would otherwise expire — an extreme (but
 * finite, positive) TTL like `1` derives a renewal interval of `1` too,
 * meaning the renewal timer and the lease's own expiry land at the exact
 * same instant: a genuine race between "renew in time" and "a waiting
 * follower reclaims as stale." `computeRenewalIntervalMs()` and this
 * validator share the EXACT SAME formula (never two independently
 * hand-duplicated ones that could silently drift), so this check is
 * authoritative for whatever `#computeCrossProcess()` will actually do at
 * runtime. Both checks run once, in the constructor, at construction time
 * — before any real lease is ever negotiated — so a misconfigured
 * `FileCache` fails fast and loud rather than silently destroying its own
 * mutual-exclusion guarantee.
 */
export class InvalidComputeLeaseTtlError extends Error {
  constructor(ttlMs: number, reason: string) {
    super(`Invalid FileCache compute lease TTL '${String(ttlMs)}': ${reason}`);
    this.name = "InvalidComputeLeaseTtlError";
  }
}

function computeRenewalIntervalMs(computeLeaseTtlMs: number): number {
  return Math.max(1, Math.floor(computeLeaseTtlMs / 3));
}

function assertValidComputeLeaseTtl(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new InvalidComputeLeaseTtlError(
      ttlMs,
      "must be a finite, POSITIVE number of milliseconds. Unlike an ordinary cache-entry TTL, 0 destroys lease " +
        "semantics entirely (a lease that expires the instant it is granted excludes no one); NaN/Infinity/" +
        "negative values are equally nonsensical for a real wall-clock deadline."
    );
  }
  const renewalIntervalMs = computeRenewalIntervalMs(ttlMs);
  if (renewalIntervalMs >= ttlMs) {
    throw new InvalidComputeLeaseTtlError(
      ttlMs,
      `the derived renewal interval (${renewalIntervalMs}ms) would not run strictly before the lease's own ` +
        `expiry — a lease this short can expire (and be reclaimed by a waiting follower) at the same instant ` +
        `its own owner's renewal timer fires, defeating the "renew for as long as compute() is genuinely in ` +
        `flight" guarantee.`
    );
  }
}

export class FileCache<T = unknown> {
  /**
   * P1 fix (independent Codex review, "do not hold the synchronous cache
   * lock across await"): same-process rationale as `cache.ts`'in
   * `inFlight`'inin fix notu — two callers in THIS process racing the SAME
   * missing key must never both reach `#computeCrossProcess()` (bkz.
   * aşağısı) at all; the second one simply awaits the first's own Promise.
   * This is a PURE in-process optimization layered on top of the
   * cross-process lease protocol below — it never touches the filesystem,
   * so it adds no new failure mode, and removing it would only cost extra
   * (still-correct) cross-process lease round-trips for same-process
   * callers, never a correctness regression.
   */
  private readonly inFlight = new Map<string, Promise<ComputeWithFileCacheResult<T>>>();

  constructor(
    private readonly stateStore: StateStore,
    private readonly path: string,
    private readonly lockOptions?: FileLockOptions,
    private readonly computeLeaseTtlMs: number = DEFAULT_COMPUTE_LEASE_TTL_MS
  ) {
    assertValidComputeLeaseTtl(computeLeaseTtlMs);
  }

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

  /**
   * P2 fix (independent Codex review, "deduplicate concurrent durable
   * cache computations"): a distinct lock path PER KEY (never the whole-
   * cache `lockPath()` `set()`/`lookup()` already use for their own
   * mutation critical sections, which would serialize EVERY key's compute
   * against every other key's, defeating the point of a per-key lease) —
   * derived by hashing the key so arbitrary caller-supplied strings (which
   * may contain path separators, be extremely long, or collide with the
   * `__proto__`-shaped concerns this file's own top-of-file note already
   * documents for OTHER reasons) never need to be filesystem-safe
   * themselves.
   */
  /**
   * A SHORT-LIVED, per-key file lock used ONLY to guard the brief,
   * synchronous "check the cache, then read-or-write the durable lease
   * record" critical section below — never held across an `await`. Kept
   * distinct from the whole-cache `lockPath()` `set()`/`lookup()` use for
   * their own mutation critical sections (bkz. o alanların üstündeki fix
   * notları), so a compute lease negotiation for one key never serializes
   * against an unrelated key's ordinary `set()`/`get()`.
   */
  private computeLockPath(key: string): string {
    return `${this.path}.compute.${createHash("sha256").update(key).digest("hex")}.lock`;
  }

  /**
   * P1 fix (independent Codex review, "do not hold the synchronous cache
   * lock across await"): the durable "someone is already computing this
   * key" marker — `{ ownerId, expiresAt }`, written and read ONLY inside
   * `#negotiateComputeOwnership()`'s short, lock-protected critical
   * section (bkz. aşağısı), NEVER while an `await compute()` is pending.
   * Path derived the same hashed way `computeLockPath()` already is, kept
   * as a SEPARATE file (`.lease`, not `.lock`) so the DATA (who owns this
   * compute, until when) is never confused with the brief MUTUAL-EXCLUSION
   * primitive (`acquireFileLock()`'s own directory-based lock) used only
   * to serialize reads/writes of that data.
   */
  private computeLeasePath(key: string): string {
    return `${this.path}.compute.${createHash("sha256").update(key).digest("hex")}.lease`;
  }

  /**
   * P1 fix (P0 final closure remediation, finding 2, "paid bootstrap
   * checkpoint must be atomic with provider completion"): the lease
   * record can now ALSO carry the completed compute's own result
   * (`completed: true, value`) — bkz. `recordComputeCompletion()`'ın fix
   * notu for why this is written durably BEFORE the main cache's own
   * `set()` is even attempted, so a failure of THAT later write can never
   * lose the already-paid-for result.
   */
  private readComputeLease(
    key: string
  ): { readonly ownerId: string; readonly expiresAt: number; readonly completed: boolean; readonly value?: T } | undefined {
    const raw = this.stateStore.read<{ ownerId?: unknown; expiresAt?: unknown; completed?: unknown; value?: unknown }>(
      this.computeLeasePath(key)
    );
    if (!raw || typeof raw.ownerId !== "string" || typeof raw.expiresAt !== "number" || !Number.isFinite(raw.expiresAt)) {
      return undefined;
    }
    const completed = raw.completed === true;
    return { ownerId: raw.ownerId, expiresAt: raw.expiresAt, completed, value: completed ? (raw.value as T) : undefined };
  }

  private writeComputeLease(key: string, ownerId: string, expiresAt: number): void {
    this.stateStore.write(this.computeLeasePath(key), { ownerId, expiresAt });
  }

  /**
   * P1 fix (P0 final closure remediation, finding 2, "paid bootstrap
   * checkpoint must be atomic with provider completion"): reproduced —
   * `compute()` succeeds (the provider is genuinely invoked and billed),
   * but the SEPARATE main-cache write (`set()`, targeting THIS FileCache's
   * own `this.path`) then fails once (e.g. a transient store error). The
   * old code propagated that failure straight out of
   * `#computeCrossProcess()`, which is fine on its own — but a caller
   * that RETRIES the whole operation (exactly how `bootstrapProject()`'s
   * own caller is expected to recover from a failed attempt) would find
   * NO recorded value (the main cache write never landed) and NO live
   * lease (the failure path released it), so `negotiateComputeOwnership()`
   * would honestly see "nobody has ever computed this" and invoke
   * `compute()` — and therefore the real, billable provider — a SECOND
   * time for work already paid for once. Fixed: the lease record (a
   * DIFFERENT file than the main cache's own `this.path`, so a failure
   * localized to writing the main file does not also prevent this write)
   * durably records the completed value FIRST, fenced by ownership via
   * the same short, synchronous, non-`await`-spanning critical section
   * every other lease mutation in this file already uses — so even if
   * every subsequent attempt to write it into the main cache fails,
   * `negotiateComputeOwnership()`'s own lease check (bkz. aşağısı) finds
   * this completed record and returns the ALREADY-PAID-FOR value instead
   * of ever calling `compute()` again for this key.
   */
  private recordComputeCompletion(key: string, ownerId: string, value: T): boolean {
    const release = acquireFileLock(this.computeLockPath(key), this.lockOptions);
    try {
      const current = this.readComputeLease(key);
      if (!current || current.ownerId !== ownerId) {
        return false;
      }
      this.stateStore.write(this.computeLeasePath(key), { ownerId, expiresAt: current.expiresAt, completed: true, value });
      return true;
    } finally {
      release();
    }
  }

  /**
   * P1 fix (independent review, "fence compute-lease release by owner",
   * finding 4): the ONE place a caller may mutate an EXISTING compute
   * lease it believes it still owns (renewal, and release-on-failure) —
   * bkz. `renewComputeLease()`/`releaseComputeLease()` aşağısı. Both used
   * to write UNCONDITIONALLY: `releaseComputeLease()` wrote
   * `{ownerId, expiresAt: 0}` regardless of what was CURRENTLY persisted,
   * so an owner whose OWN lease had already (perhaps wrongly) been
   * treated as expired — letting a successor claim a fresh lease with a
   * DIFFERENT ownerId — could still overwrite that successor's genuinely
   * live lease with its own now-stale `{expiresAt: 0}` record the moment
   * its (still in-flight, now-doomed) `compute()` call finally failed,
   * immediately exposing the key to a THIRD contender even though the
   * successor's computation was still legitimately running. Fixed with a
   * compare-and-swap: the write only happens if the CURRENTLY persisted
   * lease still names `expectedOwnerId` as its owner — read and write
   * happen inside the SAME short, synchronous `computeLockPath(key)`
   * critical section (never spanning an `await`), so no other contender's
   * own negotiation/renewal/release can interleave between the check and
   * the write. A stale caller whose ownership has already moved on gets
   * `false` and changes nothing — the successor's lease survives
   * untouched, exactly what finding 4 requires.
   */
  private compareAndSwapComputeLease(key: string, expectedOwnerId: string, newExpiresAt: number): boolean {
    const release = acquireFileLock(this.computeLockPath(key), this.lockOptions);
    try {
      const current = this.readComputeLease(key);
      if (!current || current.ownerId !== expectedOwnerId) {
        return false;
      }
      this.writeComputeLease(key, expectedOwnerId, newExpiresAt);
      return true;
    } finally {
      release();
    }
  }

  /**
   * P1 fix (independent review, "renew compute leases while their owners
   * are active", finding 3): called periodically (bkz.
   * `#computeCrossProcess()`'in kendi renewal timer'ı) for as long as this
   * owner's `compute()` call is genuinely still running, EXTENDING the
   * durable lease's `expiresAt` well before it would otherwise elapse — a
   * genuinely long-running (e.g. a real, slow model/network call)
   * computation no longer looks "abandoned" to another contender's
   * `negotiateComputeOwnership()` merely because the ORIGINAL,
   * one-shot `computeLeaseTtlMs` window has passed while it was still
   * legitimately in flight. Routed through `compareAndSwapComputeLease()`
   * so a renewal can never resurrect/steal a lease this owner no longer
   * actually holds (the fenced-out case: the returned `false` here simply
   * means "stop renewing," never "reclaim by force").
   */
  private renewComputeLease(key: string, ownerId: string): boolean {
    return this.compareAndSwapComputeLease(key, ownerId, Date.now() + this.computeLeaseTtlMs);
  }

  /**
   * P1 fix (independent Codex review, "do not hold the synchronous cache
   * lock across await" — reproduced: a caller holding `computeLockPath()`'s
   * synchronous, directory-based file lock across `await compute()` forces
   * every OTHER same-process/cross-process contender for the SAME key to
   * block the Node.js EVENT LOOP inside `acquireFileLock()`'s own
   * synchronous `Atomics.wait()` spin-wait for up to their configured
   * `timeoutMs`, throwing `FileLockTimeoutError` the instant that elapses —
   * even though the actual computation was still legitimately in flight and
   * would have finished shortly after. A synchronous mutual-exclusion
   * primitive must NEVER be held across an asynchronous gap): this method
   * used to hold `computeLockPath(key)`'s lock for the ENTIRE duration of
   * `await compute()`. Fixed with a two-level protocol — bkz. `#negotiateComputeOwnership()`'s
   * own fix notu for the short, synchronous critical section this now
   * uses instead:
   *   (1) SAME-PROCESS callers dedupe via `inFlight` (bkz. onun üstündeki
   *       fix notu) — a genuine JS `Promise`, no lock, no polling, no
   *       event-loop blocking at all.
   *   (2) CROSS-PROCESS callers negotiate a durable, TTL-bounded compute
   *       LEASE via a SHORT (microseconds-scale) critical section —
   *       acquire the per-key file lock, check whether the value already
   *       landed (another process finished while this one was contending),
   *       check/claim the lease, RELEASE the lock — all BEFORE `compute()`
   *       ever runs. The winner then runs `compute()` with NO lock held at
   *       all (the event loop is never blocked by a pending computation),
   *       persists via the ordinary, independently-locked `set()`, and — on
   *       failure — immediately expires its own lease (never waits out the
   *       full TTL) so a retry can proceed at once. A loser (lease already
   *       held and not yet expired) sleeps `COMPUTE_LEASE_POLL_INTERVAL_MS`
   *       (an ordinary `await`-based sleep — never a synchronous, event-
   *       loop-blocking wait) and renegotiates; if the ORIGINAL owner
   *       crashes mid-compute, the lease's own `expiresAt` bounds how long
   *       any follower ever waits before reclaiming it — the same
   *       TTL/mtime-bounded "owner identity cannot be perfectly proven, so
   *       bound the wait instead" recovery shape `runtime/cache/file-lock.ts`'s
   *       own documented UNKNOWN-owner path already establishes, not a
   *       novel mechanism.
   */
  async computeAndSet(key: string, compute: () => Promise<T> | T, ttlMs?: number): Promise<ComputeWithFileCacheResult<T>> {
    const existing = this.inFlight.get(key);
    if (existing) {
      // A same-process follower always reports a cache HIT regardless of
      // what the shared in-flight call itself observed (bkz. `inFlight`'in
      // üstündeki fix notu) — it never independently negotiated ownership.
      return { value: (await existing).value, cached: true };
    }
    const promise = this.#computeCrossProcess(key, compute, ttlMs);
    this.inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * The SHORT, synchronous critical section: acquire `computeLockPath(key)`
   * (never held past this function's own synchronous body — no `await`
   * anywhere inside it), re-check the cache for a value another contender
   * may have already committed, and otherwise atomically read-or-claim the
   * durable compute lease. Returns immediately in every case — the caller
   * (`#computeCrossProcess()`) decides what to do (run `compute()`, reuse a
   * value, or sleep-and-retry) OUTSIDE this lock.
   */
  private negotiateComputeOwnership(
    key: string,
    ownerId: string
  ): { readonly kind: "value"; readonly value: T } | { readonly kind: "owner" } | { readonly kind: "busy" } {
    const release = acquireFileLock(this.computeLockPath(key), this.lockOptions);
    try {
      const recheck = this.lookup(key);
      if (recheck.found) {
        return { kind: "value", value: recheck.value as T };
      }
      const now = Date.now();
      const existingLease = this.readComputeLease(key);
      // P1 fix (P0 final closure remediation, finding 2): a `completed`
      // lease (bkz. `recordComputeCompletion()`'ın fix notu) means the
      // paid work genuinely finished — checked and returned BEFORE the
      // ordinary liveness check below, and regardless of whether
      // `expiresAt` has since passed, since "completed" is a stronger,
      // permanent fact than "still within its original TTL window."
      // Returning it here is exactly what stops a retrying caller from
      // ever invoking `compute()` (and the real, billable provider) a
      // second time merely because the main cache's own write of this
      // same value failed on a previous attempt.
      if (existingLease?.completed) {
        return { kind: "value", value: existingLease.value as T };
      }
      if (existingLease && existingLease.expiresAt > now) {
        return { kind: "busy" };
      }
      this.writeComputeLease(key, ownerId, now + this.computeLeaseTtlMs);
      return { kind: "owner" };
    } finally {
      release();
    }
  }

  /**
   * Immediately expires this key's compute lease — called ONLY when the
   * lease OWNER's own `compute()` call fails, so a genuine failure never
   * forces a waiting follower to sit out the full `computeLeaseTtlMs`
   * before it can attempt its own fresh compute. A best-effort write: if
   * it itself fails, the lease still naturally expires at its own
   * `expiresAt` — bounded recovery, never a permanent deadlock.
   *
   * P1 fix (independent review, "fence compute-lease release by owner",
   * finding 4): routed through `compareAndSwapComputeLease()` — bkz. onun
   * üstündeki fix notu for the exact reproduction this closes. `ownerId`
   * no longer naming the CURRENT lease owner (because it already expired
   * and a successor has since claimed a fresh one) now means this call
   * changes NOTHING, rather than overwriting the successor's live lease
   * with a fabricated already-expired record under this stale owner's
   * name.
   */
  private releaseComputeLease(key: string, ownerId: string): void {
    this.compareAndSwapComputeLease(key, ownerId, 0);
  }

  async #computeCrossProcess(
    key: string,
    compute: () => Promise<T> | T,
    ttlMs?: number
  ): Promise<ComputeWithFileCacheResult<T>> {
    const ownerId = `${process.pid}-${randomBytes(8).toString("hex")}`;
    for (;;) {
      const outcome = this.negotiateComputeOwnership(key, ownerId);
      if (outcome.kind === "value") {
        // This call never actually computed anything — another contender
        // (this process or another) already won ownership and persisted a
        // result before this negotiation ran. Reported as a genuine cache
        // hit, exactly like `computeWithFileCache()`'s own initial lookup.
        //
        // P1 fix (P0 final closure remediation, finding 2): `outcome.value`
        // may have come from a `completed` LEASE record rather than the
        // main cache (bkz. `negotiateComputeOwnership()`'in fix notu) — a
        // prior attempt's paid result that never made it into the main
        // cache file. Opportunistically heal that here so future lookups
        // are fast and do not depend on the lease file forever; a failure
        // here is never fatal (the lease record remains the durable source
        // of truth until this eventually succeeds on some later call).
        try {
          this.set(key, outcome.value, ttlMs);
        } catch {
          // Best-effort heal only — see fix note above.
        }
        return { value: outcome.value, cached: true };
      }
      if (outcome.kind === "owner") {
        // P1 fix (independent review, "renew compute leases while their
        // owners are active", finding 3): a periodic, best-effort renewal
        // — well inside `computeLeaseTtlMs` (a third of it, so at least
        // two renewal attempts land before the ORIGINAL claim would ever
        // elapse) — keeps this lease looking genuinely live to every other
        // contender's `negotiateComputeOwnership()` for as long as
        // `compute()` below is still actually running, no matter how much
        // longer than the original TTL window it takes. Each tick is its
        // OWN short, synchronous critical section (bkz.
        // `renewComputeLease()`/`compareAndSwapComputeLease()`'in fix
        // notları) — never a lock held across this `await compute()`
        // itself. `.unref()` so a leaked timer (there should never be one,
        // given the `finally` below) cannot itself keep the process alive.
        // If the process crashes outright, renewal simply stops firing —
        // the lease then naturally elapses at its own last-renewed
        // `expiresAt`, exactly the same bounded "dead/crashed owners
        // eventually stop renewing, successors recover only once genuinely
        // stale" recovery shape this file's lease design already
        // documents for the ORIGINAL, one-shot claim.
        const renewalIntervalMs = computeRenewalIntervalMs(this.computeLeaseTtlMs);
        const renewalTimer = setInterval(() => {
          this.renewComputeLease(key, ownerId);
        }, renewalIntervalMs);
        renewalTimer.unref?.();
        try {
          // No lock held here at all — an `await`-bound computation never
          // blocks the event loop, and never blocks another contender's own
          // brief `negotiateComputeOwnership()` critical section.
          let value: T;
          try {
            value = await compute();
          } catch (err) {
            // `compute()` itself never ran to completion — no billable
            // work was ever actually finished, so releasing the lease
            // (letting a fresh contender try again) is exactly correct.
            this.releaseComputeLease(key, ownerId);
            throw err;
          }
          // P1 fix (P0 final closure remediation, finding 2, "paid
          // bootstrap checkpoint must be atomic with provider
          // completion"): from THIS point on, `value` is a genuine,
          // already-billed result — bkz. `recordComputeCompletion()`'ın
          // fix notu. That durable record is written FIRST, and on ANY
          // failure from here on (including this line itself, or the
          // main-cache `set()` below), the lease is deliberately NEVER
          // released: releasing it would tell the next contender "nobody
          // has computed this yet," and `negotiateComputeOwnership()`
          // would then invoke `compute()` — the real, billable provider —
          // a second time for work already paid for once. Whether or not
          // this specific call successfully reflects the result into the
          // main cache, `negotiateComputeOwnership()`'s own completed-
          // lease check guarantees every future caller (this one retried,
          // or any other) recovers the SAME value without recomputing.
          //
          // P1 fix (P0 final closure remediation, finding 5, "successful
          // stale compute-lease owners must not commit"): reproduced —
          // `recordComputeCompletion()`'s own CAS return value used to be
          // discarded entirely, so even when it returned `false` (this
          // owner's lease had ALREADY been reclaimed by a successor —
          // e.g. this owner was wrongly presumed abandoned while
          // genuinely still computing, a legitimate race the lease
          // protocol's own TTL/reclaim design accepts as possible) the
          // code below still called `this.set(key, value, ttlMs)`
          // UNCONDITIONALLY — clobbering the main cache with THIS now-
          // stale owner's result even after a successor had already
          // legitimately claimed the key and may have already persisted
          // its OWN, authoritative result. Lease release/renewal were
          // already owner-fenced (findings 3/4 of this same batch); the
          // final COMMIT step was not. Fixed: `committed` is checked, and
          // a losing/stale owner falls through to renegotiate — exactly
          // the same path an ordinary losing contender takes — so it
          // recovers the SUCCESSOR's real, already-committed value on the
          // next iteration instead of ever overwriting it with its own.
          const committed = this.recordComputeCompletion(key, ownerId, value);
          if (!committed) {
            continue;
          }
          this.set(key, value, ttlMs);
          return { value, cached: false };
        } finally {
          clearInterval(renewalTimer);
        }
      }
      // "busy": another contender holds a live lease. Sleep via an
      // ordinary `await` (never a synchronous, event-loop-blocking wait)
      // and renegotiate — either the winner's value has landed by then, or
      // the lease has meanwhile expired (bounding a crashed owner's impact).
      await sleep(COMPUTE_LEASE_POLL_INTERVAL_MS);
    }
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
  // P2 fix (independent Codex review, "deduplicate concurrent durable
  // cache computations"): a MISS here no longer calls `compute()`
  // directly — bkz. `FileCache.computeAndSet()`'in fix notu for the full
  // single-flight/lease protocol this now routes through instead.
  return cache.computeAndSet(key, compute, ttlMs);
}
