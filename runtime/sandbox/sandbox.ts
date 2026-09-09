// Baseline section 87 (Sandbox): yol sınırlama (path confinement) ve
// zaman aşımı (timeout) kontrolleri. Bu, bir ajanın "proje kökü dışına"
// (örn. `../../etc/passwd`) çıkarak dosya okuyup yazmasını veya bir işlemi
// sonsuza kadar çalışır bırakmasını engelleyen minimum korumadır.

import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

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
 * `relativePath` (`path.relative(root, target)`'in sonucu) `root`'un
 * KENDİSİNİ veya GERÇEK bir ALT YOLUNU mu ifade ediyor, saf/platform
 * bağımsız bir yardımcı olarak karar verir.
 *
 * P2 fix (15th independent review round, "filesystem root containment
 * incorrectly rejects valid descendants"): eskiden `assertWithinRoot()`
 * SAF BİR ÖN EK (prefix) testi kullanıyordu —
 * `!resolvedTarget.startsWith(resolvedRoot + sep)`. `resolvedRoot`
 * ZATEN bir dosya sistemi kökü ise (POSIX'te `/`, Windows'ta `C:\\`),
 * `resolvedRoot + sep` bu ayırıcıyı İKİNCİ KEZ ekler
 * (`"/" + "/" = "//"`), ve HİÇBİR gerçek alt yol (ör. `/tmp`) bu ÇİFT
 * ayırıcılı önekle asla eşleşmez — `assertWithinRoot("/", "/tmp")` GEÇERLİ
 * bir soy olduğu halde yanlışlıkla `PathEscapeError` fırlatırdı. Kök
 * neden, ÖN EK BİRLEŞTİRMENİN kendisiydi, sadece bir kenar durumu değil.
 * Fix: artık `path.relative(root, target)`'in SONUCU üzerinde akıl
 * yürütülüyor — bu, ne `root`'un KENDİSİ bir dosya sistemi kökü olsun ne
 * olmasın, DOĞRU (relative path semantics), platformun (`node:path`'in
 * çalıştığı GERÇEK işletim sistemine göre otomatik POSIX/Windows seçen)
 * KENDİ ayırıcı/mutlaklık kurallarını izler. `isContainedRelativePath`
 * saf bir işlev olarak dışa aktarılır ki hem GERÇEK çalışma zamanı
 * platformunun (`node:path`) davranışı hem de Windows'un KENDİ
 * semantiği (`path.win32` ile beslenerek, bir POSIX CI makinesinde bile)
 * doğrudan test edilebilsin.
 *
 * Karar mantığı:
 *  - `relativePath === ""` -> `target` `root`'un TAM OLARAK KENDİSİ (kabul).
 *  - `relativePath === ".."` veya `".." + sep` ile BAŞLIYORSA -> `target`
 *    `root`'un DIŞINA çıkıyor (ör. bir üst dizin, bir kardeş dizin, ya da
 *    `/safe` vs `/safe-evil` gibi bir ÖN EK ÇAKIŞMASI — `path.relative`
 *    bunların HEPSİNİ doğal olarak `".." + ...`  ile ifade eder, elle
 *    kontrol edilen bir ayırıcı birleştirmesine asla ihtiyaç duymadan).
 *  - `relativePath` MUTLAK bir yolsa (`path.isAbsolute`) -> `root` ile
 *    `target` arasında GÖRECELİ olarak ifade edilebilecek ortak bir temel
 *    yok demektir (ör. Windows'ta farklı sürücü harfleri, `C:\\` vs
 *    `D:\\foo` — `path.win32.relative` bu durumda `to` yolunu OLDUĞU GİBİ,
 *    yani mutlak olarak döndürür) -> reddedilir.
 *  - Bunların HİÇBİRİ değilse -> gerçek, göreli bir alt yoldur (kabul).
 */
export function isContainedRelativePath(
  relativePath: string,
  pathOps: { readonly sep: string; readonly isAbsolute: (p: string) => boolean } = { sep, isAbsolute }
): boolean {
  if (relativePath === "") return true;
  if (relativePath === "..") return false;
  if (relativePath.startsWith(`..${pathOps.sep}`)) return false;
  if (pathOps.isAbsolute(relativePath)) return false;
  return true;
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

  if (!isContainedRelativePath(relative(resolvedRoot, resolvedTarget))) {
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

  // P1 fix (7th independent review round, "static hard-link aliases permit
  // cross-project overwrites"): yukarıdaki kontrol, TEK bir dizin girdisinin
  // BAŞKA bir konuma yönlendirilmesini (symlink/junction) yakalar — ama bir
  // SABİT BAĞ (hard link) hiçbir yere "yönlendirmez". İki hard-linked yol,
  // AYNI inode'u işaret eden, birbirinden BAĞIMSIZ iki dizin girdisidir; her
  // biri `realpathSync` ile KENDİSİNE çözülür (hiçbir çözümleme farkı
  // oluşmaz), bu yüzden yukarıdaki sözdizimsel-karşı-gerçek göreli yol
  // eşitliği testi bunu YAPISAL OLARAK yakalayamaz. Bu, ayrı ve tamamen
  // orthogonal bir kontrol gerektirir — bkz. assertNoHardLinkAlias().
  assertNoHardLinkAlias(resolvedTarget);

  return resolvedTarget;
}

export class HardLinkAliasError extends Error {
  constructor(target: string, nlink: number) {
    super(
      `Refusing to write through '${target}': it already exists as a regular file with ` +
        `${nlink} hard link(s) (nlink > 1). A multiply-linked file has no single, ` +
        `distinguishable owner path — it may be a static filesystem alias for another ` +
        `project's authoritative file, and (unlike a symlink) there is no "resolve target" ` +
        `to compare against the sandbox root. Exclusive ownership of this destination cannot ` +
        `be proven, so the write is rejected (fail closed, baseline section 87).`
    );
    this.name = "HardLinkAliasError";
  }
}

/**
 * Bir hedef dosyanın (varsa) BEKLENMEDİK ek sabit bağlara (hard link) sahip
 * OLMADIĞINI doğrular. Yalnızca ZATEN VAR OLAN, SIRADAN (regular) dosyalar
 * için anlamlıdır:
 *  - Hedef henüz yoksa (`lstatSync` başarısız olur), henüz hiçbir inode
 *    paylaşımı yoktur — güvenle yazılabilir; bu fonksiyon sessizce döner
 *    (canonicalizeNearestExisting zaten "henüz yok" durumunu doğru ele alır).
 *  - Hedef bir dizin ise, POSIX'te dizinler için sabit bağ oluşturulamaz
 *    (yalnızca `.`/`..` kendi kendine referanslardır) — bu kontrolün kapsamı
 *    dışındadır.
 *  - Hedef sıradan bir dosya İSE ve `nlink > 1` ise: bu dosya sistemindeki
 *    BAŞKA bir dizin girdisi de AYNI inode'u paylaşıyor demektir. Bu Factory
 *    kernel'i tarafından yönetilen dosyalar (`genome.json`, `organization.json`
 *    vb.) normal koşullarda HER ZAMAN `nlink === 1` ile yaratılır
 *    (`fs.writeFileSync` sıradan bir dosya oluşturur, sabit bağ değil); bu
 *    yüzden `nlink > 1` görmek MEŞRU bir kullanım senaryosunda BEKLENMEZ —
 *    yalnızca önceden yerleştirilmiş kötü niyetli (veya yanlışlıkla oluşmuş)
 *    bir sabit bağın işaretidir. Emin olunamayan (proven değil) bir durumda
 *    fail-closed davranılır: yazma reddedilir.
 *
 * DÜRÜSTÇE BELGELENEN PLATFORM SINIRLAMASI: `Stats.nlink`, TÜM platformlarda/
 * dosya sistemlerinde güvenilir biçimde raporlanmayabilir (ör. bazı FAT/exFAT
 * bağlamalarında veya belirli sanallaştırılmış/ağ dosya sistemlerinde her
 * zaman `1` dönebilir, hard link'in varlığına rağmen). Bu durumda bu kontrol
 * SESSİZCE hiçbir şey YAKALAYAMAZ — ancak platform `nlink`'i DOĞRU
 * raporladığında (Linux/macOS ext4/APFS/HFS+ gibi yaygın POSIX dosya
 * sistemlerinde olduğu gibi), `nlink > 1` ASLA görmezden gelinmez. Bu, var
 * olan symlink/dangling/parent/nested/canonical-root korumalarını ZAYIFLATMAZ
 * — bunlara EK, orthogonal bir kontroldür.
 */
function assertNoHardLinkAlias(target: string): void {
  let stat;
  try {
    stat = lstatSync(target);
  } catch {
    return; // henüz yok — paylaşılan bir inode olamaz, güvenle yaratılabilir
  }

  if (!stat.isFile()) {
    return; // dizinler/symlink'ler bu kontrolün kapsamı dışında (POSIX'te dizinler hard-link'lenemez)
  }

  if (stat.nlink > 1) {
    throw new HardLinkAliasError(target, stat.nlink);
  }
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
 * P2 fix (34th independent review round, finding 12, "reject non-finite
 * sandbox timeout values"): `withTimeout()` used to pass `ms` straight
 * into `Date.now() + ms` (the `deadlineAt` authoritative deadline the 32nd
 * round's own event-loop-starvation fix, above, relies on) and into
 * `setTimeout(fn, ms)`, with no validation at all. A `NaN` `ms` produces
 * `deadlineAt: NaN` — since ANY comparison against `NaN` is `false`,
 * `Date.now() >= deadlineAt` can NEVER be true, silently DISABLING that
 * exact 32nd-round protection (the fallback timer, which Node clamps a
 * NaN delay to ~1ms, still eventually fires — but the authoritative clock
 * check this file added specifically to NOT depend on that timer having
 * run yet is defeated). An `Infinity` `ms` produces `deadlineAt: Infinity`
 * — the same "this comparison can never be true" defeat — while Node
 * additionally clamps the underlying `setTimeout` delay itself to its own
 * ~24.8-day (2^31-1 ms) maximum, silently returning a WILDLY different
 * effective timeout than what the caller believes it configured. A
 * negative `ms` produces an ALREADY-PAST `deadlineAt`, making the very
 * first deadline check after `operation` starts declare a timeout
 * regardless of how fast the operation genuinely completes — distorting
 * enforcement in the other direction. Fixed: `ms` is validated BEFORE any
 * timer/deadline calculation runs at all — finite, nonnegative, and within
 * Node's own supported `setTimeout` delay range (beyond which Node itself
 * silently clamps rather than honoring the requested delay), or this
 * function fails closed immediately, before `operation` is ever invoked.
 */
const MAX_SANDBOX_TIMEOUT_MS = 2_147_483_647; // Node's setTimeout delay limit (2^31 - 1 ms, ~24.8 days) — beyond this Node silently clamps instead of honoring the requested delay.

export class InvalidSandboxTimeoutError extends Error {
  constructor(ms: number) {
    super(
      `Invalid sandbox timeout '${String(ms)}': must be a finite, nonnegative number of milliseconds no greater ` +
        `than ${MAX_SANDBOX_TIMEOUT_MS} (Node's own setTimeout delay limit). NaN, Infinity, -Infinity, and ` +
        `negative values are rejected outright rather than silently disabling the event-loop-starvation deadline ` +
        `check this file's 32nd independent review round fix relies on, or distorting timeout enforcement.`
    );
    this.name = "InvalidSandboxTimeoutError";
  }
}

/**
 * P1 fix (27th independent review round, finding 9, "timeout must
 * actually cancel sandbox work"): `withTimeout` used to accept an
 * ALREADY-STARTED, opaque `Promise<T>` and race it against a timer via
 * `Promise.race()`. `Promise.race()` only ever stops THIS function from
 * WAITING on the loser — it has no way to reach into an arbitrary Promise
 * and stop whatever produced it. Codex reproduced exactly this: a
 * "timed-out" filesystem write, network call, or spawned process kept
 * running to completion in the background, fully unobserved, after
 * `withTimeout` had already told its caller the operation was over —
 * every side effect that operation was ever going to have (writing a
 * file, calling an external service, spending real provider cost) still
 * happened, just silently, with nobody watching for it and no way to
 * undo it. Bölüm 87's "bir işlemi sonsuza kadar çalışır bırakmasını
 * engelleyen minimum koruma" promise was therefore never actually kept —
 * it only ever protected the CALLER's own wait, never the sandboxed work
 * itself.
 *
 * Fixed by changing the contract entirely, rather than pretending an
 * arbitrary already-running `Promise<T>` can be retrofitted with
 * cancellation (it structurally cannot — JS Promises have no `cancel()`):
 * `withTimeout` now takes an `operation` FACTORY, `(signal: AbortSignal)
 * => Promise<T>`, and constructs its own `AbortController` internally.
 * The factory is only ever invoked WITH that controller's `signal`
 * already in hand, before any work starts — so a genuinely cancellable
 * operation (anything built on Node's `AbortSignal` support: `fs/promises`
 * calls accepting `{ signal }`, `fetch()`, `child_process.spawn(..., {
 * signal })`, or code that manually checks `signal.aborted`/listens for
 * `"abort"`) can ACTUALLY stop the underlying work — not merely stop this
 * function from waiting on it — the instant the deadline is reached.
 * `withTimeout` calls `controller.abort()` when the timer fires and then
 * `await`s the SAME `operation(...)` promise directly (never a
 * `Promise.race` against a second, independent timer promise) — so this
 * function does not return control to ITS OWN caller until the real
 * operation has genuinely settled (whether normally, or via the abort it
 * was just asked to honor). A `SandboxTimeoutError` is thrown only once
 * that settlement has actually happened, so "timeout" here always means
 * "the operation is over," never "we simply stopped listening for it."
 *
 * This deliberately does NOT retrofit cancellation onto a plain,
 * non-cooperative Promise — bölüm 87 çözümü budur: yapısal olarak
 * iptal edilemeyen keyfi bir Promise'i iptal edilebilirmiş gibi
 * GÖSTERMEK yerine, iptal edilebilirliği çağıranın sorumluluğuna açıkça
 * taşımak (operation'ın `signal`'i GERÇEKTEN kullanması gerekir) —
 * "Do NOT pretend arbitrary Promises are cancellable." An `operation`
 * that ignores its `signal` entirely will, as before this fix and as
 * inherent to JavaScript itself, keep running in the background — the
 * difference is that `withTimeout` no longer LIES about that by
 * returning early anyway; it keeps waiting for the real settlement rather
 * than reporting a termination that never happened.
 */
/**
 * P1 fix (32nd independent review round, finding 3, "enforce timeout
 * against the actual deadline"): `timedOut` used to be set ONLY inside the
 * `setTimeout` callback below — a MACROTASK that Node's event loop can only
 * run once it is free. Codex reproduced: if `operation`'s own work
 * synchronously blocks the event loop PAST `ms` (e.g. a tight CPU-bound
 * loop, or any synchronous call that takes longer than the timeout) and
 * THEN settles, the `await operation(...)` continuation resumes as a
 * MICROTASK — which Node always fully drains BEFORE advancing to the next
 * macrotask phase (where the overdue `setTimeout` callback is still
 * waiting). That ordering means this function's own resolve/reject
 * handling below could run and read `timedOut` as still `false` — genuinely
 * PAST the real deadline in wall-clock terms — and return the operation's
 * result as a success, even though bölüm 87's whole promise is that an
 * operation can never be allowed to run (or be reported as having
 * succeeded) past its budgeted time. The bug was trusting a FLAG that only
 * a delayed timer callback could set, rather than the actual elapsed time.
 * Fixed: `deadlineAt` captures the authoritative wall-clock deadline
 * (`Date.now() + ms`) BEFORE `operation` is ever invoked, and both the
 * resolve and reject paths below compare `Date.now()` against it directly
 * — independently of whether the `setTimeout` callback has had a chance to
 * run yet. `timedOut` (still set by the timer, and still what triggers the
 * actual `controller.abort()` for a cooperative operation) is now only ONE
 * of two ways this function can conclude "the deadline was exceeded" — the
 * OTHER is a fresh, trusted clock read taken at the moment of settlement,
 * which cannot be starved by event-loop congestion the way a pending timer
 * callback can. A genuinely cancellable operation that honors `signal`
 * still settles (via the abort) at essentially the same moment `timedOut`
 * flips, so this changes nothing for the cooperative case already covered
 * by the 27th/28th round fixes above — this closes ONLY the non-cooperative,
 * event-loop-starvation gap the flag-only check could not see.
 */
export async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  // P2 fix (34th independent review round, finding 12): validated BEFORE
  // any timer/deadline calculation runs, and before `operation` is ever
  // invoked — bkz. `InvalidSandboxTimeoutError`'ın fix notu.
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_SANDBOX_TIMEOUT_MS) {
    throw new InvalidSandboxTimeoutError(ms);
  }
  const controller = new AbortController();
  let timedOut = false;
  const deadlineAt = Date.now() + ms;
  const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
    timedOut = true;
    controller.abort(new SandboxTimeoutError(ms));
  }, ms);

  try {
    const value = await operation(controller.signal);
    // P1 fix (28th independent review round, finding 3, "preserve timeout
    // failure after deadline"): this check used to exist ONLY in the
    // `catch` block below — an `operation` that ignores its `signal`
    // (never honors cancellation) and eventually RESOLVES successfully,
    // even after the deadline already fired and `timedOut` was already
    // `true`, used to have that late success value returned here
    // completely UNCHECKED, silently overwriting the timeout outcome the
    // caller was entitled to see. Once the deadline is exceeded, that
    // outcome is authoritative and must never be overwritten by whatever
    // the operation eventually does — a late resolve is treated exactly
    // like a late reject (below): both throw `SandboxTimeoutError`,
    // never silently returning a value produced after the caller was
    // already told "this timed out." A genuinely cancellable operation
    // (one that honors `signal`) never reaches this branch in the first
    // place, since it settles (by rejecting via the abort) before or at
    // the same moment `timedOut` is set — this branch exists specifically
    // for the non-cooperative case this function has always documented it
    // cannot force-cancel.
    //
    // P1 fix (32nd independent review round, finding 3): `timedOut` alone
    // is no longer trusted here — bkz. bu fonksiyonun üstündeki fix notu —
    // `Date.now() >= deadlineAt` independently catches the case where the
    // deadline has genuinely already passed but the timer callback simply
    // has not run yet (event-loop starvation by the operation's own
    // synchronous work).
    if (timedOut || Date.now() >= deadlineAt) {
      throw new SandboxTimeoutError(ms);
    }
    return value;
  } catch (err) {
    // The operation settled (rejected) as a DIRECT, observed consequence
    // of the abort this function itself issued — genuine termination, not
    // abandoned waiting. Any OTHER rejection (the operation failing for
    // its own, unrelated reasons) is never masked as a timeout, UNLESS the
    // deadline had already passed by the time it rejected — in which case
    // the timeout outcome is still authoritative (same reasoning as the
    // resolve path above): whatever caused the rejection happened only
    // because the operation kept running past a deadline that was already
    // exceeded, so it is reported as the timeout it genuinely is.
    //
    // P1 fix (32nd independent review round, finding 3): same authoritative
    // clock check as the resolve path above — a synchronous, event-loop-
    // starving `operation` that eventually REJECTS past its real deadline
    // (rather than resolving) must be reported as a timeout too, even if
    // the timer callback itself has not yet run.
    if (timedOut || Date.now() >= deadlineAt) {
      throw new SandboxTimeoutError(ms);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
