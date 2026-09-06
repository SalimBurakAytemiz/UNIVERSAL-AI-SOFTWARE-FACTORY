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
   * How old an unreleased lock must be (or, independent of age, whether
   * its owning PID is provably no longer alive) before it is considered
   * abandoned and safe to reclaim.
   */
  readonly staleMs?: number;
  readonly pollIntervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 15;

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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: process exists but we lack permission to signal it — still
    // alive. Anything else (ESRCH included) means it is genuinely gone.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockMeta(metaPath: string): LockMeta | undefined {
  try {
    return JSON.parse(readFileSync(metaPath, "utf8")) as LockMeta;
  } catch {
    return undefined;
  }
}

/**
 * Bir kilidin TERK EDİLMİŞ (stale) sayılıp sayılmayacağına karar verir.
 * İki bağımsız yol vardır: (1) sahibi olan PID artık HİÇ YAŞAMIYORSA
 * (bkz. `isProcessAlive`) — bu durumda `staleMs` kadar beklemeye HİÇ
 * gerek yoktur, çökmüş bir process asla kilidi serbest bırakamayacağı
 * için sonsuz kilitlenmeyi (deadlock) önler; (2) kilit, PID hâlâ
 * yaşıyor olsa bile `staleMs`'den daha uzun süredir açık kalmışsa.
 * Metadata dosyası okunamazsa (yarış/bozulma), dizinin kendi
 * `mtime`'ına geri düşülür; dizin de hiç yoksa (bu sırada serbest
 * bırakılmış), "stale değil" döner — çağıran döngü zaten `mkdirSync`'i
 * yeniden deneyecek ve bu durumda doğrudan başarılı olacaktır.
 */
function isLockStale(lockDirPath: string, metaPath: string, staleMs: number): boolean {
  const meta = readLockMeta(metaPath);
  if (meta && !isProcessAlive(meta.pid)) {
    return true;
  }
  if (meta) {
    return Date.now() - meta.acquiredAt > staleMs;
  }
  try {
    const stat = statSync(lockDirPath);
    return Date.now() - stat.mtimeMs > staleMs;
  } catch {
    return false;
  }
}

/**
 * `lockDirPath`'te process'ler-arası bir kilit alır ve bir `release()`
 * geri çağırımı döndürür. Aşırı yüklenme (contention) altında `timeoutMs`
 * kadar bekler; bu sürede terk edilmiş bir kilit tespit edilirse (bkz.
 * `isLockStale`) onu ZORLA temizler ve HEMEN yeniden dener (çökmüş bir
 * sahip asla kalıcı bir kilitlenmeye yol açmaz).
 */
export function acquireFileLock(lockDirPath: string, options: FileLockOptions = {}): () => void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const metaPath = join(lockDirPath, "owner.json");
  const token = randomBytes(8).toString("hex");
  const deadline = Date.now() + timeoutMs;

  mkdirSync(dirname(lockDirPath), { recursive: true });

  for (;;) {
    try {
      // Atomik: hedef zaten varsa bu satır EEXIST ile başarısız olur —
      // "var mı diye kontrol et, sonra oluştur" arasında ASLA bir pencere
      // yoktur, çünkü ikisi tek bir syscall'dır.
      mkdirSync(lockDirPath);
      try {
        const meta: LockMeta = { pid: process.pid, token, acquiredAt: Date.now() };
        writeFileSync(metaPath, JSON.stringify(meta), "utf8");
      } catch {
        // En iyi çaba (best-effort): metadata yazılamasa bile kilidin
        // kendisi (dizin) zaten alınmıştır; sadece yaş-tabanlı stale
        // tespiti dizin mtime'ına geri düşer.
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseFileLock(lockDirPath, metaPath, token);
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (isLockStale(lockDirPath, metaPath, staleMs)) {
        try {
          rmSync(lockDirPath, { recursive: true, force: true });
        } catch {
          // Başka bir process aynı temizliği yarışarak yapıyor olabilir
          // — sorun değil, döngü başa dönüp yeniden dener.
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new FileLockTimeoutError(lockDirPath, timeoutMs);
      }
      sleepSync(pollIntervalMs);
    }
  }
}

/**
 * Yalnızca hâlâ BİZİM kilidimiz olduğu (token eşleşiyorsa) doğrulandıktan
 * SONRA kaldırır. Bu kontrol olmadan: bu kilit terk edilmiş sayılıp
 * BAŞKA bir process tarafından zaten ele geçirilmiş olabilir — token
 * kontrolü olmadan yapılacak koşulsuz bir kaldırma, o YENİ sahibin
 * kilidini silerdi, bu da iki process'in aynı anda kilidi tuttuğunu
 * SANMASINA (tam olarak önlenmesi gereken yarış durumu) yol açardı.
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
