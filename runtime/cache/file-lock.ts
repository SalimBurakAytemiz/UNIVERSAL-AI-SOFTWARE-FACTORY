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

function readLockMeta(metaPath: string): LockMeta | undefined {
  try {
    return JSON.parse(readFileSync(metaPath, "utf8")) as LockMeta;
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
 * Döndürülen `true`, kaldırmanın (silmenin) fiilen denendiği (ve
 * `lockDirPath`'in artık boş olması BEKLENDİĞİ) anlamına gelir — çağıran
 * döngü bu durumda HEMEN `mkdirSync(lockDirPath)`'i yeniden dener; `false`,
 * ya kapının kaybedildiği ya da son kontrolün kilidi artık stale
 * BULMADIĞI (canlı bir sahip tarafından meşru şekilde yenilendiği)
 * anlamına gelir — çağıran normal zaman aşımı/bekleme yoluna döner
 * (gereksiz sıkı döngüden -busy loop- kaçınmak için).
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
      // En iyi çaba: kaldırma başarısız olsa bile, çağıran döngü zaten
      // `mkdirSync`'i yeniden deneyip gerçek durumu gözlemleyecek.
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
 * `claimPath`'i atomik olarak (mkdirSync ile) alır. Zaten alınmışsa
 * (EEXIST), bu işaretin KENDİSİNİN de terk edilmiş olup olmadığını
 * (kendi `mtime`'ı üzerinden, `staleMs` ile) kontrol eder — meşru bir
 * reclaim işlemi bir avuç senkron syscall'dan oluşup neredeyse anında
 * bittiğinden, bu işaretin `staleMs`'den daha uzun süredir açık kalması,
 * onu ALAN process'in reclaim SIRASINDA çökmüş olduğunu gösterir; bu
 * durumda işaret zorla temizlenip yeniden denenir — aksi halde çökmüş bir
 * reclaim'in yarım kalan kapı işareti, bu `lockDirPath`'in SONSUZA DEK bir
 * daha asla geri kazanılamamasına (kalıcı kilitlenme) yol açardı.
 */
function acquireReclaimGate(claimPath: string, staleMs: number): boolean {
  try {
    mkdirSync(claimPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    try {
      const stat = statSync(claimPath);
      if (Date.now() - stat.mtimeMs <= staleMs) {
        return false;
      }
    } catch {
      return false;
    }
    try {
      rmSync(claimPath, { recursive: true, force: true });
    } catch {
      return false;
    }
    try {
      mkdirSync(claimPath);
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
 * Bilinen, kasıtlı sınırlama (P0 kapsamı): sahiplik kimliği yalnızca PID +
 * rastgele bir token ile belirlenir; işletim sisteminin PID'leri yeniden
 * kullanabilmesi (PID reuse) teorik olarak ÇOK dar bir pencerede yanlış-
 * pozitif bir "canlı" sonucuna yol açabilir (bir process ölür, aynı PID
 * neredeyse anında BAŞKA bir process'e atanır). Process başlangıç
 * zaman damgasını taşınabilir (Windows dahil), ek bağımlılık gerektirmeyen
 * bir şekilde okumanın standart bir yolu yoktur (`/proc` yalnızca Linux'a
 * özgüdür ve "gereksiz platforma özgü varsayım eklenmeyecek" ilkesini
 * ihlal eder) — bu yüzden bilinçli olarak eklenmemiştir.
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
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (isLockStale(lockDirPath, metaPath, staleMs) && tryReclaimStaleLock(lockDirPath, metaPath, staleMs)) {
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
