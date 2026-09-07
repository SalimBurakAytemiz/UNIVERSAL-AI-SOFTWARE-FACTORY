// Baseline section 69 (Cost Engine): her görev/ajan/model/sağlayıcı
// çağrısının maliyeti izlenir. "Sessiz harcama yok" ilkesi (bölüm 147)
// burada başlar — bir tutar bu motora kaydedilmeden harcanmış sayılmaz.

import { freezeRecord } from "../util/immutable.js";

export class InvalidMonetaryAmountError extends Error {
  constructor(context: string, amount: number) {
    super(
      `Invalid monetary amount in ${context}: ${amount}. Amounts must be finite and ` +
        `non-negative — NaN, Infinity, -Infinity, and negative values are all rejected. ` +
        `A negative amount is not a discount or refund; those require an explicitly ` +
        `modeled refund/credit operation, never a negative amountUsd.`
    );
    this.name = "InvalidMonetaryAmountError";
  }
}

/**
 * Para tutarlarının HER yerde (CostEngine.record, BudgetGuard) aynı
 * kuralla doğrulanması için tek kaynak: sonlu (finite) ve negatif olmayan
 * olmalıdır. NaN bir kez sızarsa toplamlar kalıcı olarak "zehirlenir"
 * (NaN + x = NaN) ve bütçe karşılaştırmaları (`NaN > limit` HER ZAMAN
 * false döner) sessizce geçer — bu yüzden hiçbir duruma dokunulmadan ÖNCE
 * reddedilir (fail closed).
 */
export function assertValidMonetaryAmount(amount: number, context: string): void {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new InvalidMonetaryAmountError(context, amount);
  }
}

/**
 * P2 fix (8th independent review round, "floating-point comparisons reject
 * exact budget spend"): Codex, `0.10` sonra `0.20` harcanıp $0.30'luk bir
 * tavana karşı kontrol edildiğinde, JavaScript'in ikili kayan noktalı
 * toplamasının `0.30000000000000004` ÜRETTİĞİNİ ve bu değerin `0.3`'ten
 * BÜYÜK olduğu için (`projected > limit`) TAM TAVAN harcamasının YANLIŞLIKLA
 * REDDEDİLDİĞİNİ gösterdi — bu, dört bütçe tavanının (perTaskUsd, perRunUsd,
 * dailyUsd, monthlyUsd) TAMAMINDA tekrarlanan aynı hatadır (runtime/budget/
 * budget.ts). Fix, RASGELE/dağınık bir epsilon DEĞİL — TEK, merkezi,
 * belgelenen bir hassasiyet POLİTİKASI kullanır: her tutar, karşılaştırmadan
 * ÖNCE `MONETARY_PRECISION_SCALE` (mikro-dolar, $0.000001 — hem sıradan
 * sent-düzeyi harcamayı GÜVENLE kapsar hem de token-başına milyonda birkaç
 * dolarlık model fiyatlandırması gibi daha ince taneli P0 fiyatlarını
 * bozmaz) ile TAM SAYI birimlere yuvarlanır (`Math.round`), ve karşılaştırma
 * bu İKİ TAM SAYI üzerinde yapılır — tam sayı karşılaştırması, kayan
 * noktalı birikim gürültüsünden (`0.1 + 0.2 !== 0.3` sınıfı) yapısal olarak
 * ETKİLENMEZ. Bu fonksiyon, dört bütçe tavanının HEPSİ için (ve gelecekte
 * eklenecek her kümülatif parasal karşılaştırma için) TEK kaynak olarak
 * kullanılmalıdır — her karşılaştırma noktasında ayrı ayrı icat edilen bir
 * epsilon/tolerans DEĞİL.
 */
export const MONETARY_PRECISION_SCALE = 1_000_000;

function toMonetaryUnits(amountUsd: number): number {
  return Math.round(amountUsd * MONETARY_PRECISION_SCALE);
}

/**
 * `a`'nın, Factory'nin sabit parasal hassasiyetinde (bkz.
 * `MONETARY_PRECISION_SCALE`) `b`'yi GERÇEKTEN aşıp aşmadığını döndürür —
 * TAM tavan harcaması (`a === b` niyetiyle) ikili kayan nokta gürültüsü
 * yüzünden asla yanlışlıkla `true` dönmez.
 */
export function exceedsMonetaryAmount(a: number, b: number): boolean {
  return toMonetaryUnits(a) > toMonetaryUnits(b);
}

export interface CostEntry {
  readonly taskId: string;
  readonly agentId?: string;
  readonly projectId?: string;
  readonly provider: string;
  readonly modelId: string;
  readonly amountUsd: number;
  readonly timestamp: string;
}

export interface CostScope {
  readonly taskId?: string;
  readonly agentId?: string;
  readonly projectId?: string;
}

/**
 * P1 fix (16th independent review round, "outstanding budget reservations
 * are not shared across guards using one cost ledger"): Codex reproduced
 * two `BudgetGuard` instances constructed over the SAME `CostEngine` —
 * each guard kept its OWN private `Map` of outstanding (not-yet-committed)
 * reservations, so a reservation opened by guard A was completely
 * invisible to guard B's own ceiling checks. Two concurrent $0.60
 * invocations, one authorized through EACH guard, both independently saw
 * "$0 reserved so far" and both succeeded against a shared $1.00
 * `perRunUsd` ceiling — $1.20 committed, the exact race the 10th round's
 * reservation model was supposed to make structurally impossible, just
 * reintroduced one layer up (across guards instead of within one guard).
 * `CostEngine` already WAS the single, shared source of truth for
 * COMMITTED spending (`record()`/`totalFor()`/`total()`/`totalInWindow()`)
 * — the fix is to make it the SAME authoritative source of truth for
 * OUTSTANDING reservations too, since it is the object every cooperating
 * `BudgetGuard` already shares by construction. `ReservationOwnership`
 * (moved here from `runtime/budget/budget.ts`, which now imports/
 * re-exports it for API stability) captures every ownership dimension a
 * reservation can carry — `CostScope`'s `taskId`/`agentId`/`projectId`
 * plus `provider`/`modelId` — exactly as before; only WHERE this state
 * lives has changed, not its shape or its ownership-validation semantics
 * (which remain entirely `BudgetGuard`'s responsibility — this ledger is
 * deliberately "dumb storage + aggregation," mirroring `record()`/
 * `totalFor()`'s own division of labor between mechanism (here) and
 * policy (`BudgetGuard`'s ceilings)).
 */
export interface ReservationOwnership extends CostScope {
  readonly provider?: string;
  readonly modelId?: string;
}

export type ReservationLedgerStatus = "ACTIVE" | "RECONCILIATION_FAILED";

export interface LedgerReservation {
  readonly id: string;
  readonly scope: Readonly<ReservationOwnership>;
  readonly amountUsd: number;
  readonly status: ReservationLedgerStatus;
}

/**
 * P1 fix (26th independent review round, finding 3, "reservation ownership
 * evidence must not be forgeable"): the diagnostic/read view of a
 * reservation returned by `getReservation()` — deliberately narrower than
 * `LedgerReservation`. It omits `scope` entirely; see the fix note above
 * `getReservation()` for why.
 */
export type ReservationView = Omit<LedgerReservation, "scope">;

export class UnknownReservationError extends Error {
  constructor(reservationId: string) {
    super(
      `No open reservation '${reservationId}' — it may have already been committed/released, ` +
        `or never existed. commit()/release() must be called at most once per reserve() call.`
    );
    this.name = "UnknownReservationError";
  }
}

/**
 * P1 fix (24th independent review round, "reservation deletion must not
 * bypass reconciliation"): moved here (from `runtime/budget/budget.ts`,
 * which now imports/re-exports it for API stability — same pattern as
 * `ReservationOwnership`'s 16th-round move) because the invariant it
 * protects — "a reservation whose commit() attempt failed after a
 * provider call may already have happened can NEVER be release()d" — must
 * hold regardless of WHICH caller is trying to remove the reservation, not
 * only when the removal happens to go through `BudgetGuard.release()`.
 * See `releaseReservation()`'s note below for the full fix rationale.
 */
export class UnresolvedReconciliationError extends Error {
  constructor(reservationId: string) {
    super(
      `Reservation '${reservationId}' has an UNRESOLVED reconciliation failure (a prior commit() ` +
        `attempt failed after the provider call may already have run) and cannot be release()d — ` +
        `release() is only for a reservation where NO cost was ever incurred. Retry commit() with a ` +
        `corrected amount on this same reservation id instead; that is the only safe path forward.`
    );
    this.name = "UnresolvedReconciliationError";
  }
}

/**
 * P1 fix (25th independent review round, "reservation ownership must be
 * validated inside CostEngine"): moved here (from `runtime/budget/
 * budget.ts`, which now imports/re-exports it for API stability — same
 * pattern as `UnknownReservationError`/`UnresolvedReconciliationError`'s
 * 24th-round move) because the invariant it protects — "a commit/release
 * can only ever act on the SAME ownership scope a reservation was
 * actually created under" — used to be enforced ONLY inside
 * `BudgetGuard.commit()`, one layer above `CostEngine.commitReservation()`/
 * `releaseReservation()`. Any caller holding a `CostEngine` reference
 * directly (bypassing `BudgetGuard` entirely) could call
 * `commitReservation(id, entry)`/`releaseReservation(id, scope)` with an
 * entry/scope belonging to a COMPLETELY different task/project/agent than
 * the one the reservation actually protects — e.g. reserve under project A,
 * commit or release under project B — silently letting A's protected
 * capacity be spent or freed under B's name. Fixed: the ownership-mismatch
 * check now lives INSIDE `commitReservation()`/`releaseReservation()`
 * themselves (bkz. aşağıdaki metodlar), so it holds regardless of whether
 * the caller goes through `BudgetGuard` or talks to the ledger directly.
 */
/**
 * P1 fix (26th independent review round, finding 3, "reservation ownership
 * evidence must not be forgeable"): this error's message used to interpolate
 * the reservation's OWN authoritative ownership fields (taskId, projectId,
 * agentId, provider, modelId) directly into the thrown message string —
 * readable by WHOEVER calls `commitReservation()`/`releaseReservation()`
 * and catches the error, including a caller who deliberately supplied a
 * WRONG guess purely to harvest the true values back out of the rejection.
 * Combined with `getReservation()` ALSO publicly exposing the same scope
 * (bkz. aşağıdaki fix notu), a caller with no legitimate relationship to a
 * reservation could learn its exact ownership two different ways — either
 * read it directly, or provoke this error and parse the message — then
 * replay it as `callerScope` on a follow-up call to pass the ownership
 * check trivially. Fixed: the message now reports ONLY that a mismatch
 * occurred and echoes back the CALLER'S OWN supplied values (information
 * they already possessed — echoing it back discloses nothing new), never
 * the reservation's true authoritative values. Legitimate forensic
 * traceability is not lost: `BudgetGuard.reserve()`'s own
 * `BUDGET_RESERVATION_CREATED` audit event already records the true scope
 * at creation time in the SAME append-only, runtime-private `AuditLog`
 * (bkz. audit/audit-log.ts'in `#records`'ı) — a legitimate reviewer with
 * audit-log access can always join that event with a later mismatch event
 * by `reservationId`; this error's own message simply stops being a second,
 * directly-exploitable channel for the same information.
 */
export class ReservationOwnershipMismatchError extends Error {
  constructor(operation: "commit" | "release", reservationId: string, _reservationScope: Readonly<ReservationOwnership>, suppliedScope: ReservationOwnership) {
    super(
      `${operation}(reservationId=${reservationId}) supplied ownership (taskId=${String(suppliedScope.taskId)}, ` +
        `projectId=${String(suppliedScope.projectId)}, agentId=${String(suppliedScope.agentId)}, ` +
        `provider=${String(suppliedScope.provider)}, modelId=${String(suppliedScope.modelId)}) does not match ` +
        `the reservation's own authoritative ownership. A reservation is the authoritative source of ownership ` +
        `for its own commit/release — this call was rejected before any mutation. A reservation id alone is ` +
        `never sufficient to commit or release capacity reserved under a different owner's scope, and this ` +
        `error deliberately does not disclose the reservation's true ownership details (see the fix note above) ` +
        `— cross-reference this reservation's BUDGET_RESERVATION_CREATED audit event for that, if you have ` +
        `legitimate access to the audit log.`
    );
    this.name = "ReservationOwnershipMismatchError";
  }
}

function ownershipMismatches(reservationScope: Readonly<ReservationOwnership>, suppliedScope: ReservationOwnership): boolean {
  const reservedProvider = reservationScope.provider;
  const reservedModelId = reservationScope.modelId;
  return (
    suppliedScope.taskId !== reservationScope.taskId ||
    suppliedScope.projectId !== reservationScope.projectId ||
    suppliedScope.agentId !== reservationScope.agentId ||
    (reservedProvider !== undefined && suppliedScope.provider !== reservedProvider) ||
    (reservedModelId !== undefined && suppliedScope.modelId !== reservedModelId)
  );
}

export class CostEngine {
  /**
   * P1 fix (26th independent review round, finding 2, "cost ledger state
   * must be runtime-private"): this array (and `#reservations`/
   * `#reservationSeq` below) used to be declared with TypeScript's
   * `private` keyword — compile-time only. Compiled JS leaves it an
   * ordinary, enumerable instance property: `(engine as any).entries`, or
   * plain bracket access (`engine["entries"]`), reaches it with no
   * type-system escape hatch needed at all. A consumer holding a
   * `CostEngine` reference could `.push()` a fabricated entry directly
   * (recording spend that never went through `record()`'s own
   * `assertValidMonetaryAmount()` gate — poisoning every total with an
   * unvalidated NaN/negative amount), `.splice()` an already-recorded
   * entry back out (silently discarding evidence of REAL spend — exactly
   * the "no silent spending" invariant, baseline section 147, forbids in
   * reverse), or reassign the array outright (`engine["entries"] = []`),
   * wiping the entire cost history with no reconciliation, no audit trail,
   * and no error. Fixed the same way `audit/audit-log.ts`'s `#records`
   * (round 25, finding 9, and this round's own targeted-audit follow-ups
   * on `decision-ledger.ts`/`assumption-register.ts`/`workers/registry.ts`/
   * `models/registry.ts`) already are: genuine ECMAScript private class
   * fields (`#entries`/`#reservations`/`#reservationSeq`), enforced by the
   * JS runtime itself — `as any`, bracket access,
   * `Object.getOwnPropertyNames()`, and `Reflect.ownKeys()` all fail to
   * reach them, and any code outside this class body attempting
   * `x.#entries` is a `SyntaxError` at PARSE time, not merely rejected at
   * runtime.
   */
  #entries: CostEntry[] = [];

  /**
   * Bu ledger'a bağlı HER `BudgetGuard`'ın PAYLAŞTIĞI, tek/yetkili
   * bekleyen-rezervasyon deposu — bkz. `ReservationOwnership`'in üstündeki
   * fix notu. `reserve()`/`commit()`/`release()`'in KENDİSİ (politika:
   * hangi tavanların uygulanacağı, sahiplik uyuşmazlığı kontrolü, hangi
   * hataların fırlatılacağı) hâlâ TAMAMEN `BudgetGuard`'da yaşar — bu sınıf
   * yalnızca ham depolama ve toplama sağlar, tıpkı `record()`/`totalFor()`
   * gibi.
   */
  #reservations = new Map<
    string,
    { scope: Readonly<ReservationOwnership>; amountUsd: number; status: ReservationLedgerStatus }
  >();
  #reservationSeq = 0;

  /**
   * `now` enjekte edilebilir bir saat fonksiyonudur — varsayılan olarak
   * gerçek zamanı kullanır, ancak testler (özellikle günlük/aylık bütçe
   * sıfırlanma senaryoları) belirli bir ana "sabitlenmiş" kayıtlar
   * üretebilmek için bunu değiştirebilir (bkz. runtime/budget/budget.ts).
   */
  constructor(private readonly now: () => Date = () => new Date()) {}

  record(entry: Omit<CostEntry, "timestamp">): CostEntry {
    // Doğrudan record() çağrıları da (BudgetGuard'ı atlayan çağrılar dahil)
    // korunur — bozuk bir tutarın toplamlara sızmasına asla izin verilmez.
    assertValidMonetaryAmount(entry.amountUsd, `CostEngine.record(taskId=${entry.taskId})`);
    const full: CostEntry = { ...entry, timestamp: this.now().toISOString() };
    // İç diziye eklenen nesne İLE dışarı döndürülen nesne KASITLI OLARAK
    // aynı referans DEĞİLDİR: çağıran döndürülen kaydı (ör. amountUsd'yi
    // NaN'a) mutasyona uğratsa bile, iç toplamlar (total/totalFor/
    // totalInWindow) her zaman motorun kendi, asla dışarı sızmamış
    // kopyasını okur. Object.freeze, bu ayrımın atlanamamasını (örn.
    // "as any" ile alan ataması) TypeError'a çevirerek garanti eder.
    this.#entries.push(full);
    return freezeRecord(full);
  }

  all(): readonly CostEntry[] {
    return this.#entries.map((e) => freezeRecord(e));
  }

  /** Belirli bir kapsam (görev/ajan/proje) için toplam maliyeti hesaplar. */
  totalFor(scope: CostScope): number {
    return this.#entries.filter((e) => matchesScope(e, scope)).reduce((sum, e) => sum + e.amountUsd, 0);
  }

  total(): number {
    return this.#entries.reduce((sum, e) => sum + e.amountUsd, 0);
  }

  /**
   * Belirli bir kapsam VE zaman penceresi (sinceIso'dan itibaren) için
   * toplam maliyeti hesaplar. Günlük/aylık bütçe tavanlarının (bölüm 70-72)
   * gerçekten "dönemsel" olabilmesi için gereken temel sorgu budur — ISO
   * 8601 zaman damgaları sözlüksel (string) karşılaştırmayla doğru sırada
   * olduğundan basit bir string karşılaştırması yeterlidir.
   */
  totalInWindow(scope: CostScope, sinceIso: string): number {
    return this.#entries
      .filter((e) => matchesScope(e, scope) && e.timestamp >= sinceIso)
      .reduce((sum, e) => sum + e.amountUsd, 0);
  }

  /**
   * Yeni bir bekleyen rezervasyon açar — bu ledger'a bağlı HER
   * `BudgetGuard`'ın PAYLAŞTIĞI tek depoya yazar (bkz. `ReservationOwnership`'in
   * üstündeki fix notu). Senkron ve HİÇBİR `await` içermez — çağıranın
   * (`BudgetGuard.reserve()`) kendi tavan kontrolüyle AYNI JS "tick"inde
   * çalışır, bu yüzden birleşik işlem (kontrol + rezervasyon oluşturma)
   * hâlâ atomiktir; JS'in tek iş parçacıklı çalışma zamanı iki eşzamanlı
   * `reserve()` çağrısının ASLA iç içe geçmemesini garanti eder. Doğrudan
   * (BudgetGuard atlanarak) çağrılsa bile tutar doğrulanır — `record()`
   * ile AYNI felsefe: bozuk bir tutarın hiçbir yoldan sızmaması.
   */
  createReservation(scope: ReservationOwnership, amountUsd: number): LedgerReservation {
    assertValidMonetaryAmount(amountUsd, "CostEngine.createReservation");
    const id = `res-${++this.#reservationSeq}`;
    const frozenScope = freezeRecord({ ...scope });
    this.#reservations.set(id, { scope: frozenScope, amountUsd, status: "ACTIVE" });
    return freezeRecord({ id, scope: frozenScope, amountUsd, status: "ACTIVE" as ReservationLedgerStatus });
  }

  /**
   * Verilen id'deki rezervasyonun donmuş, ayrık bir anlık görüntüsü —
   * bulunamazsa `undefined`.
   *
   * P1 fix (26th independent review round, finding 3, "reservation
   * ownership evidence must not be forgeable"): this used to return the
   * FULL `LedgerReservation`, INCLUDING `scope` — the exact ownership data
   * `commitReservation()`/`releaseReservation()` compare a caller-supplied
   * scope against. Codex reproduced: caller B, merely knowing (or
   * predicting — reservation ids are sequential, `res-1`, `res-2`, ...)
   * caller A's reservation id, could call this PUBLIC method to read back
   * A's authoritative scope with NO prior relationship to that reservation
   * whatsoever, then replay it verbatim as `callerScope` to
   * `releaseReservation(idA, learnedScope)` — passing the ownership check
   * trivially, since the "proof" of ownership was handed to them by this
   * very lookup. A read-only diagnostic method must never double as
   * reusable authorization material. Fixed: the returned `ReservationView`
   * omits `scope` — `id`/`amountUsd`/`status` remain visible (none of
   * these are compared by `ownershipMismatches()`, so none of them let a
   * caller forge ownership), but the one field that WOULD is no longer
   * obtainable through this — or any other — public method. A legitimate
   * caller does not need to look this up at all: it already knows its own
   * scope, because it is the same scope it supplied to `reserve()` in the
   * first place (bkz. `runtime/budget/budget.ts`'in `Reservation.scope`'ı).
   */
  getReservation(id: string): ReservationView | undefined {
    const r = this.#reservations.get(id);
    if (!r) return undefined;
    return freezeRecord({ id, amountUsd: r.amountUsd, status: r.status });
  }

  /**
   * Bir rezervasyonu "ÇÖZÜLMEMİŞ MUTABAKAT BAŞARISIZLIĞI" durumuna işaretler
   * — bkz. `runtime/budget/budget.ts`'deki `ReservationStatus`/
   * `UnresolvedReconciliationError`'ın notu. Rezervasyon zaten yoksa
   * sessizce hiçbir şey yapmaz (çağıran — `BudgetGuard` — varlığını zaten
   * `getReservation()` ile doğrulamış olmalıdır; bu yalnızca dahili bir
   * durum geçişidir, kendi başına bir "bulundu mu?" sözleşmesi değildir).
   */
  markReservationReconciliationFailed(id: string): void {
    const r = this.#reservations.get(id);
    if (r) r.status = "RECONCILIATION_FAILED";
  }

  /**
   * P1 fix (24th independent review round, "reservation deletion must not
   * bypass reconciliation"): this used to be a single, unguarded
   * `deleteReservation(id)` — public, and callable by ANY code holding a
   * reference to this `CostEngine` (not just a cooperating `BudgetGuard`),
   * for ANY reservation regardless of its status. That meant a "normal
   * consumer" (something that never went through `BudgetGuard.commit()`/
   * `release()` at all) could remove a `RECONCILIATION_FAILED`
   * reservation — one whose protected capacity exists PRECISELY because a
   * provider call may already have happened and its real cost was never
   * safely recorded (bkz. `commit()`'s ve `markReservationReconciliationFailed()`'in
   * üstündeki fix notları) — silently freeing that capacity with NO cost
   * ever recorded, exactly the "silent spending" bölüm 147 forbids in
   * reverse (silently discarding the PROTECTION against it). It could
   * equally delete a perfectly ordinary ACTIVE reservation out from under
   * its owner, letting a second, unrelated reservation succeed against a
   * ceiling the first reservation should still have been protecting.
   * `deleteReservation` is removed from the public API entirely — a
   * reservation can now ONLY leave this ledger through one of the two
   * methods below, each of which enforces the SAME domain invariant
   * regardless of caller: `commitReservation()` requires a genuine,
   * validated committed cost to accompany the removal (so removing
   * capacity always means SOME real cost was just recorded, never a free
   * deletion), and `releaseReservation()` refuses to remove a
   * `RECONCILIATION_FAILED` reservation at all. `BudgetGuard` no longer
   * performs commit/release's storage mutation itself — it now calls
   * these two ledger-owned methods, so the protection holds even for a
   * caller that talks to `CostEngine` directly, bypassing `BudgetGuard`
   * altogether.
   */
  /**
   * P1 fix (25th independent review round, "reservation ownership must be
   * validated inside CostEngine"): the ownership-mismatch check (bkz.
   * `ownershipMismatches()`/`ReservationOwnershipMismatchError`'ın
   * üstündeki not) now runs HERE, before any mutation — a caller can no
   * longer commit a reservation under a scope different from the one it
   * was reserved under, regardless of whether they go through
   * `BudgetGuard.commit()` or call this method directly. A mismatch marks
   * the reservation `RECONCILIATION_FAILED` (protected — bkz. üstteki
   * not, aynı bir gerçek provider çağrısının zaten olmuş olabileceği
   * mantığı) rather than leaving it releasable.
   */
  commitReservation(id: string, entry: Omit<CostEntry, "timestamp">): CostEntry {
    const reservation = this.#reservations.get(id);
    if (!reservation) {
      throw new UnknownReservationError(id);
    }
    if (ownershipMismatches(reservation.scope, entry)) {
      reservation.status = "RECONCILIATION_FAILED";
      throw new ReservationOwnershipMismatchError("commit", id, reservation.scope, entry);
    }
    try {
      assertValidMonetaryAmount(entry.amountUsd, `CostEngine.commitReservation(id=${id})`);
    } catch (err) {
      // Doğrulama BAŞARISIZ olursa rezervasyon SİLİNMEZ — "RECONCILIATION_FAILED"
      // olarak işaretlenip KORUNUR (bkz. üstteki not); ÇAĞIRANIN (BudgetGuard)
      // kendi audit/hata işleme mantığı bu hatayı zaten sarmalar.
      reservation.status = "RECONCILIATION_FAILED";
      throw err;
    }
    const recorded = this.record(entry);
    this.#reservations.delete(id);
    return recorded;
  }

  /**
   * Bir rezervasyonu, HİÇBİR gerçek maliyet oluşmadığı varsayımıyla
   * (provider çağrısı hiç yapılmadı veya başarısız oldu) serbest bırakır.
   * `RECONCILIATION_FAILED` durumundaki bir rezervasyon REDDEDİLİR (bkz.
   * `UnresolvedReconciliationError`'ın üstündeki not) — bu koruma artık bu
   * ledger'ın KENDİSİNDE uygulanır, yalnızca `BudgetGuard.release()`
   * üzerinden ÇAĞIRILDIĞINDA değil.
   *
   * P1 fix (25th independent review round, "callers must not release
   * someone else's active reservation"): `release()` used to take ONLY a
   * reservation id — no ownership check at all. A reservation id is
   * predictable (`res-1`, `res-2`, ...) and, once known by ANY caller
   * (not just the one that created it), was previously SUFFICIENT to
   * release ANOTHER caller's active, in-flight reservation, freeing its
   * protected capacity for use by someone else — a reservation id acting
   * as a bearer capability rather than an authenticated reference. Fixed:
   * `callerScope` is now a REQUIRED parameter, validated against the
   * reservation's OWN authoritative `scope` (bkz. `ownershipMismatches()`)
   * before any deletion. Unlike `commitReservation()`'s mismatch (which
   * marks `RECONCILIATION_FAILED`, since a real provider call may already
   * have happened under that reservation), a release-ownership mismatch
   * does NOT mark the reservation failed — nothing was ever committed by
   * this call, so the legitimate owner must still be able to normally
   * release/commit it later; only THIS caller's illegitimate attempt is
   * rejected.
   */
  releaseReservation(id: string, callerScope: ReservationOwnership): LedgerReservation {
    const reservation = this.#reservations.get(id);
    if (!reservation) {
      throw new UnknownReservationError(id);
    }
    if (reservation.status === "RECONCILIATION_FAILED") {
      throw new UnresolvedReconciliationError(id);
    }
    if (ownershipMismatches(reservation.scope, callerScope)) {
      throw new ReservationOwnershipMismatchError("release", id, reservation.scope, callerScope);
    }
    this.#reservations.delete(id);
    return freezeRecord({ id, scope: reservation.scope, amountUsd: reservation.amountUsd, status: reservation.status });
  }

  /**
   * Verilen sorguyla eşleşen TÜM açık (durumu ne olursa olsun — ACTIVE
   * VEYA RECONCILIATION_FAILED, ikisi de kapasiteyi KORUMAYA devam eder)
   * rezervasyonun toplamı. Bu ledger'a bağlı HER `BudgetGuard`'ın
   * `buildCeilingChecks()`'i bu TEK, PAYLAŞILAN toplamı okur — 16th
   * independent review round'dan ÖNCE her `BudgetGuard`'ın kendi ayrı,
   * paylaşılmayan bir toplamı vardı (bkz. bu dosyanın üstündeki fix notu).
   */
  reservedTotal(query: CostScope): number {
    let total = 0;
    for (const reservation of this.#reservations.values()) {
      if (matchesScope(reservation.scope, query)) {
        total += reservation.amountUsd;
      }
    }
    return total;
  }
}

function matchesScope(entry: CostScope, scope: CostScope): boolean {
  return (
    (scope.taskId === undefined || entry.taskId === scope.taskId) &&
    (scope.agentId === undefined || entry.agentId === scope.agentId) &&
    (scope.projectId === undefined || entry.projectId === scope.projectId)
  );
}
