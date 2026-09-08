// Baseline section 70-72 (Project AI Budget, Agent/Task Budgets, Cost
// Ceilings) + Proof E (bölüm 306): bütçe tavanları kaçak (runaway) yürütmeyi
// DURDURUR. Bu koruma, harcama gerçekleşmeden ÖNCE (projected amount ile)
// çağrılmalıdır — yoksa tavanı aştıktan sonra durdurmak "sessiz harcama
// yok" ilkesini ihlal eder.
//
// dailyUsd/monthlyUsd DÖNEMSEL tavanlardır: her gün/ay başında sıfırlanır
// (UTC takvim günü/ayı — kayan 24 saat/30 gün penceresi DEĞİL, çünkü
// dönemin ne zaman başladığı belirsizleşirse denetim de belirsizleşir).
// `now` enjekte edilebilir bir saat fonksiyonudur; testler bunu ilerleterek
// gün/ay sınırlarını (rollover) gerçek zaman geçmeden doğrulayabilir.

import {
  assertValidMonetaryAmount,
  exceedsMonetaryAmount,
  ReservationOwnershipMismatchError,
  UnknownReservationError,
  UnresolvedReconciliationError
} from "../cost/cost-engine.js";
import type { CostEngine, CostEntry, CostScope, LedgerReservation, ReservationOwnership } from "../cost/cost-engine.js";
import type { AuditLog } from "../audit/audit-log.js";
import { freezeRecord } from "../util/immutable.js";

// P1 fix (16th independent review round, "outstanding budget reservations
// are not shared across guards using one cost ledger"): re-exported here
// (rather than only from cost-engine.ts) purely for API stability —
// `ReservationOwnership` used to be DEFINED in this file; it now lives in
// cost-engine.ts (the new authoritative home for reservation state, bkz.
// aşağıdaki `reservations`/`reserve()`/`commit()`/`release()`'in üstündeki
// fix notları), but any code that imported the type from here (or from
// this module's own `Reservation` interface) sees no shape change.
export type { ReservationOwnership };

// P1 fix (24th independent review round, "reservation deletion must not
// bypass reconciliation"): `UnknownReservationError`/`UnresolvedReconciliationError`
// used to be DEFINED in this file; they now live in cost-engine.ts (bkz.
// `CostEngine.commitReservation()`/`releaseReservation()`'ın üstündeki fix
// notu — the invariant they protect must hold at the ledger level, not
// only when accessed through `BudgetGuard`), re-exported here for API
// stability so every existing caller/test importing them from this module
// continues to work unchanged.
//
// P1 fix (25th independent review round, "reservation ownership must be
// validated inside CostEngine"): `ReservationOwnershipMismatchError` used
// to be DEFINED in this file too — it now also lives in cost-engine.ts for
// the exact same reason (the ownership check it reports on now runs
// inside `CostEngine.commitReservation()`/`releaseReservation()`
// themselves), re-exported here for the same API-stability reason.
export { ReservationOwnershipMismatchError, UnknownReservationError, UnresolvedReconciliationError };

export type BudgetCeilingName = "perTaskUsd" | "perRunUsd" | "dailyUsd" | "monthlyUsd";

export interface BudgetLimits {
  readonly perTaskUsd?: number;
  readonly perRunUsd?: number;
  readonly dailyUsd?: number;
  readonly monthlyUsd?: number;
}

export class InvalidBudgetLimitError extends Error {
  constructor(ceiling: BudgetCeilingName, limit: number) {
    super(
      `Invalid budget limit for '${ceiling}': ${limit}. Configured ceilings must be ` +
        `finite and non-negative (NaN/Infinity/-Infinity/negative are rejected).`
    );
    this.name = "InvalidBudgetLimitError";
  }
}

function assertValidLimit(ceiling: BudgetCeilingName, limit: number | undefined): void {
  if (limit === undefined) return;
  if (!Number.isFinite(limit) || limit < 0) {
    throw new InvalidBudgetLimitError(ceiling, limit);
  }
}

/**
 * P2 fix (13th independent review round, "bootstrap validates budget
 * limits after filesystem mutation"): the ONLY place `BudgetLimits` was
 * ever validated used to be `BudgetGuard`'s own constructor — which is
 * correct for `BudgetGuard` itself, but meant any CALLER that performs
 * side effects (filesystem writes, external calls, ...) BEFORE
 * constructing its `BudgetGuard` discovers an invalid ceiling (NaN/
 * Infinity/negative) only AFTER those side effects already happened.
 * Codex reproduced exactly this in `runtime/project-lifecycle/
 * orchestrator.ts`'s `bootstrapProject()`: `perTaskUsd: NaN` was
 * ultimately rejected, but only once `new BudgetGuard(...)` ran — by
 * which point `scaffoldProjectOs()` had already created 24 real
 * directories on disk. Exported here (rather than duplicated at each
 * call site) so `BudgetGuard`'s constructor and any caller that needs to
 * fail BEFORE its own side effects share the exact same validation rule.
 */
export function assertValidBudgetLimits(limits: BudgetLimits): void {
  assertValidLimit("perTaskUsd", limits.perTaskUsd);
  assertValidLimit("perRunUsd", limits.perRunUsd);
  assertValidLimit("dailyUsd", limits.dailyUsd);
  assertValidLimit("monthlyUsd", limits.monthlyUsd);
}

export class BudgetExceededError extends Error {
  constructor(
    public readonly ceiling: BudgetCeilingName,
    public readonly limit: number,
    public readonly wouldBeTotal: number
  ) {
    super(
      `Budget ceiling '${ceiling}' ($${limit}) would be exceeded by this action ` +
        `(projected total $${wouldBeTotal.toFixed(4)}). Execution blocked before spending occurred.`
    );
    this.name = "BudgetExceededError";
  }
}

interface CeilingCheck {
  readonly ceiling: BudgetCeilingName;
  readonly limit: number;
  readonly projected: number;
}

export interface Reservation {
  readonly id: string;
  readonly scope: Readonly<ReservationOwnership>;
  readonly amountUsd: number;
}

/**
 * P1 fix (12th independent review round, "failed reconciliation
 * reservations can still be released"): a reservation whose `commit()`
 * attempt failed (malformed actual amount) used to remain in the map with
 * NO explicit state of its own — it was structurally identical to a
 * fresh, never-committed reservation. That meant `release()` (the
 * documented rule for "the provider call itself threw, no cost ever
 * occurred") could ALSO be called on it, deleting it and silently
 * restoring the budget capacity it protected — even though a REAL (or
 * potentially real) provider call may already have happened and only the
 * RECONCILIATION of its cost failed, not the call itself. Those are two
 * completely different situations that must never share one escape
 * hatch. `ReservationStatus` makes this explicit: "ACTIVE" is the normal
 * open state (`release()` is legitimate here — nothing was ever
 * incurred); "RECONCILIATION_FAILED" means a `commit()` attempt failed
 * AFTER the provider may have already run — `release()` is REJECTED in
 * this state (bkz. `UnresolvedReconciliationError`), and the ONLY way
 * forward is a corrected `commit()` retry on the SAME reservation id
 * (safe/idempotent, since nothing was deleted). A reservation leaves the
 * map ENTIRELY only on a genuinely terminal transition — a successful
 * `commit()` (cost durably recorded) or a legitimate `release()` from
 * "ACTIVE" — so "terminal exactly once" is enforced by the Map itself:
 * once removed, any further commit()/release() call sees "not found"
 * (`UnknownReservationError`), never a silent no-op.
 */
export type ReservationStatus = "ACTIVE" | "RECONCILIATION_FAILED";

/** Verilen anın ait olduğu UTC takvim gününün başlangıcını (00:00:00.000Z) döndürür. */
function startOfUtcDay(date: Date): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString();
}

/** Verilen anın ait olduğu UTC takvim ayının başlangıcını (1. gün, 00:00:00.000Z) döndürür. */
function startOfUtcMonth(date: Date): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();
}

export class BudgetGuard {
  /**
   * P1 fix (4th independent review round): eskiden constructor,
   * ÇAĞIRANIN geçtiği `limits` nesnesinin REFERANSINI doğrudan saklıyordu.
   * TypeScript'in `readonly` işaretleyicisi yalnızca derleme zamanında
   * uyarır — çağıran, kaydettikten SONRA aynı nesneyi
   * (`limits.dailyUsd = -1` gibi) mutasyona uğratırsa, bu doğrudan
   * yetkili (authoritative) tavanları da bozardı; kurulum anındaki
   * doğrulama bunu YAKALAYAMAZ çünkü mutasyon doğrulamadan SONRA olur.
   * Artık: doğrula, SONRA çağıranın nesnesinden BAĞIMSIZ, donmuş bir iç
   * kopya oluştur — orijinal nesneye yapılan hiçbir sonraki mutasyon iç
   * durumu etkileyemez.
   */
  /**
   * P1 fix (27th independent review round, finding 6, "keep budget limits
   * runtime-private"): this used to be declared with TypeScript's
   * compile-time-only `private readonly` — in the emitted JS it is an
   * ordinary, enumerable instance property. `(guard as any).limits =
   * { perTaskUsd: Number.MAX_VALUE }` from any caller holding a
   * `BudgetGuard` reference would silently replace the configured
   * ceilings — the freezing/detaching this constructor already does only
   * protects against MUTATING the object in place, not against
   * REPLACING the property that points to it entirely (a `readonly`
   * class field is still an ordinary writable property in JS unless it
   * is a genuine `#private` field). Fixed: a genuine ECMAScript private
   * field (`#limits`), assigned once in the constructor body — `as any`,
   * bracket access, and every reflection API fail to reach it.
   */
  #limits: Readonly<BudgetLimits>;

  /**
   * P1 fix (27th independent review round targeted-audit follow-up, same
   * root class as finding 3 [capability-gateway/gateway.ts's `#policy`/
   * `#approvals`] and finding 6 [`#limits`, immediately above]):
   * `costEngine`/`now`/`auditLog` used to be declared as TypeScript
   * constructor-parameter-property `private readonly` fields — compile-time
   * only. In the emitted JS these are ordinary, enumerable instance
   * properties: `(guard as any).costEngine = fakeCostEngineWhoseRecord
   * IsANoOpAndWhoseTotalsAreAlwaysZero` from any caller holding a
   * `BudgetGuard` reference would silently defeat EVERY ceiling check
   * (`totalFor`/`total`/`totalInWindow`/`reservedTotal`, all read from
   * `this.#costEngine`) and every spend/reservation record
   * (`record`/`createReservation`/`commitReservation`/`releaseReservation`,
   * all written through `this.#costEngine`) — the exact same class of bug
   * `#limits` just above was fixed for, just reachable through a different
   * property name. `now` is likewise authoritative for the daily/monthly
   * ceiling WINDOW boundary (`startOfUtcDay(this.#now())`/
   * `startOfUtcMonth(this.#now())`) — replacing it could make every spend
   * appear to fall inside a perpetually-fresh window, defeating periodic
   * ceilings entirely. `auditLog` is the sole channel every
   * `BUDGET_*` event in this class reaches — replacing it with a
   * discard-everything stub would silently erase the audit trail baseline
   * section 147/303 requires for "no silent spending." Fixed identically to
   * `#limits`: genuine ECMAScript private fields, assigned once in the
   * constructor body — `as any`, bracket access, and every reflection API
   * fail to reach them.
   */
  readonly #costEngine: CostEngine;
  readonly #now: () => Date;
  readonly #auditLog?: AuditLog;

  /**
   * P1 fix (10th independent review round, "concurrent model invocations
   * can exceed budgets"): Codex reproduced two concurrent $0.60 provider
   * calls against a $1.00 ceiling BOTH executing — each independently
   * called `assertWithinBudget()` (a pure read of ALREADY-recorded totals)
   * BEFORE either had recorded anything, so both passed; the actual
   * `spend()` call only happened AFTER an `await`ed provider round-trip,
   * by which point BOTH providers had already been invoked and BOTH real
   * costs had already been incurred — `spend()` itself is atomic
   * (no `await` between its own check and its own record), so it correctly
   * rejected the SECOND `spend()` call, but that rejection happened AFTER
   * the second $0.60 was already spent for real, silently losing track of
   * $0.60 of genuinely incurred cost. The root cause is a classic
   * check-then-(async-gap)-then-act race: `assertWithinBudget()` alone
   * checks but never RESERVES anything, so nothing stops a second
   * concurrent caller from also passing the same check during that gap.
   * Fixed with a reservation/reconciliation model: `reserve()` atomically
   * (synchronously, no `await` inside it — JS's single-threaded run-to-
   * completion semantics make "check its ceilings" and "record the
   * reservation" a single indivisible step, exactly like the existing
   * `spend()`) evaluates ALL ceilings INCLUDING every other currently-open
   * reservation, and only if none would be exceeded does it add a new
   * reservation and return an opaque handle — this must happen and
   * complete BEFORE any provider is ever invoked. After the (awaited,
   * genuinely concurrent-safe) provider call, `commit()` deletes the
   * reservation and records the ACTUAL incurred cost unconditionally
   * (never re-checked against ceilings, and never dropped, even if that
   * pushes a ceiling into overage on paper — bölüm 147, "sessiz harcama
   * yok" means an already-incurred real-world cost may NEVER be silently
   * discarded just because accounting it would look bad); an overage is
   * still detected and logged to the audit trail for visibility, but the
   * cost itself is always recorded. `release()` is the documented
   * reconciliation rule for a provider call that THROWS (P0's providers
   * are assumed not to partially bill on failure — a real provider
   * adapter that CAN incur a partial cost on failure must report that
   * partial cost via `commit()` with the partial amount, not `release()`,
   * which is out of scope for the MockProvider this repository ships).
   *
   * P1 fix (16th independent review round, "outstanding budget
   * reservations are not shared across guards using one cost ledger"):
   * this class used to own a PRIVATE `Map` of outstanding reservations —
   * Codex reproduced two `BudgetGuard` instances constructed over the
   * SAME `CostEngine` each keeping their own separate reservation map,
   * so a reservation opened through guard A was completely invisible to
   * guard B's own `buildCeilingChecks()`. Two concurrent $0.60
   * invocations, one authorized through each guard, both independently
   * saw zero outstanding reservations and both succeeded against a
   * shared $1.00 ceiling — $1.20 committed, reintroducing the exact race
   * the 10th round's reservation model was meant to make structurally
   * impossible, one layer up. Fixed: reservation storage now lives on
   * `this.#costEngine` itself (`createReservation()`/`getReservation()`/
   * `markReservationReconciliationFailed()`/`deleteReservation()`/
   * `reservedTotal()` — bkz. runtime/cost/cost-engine.ts) — the SAME
   * object every cooperating `BudgetGuard` already shares by
   * construction, exactly as it already was for COMMITTED spending
   * (`record()`/`totalFor()`). This class no longer stores reservation
   * state itself at all; `reserve()`/`commit()`/`release()` below are
   * unchanged in their PUBLIC signatures, error types, ownership-mismatch
   * validation, and audit events — only the underlying storage moved, so
   * every existing caller (gateway.ts, router.ts, all prior regression
   * tests) continues to work unchanged, but now genuinely enforces
   * ceilings against every reservation on the shared ledger, regardless
   * of which `BudgetGuard` instance created it. This remains fully
   * concurrency-safe: `createReservation()`/`getReservation()`/
   * `markReservationReconciliationFailed()`/`deleteReservation()` are all
   * synchronous with no `await` inside them, so the combined "read
   * shared ledger -> check ceilings -> write shared ledger" sequence in
   * `reserve()` still executes as one indivisible JS tick — a second,
   * concurrent `reserve()` call (whether on this same guard, another
   * guard over the same ledger, or a different ledger entirely) can
   * never observe a partially-updated state.
   */
  constructor(costEngine: CostEngine, limits: BudgetLimits, now: () => Date = () => new Date(), auditLog?: AuditLog) {
    // P1 fix (28th independent review round, finding 7, "snapshot budget
    // limits before validation" — same root class as round 27's finding 1
    // [policy-engine.ts risk validation] and finding 7 [budget.ts spend
    // entries]): `limits` used to be validated DIRECTLY
    // (`assertValidBudgetLimits(limits)`, reading `limits.perTaskUsd`/
    // `.perRunUsd`/`.dailyUsd`/`.monthlyUsd` from the caller's own object),
    // then read AGAIN one line below via `freezeRecord({ ...limits })` — two
    // SEPARATE reads of a caller-owned object that, if getter/Proxy-backed,
    // need not agree. A getter answering a valid ceiling (e.g. `perTaskUsd:
    // 1`) on the validation read and a wildly different one (e.g.
    // `Number.MAX_VALUE`, or an invalid NaN/negative value the constructor
    // was supposed to reject) on the snapshot read would pass validation
    // against a value that never ends up stored, while the REAL ceiling
    // every future `reserve()`/`spend()` call enforces was never actually
    // validated. Fixed: `limits` is spread into `snapshot` FIRST — a
    // genuine, static plain object, reading every property exactly ONCE —
    // and `assertValidBudgetLimits(snapshot)` validates that SAME object,
    // which is then the ONE frozen and stored; the caller's original
    // `limits` parameter is never read again after this one spread.
    const snapshot: BudgetLimits = { ...limits };
    assertValidBudgetLimits(snapshot);
    this.#limits = freezeRecord(snapshot);
    this.#costEngine = costEngine;
    this.#now = now;
    this.#auditLog = auditLog;
  }

  /**
   * Yapılandırılmış tavanların salt-okunur, ayrık bir anlık görüntüsü.
   * Döndürülen nesne üzerindeki hiçbir mutasyon iç `this.#limits`'i
   * etkilemez (donmuş + kopya).
   */
  getLimits(): Readonly<BudgetLimits> {
    return freezeRecord({ ...this.#limits });
  }

  /**
   * P1 fix (5th independent review round, "per-task budgets mix
   * projects"): perTaskUsd eskiden yalnızca `taskId`'ye göre kapsamlanıyordu
   * — Codex, aynı `taskId`'yi kullanan İKİ FARKLI projenin (ör. genel bir
   * "bootstrap" görev şablonu) aynı $X tavanını PAYLAŞTIĞINI gösterdi:
   * Proje A kendi $1'lık tavanını harcadığında, Proje B'nin kendi ayrı ve
   * hiç kullanılmamış $1'lık tavanı da BOŞ YERE reddediliyordu.
   *
   * Kapsamlama semantiği (bölüm 70-72), artık AÇIKÇA şu şekilde
   * tanımlanır: bir `projectId` VERİLMİŞSE, görev bütçesi anahtarı
   * `projectId + taskId`'dir (aynı projedeki aynı görev tekrar tekrar
   * kullanılabilir/paylaşılabilir, ama FARKLI projeler asla aynı tavanı
   * paylaşmaz). `projectId` verilMEMİŞSE (ör. proje-bağımsız bir arka
   * plan/altyapı görevi), tavan KASITLI OLARAK global kalır — yalnızca
   * `taskId`'ye göre kapsamlanır — çünkü bu, mevcut sözleşmenin
   * (`spend()` her zaman `projectId` geçmek ZORUNDA değildir) desteklediği
   * meşru bir kullanım şeklidir.
   */
  /**
   * Her tavan kontrolü artık ÜÇ bileşenin toplamına karşı değerlendirilir:
   * (1) CostEngine'e zaten KAYDEDİLMİŞ gerçek harcamalar, (2) henüz
   * mutabakata varılmamış ama zaten AYRILMIŞ (`reserve()` ile açılmış,
   * henüz `commit()`/`release()` edilmemiş) tutarlar — artık
   * `this.#costEngine.reservedTotal()` üzerinden bu ledger'a bağlı HER
   * `BudgetGuard`'ın PAYLAŞTIĞI tek/yetkili toplam (bkz. 16th independent
   * review round fix notu, bu dosyanın üstünde), (3) bu ÇAĞRININ kendi
   * projeksiyonu. (2)'nin dahil edilmesi, tam olarak 10th independent
   * review round'un eşzamanlılık düzeltmesidir — onsuz, iki eşzamanlı
   * `reserve()` çağrısı yine birbirini GÖRMEZ ve ikisi de geçer.
   */
  private buildCeilingChecks(scope: CostScope, projectedAmountUsd: number): CeilingCheck[] {
    const checks: CeilingCheck[] = [];

    if (this.#limits.perTaskUsd !== undefined && scope.taskId !== undefined) {
      const taskScope: CostScope =
        scope.projectId !== undefined ? { taskId: scope.taskId, projectId: scope.projectId } : { taskId: scope.taskId };
      checks.push({
        ceiling: "perTaskUsd",
        limit: this.#limits.perTaskUsd,
        projected: this.#costEngine.totalFor(taskScope) + this.#costEngine.reservedTotal(taskScope) + projectedAmountUsd
      });
    }

    // P1 fix (29th independent review round, finding 7, "per-run budget must
    // be scoped to the actual run"): `this.#costEngine.total()` sums this
    // engine's ENTIRE durable ledger — every entry ever recorded across
    // every run that has shared this `CostEngine` instance/persisted state,
    // not just the current run — so a SECOND run starting on the same
    // durable ledger (the ordinary, intended way this repo's `CostEngine`
    // persists across restarts) inherited whatever the FIRST run already
    // spent, leaving it with zero fresh `perRunUsd` capacity of its own.
    // Fixed exactly like `perTaskUsd` above: when the caller supplies a
    // genuine `runId`, the ceiling is scoped to ONLY that run's entries/
    // reservations via `totalFor`/`reservedTotal`; callers that never
    // supply `runId` (every one of the 200+ existing call sites today) see
    // `runScope` degrade to `{}`, which `matchesScope()` treats as "matches
    // everything" — i.e. the exact prior global-sum behavior, unchanged.
    if (this.#limits.perRunUsd !== undefined) {
      const runScope: CostScope = scope.runId !== undefined ? { runId: scope.runId } : {};
      checks.push({
        ceiling: "perRunUsd",
        limit: this.#limits.perRunUsd,
        projected: this.#costEngine.totalFor(runScope) + this.#costEngine.reservedTotal(runScope) + projectedAmountUsd
      });
    }

    // dailyUsd/monthlyUsd: taskId'ye göre DEĞİL, verilirse projectId'ye göre
    // (yoksa motorun tamamına göre) kapsamlanır — perTaskUsd'nin aksine, bu
    // tavanlar tek bir görev için değil bir dönem için tanımlıdır.
    const periodScope: CostScope = scope.projectId !== undefined ? { projectId: scope.projectId } : {};

    if (this.#limits.dailyUsd !== undefined) {
      checks.push({
        ceiling: "dailyUsd",
        limit: this.#limits.dailyUsd,
        projected:
          this.#costEngine.totalInWindow(periodScope, startOfUtcDay(this.#now())) +
          this.#costEngine.reservedTotal(periodScope) +
          projectedAmountUsd
      });
    }

    if (this.#limits.monthlyUsd !== undefined) {
      checks.push({
        ceiling: "monthlyUsd",
        limit: this.#limits.monthlyUsd,
        projected:
          this.#costEngine.totalInWindow(periodScope, startOfUtcMonth(this.#now())) +
          this.#costEngine.reservedTotal(periodScope) +
          projectedAmountUsd
      });
    }

    return checks;
  }

  /**
   * Bir eylem gerçekleştirilmeden önce çağrılır. Eylem, herhangi bir tavanı
   * aşacaksa BudgetExceededError fırlatır ve harcama hiç gerçekleşmez.
   * Her kontrol (izin verilen ya da engellenen), bir AuditLog verildiyse,
   * kalıcı kanıt olarak kaydedilir (bölüm 242, 303 — "no claim without
   * evidence" bütçe kararları için de geçerlidir).
   */
  assertWithinBudget(scope: CostScope, projectedAmountUsd: number): void {
    // Herhangi bir karşılaştırma yapılmadan veya durum değiştirilmeden ÖNCE
    // doğrula: NaN sızarsa `NaN > limit` HER ZAMAN false döner (tavan
    // sessizce atlanmış olur) ve negatif bir tutar yapay bütçe payı
    // yaratabilir. Bu yüzden fail-closed burada, en başta gerçekleşir.
    try {
      assertValidMonetaryAmount(projectedAmountUsd, "BudgetGuard.assertWithinBudget");
    } catch (err) {
      this.#auditLog?.append({
        type: "BUDGET_INVALID_AMOUNT_REJECTED",
        actor: "budget-guard",
        payload: { scope, projectedAmountUsd, reason: err instanceof Error ? err.message : String(err) },
        timestamp: this.#now().toISOString()
      });
      throw err;
    }

    const checks = this.buildCeilingChecks(scope, projectedAmountUsd);

    // P2 fix (8th independent review round, "floating-point comparisons
    // reject exact budget spend"): eskiden burada ÇIPLAK `>` operatörü
    // kullanılıyordu — `0.10` + `0.20` gibi ikili kayan noktalı toplamalar
    // `0.30000000000000004` ürettiğinde, TAM tavan harcaması (`0.30`)
    // yanlışlıkla reddediliyordu. `exceedsMonetaryAmount()` (runtime/cost/
    // cost-engine.ts), TÜM dört tavan türü için AYNI, merkezi, belgelenen
    // hassasiyet politikasını (mikro-dolar tam sayı birimleri) kullanır —
    // dağınık/rastgele bir epsilon değil.
    for (const check of checks) {
      if (exceedsMonetaryAmount(check.projected, check.limit)) {
        this.#auditLog?.append({
          type: "BUDGET_BLOCKED",
          actor: "budget-guard",
          payload: { scope, projectedAmountUsd, ...check },
          timestamp: this.#now().toISOString()
        });
        throw new BudgetExceededError(check.ceiling, check.limit, check.projected);
      }
    }

    this.#auditLog?.append({
      type: "BUDGET_CHECK_PASSED",
      actor: "budget-guard",
      payload: { scope, projectedAmountUsd, checks },
      timestamp: this.#now().toISOString()
    });
  }

  /**
   * Bütçe kontrolünü geçerse maliyeti kaydeder; geçmezse hiçbir şey
   * kaydedilmeden hata fırlatır. Bu, "kontrol et sonra harca" sırasını
   * tek bir atomik adımda garanti eder. Node.js tek iş parçacıklı olduğu
   * ve bu iki adım arasında hiçbir `await` bulunmadığı için, aynı anda
   * gelen birçok `spend()` çağrısı arasında bir yarış durumu (race
   * condition) OLUŞAMAZ — her çağrı, bir sonraki başlamadan tamamen biter
   * (eşzamanlılık güvenliği, JS çalışma zamanının kendisinden gelir).
   */
  /**
   * P1 fix (27th independent review round, finding 7, "snapshot spend
   * entries before checking them"): `entry.amountUsd` (and `.taskId`/
   * `.projectId`) used to be read ONCE here (for `assertWithinBudget`'s
   * ceiling check) and then read AGAIN inside `this.#costEngine.record
   * (entry)` (which spreads `entry`'s own properties to build the
   * recorded `CostEntry`) — two SEPARATE reads of the SAME caller-owned
   * object. If `entry` is a getter/Proxy, nothing requires those two
   * reads to agree: a small, ceiling-compliant amount could be checked
   * here while a completely different (larger, or negative/NaN) amount
   * is what actually gets durably recorded, or vice versa — "no silent
   * spending" (bölüm 147) depends on the CHECKED amount and the RECORDED
   * amount being provably the same value. Fixed: `entry` is copied into
   * `snapshot` — a genuine, static plain object with no getters/Proxy
   * behavior — as the VERY FIRST thing this method does, reading every
   * property exactly once; `assertWithinBudget()` and
   * `costEngine.record()` both operate on this SAME snapshot, never the
   * original `entry` parameter again.
   */
  /**
   * P1 fix (31st independent review round, finding 1, "recheck ceilings
   * inside the persistent-ledger lock"): `assertWithinBudget()`'s ceiling
   * check and `costEngine.record()`'s mutation used to run as two SEPARATE
   * steps — the check reading whatever totals this engine's in-memory
   * state happened to hold at that moment, unprotected by any lock. For a
   * `CostEngine` backed by shared persistence (bkz. `CostEngine.
   * withLedgerLock()`'ın üstündeki fix notu), a sibling instance's
   * already-durably-recorded spend could be invisible to that read, so
   * this call's own ceiling check could pass against stale data even
   * though the sibling's write — reloaded only once `record()` itself
   * acquired the lock — would have made it fail. Fixed: the check AND the
   * record now both run inside ONE `withLedgerLock()` transaction, so the
   * ceiling check observes the exact same freshly-reloaded state the
   * mutation is about to be applied to, with no gap for a sibling
   * instance to interleave.
   */
  spend(entry: {
    taskId: string;
    agentId?: string;
    projectId?: string;
    runId?: string;
    provider: string;
    modelId: string;
    amountUsd: number;
  }) {
    const snapshot = { ...entry };
    return this.#costEngine.withLedgerLock(() => {
      // P1 fix (29th independent review round, finding 7): `runId` must reach
      // `assertWithinBudget()`'s scope, not just `taskId`/`projectId` — otherwise
      // `buildCeilingChecks()`'s new `perRunUsd` scoping (bkz. yukarıdaki fix
      // notu) is unreachable through this, the most common spend path.
      this.assertWithinBudget(
        { taskId: snapshot.taskId, projectId: snapshot.projectId, runId: snapshot.runId },
        snapshot.amountUsd
      );
      return this.#costEngine.record(snapshot);
    });
  }

  /**
   * Bir provider/model çağrısı yapılmadan ÖNCE çağrılır — `spend()`'in
   * "kontrol et + kaydet" atomikliğinin AYNISINI, ama gerçek maliyet henüz
   * bilinmezken (yalnızca TAHMİNİ maliyet bilinirken) sağlar. `reserve()`
   * içinde HİÇBİR `await` yoktur; kontrol VE yeni rezervasyonun eklenmesi
   * tek bir senkron JS "tick"inde gerçekleşir, bu yüzden eşzamanlı iki
   * `reserve()` çağrısı arasında ARADA KALAN bir an OLAMAZ — biri
   * tamamlanmadan diğeri BAŞLAYAMAZ (10th independent review round fix,
   * bkz. `reservations` alanının üstündeki not). Tavan aşılıyorsa (mevcut
   * kayıtlı harcamalar + TÜM diğer açık rezervasyonlar + bu tahmini tutar),
   * fail-closed olunur ve HİÇBİR rezervasyon oluşturulmaz — çağıran,
   * provider'ı ASLA çağırmamalıdır.
   */
  reserve(scope: ReservationOwnership, amountUsd: number): Reservation {
    // P1 fix (28th independent review round, finding 8, "snapshot
    // reservation scope before ceiling checks" — same root class as
    // finding 7 above and round 27's finding 7): `scope` used to be read
    // MULTIPLE separate times from the caller's own object — once (or
    // twice) for the `BUDGET_INVALID_AMOUNT_REJECTED`/
    // `BUDGET_RESERVATION_BLOCKED` audit payloads, again inside
    // `buildCeilingChecks(scope, amountUsd)`'s own scope matching, again
    // inside `costEngine.createReservation(scope, amountUsd)`'s own
    // `{ ...scope }` spread, and again in the final
    // `BUDGET_RESERVATION_CREATED` audit payload. A getter/Proxy-backed
    // `scope` could answer differently across these reads — e.g. passing
    // the ceiling check under one `projectId` while the reservation is
    // actually created (and its audit trail recorded) under a completely
    // different one. Fixed: `scope` is spread into `snapshot` — a genuine,
    // static plain object — as the VERY FIRST thing this method does;
    // every stage below (ceiling checks, reservation creation, both audit
    // payloads) uses this SAME snapshot, never the original `scope`
    // parameter again.
    const snapshot: ReservationOwnership = { ...scope };
    try {
      assertValidMonetaryAmount(amountUsd, "BudgetGuard.reserve");
    } catch (err) {
      this.#auditLog?.append({
        type: "BUDGET_INVALID_AMOUNT_REJECTED",
        actor: "budget-guard",
        payload: { scope: snapshot, amountUsd, reason: err instanceof Error ? err.message : String(err) },
        timestamp: this.#now().toISOString()
      });
      throw err;
    }

    // P1 fix (31st independent review round, finding 1, "recheck ceilings
    // inside the persistent-ledger lock"): the ceiling check (reading
    // `this.#costEngine`'s current totals) and the reservation mutation
    // (`createReservation()`) used to be two SEPARATE steps — the check
    // running against whatever this engine's in-memory state happened to
    // hold, unprotected by any lock, and the mutation only reloading the
    // LATEST durable state once it acquired the lock itself, by which
    // point the ceiling decision had already been made. Two `BudgetGuard`/
    // `CostEngine` instances sharing one persisted ledger could each pass
    // a ceiling check against their own stale, empty-looking totals and
    // both proceed to reserve — exactly the double-reservation race
    // `CostEngine.withLedgerLock()`'ın üstündeki fix notu describes.
    // Fixed: the check and the mutation now both run inside ONE
    // `withLedgerLock()` transaction, so the check observes the exact same
    // freshly-reloaded state the reservation is about to be recorded
    // against — a sibling instance's already-committed cost or open
    // reservation can never be invisible to this check.
    const created = this.#costEngine.withLedgerLock(() => {
      const checks = this.buildCeilingChecks(snapshot, amountUsd);
      for (const check of checks) {
        if (exceedsMonetaryAmount(check.projected, check.limit)) {
          this.#auditLog?.append({
            type: "BUDGET_RESERVATION_BLOCKED",
            actor: "budget-guard",
            payload: { scope: snapshot, amountUsd, ...check },
            timestamp: this.#now().toISOString()
          });
          throw new BudgetExceededError(check.ceiling, check.limit, check.projected);
        }
      }

      // Rezervasyon, bu ledger'a bağlı HER `BudgetGuard`'ın PAYLAŞTIĞI
      // `this.#costEngine`'in KENDİSİNDE oluşturulur — artık bu sınıfın
      // kendi özel bir Map'inde DEĞİL (bkz. bu sınıfın üstündeki 16th
      // independent review round fix notu).
      const reservation = this.#costEngine.createReservation(snapshot, amountUsd);

      this.#auditLog?.append({
        type: "BUDGET_RESERVATION_CREATED",
        actor: "budget-guard",
        payload: { reservationId: reservation.id, scope: snapshot, amountUsd, checks },
        timestamp: this.#now().toISOString()
      });

      return reservation;
    });

    return freezeRecord({ id: created.id, scope: created.scope, amountUsd: created.amountUsd });
  }

  /**
   * Provider çağrısı BAŞARIYLA tamamlandıktan sonra çağrılır — GERÇEK
   * (tahmini değil) maliyeti KOŞULSUZ olarak kaydeder ve YALNIZCA bu
   * kayıt GÜVENLE tamamlandıktan SONRA açık rezervasyonu siler.
   * "Koşulsuz" kastidir: bir çıktının SONRADAN `validate()`'i geçememesi
   * (ya da mutabakat anında bir tavanın kağıt üzerinde aşılmış görünmesi)
   * zaten GERÇEKLEŞMİŞ bir maliyeti asla SİLEMEZ (bölüm 147, "sessiz
   * harcama yok") — bu yüzden burada `assertWithinBudget` TEKRAR
   * ÇAĞRILMAZ. Aşım yine de AuditLog'a `overages` olarak kaydedilir
   * (görünürlük için), ama harcamanın kendisi HER ZAMAN kaydedilir.
   * Rezervasyon zaten mevcut değilse (örn. `commit()`/`release()` daha
   * önce çağrılmışsa) UnknownReservationError fırlatır — aynı
   * rezervasyonun İKİ KEZ mutabakata varılması yapısal olarak
   * imkânsızdır.
   *
   * P1 fix (11th independent review round, "failed reconciliation
   * releases reservation before cost is safely recorded"): Codex
   * reproduced: bir rezervasyon var, mutabakat BAŞLAR, rezervasyon ÖNCE
   * SİLİNİR, ardından `entry.amountUsd` (ör. NaN) doğrulaması BAŞARISIZ
   * OLUR — rezervasyon artık YOK, hiçbir maliyet KAYDEDİLMEDİ, ve
   * korunan bütçe kapasitesi SESSİZCE geri gelir: başka (tam tavanlık)
   * bir rezervasyon şimdi başarıyla oluşturulabilir, üstelik GERÇEK (ya
   * da potansiyel olarak gerçek) bir provider çağrısı zaten olmuş
   * olabilir. Kök neden: silme İŞLEMİ, doğrulama/kayıt BAŞARIYLA
   * tamamlanmadan ÖNCE gerçekleşiyordu. Fix: sıra TERSİNE ÇEVRİLDİ —
   * `assertValidMonetaryAmount` VE `costEngine.record()` artık
   * rezervasyon HÂLÂ AÇIKKEN çalışır; rezervasyon SADECE bu ikisi
   * GERÇEKTEN başarılı olduktan SONRA silinir. Doğrulama veya kayıt
   * BAŞARISIZ olursa: rezervasyon KORUNUR (silinmez — bu yüzden
   * `reservedTotal()` üzerinden HÂLÂ her tavana karşı sayılmaya devam
   * eder, "korunan bütçe kapasitesi" asla sessizce serbest kalmaz),
   * başarısızlık BUDGET_RESERVATION_COMMIT_FAILED olarak audit'e
   * KAYDEDİLİR (sessiz değil — mutabakatın ÇÖZÜLMEMİŞ kaldığının
   * kanıtı), ve hata YENİDEN fırlatılır (fail closed). Rezervasyon hâlâ
   * açık olduğundan, çağıran DAHA SONRA (ör. gerçek tutar netleştiğinde)
   * `commit()`'i AYNI `reservationId` ile GÜVENLE TEKRAR deneyebilir —
   * yeniden deneme doğası gereği güvenlidir (idempotent), çünkü
   * rezervasyon hâlâ oradadır.
   */
  commit(
    reservationId: string,
    entry: {
      taskId: string;
      agentId?: string;
      projectId?: string;
      // P1 fix (30th independent review round, finding 1, "preserve run
      // identity through reservation commits"): this type used to omit
      // `runId` entirely, so even a reservation created with one (via
      // `reserve()`'s `ReservationOwnership`) had it silently DROPPED the
      // moment it was committed — `commitReservation()`'s `record()` call
      // only ever recorded the fields THIS type declared, and `runId`
      // wasn't one of them. The committed `CostEntry` then carried no
      // `runId` at all, so `perRunUsd`'s `totalFor({ runId })` scoping
      // (round 29, finding 7) silently stopped counting it — a run's own
      // ALREADY-COMMITTED spend vanished from its own ceiling the instant
      // it was committed, letting a same-run follow-up reservation succeed
      // as if that spend never happened. Adding `runId` here — and to
      // `ownershipMismatches()` (bkz. cost-engine.ts) — closes both ends:
      // the recorded entry now keeps the reservation's own `runId`, and a
      // caller committing under a mismatched `runId` fails closed exactly
      // like a mismatched `taskId`/`projectId`/`agentId` always has.
      runId?: string;
      provider: string;
      modelId: string;
      amountUsd: number;
    }
  ) {
    // P1 fix (27th independent review round, finding 7, "snapshot spend
    // entries before checking them" — same root class, applied here too):
    // `entry` used to be read repeatedly across this method (the
    // `commitReservation()` call, the ownership-mismatch audit payload,
    // the commit-failed audit payload, the overages check) — several
    // SEPARATE reads of a caller-owned object that, if getter/Proxy-
    // backed, could answer differently each time. `snapshot` captures
    // every field exactly once, up front; every reference below uses it,
    // never the original `entry` parameter again.
    const snapshot = { ...entry };
    const reservation = this.#costEngine.getReservation(reservationId);
    if (!reservation) {
      throw new UnknownReservationError(reservationId);
    }

    // P1 fix (25th independent review round, "reservation ownership must
    // be validated inside CostEngine"): the ownership-mismatch check
    // (taskId/projectId/agentId always compared; provider/modelId
    // compared only when the reservation itself recorded them) used to be
    // performed HERE, in `BudgetGuard`, before ever calling into
    // `CostEngine`. It now lives in `CostEngine.commitReservation()`
    // itself (bkz. cost-engine.ts'in `ownershipMismatches()`/
    // `ReservationOwnershipMismatchError`'ın üstündeki fix notu) — the
    // SAME check the reservation's OWN authoritative `scope` enforces,
    // but now holding even for a caller that talks to `CostEngine`
    // directly, bypassing this `BudgetGuard` entirely. This method's job
    // is now just to translate that outcome into the SAME audit events as
    // before.
    let recorded: CostEntry;
    try {
      recorded = this.#costEngine.commitReservation(reservationId, snapshot);
    } catch (err) {
      if (err instanceof ReservationOwnershipMismatchError) {
        // P1 fix (26th independent review round, finding 3, "reservation
        // ownership evidence must not be forgeable"): this event used to
        // include `reservedScope: reservation.scope` — the reservation's
        // TRUE authoritative ownership, read via `getReservation()` BEFORE
        // this call even knew whether `reservationId` legitimately belongs
        // to this caller. `getReservation()` no longer returns `scope` at
        // all (bkz. cost-engine.ts'in üstündeki fix notu), so that read is
        // no longer possible here — and it would have been exactly as
        // exploitable as calling `getReservation()` directly, since this
        // method's own `reservationId` parameter is attacker-controlled
        // input. Only the CALLER'S OWN supplied values are recorded now
        // (they already possess this data — echoing it back discloses
        // nothing new); a legitimate reviewer can still recover the true
        // scope by cross-referencing this reservation's own
        // `BUDGET_RESERVATION_CREATED` audit event by `reservationId`.
        this.#auditLog?.append({
          type: "BUDGET_RESERVATION_OWNERSHIP_MISMATCH",
          actor: "budget-guard",
          payload: {
            reservationId,
            suppliedTaskId: snapshot.taskId,
            suppliedProjectId: snapshot.projectId,
            suppliedAgentId: snapshot.agentId,
            suppliedRunId: snapshot.runId,
            suppliedProvider: snapshot.provider,
            suppliedModelId: snapshot.modelId
          },
          timestamp: this.#now().toISOString()
        });
        throw err;
      }
      // Ownership already matched `snapshot` at this point — `commitReservation()`
      // checks ownership BEFORE validating the amount — so `snapshot`'s own
      // identity fields are provably the reservation's authoritative scope
      // here, safe to log without any privileged read.
      this.#auditLog?.append({
        type: "BUDGET_RESERVATION_COMMIT_FAILED",
        actor: "budget-guard",
        payload: {
          reservationId,
          confirmedScope: {
            taskId: snapshot.taskId,
            projectId: snapshot.projectId,
            agentId: snapshot.agentId,
            runId: snapshot.runId,
            provider: snapshot.provider,
            modelId: snapshot.modelId
          },
          reservedAmountUsd: reservation.amountUsd,
          attemptedActualAmountUsd: snapshot.amountUsd,
          reason: err instanceof Error ? err.message : String(err)
        },
        timestamp: this.#now().toISOString()
      });
      throw err;
    }

    const overages = this.buildCeilingChecks(
      { taskId: snapshot.taskId, projectId: snapshot.projectId, runId: snapshot.runId },
      0
    ).filter((check) => exceedsMonetaryAmount(check.projected, check.limit));

    this.#auditLog?.append({
      type: "BUDGET_RESERVATION_COMMITTED",
      actor: "budget-guard",
      payload: {
        reservationId,
        confirmedScope: {
          taskId: snapshot.taskId,
          projectId: snapshot.projectId,
          agentId: snapshot.agentId,
          provider: snapshot.provider,
          modelId: snapshot.modelId
        },
        reservedAmountUsd: reservation.amountUsd,
        actualAmountUsd: snapshot.amountUsd,
        entry: recorded,
        overages
      },
      timestamp: this.#now().toISOString()
    });

    return recorded;
  }

  /**
   * Provider çağrısı BAŞARISIZ olduğunda (istisna fırlattığında) çağrılır
   * — belgelenen mutabakat kuralı budur: HİÇBİR gerçek maliyet
   * OLUŞMADIĞI varsayılır (bu depodaki MockProvider için doğru olan
   * varsayım), bu yüzden rezervasyon hiçbir kayıt oluşturmadan tamamen
   * SERBEST BIRAKILIR. Kısmi faturalandırma yapabilen GERÇEK bir provider
   * adaptörü bunun yerine `commit()`'i KISMİ gerçek tutarla çağırmalıdır
   * — bu P0 kapsamının dışındadır.
   *
   * P1 fix (12th independent review round, "failed reconciliation
   * reservations can still be released"): Codex reproduced reserve() ->
   * commit(NaN) (fails, reservation KORUNUR per the 11th round's fix) ->
   * release() — release() had NO concept of a reservation being in an
   * unresolved-reconciliation state, so it happily deleted it anyway,
   * silently restoring the FULL protected capacity even though the
   * provider call the reservation was protecting may already have
   * happened. `release()` is documented as being for the "the provider
   * call itself threw, nothing was ever incurred" case ONLY — it must
   * NEVER become a backdoor for "reconciliation failed, so let's just
   * pretend nothing happened." Fixed: `release()` now checks
   * `reservation.status` and REJECTS
   * (`UnresolvedReconciliationError`, without deleting anything) a
   * reservation whose prior `commit()` attempt failed — bkz.
   * `ReservationStatus`'ın üstündeki not. An ordinary "ACTIVE" reservation
   * (the normal, documented provider-failure case) is released exactly
   * as before.
   */
  /**
   * P1 fix (25th independent review round, "callers must not release
   * someone else's active reservation"): `release()` used to take ONLY a
   * reservation id — a caller who merely LEARNED another caller's
   * (predictable, sequential) reservation id could release it, freeing
   * protected capacity that was never theirs to free. `callerScope` is
   * now a REQUIRED parameter, forwarded unchanged to
   * `CostEngine.releaseReservation()`, which validates it against the
   * reservation's own authoritative scope BEFORE any deletion (bkz.
   * cost-engine.ts'in üstündeki fix notu). Every legitimate caller
   * already has this scope on hand — it is the SAME `scope` returned by
   * the original `reserve()` call (`Reservation.scope`).
   */
  release(reservationId: string, callerScope: ReservationOwnership): void {
    // P1 fix (24th independent review round, "reservation deletion must
    // not bypass reconciliation"): the RECONCILIATION_FAILED protection
    // now lives in `CostEngine.releaseReservation()` itself (bkz.
    // cost-engine.ts'in üstündeki fix notu), so it holds regardless of
    // whether the caller goes through this `BudgetGuard` or talks to the
    // ledger directly — this method's own job is now just translating
    // that outcome into the SAME audit events/error types as before.
    let released: LedgerReservation;
    try {
      released = this.#costEngine.releaseReservation(reservationId, callerScope);
    } catch (err) {
      if (err instanceof UnresolvedReconciliationError) {
        // P1 fix (26th independent review round, finding 3, "reservation
        // ownership evidence must not be forgeable"): this used to log
        // `scope: reservation?.scope` — the reservation's TRUE
        // authoritative ownership, obtained via `getReservation()`. At
        // this point in `releaseReservation()`, ownership has NOT even
        // been checked yet (the RECONCILIATION_FAILED check runs BEFORE
        // the ownership check) — so this read happened regardless of
        // whether `callerScope` was legitimate, handing the true scope to
        // ANY caller who merely names a RECONCILIATION_FAILED reservation
        // id. `getReservation()` no longer returns `scope` at all (bkz.
        // cost-engine.ts), closing this read entirely; `amountUsd` remains
        // safe to log (it plays no role in the ownership check).
        const reservation = this.#costEngine.getReservation(reservationId);
        this.#auditLog?.append({
          type: "BUDGET_RESERVATION_RELEASE_REJECTED_UNRESOLVED",
          actor: "budget-guard",
          payload: { reservationId, amountUsd: reservation?.amountUsd },
          timestamp: this.#now().toISOString()
        });
      } else if (err instanceof ReservationOwnershipMismatchError) {
        this.#auditLog?.append({
          type: "BUDGET_RESERVATION_RELEASE_REJECTED_OWNERSHIP_MISMATCH",
          actor: "budget-guard",
          payload: { reservationId, suppliedScope: callerScope },
          timestamp: this.#now().toISOString()
        });
      }
      throw err;
    }

    this.#auditLog?.append({
      type: "BUDGET_RESERVATION_RELEASED",
      actor: "budget-guard",
      payload: { reservationId, scope: released.scope, amountUsd: released.amountUsd },
      timestamp: this.#now().toISOString()
    });
  }
}
