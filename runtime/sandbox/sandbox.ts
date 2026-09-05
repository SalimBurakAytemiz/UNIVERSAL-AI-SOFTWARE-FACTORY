// Baseline section 87 (Sandbox): yol sınırlama (path confinement) ve
// zaman aşımı (timeout) kontrolleri. Bu, bir ajanın "proje kökü dışına"
// (örn. `../../etc/passwd`) çıkarak dosya okuyup yazmasını veya bir işlemi
// sonsuza kadar çalışır bırakmasını engelleyen minimum korumadır.

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";

export class PathEscapeError extends Error {
  constructor(root: string, target: string) {
    super(`Path '${target}' resolves outside sandbox root '${root}'`);
    this.name = "PathEscapeError";
  }
}

/**
 * `target` (root'a göre veya mutlak) yolunun `root` dizini dışına
 * çıkmadığını doğrular ve çözümlenmiş mutlak yolu döndürür. `../` ile
 * kaçış girişimlerini engeller (path traversal koruması).
 *
 * ÖNEMLİ SINIRLAMA: bu yalnızca SÖZDİZİMSEL (lexical) bir kontroldür —
 * `path.resolve`, sembolik bağları (symlink) ASLA takip etmez. `root`
 * içindeki bir dizin girdisi gerçekte `root` dışına işaret eden bir
 * symlink ise, bu fonksiyon bunu YAKALAYAMAZ (baseline section 87'nin
 * kendisi de bunu ayrı bir tehdit olarak tanımlar). Gerçek bir dosya
 * sistemi mutasyonundan önce bu TEK BAŞINA yeterli değildir — bkz.
 * assertFilesystemConfinement() aşağıda.
 */
export function assertWithinRoot(root: string, target: string): string {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(root, target);

  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + sep)) {
    throw new PathEscapeError(resolvedRoot, target);
  }
  return resolvedTarget;
}

/**
 * `path`'in en yakın VAR OLAN atasının GERÇEK (symlink'ler çözülmüş)
 * halini bulur ve henüz var olmayan kalan alt yolu (hiçbir zaman bir
 * symlink olamaz, çünkü henüz yaratılmadı) buna ekler. `path`'in kendisi
 * zaten varsa (bir symlink olsa bile), doğrudan onun gerçek karşılığını
 * döndürür — `realpathSync` sembolik bağ zincirlerini (iç içe olanlar
 * dahil) tam olarak çözer.
 */
function canonicalizeNearestExisting(path: string): string {
  let ancestor = path;
  const pendingSuffix: string[] = [];

  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      // Dosya sisteminin köküne kadar hiçbir şey bulunamadı — gerçek
      // (canonical) bir temel olmadan güvenli bir karşılaştırma
      // yapılamaz; fail closed.
      throw new PathEscapeError(path, path);
    }
    pendingSuffix.unshift(basename(ancestor));
    ancestor = parent;
  }

  const realAncestor = realpathSync(ancestor);
  return pendingSuffix.length > 0 ? resolve(realAncestor, ...pendingSuffix) : realAncestor;
}

/**
 * GERÇEK dosya sistemi farkındalıklı sınırlama kontrolü (bölüm 87).
 * `assertWithinRoot`'un aksine, `root` VEYA `target` yolundaki herhangi
 * bir bileşen (ya da henüz var olmayan `target`'ın en yakın var olan
 * atası) bir symlink/junction ise, bunu GERÇEK (çözülmüş) hedefine göre
 * değerlendirir — bir saldırganın `baseDir` içine `root` dışına işaret
 * eden bir symlink yerleştirip scaffold'u kandırmasını engeller.
 *
 * Akış: root -> en yakın var olan atasını bul -> realpath ile çöz ->
 * aynısını target için yap -> gerçek target, gerçek root içinde mi diye
 * doğrula (sözdizimsel assertWithinRoot ile AYNI mantık, ama gerçek
 * yollar üzerinde) -> geçerse SÖZDİZİMSEL çözülmüş (henüz oluşturulmamış)
 * yolu döndürür (çağıran, doğrulanmış olan bu yol altında güvenle
 * mkdir/write yapabilir).
 *
 * BİLİNEN SINIRLAMA (dürüstçe belgelenir): bu, "kontrol et sonra kullan"
 * (TOCTOU) desenidir — bu fonksiyonun döndüğü an ile çağıranın gerçek
 * dosya sistemi mutasyonunu yaptığı an arasında, teorik olarak bir
 * yarış-koşulu saldırganı bir symlink değiştirebilir. Node.js'in taşınabilir
 * (cross-platform) fs API'si atomik "sembolik bağları asla takip etme"
 * bayrakları (ör. Linux'a özgü openat2 RESOLVE_NO_SYMLINKS) sunmaz; P0
 * kapsamında bu kabul edilen bir kalıntı risktir, gizlenmemiştir.
 */
export function assertFilesystemConfinement(root: string, target: string): string {
  const resolvedTarget = assertWithinRoot(root, target); // ucuz, sözdizimsel ön-kontrol (fail-fast)

  const realRoot = canonicalizeNearestExisting(resolve(root));
  const realTarget = canonicalizeNearestExisting(resolvedTarget);

  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
    throw new PathEscapeError(realRoot, target);
  }

  return resolvedTarget;
}

export class InvalidProjectIdError extends Error {
  constructor(id: string, reason: string) {
    super(
      `Invalid project id '${id}': ${reason}. Project ids must match ${PROJECT_ID_PATTERN} ` +
        `(letters, digits, hyphen, underscore; must start with a letter or digit) — baseline ` +
        `section 87 (Sandbox / path confinement).`
    );
    this.name = "InvalidProjectIdError";
  }
}

const PROJECT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/**
 * Bir proje kimliğinin dosya sistemi yolu olarak GÜVENLİ olduğunu
 * doğrular. Bu, path-confinement kontrolünün (assertWithinRoot) YERİNE
 * geçmez — onunla BİRLİKTE, ilk savunma katmanı olarak çalışır: `..`, `.`,
 * `/`, `\`, mutlak yollar, boş kimlikler ve kodlanmış (`%2e%2e` gibi)
 * varyantlar dahil hiçbir güvensiz karakter dizisi bu deseni geçemez —
 * yalnızca harf/rakam ile başlayan, harf/rakam/tire/alt çizgiden oluşan
 * kimlikler kabul edilir (fail closed, bölüm 87).
 */
export function assertValidProjectId(id: string): void {
  if (typeof id !== "string" || id.length === 0) {
    throw new InvalidProjectIdError(String(id), "must be a non-empty string");
  }
  if (!PROJECT_ID_PATTERN.test(id)) {
    throw new InvalidProjectIdError(
      id,
      "must contain only letters, digits, hyphens, and underscores, and start with a letter or digit"
    );
  }
}

export class SandboxTimeoutError extends Error {
  constructor(ms: number) {
    super(`Operation exceeded sandbox timeout of ${ms}ms`);
    this.name = "SandboxTimeoutError";
  }
}

/**
 * Verilen promise, `ms` milisaniye içinde tamamlanmazsa
 * SandboxTimeoutError ile reddedilir. Sonsuz döngüye giren veya asılı
 * kalan bir işlemi kalıcı olarak kaynak tüketmekten alıkoyar (bölüm 87).
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SandboxTimeoutError(ms)), ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
