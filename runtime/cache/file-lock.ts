// P2 fix (16th independent review round, "durable cache read-modify-write
// is not safe across processes"): FileCache's set()/expiration-cleanup
// used to READ the whole persisted map, mutate an in-memory copy, and
// ATOMICALLY REPLACE the file (bkz. runtime/state/file-store.ts'in
// rename-tabanlı atomik yazma deseni) — ama bu, yalnızca TEK BİR yazmanın
// kendisini bozulmaya karşı korur; iki AYRI process aynı anda bu üç
// adımı (oku -> değiştir -> değiştir) çalıştırırsa, ikisi de AYNI eski
// haritayı okur, ikisi de kendi bağımsız girdisini ekler, ve İKİNCİ
// process'in atomik yazması BİRİNCİ process'in başarıyla eklediği girdiyi
// SESSİZCE SİLER (klasik "lost update" yarışı) — atomik dosya
// DEĞİŞTİRME, bütün oku-değiştir-yaz İŞLEMİNİ atomik yapmaz.
//
// Bu modül, mkdirSync'in ATOMİK olma özelliğini (POSIX ve Windows'ta,
// hedef zaten varsa EEXIST ile başarısız olur — "kontrol et sonra
// oluştur" yarışı YOKTUR, tek bir syscall'dır) bir process'ler-arası
// karşılıklı dışlama (mutual exclusion) ilkeli olarak kullanır: kilit,
// bir DİZİN oluşturmaktır, dosya değil. Bağımlılıksız, minimal, ve bu
// depodaki diğer kalıcılık kodunun (file-store.ts) senkron, sade
// felsefesiyle tutarlıdır — "gereksiz ağır bağımlılık eklenmez" ilkesi
// (16th round review'ın kendi talimatı).
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

export class FileLockTimeoutError extends Error {
  constructor(lockDirPath: string, timeoutMs: number) {
    super(
      `Timed out after ${timeoutMs}ms waiting to acquire the cross-process lock '${lockDirPath}'. ` +
        `Another process may be holding it (and is not stale), or is holding it far longer than expected.`
    );
    this.name = "FileLockTimeoutError";
  }
}

export interface FileLockOptions {
  /** How long to wait for the lock before throwing FileLockTimeoutError. */
  readonly timeoutMs?: number;
  /**
   * How old an unreleased lock must be, WHEN ITS OWNER'S LIVENESS CANNOT
   * BE DETERMINED, before it is treated as abandoned and safe to reclaim.
   * This is deliberately NEVER sufficient on its own to reclaim a lock
   * whose owner is confirmed alive (17th independent review round fix,
   * bkz. `isLockStale`'in üstündeki not) — a confirmed-dead owner is
   * reclaimed immediately regardless of age, and a confirmed-live owner
   * is never reclaimed regardless of age.
   */
  readonly staleMs?: number;
  readonly pollIntervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 15;

/**
 * P1 fix (28th independent review round, finding 11, "validate file-lock
 * timing options"): `timeoutMs`/`staleMs`/`pollIntervalMs` used to be
 * consumed directly from caller-supplied (possibly runtime/deserialized —
 * e.g. loaded from a JSON config file, or built from a value that
 * survived a `JSON.parse`) input with NO validation at all. Each invalid
 * value silently DISABLES the exact protection this module exists to
 * provide, rather than merely misbehaving:
 *   - `timeoutMs: NaN` -> `deadline = Date.now() + NaN` is `NaN`, and
 *     `Date.now() >= NaN` is ALWAYS `false` — the unconditional timeout
 *     check at the bottom of the acquisition loop NEVER fires, so
 *     `acquireFileLock()` waits forever instead of throwing
 *     `FileLockTimeoutError`, exactly the "kilit sonsuza kadar
 *     çalışır bırakılamaz" guarantee this file's own header comment
 *     documents.
 *   - `staleMs: NaN` (or negative) -> `isLockStale()`'s
 *     `Date.now() - stat.mtimeMs > staleMs` comparison is unreliable
 *     (`> NaN` is always `false`; a negative threshold makes EVERY lock
 *     look instantly stale) — either permanently disabling reclaim of a
 *     genuinely abandoned lock, or reclaiming a live one instantly.
 *   - `pollIntervalMs: 0` or negative -> `sleepSync()`'s own `if (ms <= 0)
 *     return;` guard makes it a genuine no-op, turning the retry loop into
 *     an uncontrolled tight busy-loop — the EXACT "asla sıkı (busy) döngüye
 *     girme" invariant this module's own comments repeatedly document as
 *     load-bearing.
 * Fixed: every timing option is validated as a genuine, finite number
 * within an architecture-appropriate bound BEFORE any acquisition/retry
 * logic runs — `NaN`/`Infinity`/`-Infinity`/negative/non-number values
 * all fail closed immediately, naming the offending option, rather than
 * silently disabling timeout/staleness/backoff behavior.
 */
export class InvalidFileLockOptionsError extends Error {
  constructor(option: "timeoutMs" | "staleMs" | "pollIntervalMs", value: unknown, requirement: string) {
    super(
      `Invalid FileLockOptions.${option}: ${typeof value === "number" ? value : JSON.stringify(value)} ` +
        `(typeof ${typeof value}). ${requirement} A file lock's timing configuration is rejected BEFORE any ` +
        `acquisition/retry logic runs — an invalid value would otherwise silently disable timeout, staleness, ` +
        `or backoff protection instead of merely misbehaving.`
    );
    this.name = "InvalidFileLockOptionsError";
  }
}

function assertValidLockTimingOptions(timeoutMs: number, staleMs: number, pollIntervalMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new InvalidFileLockOptionsError(
      "timeoutMs",
      timeoutMs,
      "timeoutMs must be a finite number >= 0 (0 means 'try once, never wait')."
    );
  }
  if (!Number.isFinite(staleMs) || staleMs <= 0) {
    throw new InvalidFileLockOptionsError("staleMs", staleMs, "staleMs must be a finite number > 0.");
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new InvalidFileLockOptionsError(
      "pollIntervalMs",
      pollIntervalMs,
      "pollIntervalMs must be a finite number > 0 (a zero/negative interval turns the retry loop into an " +
        "uncontrolled busy-loop)."
    );
  }
}

interface LockMeta {
  readonly pid: number;
  readonly token: string;
  readonly acquiredAt: number;
}

/**
 * `Atomics.wait` üzerinden gerçek zamanlı, senkron bir bekleme — Node.js'in
 * yerleşik bir senkron `sleep`'i yoktur, ama bu API kilit alma döngüsü
 * (spin-wait) için Node çekirdeğine gömülü, ek bağımlılık gerektirmeyen
 * standart bir tekniktir. Bu dosyanın geri kalanı zaten tamamen senkron
 * (StateStore/FileCache ile aynı stil) olduğundan, bir `Promise`/`await`
 * tabanlı bekleme buraya sığmaz — kilidi bekleyen çağıran zaten senkron
 * bir çağrı zincirinin içindedir.
 */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const sharedBuffer = new SharedArrayBuffer(4);
  const flag = new Int32Array(sharedBuffer);
  Atomics.wait(flag, 0, 0, ms);
}

/**
 * P2 fix (17th independent review round, "do not reclaim locks held by
 * live processes"): eskiden `process.kill(pid, 0)` EPERM DIŞINDA
 * fırlattığı HERHANGİ bir hatayı (yalnızca ESRCH değil) "process ölü"
 * olarak yorumluyordu — talimatın kendi ifadesiyle, "her arama
 * başarısızlığını sahibin ölümü SAYMAMALI" kuralını ihlal eden, aşırı
 * agresif bir varsayılan. Artık yalnızca AÇIKÇA ESRCH (bu PID hiç yok)
 * "ölü" sayılır; EPERM (var ama sinyal izni yok) VEYA beklenmeyen HERHANGİ
 * BİR başka hata "muhafazakâr" biçimde CANLI varsayılır — bir kilidi
 * yanlışlıkla çalmaktansa gereksiz yere biraz daha beklemek her zaman
 * daha güvenlidir.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return true;
  }
}

/**
 * P2 fix (22nd independent review round, "validate lock metadata before
 * using owner PID"): eskiden `readLockMeta`, `JSON.parse`'ın sonucunu
 * DOĞRUDAN `LockMeta` olarak KÖRÜ KÖRÜNE cast ediyordu (`as LockMeta`) —
 * TypeScript'in bu cast'i çalışma zamanında (runtime) DOĞRULAMADIĞINI
 * unutarak. Codex, sözdizimsel olarak GEÇERLİ JSON'un (`{}`, ya da
 * `{"pid":"123"}` gibi) YANLIŞ biçimli sahiplik metadata'sı taşıyabildiğini
 * ve bunun `isLockStale`'e kadar hiç yakalanmadan ulaştığını gösterdi:
 * `meta.pid` (ör. `undefined` ya da `"123"` bir STRING) doğrudan
 * `isProcessAlive(pid)`'e geçiyor, `process.kill(pid, 0)` bu geçersiz PID
 * için (ESRCH DIŞINDA) beklenmeyen bir hata fırlatıyor, ve `isProcessAlive`
 * bu hatayı "muhafazakâr olarak CANLI" sayıyordu — YANLIŞ BİÇİMLİ metadata,
 * SAHTE bir "onaylanmış CANLI sahip" sonucuna dönüşüyor, kilit ASLA
 * BİLİNMEYEN-sahip kurtarma politikasına girmiyor, ve otomatik kurtarma
 * KALICI olarak engellenebiliyordu (Codex, `staleMs=1` ile bile
 * `acquireFileLock`'ın sonsuza dek zaman aşımına uğradığını, terk edilmiş
 * kilidi HİÇBİR ZAMAN kurtaramadığını doğruladı).
 *
 * Gereken değişmez: metadata, SADECE geçerli JSON olduğu için ASLA
 * güvenilmemelidir — bir PID/canlılık kararı verilmeden ÖNCE sahiplik
 * metadata'sının YAPISAL olarak geçerli olduğu doğrulanmalıdır. Fixed:
 * `isValidLockMeta` artık her alanı açıkça doğrular (nesne midir, null/dizi
 * değil midir, `pid` sonlu bir TAM SAYI mıdır ve sıfırdan büyük müdür,
 * `token` boş olmayan bir string midir, `acquiredAt` sonlu bir sayı mıdır)
 * — bu doğrulamalardan HERHANGİ biri başarısız olursa `readLockMeta`
 * `undefined` döndürür, TIPKI okunamayan/bozuk metadata gibi. Bu, TEK bir
 * güven sınırında (bu fonksiyon) uygulandığından, `isLockStale` (ve onun
 * üzerinden `tryReclaimStaleLock`/`acquireReclaimGate`/`releaseFileLock`)
 * otomatik olarak doğru şekilde davranır: yapısal olarak geçersiz
 * metadata `meta` alanını `undefined` görür ve ZATEN VAR OLAN, BELGELENMİŞ
 * BİLİNMEYEN-sahip `mtime`-tabanlı SINIRLI kurtarma yoluna düşer — ne
 * "onaylanmış CANLI" sayılır (kilit sonsuza dek korunmaz), ne de anında
 * koşulsuz silinir (mevcut yaş/sınır kuralları hâlâ geçerlidir).
 */
/**
 * P2 fix (23rd independent review round, "reject out-of-range lock owner
 * PIDs"): Codex reproduced that a syntactically valid positive integer PID
 * can still fall OUTSIDE the platform-valid PID domain — Node's own
 * internal argument validation for `process.kill()` rejects any PID
 * greater than `MAX_VALID_PID` (2147483647, i.e. `2^31 - 1`, the POSIX
 * `pid_t`/Node-internal upper bound; confirmed empirically in this exact
 * environment: `process.kill(2147483648, 0)` throws `ERR_INVALID_ARG_TYPE`,
 * a TypeError, NOT `ESRCH`) with a `TypeError`/`RangeError`, never `ESRCH`.
 * `isProcessAlive()`'s existing, intentionally conservative "any non-ESRCH
 * outcome means alive" rule (17th independent review round fix — correct
 * for a genuine EPERM/unexpected-errno case) then misclassified such an
 * out-of-range PID as a CONFIRMED LIVE owner — which `isLockStale()` never
 * treats as stale regardless of age, permanently blocking the documented
 * UNKNOWN-owner recovery policy for a lock that could never have had a
 * real owner in the first place (no real OS process can ever hold a PID
 * outside this range). Fixed: `isValidLockMeta` now also rejects any `pid`
 * greater than `MAX_VALID_PID`, routing it into the same UNKNOWN-owner
 * bounded recovery path as any other structurally invalid metadata (bkz.
 * 22nd independent review round fix note above, of which this is a direct
 * extension of the same validation).
 */
const MAX_VALID_PID = 2147483647;

function isValidLockMeta(value: unknown): value is LockMeta {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.pid === "number" &&
    Number.isInteger(candidate.pid) &&
    Number.isFinite(candidate.pid) &&
    candidate.pid > 0 &&
    candidate.pid <= MAX_VALID_PID &&
    typeof candidate.token === "string" &&
    candidate.token.length > 0 &&
    typeof candidate.acquiredAt === "number" &&
    Number.isFinite(candidate.acquiredAt)
  );
}

function readLockMeta(metaPath: string): LockMeta | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(metaPath, "utf8"));
    return isValidLockMeta(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * P2 fix (17th independent review round, "do not reclaim locks held by
 * live processes"): eskiden bir kilit, sahibi HÂLÂ YAŞIYOR olsa bile
 * SADECE `staleMs`'den daha uzun süredir açık olması nedeniyle "stale"
 * sayılıyordu — Codex, uzun süren MEŞRU bir kritik bölümün (canlı sahip,
 * `staleMs`'i aşan ama hâlâ devam eden bir okuma-değiştir-yazma) başka
 * bir process tarafından "terk edilmiş" sanılıp ÇALINABİLDİĞİNİ,
 * ardından İKİ process'in aynı anda "sahibiz" sanabileceğini gösterdi —
 * tam da bu kilidin önlemesi gereken kalıcı-önbellek kayıp-güncelleme
 * yarışını YENİDEN AÇAR. Gereken değişmez: YAŞ TEK BAŞINA, kanıtlanmış
 * CANLI bir sahibin kilidini çalmak için ASLA yetki vermez. Artık üç
 * ayrık durum vardır: (1) CANLI (meta okunabildi VE `isProcessAlive`
 * true) → ASLA stale, yaş ne olursa olsun; (2) ÖLÜ (meta okunabildi VE
 * `isProcessAlive` false, yani PID'ye ESRCH) → HER ZAMAN stale, ANINDA
 * (kalıcı kilitlenmeyi önlemek için `staleMs` kadar beklemeye gerek
 * YOKTUR); (3) BİLİNMEYEN (metadata okunamadı — yarış, bozulma, disk
 * hatası) → sahibin kimliği belirlenemediğinden ne "canlı" ne "ölü"
 * varsayılabilir; TEK güvenli, SINIRLI kurtarma sinyali dizinin kendi
 * `mtime`'ı üzerinden `staleMs`'tir (bu, dizi meta yazımı başarısız olsa
 * bile kilidin sonsuza dek kilitli kalmamasını sağlayan, belgelenmiş bir
 * politikadır — her arama hatasını ölüm SAYMAK değildir).
 */
/**
 * P1 fix (33rd independent review round, finding 6 / root class E, "lock
 * ownership must not rely on PID alone") — SUPERSEDED, see the 35th round
 * fix note directly below: this round had bounded a CONFIRMED-ALIVE
 * reading by an `acquiredAt`-derived `maxOwnerAgeMs` ceiling, so that a
 * PID-reused zombie lock (the ORIGINAL owner died; the OS reassigns the
 * exact same PID to a later, unrelated process) would eventually become
 * reclaimable rather than permanently blocking `acquireFileLock()`. That
 * design traded away a DIFFERENT, more severe guarantee to get there: age
 * alone, applied uniformly to every confirmed-alive reading, cannot tell a
 * PID-reused zombie apart from a genuinely alive owner in the middle of an
 * unusually long — but entirely legitimate — held critical section. A
 * caller configuring (or defaulting into) a `maxOwnerAgeMs` shorter than
 * some real workload's actual hold time would have TWO processes believing
 * they both own the SAME critical section at once — exactly the mutual-
 * exclusion violation this entire module exists to prevent, the opposite
 * failure mode from the one round 33 was fixing.
 *
 * P1 fix (35th independent review round, finding 7, "do not reclaim a lock
 * from a confirmed-live owner"): reverses round 33's approach for exactly
 * this reason — `maxOwnerAgeMs` is removed entirely, and the CONFIRMED-
 * ALIVE branch is restored to the 17th independent review round's original,
 * unconditional invariant: a lock whose owner PID is confirmed alive is
 * NEVER stale, regardless of how long it has been held. Age is not, and
 * cannot be, authoritative proof of a DIFFERENT process now holding the
 * same PID — only genuine identity proof (a portable process-start-time
 * reading, which Node.js cannot provide without a native addition or a
 * platform-specific `/proc` path this codebase's own stated principles
 * already reject) could safely distinguish the two, and no such proof is
 * available here. The residual PID-reuse exposure round 33 set out to
 * close is therefore knowingly re-accepted — narrower in practice than it
 * sounds, since a PID reused by an unrelated process needs to ALSO
 * coincide with THIS specific lock still being held from before that PID's
 * original process died, and is the SAME conservative "when identity
 * cannot be proven, wait rather than risk stealing a live owner's lock"
 * trade-off `isProcessAlive()`'s own EPERM/unexpected-error handling has
 * always made a few lines above. Three states remain, now exactly as the
 * 17th round originally established: (1) CONFIRMED ALIVE (meta readable
 * AND `isProcessAlive` true) → NEVER stale, age irrelevant; (2) CONFIRMED
 * DEAD (meta readable AND `isProcessAlive` false, i.e. ESRCH) → ALWAYS
 * stale, immediately; (3) UNKNOWN (metadata unreadable — race, corruption,
 * disk error) → falls back to the directory's own `mtime` against
 * `staleMs`, the same bounded, non-identity-based recovery signal as
 * before.
 */
function isLockStale(lockDirPath: string, metaPath: string, staleMs: number): boolean {
  const meta = readLockMeta(metaPath);
  if (meta) {
    return !isProcessAlive(meta.pid);
  }
  try {
    const stat = statSync(lockDirPath);
    return Date.now() - stat.mtimeMs > staleMs;
  } catch {
    return false;
  }
}

/**
 * P2 fix (17th independent review round, "stale-lock reclamation is not
 * serialized across contenders"): eskiden BİRDEN FAZLA process AYNI terk
 * edilmiş kilidi "stale" olarak GÖZLEMLEYİP, ikisi de KOŞULSUZ olarak
 * `rmSync(lockDirPath)` çağırabiliyordu — Codex, Process A'nın stale
 * kilidi kaldırıp KENDİ YENİ, GEÇERLİ kilidini oluşturduğu, ardından
 * Process B'nin (hâlâ ESKİ gözlemine dayanarak) KOŞULSUZ silme işlemiyle
 * A'nın YENİ kilidini yanlışlıkla sildiğini ve sonra kendi kilidini
 * oluşturduğunu gösterdi — iki process aynı anda "kritik bölümün sahibi
 * benim" sanabiliyordu. Gereken değişmez: bir process, SADECE GÖZLEMLEDİĞİ
 * TAM O stale kilit ÖRNEĞİNİ kaldırabilir; başka bir yarışmacının
 * oluşturduğu YENİ bir yedek kiliDİ ASLA silemez. Fixed: geri kazanım
 * (reclaim) artık İKİ AYRI atomik kapı üzerinden geçer: (1) sabit,
 * `lockDirPath`'e göre TÜRETİLMİŞ bir "reclaim kapısı" dizini
 * (`lockDirPath + ".reclaim"`) — `mkdirSync` ile atomik olarak alınır; AYNI
 * `lockDirPath`'i geri kazanmaya çalışan TÜM yarışmacılar AYNI kapıyı
 * hedefler, bu yüzden `mkdirSync`'in atomikliği sayesinde TAM OLARAK BİR
 * tanesi kazanır — kaybedenler `lockDirPath`'e ASLA dokunmadan geri çekilir
 * (normal bekleme/yeniden deneme döngüsüne döner); (2) kapıyı kazanan
 * process, `lockDirPath`'in HÂLÂ stale olduğunu (canlı bir sahip tarafından
 * bu arada meşru şekilde yenilenmediğini) SİLMEDEN HEMEN ÖNCE YENİDEN
 * doğrular — kapı, "aynı anda başka HİÇBİR reclaim girişimi olamaz"ı
 * garanti ettiğinden, bu son kontrol ile gerçek `rmSync` çağrısı arasında
 * TOCTOU penceresi KALMAZ (tek istisna: `lockDirPath`'in kendisi meşru,
 * SIRADAN bir `mkdirSync` denemesiyle -reclaim mekanizmasının DIŞINDA-
 * doldurulması, ki bu zaten normal/adil bir yarıştır, "canlı bir sahibi
 * çalmak" değildir). Kapının kendisi de kendi stale-tespitine tabidir
 * (aşağıdaki `acquireReclaimGate`'e bkz.) — meşru bir reclaim işlemi
 * birkaç senkron syscall'dan oluşup neredeyse anında biter; kapıyı ALAN
 * process'in KENDİSİ reclaim SIRASINDA çökerse, kapı `staleMs` sonra yine
 * kurtarılabilir hale gelir, böylece kalıcı bir kilitlenme oluşmaz.
 * Döndürülen `true`, kaldırmanın (silmenin) GERÇEKTEN başarılı olduğu
 * (ve `lockDirPath`'in artık boş olduğu KANITLANDIĞI) anlamına gelir —
 * çağıran döngü bu durumda HEMEN `mkdirSync(lockDirPath)`'i yeniden
 * dener; `false`, kapının kaybedildiği, son kontrolün kilidi artık stale
 * BULMADIĞI (canlı bir sahip tarafından meşru şekilde yenilendiği), YA
 * DA kaldırmanın (silmenin) GERÇEKTEN BAŞARISIZ olduğu anlamına gelir —
 * her üç durumda da çağıran normal zaman aşımı/bekleme yoluna döner
 * (gereksiz sıkı döngüden -busy loop- kaçınmak için).
 *
 * P2 fix (21st independent review round, "stale-lock removal failure
 * bypasses acquisition timeout"): eskiden `rmSync(lockDirPath)`
 * BAŞARISIZ olsa bile (ör. kalıcı bir izin hatası, meşgul/silinemeyen
 * bir dizin) bu hata YUTULUYOR ve fonksiyon KOŞULSUZ `true` DÖNDÜRÜYORDU
 * — "kaldırma denendi" ile "kaldırma GERÇEKTEN başarılı oldu" arasındaki
 * farkı çağırana ASLA bildirmeden. Codex, bu durumda `acquireFileLock`'ın
 * döngüsünün `continue` ile HİÇBİR zaman aşımı kontrolüne uğramadan bir
 * sonraki `mkdirSync(lockDirPath)` denemesine geçtiğini, bu denemenin de
 * (dizin hâlâ orada olduğundan) yine EEXIST ile başarısız olacağını, ve
 * bu döngünün SONSUZA DEK (uyku/backoff OLMADAN, sıkı bir şekilde -busy
 * loop-) tekrarlanabileceğini gösterdi — 50ms gibi küçük bir
 * `timeoutMs` yapılandırılmış olsa bile, harici bir süreç sonlandırması
 * olmadan ASLA dönmüyordu. Fixed: `rmSync` başarısız olursa artık `false`
 * döndürülür (silme GERÇEKTEN denenip başarısız olduğu, "reclaim
 * başarılı" OLARAK ASLA raporlanmaz) — bu, çağıran döngüde (bkz.
 * `acquireFileLock`) HER ZAMAN normal zaman aşımı kontrolüne VE
 * uyku/backoff'a uğrayan tek, koşulsuz bir yola yönlendirir.
 */
function tryReclaimStaleLock(lockDirPath: string, metaPath: string, staleMs: number): boolean {
  const claimPath = `${lockDirPath}.reclaim`;
  if (!acquireReclaimGate(claimPath, staleMs)) {
    return false;
  }
  try {
    if (!isLockStale(lockDirPath, metaPath, staleMs)) {
      // Sahip, bizim ilk gözlemimizle şimdi arasında meşru şekilde
      // yenilendi (ör. canlı bir sahip release() edip yeniden kilitledi,
      // ya da hiç stale değilmiş) — ASLA dokunma.
      return false;
    }
    try {
      rmSync(lockDirPath, { recursive: true, force: true });
    } catch {
      // Kaldırma GERÇEKTEN başarısız oldu (force:true zaten ENOENT'i
      // yutar — buraya düşen HERHANGİ bir hata kalıcı/gerçek bir hatadır:
      // izin, meşgul dizin, vb.). ASLA "reclaim başarılı" olarak
      // raporlanmaz — çağıran döngünün normal zaman aşımı/bekleme yoluna
      // düşmesi için `false` döndürülür.
      return false;
    }
    return true;
  } finally {
    try {
      rmSync(claimPath, { recursive: true, force: true });
    } catch {
      // En iyi çaba: kendi kapı işaretimizi temizleyemesek bile, bu
      // işaretin kendi stale-tespiti (bkz. `acquireReclaimGate`) onu
      // ileride başka bir process için kurtarılabilir hale getirir.
    }
  }
}

/**
 * `metaPath`'e rastgele bir token içeren kimlik bilgisi (pid + token +
 * acquiredAt) yazar — kimlik-etiketli HERHANGİ bir dizin (hem
 * `lockDirPath` hem de aşağıdaki reclaim/recovery kapıları) için ortak
 * kullanılan tek bir yazma yordamı. Yazma başarısız olsa bile (best-
 * effort) dizinin kendisi zaten alınmıştır; sadece BİLİNMEYEN-sahip
 * stale tespiti dizin mtime'ına geri düşer (bkz. `isLockStale`).
 */
function writeGateIdentity(metaPath: string): void {
  try {
    const meta: LockMeta = { pid: process.pid, token: randomBytes(8).toString("hex"), acquiredAt: Date.now() };
    writeFileSync(metaPath, JSON.stringify(meta), "utf8");
  } catch {
    // En iyi çaba (best-effort).
  }
}

/**
 * P2 fix (19th independent review round, "make stale reclaim-gate
 * recovery ownership-safe"): eskiden bu fonksiyon, `claimPath`'in
 * KENDİSİ terk edilmiş görünüyorsa (yalnızca dizinin `mtime`'ına
 * bakarak) DOĞRUDAN `rmSync(claimPath)` çağırıyordu — hiçbir kimlik
 * doğrulaması, hiçbir tekrar-kontrol OLMADAN. Codex, tam olarak
 * `tryReclaimStaleLock`'ın KENDİSİNİN `lockDirPath` için çözdüğü SORUNUN
 * (17th independent review round) AYNISININ, bu kez bir SEVİYE İÇERİDE
 * — `claimPath`'in KENDİ terk edilmiş-kapı kurtarma yolunda — yeniden
 * ortaya çıktığını gösterdi: Process A eski/terk edilmiş `claimPath`'i
 * gözlemler, Process B AYNI eski `claimPath`'i gözlemler, A onu kaldırıp
 * KENDİ yeni kapısını oluşturur, B ise hâlâ ESKİ gözlemine dayanarak
 * KOŞULSUZ `rmSync` çağırarak A'nın YENİ kapısını yanlışlıkla siler —
 * ardından hem A hem B `tryReclaimStaleLock`'ın korumalı kritik bölümüne
 * AYNI ANDA girip birbirinin `lockDirPath` yedeğine müdahale edebilir.
 *
 * Gereken değişmez (bir seviye içeride de AYNI): bir process, SADECE
 * GÖZLEMLEDİĞİ TAM O terk edilmiş kapı ÖRNEĞİNİ kaldırabilir; başka bir
 * kurtarıcının (recoverer) oluşturduğu YENİ bir kapıyı ASLA silemez.
 * Fixed: `claimPath`'in kendisi de artık `lockDirPath` ile AYNI kimlik
 * şemasını taşır (pid + token + acquiredAt, `writeGateIdentity` ile
 * yazılır) ve AYNI üç-durumlu (`isLockStale`) canlı/ölü/bilinmeyen
 * ayrımına tabidir — yaş TEK BAŞINA burada da hiçbir şeyi terk edilmiş
 * SAYDIRMAZ; gözlemlenen sahip CANLIYSA kurtarma girişimi HİÇ başlamaz.
 * Kurtarma girişiminin KENDİSİ, gözlemlenen belirli NESİL'in (generation)
 * token'ına göre TÜRETİLMİŞ, TEK-KULLANIMLIK bir "recovery kapısı"
 * (`${claimPath}.recover-${observedToken}`) üzerinden atomik olarak
 * (`acquireRecoveryGate`, `mkdirSync` ile) alınır — AYNI terk edilmiş
 * NESLİ kurtarmaya çalışan TÜM kurtarıcılar AYNI recovery kapısını
 * hedefler, bu yüzden TAM OLARAK BİRİ kazanır; kaybedenler `claimPath`'e
 * ASLA dokunmadan geri çekilir. Kazanan, `claimPath`'in HÂLÂ terk
 * edilmiş olduğunu (bu arada meşru şekilde yenilenmediğini) SİLMEDEN
 * HEMEN ÖNCE YENİDEN doğrular — recovery kapısı, "aynı anda başka HİÇBİR
 * kurtarma girişimi olamaz"ı garanti ettiğinden, TOCTOU penceresi burada
 * da KALMAZ. Recovery kapısının token'a göre türetilmiş olması, onu
 * TEK-KULLANIMLIK yapar: bir kez BAŞARIYLA kullanıldıktan (ya da
 * `claimPath` başka biri tarafından meşru şekilde ilerletildikten) SONRA,
 * bu ÖZEL token bir daha ASLA "şu anki terk edilmiş nesil" olarak
 * gözlemlenmez — bu yüzden sonsuza dek kullanılmayan bir artık olarak
 * kalması ZARARSIZDIR (gelecekteki hiçbir kurtarma denemesi onu bir daha
 * hedeflemez). Kabul edilen, belgelenmiş, DAR bir sınırlama: recovery
 * kapısını ALAN process'in KENDİSİ de kurtarma SIRASINDA çökerse
 * (yalnızca İKİ BAĞIMSIZ çökme —özgün sahip VE reclaim'i— art arda
 * gerçekleştiğinde ulaşılabilen, son derece nadir bir bileşik senaryo),
 * `acquireRecoveryGate` KENDİSİ basit, tek-seviyeli bir yaş-tabanlı
 * (mtime) geri düşüşle kurtarılır (üçüncü bir iç içe kapı EKLEMEDEN) —
 * bu, "kalıcı kilitlenme asla" gereksinimini korur, ancak yalnızca bu
 * son derece nadir bileşik senaryoda TOCTOU'ya karşı tam korumalı
 * DEĞİLDİR; bu, PID yeniden kullanımı sınırlaması gibi, bu dosyanın
 * kasıtlı olarak kabul ettiği ve belgelediği bir P0-minimal ödünleşimdir.
 */
/**
 * P1 fix (23rd independent review round, "sanitize reclaim tokens before
 * deriving filesystem paths"): Codex found that `acquireReclaimGate()`
 * derived `recoveryGatePath` by directly interpolating a token READ FROM
 * PERSISTED METADATA (`readLockMeta(claimMetaPath)?.token`) into a
 * filesystem path (`${claimPath}.recover-${observedToken}`) with NO
 * validation of the token's own shape. This repository's OWN token
 * generator (`writeGateIdentity`, above) always produces a fixed-format,
 * 16-character lowercase hex string (`randomBytes(8).toString("hex")`) —
 * but `owner.json` is a plain JSON file on disk, and the 22nd independent
 * review round's fix only validates that `token` is a NON-EMPTY STRING,
 * not that it matches this canonical shape. A malformed or hostile
 * `owner.json` (written by a corrupted process, a misbehaving third party
 * with filesystem access, or simply bit-rot) could therefore carry a
 * `token` containing path separators or traversal components (`"../x"`,
 * `"../../x"`, `"a/b"`, `"a\\b"`, an absolute-path fragment, etc.) — since
 * `recoveryGatePath` is later passed to `mkdirSync`/`rmSync`, such a token
 * could redirect the recovery gate (and, via `acquireRecoveryGate`'s own
 * stale-then-`rmSync` path) OUTSIDE the intended `.reclaim` directory
 * entirely, causing a RECURSIVE DELETE of an unrelated, attacker- or
 * corruption-chosen filesystem location.
 *
 * Gereken değişmez: kalıcı/güvenilmeyen token verisi, ASLA doğrudan bir
 * dosya sistemi yolu BİLEŞENİNE yönlendirilemez. Fixed: `sanitizeReclaimToken()`
 * yalnızca bu uygulamanın KENDİSİNİN ürettiği KANONİK biçimi (tam olarak
 * 16 küçük harfli onaltılık karakter) kabul eder; bunun dışındaki HERHANGİ
 * bir değer (yol ayırıcıları, `..`, mutlak yol parçaları, platforma özgü
 * ayırıcılar, olağandışı uzunluk, boş string dahil) sabit, zararsız bir
 * yer tutucuya (`"unknown-generation"` — zaten `token` hiç okunamadığında
 * kullanılan AYNI mevcut geri düşüş değeri) düşürülür. Bu, `recoveryGatePath`'in
 * HER ZAMAN `claimPath`'in kendisinden türetilen, sabit bir son ek dışında
 * hiçbir şey İÇERMEMESİNİ garanti eder — token ne olursa olsun, üretilen
 * yol asla `.reclaim` dizininin dışına ÇIKAMAZ. Sahiplik/token semantiği
 * (bkz. `releaseFileLock`/`tryReclaimStaleLock`'ın kendi token kontrolleri)
 * DEĞİŞTİRİLMEDİ — bu fonksiyon yalnızca bir token'ın bir YOL BİLEŞENİ
 * olarak KULLANILIP KULLANILAMAYACAĞINI belirler, sahiplik kararlarını
 * DEĞİL.
 */
const CANONICAL_RECLAIM_TOKEN_PATTERN = /^[0-9a-f]{16}$/;

/** Exported for direct, deterministic unit testing of every rejected shape (path separators, traversal, absolute paths, oversized/malformed values) without needing to fabricate a full filesystem escape scenario for each one. */
export function sanitizeReclaimToken(token: string | undefined): string {
  if (typeof token === "string" && CANONICAL_RECLAIM_TOKEN_PATTERN.test(token)) {
    return token;
  }
  return "unknown-generation";
}

function acquireReclaimGate(claimPath: string, staleMs: number): boolean {
  const claimMetaPath = join(claimPath, "owner.json");
  try {
    mkdirSync(claimPath);
    writeGateIdentity(claimMetaPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    if (!isLockStale(claimPath, claimMetaPath, staleMs)) {
      // Kapı hâlâ meşru şekilde tutuluyor (canlı bir sahip VEYA henüz
      // yaşlanmamış) — ASLA dokunma.
      return false;
    }
    const observedToken = sanitizeReclaimToken(readLockMeta(claimMetaPath)?.token);
    const recoveryGatePath = `${claimPath}.recover-${observedToken}`;
    if (!acquireRecoveryGate(recoveryGatePath, staleMs)) {
      return false;
    }
    try {
      // Recovery kapısını ALDIKTAN SONRA yeniden doğrula — aynı anda
      // başka HİÇBİR kurtarıcı bu AYNI nesli hedefleyemez, bu yüzden bu
      // kontrol ile gerçek `rmSync` arasında TOCTOU penceresi KALMAZ.
      if (!isLockStale(claimPath, claimMetaPath, staleMs)) {
        return false;
      }
      try {
        rmSync(claimPath, { recursive: true, force: true });
      } catch {
        // En iyi çaba: çağıran döngü zaten yeniden deneyecek.
      }
      try {
        mkdirSync(claimPath);
        writeGateIdentity(claimMetaPath);
        return true;
      } catch {
        return false;
      }
    } finally {
      try {
        rmSync(recoveryGatePath, { recursive: true, force: true });
      } catch {
        // En iyi çaba: token'a göre türetilmiş olduğundan, temizlenemese
        // bile bir daha ASLA hedeflenmeyecek zararsız bir artıktır.
      }
    }
  }
}

/**
 * `recoveryGatePath`'i atomik olarak alır — `acquireReclaimGate`'in
 * üstündeki fix notuna bkz. Bu kapı, gözlemlenen BELİRLİ terk edilmiş
 * nesle (`observedToken`) göre türetildiğinden TEK-KULLANIMLIKTIR;
 * kendi terk edilme kontrolü bu yüzden kasıtlı olarak basit ve TEK
 * seviyelidir (üçüncü bir iç içe kapı yok) — bu yola ancak İKİ BAĞIMSIZ
 * çökme art arda gerçekleştiğinde ulaşılır (bkz. yukarıdaki not).
 */
function acquireRecoveryGate(recoveryGatePath: string, staleMs: number): boolean {
  try {
    mkdirSync(recoveryGatePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    try {
      const stat = statSync(recoveryGatePath);
      if (Date.now() - stat.mtimeMs <= staleMs) {
        return false;
      }
    } catch {
      return false;
    }
    try {
      rmSync(recoveryGatePath, { recursive: true, force: true });
    } catch {
      return false;
    }
    try {
      mkdirSync(recoveryGatePath);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * `lockDirPath`'te process'ler-arası bir kilit alır ve bir `release()`
 * geri çağırımı döndürür. Aşırı yüklenme (contention) altında `timeoutMs`
 * kadar bekler; bu sürede kanıtlanmış şekilde terk edilmiş bir kilit
 * tespit edilirse (bkz. `isLockStale`), onu YALNIZCA `tryReclaimStaleLock`'ın
 * kimlik-doğrulamalı, tek-kazananlı protokolü ÜZERİNDEN kaldırır — asla
 * koşulsuz/doğrudan bir `rmSync` ile değil.
 *
 * P2 fix (21st independent review round, "stale-lock removal failure
 * bypasses acquisition timeout"): eskiden `EEXIST` yakalama bloğu şu
 * satırı içeriyordu: `if (isLockStale(...) && tryReclaimStaleLock(...))
 * { continue; }` — Codex, `tryReclaimStaleLock()` (o zamanki hatalı
 * haliyle) kalıcı bir kaldırma hatasında bile KOŞULSUZ `true`
 * döndürdüğünde, bu `continue`'nün HİÇBİR ZAMAN aşağıdaki
 * `Date.now() >= deadline` kontrolüne UĞRAMADIĞINI, döngünün bir sonraki
 * `mkdirSync` denemesinin de (dizin hâlâ orada olduğundan) yine EEXIST
 * ile başarısız olacağını, ve bu döngünün UYKU/backoff OLMADAN sonsuza
 * dek (sıkı bir -busy- döngü olarak) tekrarlanabileceğini gösterdi — 50ms
 * gibi küçük bir `timeoutMs` yapılandırılmış olsa bile harici bir süreç
 * sonlandırması olmadan ASLA dönmüyordu. `tryReclaimStaleLock()`'ın
 * kendisi de artık kaldırma GERÇEKTEN başarısız olduğunda `false`
 * döndürüyor (bkz. o fonksiyonun üstündeki fix notu), ama bu TEK BAŞINA
 * yeterli değildi — çağıran döngünün KENDİSİ de, reclaim denemesinin
 * SONUCU ne olursa olsun (başarılı, başarısız, kapı kaybedildi, sahip
 * hâlâ canlı), zaman aşımı kontrolünü ASLA atlamayacak şekilde yeniden
 * yapılandırıldı: artık `continue` YOKTUR — döngünün gövdesi her
 * yinelemede, hangi dala girerse girsin, TEK VE KOŞULSUZ bir
 * `Date.now() >= deadline` kontrolünden geçer; yalnızca reclaim GERÇEKTEN
 * başarılı olduğunda (dizin kanıtlanmış şekilde boşaltıldığında) uyku
 * ATLANIR (ilerleme kaydedildiği için gecikmesiz yeniden deneme meşrudur)
 * — reclaim başarısız/uygulanamaz olan HER durumda (dahil: kaldırma
 * hatası, kapı kaybı, sahip hâlâ canlı, `isLockStale` false) döngü HER
 * ZAMAN `pollIntervalMs` kadar uyur, ASLA sıkı döngüye girmez.
 *
 * P1 fix (33rd independent review round, finding 6 / root class E) —
 * SUPERSEDED by the 35th round, finding 7 (bkz. `isLockStale()`'in kendi,
 * en güncel fix notu): this paragraph used to document that a
 * CONFIRMED-ALIVE reading was bounded by `maxOwnerAgeMs`, so a PID-reused
 * zombie lock would eventually age past that ceiling and become
 * reclaimable rather than blocking forever. That mechanism has been
 * REMOVED: age applied uniformly to every confirmed-alive owner cannot
 * tell a PID-reused zombie apart from a genuinely alive owner mid-way
 * through an unusually long but legitimate critical section — reclaiming
 * the latter puts two processes in the same critical section at once,
 * a strictly worse failure than the PID-reuse window it was closing. The
 * ORIGINAL 17th independent review round invariant is restored: sahiplik
 * kimliği yalnızca PID + rastgele bir token ile belirlenir; bir kilit,
 * sahibi CANLI olduğu sürece yaşı ne olursa olsun ASLA reclaim edilmez.
 * PID reuse remains an accepted, permanent, narrow P0 limitation — the
 * same conservative trade-off `isProcessAlive()`'s own EPERM/unexpected-
 * error handling has always made (bkz. o fonksiyonun kendi fix notu): when
 * identity truly cannot be proven, wait rather than risk stealing a live
 * owner's lock.
 */
export function acquireFileLock(lockDirPath: string, options: FileLockOptions = {}): () => void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  // P1 fix (28th independent review round, finding 11, "validate file-lock
  // timing options"): validated BEFORE any acquisition/retry logic runs —
  // bkz. `assertValidLockTimingOptions()`'ın üstündeki fix notu.
  assertValidLockTimingOptions(timeoutMs, staleMs, pollIntervalMs);
  const metaPath = join(lockDirPath, "owner.json");
  const token = randomBytes(8).toString("hex");
  const deadline = Date.now() + timeoutMs;

  mkdirSync(dirname(lockDirPath), { recursive: true });

  // P2 fix (37th independent review round, finding 10, "timeout deadline
  // checked only on the failure path"): `firstAttempt` preserves the
  // documented "timeoutMs: 0 means try once, never wait" contract (bkz.
  // aşağıdaki notun devamı) — the very first `mkdirSync` attempt always
  // runs regardless of the deadline, since `deadline = Date.now() + 0`
  // would otherwise already be (or be about to become) satisfied by the
  // time it's checked, purely from the microseconds of code executed
  // between computing `deadline` and reaching this check. Every SUBSEQUENT
  // attempt, however, only ever happens after this waiter has already gone
  // through at least one non-reclaimed EEXIST + deadline-check + sleep
  // cycle below — exactly the retry this finding is about.
  let firstAttempt = true;

  for (;;) {
    try {
      // Atomik: hedef zaten varsa bu satır EEXIST ile başarısız olur —
      // "var mı diye kontrol et, sonra oluştur" arasında ASLA bir pencere
      // yoktur, çünkü ikisi tek bir syscall'dır.
      mkdirSync(lockDirPath);
      // P2 fix (37th independent review round, finding 10): the deadline
      // used to be rechecked ONLY on the EEXIST/failure branch below —
      // never here, on the SUCCESS branch. Codex's reproduction: a waiter
      // whose `pollIntervalMs`-long sleep (below) already carried it PAST
      // its own `deadline` would still reach this `mkdirSync()` call on the
      // next loop iteration; if the previous owner happened to release the
      // lock during that exact sleep window, this call would succeed and
      // the function would return a GENUINE lock to a caller whose timeout
      // had already, provably, elapsed — silently violating the caller's
      // own timeout budget. Fixed: a retry (never the very first attempt —
      // bkz. `firstAttempt` yukarıdaki fix notu) that only succeeds AFTER
      // the deadline has already passed is not treated as a valid
      // acquisition. Since `mkdirSync()` just succeeded, WE unambiguously
      // own this lock right now (no other process could have raced in
      // between) — so cleanup here is a direct, unconditional `rmSync`
      // (no token/ownership check needed or possible, since metadata
      // hasn't even been written yet), never `releaseFileLock()`'s
      // ownership-verified path, which exists for a DIFFERENT threat model
      // (another process may already believe it owns this same path).
      if (!firstAttempt && Date.now() >= deadline) {
        rmSync(lockDirPath, { recursive: true, force: true });
        throw new FileLockTimeoutError(lockDirPath, timeoutMs);
      }
      try {
        const meta: LockMeta = { pid: process.pid, token, acquiredAt: Date.now() };
        writeFileSync(metaPath, JSON.stringify(meta), "utf8");
      } catch {
        // En iyi çaba (best-effort): metadata yazılamasa bile kilidin
        // kendisi (dizin) zaten alınmıştır; sadece BİLİNMEYEN-sahip
        // stale tespiti dizin mtime'ına geri düşer.
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseFileLock(lockDirPath, metaPath, token);
      };
    } catch (err) {
      if (err instanceof FileLockTimeoutError) throw err;
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    firstAttempt = false;

    // Buraya SADECE EEXIST üzerinden ulaşılır. Reclaim denemesinin SONUCU
    // ne olursa olsun (başarılı, başarısız, kapı kaybedildi, sahip hâlâ
    // canlı) — bu satırdan SONRA, döngünün başına dönmeden ÖNCE, TEK VE
    // KOŞULSUZ bir zaman aşımı kontrolünden geçilir; hiçbir dal bunu
    // atlayamaz (bkz. yukarıdaki fonksiyon-seviyesi fix notu).
    const reclaimed = isLockStale(lockDirPath, metaPath, staleMs) ? tryReclaimStaleLock(lockDirPath, metaPath, staleMs) : false;

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new FileLockTimeoutError(lockDirPath, timeoutMs);
    }

    if (!reclaimed) {
      // Reclaim GERÇEKTEN başarılı olmadıysa (uygulanamadı, kapı
      // kaybedildi, sahip hâlâ canlı, YA DA kaldırma başarısız oldu) HER
      // ZAMAN uyu — asla sıkı (busy) döngüye girme. Reclaim GERÇEKTEN
      // başarılıysa (dizin kanıtlanmış şekilde boşaltıldıysa) uyku
      // atlanır — gecikmesiz yeniden deneme meşru bir ilerlemedir.
      //
      // P2 fix (37th independent review round, finding 10, "sleep duration
      // must never exceed remaining timeout"): this used to be an
      // unconditional `sleepSync(pollIntervalMs)` — when the remaining
      // budget (`remainingMs`) is SHORTER than a full poll interval (a
      // small `timeoutMs`, or several already-elapsed retries), sleeping
      // the full interval overshoots the deadline before it is ever
      // rechecked, needlessly widening the exact "stale timeout, lucky
      // late acquisition" window this fix closes above. Capped to whichever
      // is smaller — never sleeps past this waiter's own deadline.
      sleepSync(Math.min(pollIntervalMs, remainingMs));
    }
  }
}

/**
 * Yalnızca hâlâ BİZİM kilidimiz olduğu (token eşleşiyorsa) doğrulandıktan
 * SONRA kaldırır. Bu kontrol olmadan: bu kilit terk edilmiş sayılıp
 * BAŞKA bir process tarafından zaten ele geçirilmiş olabilir — token
 * kontrolü olmadan yapılacak koşulsuz bir kaldırma, o YENİ sahibin
 * kilidini silerdi, bu da iki process'in aynı anda kilidi tuttuğunu
 * SANMASINA (tam olarak önlenmesi gereken yarış durumu) yol açardı. Bu
 * kural hem NORMAL release() için hem de stale/ölü-sahip geri kazanımı
 * için AYNI şekilde geçerlidir (bkz. `tryReclaimStaleLock`'ın kendi
 * kimlik-doğrulamalı deseni).
 */
function releaseFileLock(lockDirPath: string, metaPath: string, token: string): void {
  const meta = readLockMeta(metaPath);
  if (!meta || meta.token !== token) {
    // Kilidimiz zaten stale sayılıp başka biri tarafından ele geçirilmiş
    // (ya da tamamen kaldırılmış) — kaldıracak hiçbir şeyimiz yok, ve
    // olası YENİ sahibin kilidine ASLA dokunulmamalı.
    return;
  }
  try {
    rmSync(lockDirPath, { recursive: true, force: true });
  } catch {
    // En iyi çaba: kaldırma bir eşzamanlı stale-reclaim ile yarışırsa,
    // bir sonraki alıcının kendi stale kontrolü durumu çözer.
  }
}
