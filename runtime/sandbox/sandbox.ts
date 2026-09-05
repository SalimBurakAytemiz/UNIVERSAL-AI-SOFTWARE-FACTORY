// Baseline section 87 (Sandbox): yol sınırlama (path confinement) ve
// zaman aşımı (timeout) kontrolleri. Bu, bir ajanın "proje kökü dışına"
// (örn. `../../etc/passwd`) çıkarak dosya okuyup yazmasını veya bir işlemi
// sonsuza kadar çalışır bırakmasını engelleyen minimum korumadır.

import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";

export class PathEscapeError extends Error {
  constructor(root: string, target: string) {
    super(
      `Path '${target}' does not resolve to its own canonical, non-aliased location inside ` +
        `sandbox root '${root}' (either it escapes the root entirely, or a symlink/junction ` +
        `redirects it to a different location that merely happens to still be inside the root).`
    );
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
 * `path`'in en yakın VAR OLAN atasının GERÇEK (symlink'ler çözülmüş) halini
 * bulur ve henüz var olmayan kalan alt yolu (hiçbir zaman bir symlink
 * olamaz, çünkü henüz yaratılmadı) buna ekler.
 *
 * P1 fix (5th independent review round, "final-destination / dangling
 * symlink escape"): eskiden bu döngü `existsSync()` ile "bu seviyede bir
 * şey var mı?" sorusunu soruyordu. `existsSync()`, bir symlink'i ÇÖZER —
 * SARKAN (dangling, hedefi var olmayan) bir symlink için `existsSync`
 * `false` döner, tıpkı orada HİÇBİR ŞEY yokmuş gibi. Bu, gerçek bir
 * saldırı yüzeyiydi: `baseDir/proj` sarkan bir symlink ise (ör.
 * `/nowhere/outside`'a işaret ediyorsa), eski kod bunu "henüz
 * oluşturulmamış, güvenle yaratılabilir bir yol" sanıp üstüne atlıyor ve
 * `baseDir` içindeymiş gibi GEÇERLİ sayıyordu — oysa `fs.writeFileSync`
 * gibi bir işlem, sarkan bir symlink'in üzerine YAZARKEN o symlink'i
 * TAKİP EDER ve dosyayı symlink'in GERÇEKTE işaret ettiği (dışarıdaki)
 * konumda oluşturur. Artık her seviyede `lstatSync` kullanılır — bu,
 * symlink'i ÇÖZMEZ, yalnızca "bu TAM yolda bir dosya sistemi girdisi
 * (inode) var mı?" sorusuna cevap verir (var olsun ya da olmasın bir
 * symlink dahil). Bir girdi VARSA (gerçek dosya/klasör YA DA bir symlink,
 * sarkan olsun olmasın), `realpathSync` ile çözülmeye ÇALIŞILIR:
 * başarılıysa gerçek hedef kullanılır (var olan davranış); BAŞARISIZ
 * olursa (yalnızca sarkan bir symlink'te olur — lstat bir şey görüyor ama
 * stat/realpath hedefi bulamıyor) bu asla "henüz yok" ile karıştırılmaz —
 * doğrudan fail-closed (PathEscapeError) olunur.
 */
function canonicalizeNearestExisting(path: string): string {
  let current = path;
  const pendingSuffix: string[] = [];

  for (;;) {
    let exists = true;
    try {
      lstatSync(current); // symlink'i ÇÖZMEZ — sadece bu tam yolda bir girdi olup olmadığını söyler
    } catch {
      exists = false;
    }

    if (exists) {
      try {
        const real = realpathSync(current); // gerçek dosya/klasör YA DA çözülebilen bir symlink
        return pendingSuffix.length > 0 ? resolve(real, ...pendingSuffix) : real;
      } catch {
        // lstat bir girdi gördü ama realpath çözemedi -> SARKAN bir symlink.
        // Bu, "henüz yok, güvenle oluşturulabilir" ile ASLA eşdeğer değildir.
        throw new PathEscapeError(path, current);
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      // Dosya sisteminin köküne kadar hiçbir şey bulunamadı — gerçek
      // (canonical) bir temel olmadan güvenli bir karşılaştırma
      // yapılamaz; fail closed.
      throw new PathEscapeError(path, path);
    }
    pendingSuffix.unshift(basename(current));
    current = parent;
  }
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
 * BİLİNEN SINIRLAMA (dürüstçe belgelenir — 5th independent review round'da
 * netleştirildi): bu, "kontrol et sonra kullan" (TOCTOU) desenidir — bu
 * fonksiyonun döndüğü an ile çağıranın gerçek dosya sistemi mutasyonunu
 * yaptığı an arasında, bir yarış-koşulu bir symlink değiştirebilir. Node.js'in
 * taşınabilir (cross-platform) fs API'si atomik "sembolik bağları asla takip
 * etme" bayrakları (ör. Linux'a özgü openat2 RESOLVE_NO_SYMLINKS) sunmaz.
 *
 * Bu, YALNIZCA "kapsamı sınırlı, GÜVENİLİR (hostile olmayan) dosya sistemi
 * yazıcılarına sahip bir P0 prototipi" için kabul edilebilir bir kalıntı
 * risktir. Bu fonksiyon, DÜŞMANCA/EŞ ZAMANLI bir yazıcıya (ör. aynı ana
 * makinede çalışan, kötü niyetli, sürekli symlink değiştiren başka bir
 * süreç) karşı izolasyon SAĞLADIĞINI ASLA İDDİA ETMEZ — sağladığı garanti,
 * kontrol anında mevcut olan (var olan veya SARKAN/dangling) her türlü
 * symlink/junction yönlendirmesinin doğru şekilde tespit edilip
 * reddedilmesidir (yarış koşulu olmaksızın tekrarlanabilir kaçışlar
 * kapatılmıştır), atomik bir syscall garantisi değil.
 *
 * P1 fix (6th independent review round, "project-root alias permits
 * cross-project writes"): eskiden yalnızca "gerçek (resolved) hedef, hâlâ
 * root'un İÇİNDE mi?" kontrol ediliyordu (bir ÖN EK/prefix testi). Bu,
 * `baseDir/A` önceden VAR OLAN bir symlink olarak `baseDir/B`'ye işaret
 * ediyorsa YAKALAYAMAZDI — çünkü B de `baseDir` içinde olduğundan önek
 * testi geçerdi, ama proje A aslında proje B'nin GERÇEK dizinine
 * YAZIYORDU (kimlik takma adı / alias — hiçbir yarış koşulu gerekmeden,
 * kaçış "dışarı" değil "içeride başka bir yere" olduğu için). Artık
 * kontrol çok daha KATI: `root`'tan `target`'a olan GÖRECELİ yol
 * (sözdizimsel) ile `realRoot`'tan `realTarget`'a olan GÖRECELİ yol
 * (symlink'ler çözülmüş) TAM OLARAK AYNI olmalıdır. Yalnızca `root`'un
 * kendisinin (ör. `/tmp` -> `/private/tmp` gibi işletim sistemi düzeyinde,
 * zararsız) çözülmesine izin verilir — çağıranın EKLEDİĞİ alt yol
 * (projectId, alt klasör adı, dosya adı) symlink çözümlemesi sırasında
 * HİÇBİR ŞEKİLDE değişemez/yönlendirilemez. Bu, eski önek-tabanlı kontrolü
 * KATI BİR ÜST KÜMESİDİR (eşitlik sağlanıyorsa önek testi de otomatik
 * sağlanır), bu yüzden önceki tüm "dışarı kaçış" korumaları korunur.
 */
export function assertFilesystemConfinement(root: string, target: string): string {
  const resolvedRoot = resolve(root);
  const resolvedTarget = assertWithinRoot(root, target); // ucuz, sözdizimsel ön-kontrol (fail-fast)

  const realRoot = canonicalizeNearestExisting(resolvedRoot);
  const realTarget = canonicalizeNearestExisting(resolvedTarget);

  const lexicalRelative = relative(resolvedRoot, resolvedTarget);
  const realRelative = relative(realRoot, realTarget);

  if (lexicalRelative !== realRelative) {
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
