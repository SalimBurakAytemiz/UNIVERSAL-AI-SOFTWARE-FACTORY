// Baseline section 69 (Cost Engine): her görev/ajan/model/sağlayıcı
// çağrısının maliyeti izlenir. "Sessiz harcama yok" ilkesi (bölüm 147)
// burada başlar — bir tutar bu motora kaydedilmeden harcanmış sayılmaz.

import { randomBytes } from "node:crypto";
import { freezeRecord } from "../util/immutable.js";
import type { StateStore } from "../state/file-store.js";
import { acquireFileLock, type FileLockOptions } from "../cache/file-lock.js";

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

export class InvalidCostEntryIdentityError extends Error {
  constructor(context: string, reason: string) {
    super(
      `Refusing to record cost entry in ${context}: ${reason}. A live entry that fails this exact check is ` +
        `one 'assertValidPersistedCostState()' (bkz. bu dosyanın restore-time doğrulaması) would ALSO reject ` +
        `on the next restart — accepting it now would durably persist a live write that restore then refuses, ` +
        `silently making genuinely-incurred spend unrecoverable after a restart (baseline section 147, 277).`
    );
    this.name = "InvalidCostEntryIdentityError";
  }
}

/**
 * P2 fix (36th independent review round, finding 10, "enforce restore-time
 * identity checks before record() persistence"): `record()`/`#recordCommitted()`
 * used to validate ONLY `amountUsd` (via `assertValidMonetaryAmount()`) before
 * persisting a `CostEntry` — `taskId`/`provider`/`modelId` (required, per the
 * `CostEntry` interface above) and `agentId`/`projectId`/`runId` (optional, but
 * must be a string when present) were never checked at all. Meanwhile
 * `assertValidPersistedCostState()` (bkz. aşağısı, `#loadFromStore()`'un
 * kendi restore-time doğrulaması) DOES reject an entry whose `taskId`/
 * `provider`/`modelId` is an empty string or non-string. That asymmetry is
 * exactly this codebase's own "the record actually stored and what a later
 * read of it accepts disagree" defect class (bkz. `audit-log.ts`'nin
 * Map/Set/undefined fix notları, aynı kök sınıf): a caller could `record()`
 * an entry with `taskId: ""` today — it is accepted, pushed into `#entries`,
 * durably persisted (if `persistence` is configured) — and the NEXT process
 * restart's `#loadFromStore()` would refuse to load that exact same entry
 * (`CorruptCostStateError`), taking the ENTIRE cost ledger down with it, not
 * merely that one entry. Fixed by validating EVERY identity field `record()`
 * accepts against the EXACT SAME rule restore uses, at the SAME shared choke
 * point (`#recordSnapshot()`, bkz. aşağısı) both `record()` and
 * `#recordCommitted()` already funnel through before ANY mutation or
 * persistence — so "would restore reject this?" is answered, and enforced,
 * BEFORE `this.#entries.push()` ever runs, never only after the fact.
 */
function assertValidCostEntryIdentity(entry: Omit<CostEntry, "timestamp" | "reservationId">, context: string): void {
  if (typeof entry.taskId !== "string" || entry.taskId.length === 0) {
    throw new InvalidCostEntryIdentityError(context, "taskId is not a non-empty string");
  }
  if (typeof entry.provider !== "string" || entry.provider.length === 0) {
    throw new InvalidCostEntryIdentityError(context, "provider is not a non-empty string");
  }
  if (typeof entry.modelId !== "string" || entry.modelId.length === 0) {
    throw new InvalidCostEntryIdentityError(context, "modelId is not a non-empty string");
  }
  if (entry.agentId !== undefined && typeof entry.agentId !== "string") {
    throw new InvalidCostEntryIdentityError(context, "agentId is neither a string nor undefined");
  }
  if (entry.projectId !== undefined && typeof entry.projectId !== "string") {
    throw new InvalidCostEntryIdentityError(context, "projectId is neither a string nor undefined");
  }
  if (entry.runId !== undefined && typeof entry.runId !== "string") {
    throw new InvalidCostEntryIdentityError(context, "runId is neither a string nor undefined");
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
  /**
   * P1 fix (29th independent review round, finding 7, "per-run budget must
   * be scoped to the actual run"): mirrors how `agentId`/`projectId` were
   * each added as an OPTIONAL ownership dimension in earlier rounds —
   * `runId` is the same kind of minimal, additive primitive, threaded ONLY
   * as far as `CostEngine`/`BudgetGuard` need it to scope a ceiling
   * correctly. See `CostScope.runId`'s fix note below for the full
   * rationale, and `budget.ts`'s `buildCeilingChecks()` for the actual
   * `perRunUsd` fix this enables.
   */
  readonly runId?: string;
  readonly provider: string;
  readonly modelId: string;
  readonly amountUsd: number;
  readonly timestamp: string;
  /**
   * P1 fix (29th independent review round, finding 1, "make persisted cost
   * commits atomic/idempotent"): set ONLY by `commitReservation()` (never
   * by a direct `record()` call outside a reservation) to the reservation's
   * OWN id — the durable identity `commitReservation()` uses to recognize
   * "this reservation's real cost was already recorded" on a retry. See
   * `commitReservation()`'s fix note below for the full rationale.
   */
  readonly reservationId?: string;
}

/**
 * P1 fix (29th independent review round, finding 7, "per-run budget must
 * be scoped to the actual run"): Codex reproduced `BudgetGuard`'s
 * `perRunUsd` ceiling check (bkz. `runtime/budget/budget.ts`'s
 * `buildCeilingChecks()`) summing `this.#costEngine.total()` — the
 * ENTIRE shared, durable ledger's cumulative lifetime spend, across EVERY
 * invocation that has EVER used this `CostEngine` instance, not just the
 * current run — meaning a SECOND run sharing the same durable ledger
 * (the ordinary, intended way this repo's `CostEngine` persists across
 * process restarts, bkz. bu dosyanın round 28 fix notu) starts with
 * ZERO fresh `perRunUsd` capacity of its own; it inherits whatever the
 * FIRST run already spent, even though "per RUN" (bölüm 70-72) is
 * explicitly meant to bound a single supervised iteration, not the
 * ledger's entire lifetime. `runId` is the missing ownership dimension
 * that lets a caller who DOES have a genuine run identity scope a
 * reservation/entry to it — added the SAME additive, optional way
 * `agentId`/`projectId` already were: every EXISTING caller that never
 * supplies `runId` sees `matchesScope()`'s `runId` check degrade to
 * "matches everything" (bkz. aşağıdaki `matchesScope()`), so `perRunUsd`'s
 * behavior is UNCHANGED for any caller not yet passing one — this is
 * additive plumbing, not a forced behavior change on 200+ existing call
 * sites, matching this exact same class's prior `agentId` addition.
 */
export interface CostScope {
  readonly taskId?: string;
  readonly agentId?: string;
  readonly projectId?: string;
  readonly runId?: string;
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

/** The internal, mutable-ledger shape a reservation is stored under in `#reservations` — never exported as mutable state (bkz. `LedgerReservation`/`ReservationView` for the frozen, external-facing shapes). */
interface ReservationEntry {
  readonly scope: Readonly<ReservationOwnership>;
  readonly amountUsd: number;
  readonly status: ReservationLedgerStatus;
}

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
  constructor(operation: "commit" | "release" | "reconcile", reservationId: string, _reservationScope: Readonly<ReservationOwnership>, suppliedScope: ReservationOwnership) {
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

/**
 * P1 fix (28th independent review round, finding 4, "persist cost entries
 * and reservations across restarts"): committed spend (`#entries`) and
 * open/protected reservations (`#reservations`) used to exist ONLY in
 * this class's in-memory state — a process restart (deploy, crash,
 * scheduled restart) silently lost the ENTIRE cost ledger: every already-
 * incurred, genuinely-spent dollar simply vanished from every future
 * ceiling check (baseline section 147's "no silent spending" cuts both
 * ways — losing evidence of REAL spend is just as much a violation as
 * fabricating spend that never happened), daily/monthly windows reset to
 * zero regardless of what was truly spent earlier that period, and any
 * `RECONCILIATION_FAILED` reservation (protecting capacity because a
 * provider call may already have incurred real, unresolved cost) lost its
 * protection entirely, becoming silently releasable again after restart.
 * Fixed with an OPTIONAL `persistence: { store: StateStore; path: string }`
 * constructor parameter — using the SAME `StateStore` abstraction
 * `runtime/state/file-store.ts` already provides for `project-lifecycle/
 * orchestrator.ts`'s own durable state (bölüm 275/277), not a new
 * persistence mechanism. When supplied: the constructor synchronously
 * restores any existing persisted state (validated — see
 * `assertValidPersistedCostState()` below, fail closed on anything
 * malformed) BEFORE this instance is usable, and every mutating operation
 * (`record()`/`createReservation()`/`commitReservation()`/
 * `releaseReservation()`/`markReservationReconciliationFailed()`)
 * synchronously persists the updated state afterward via the SAME
 * atomic-write `FileStateStore.write()` this codebase's other durable
 * state already relies on (temp-file-then-rename, so a crash mid-write
 * can never corrupt the previously-good durable file). Omitting
 * `persistence` preserves the exact prior in-memory-only behavior for any
 * caller (tests, ephemeral single-process usage) that does not need
 * cross-restart durability — this is an additive, backward-compatible
 * constructor parameter; none of the 200+ existing `new CostEngine()`/
 * `new CostEngine(now)` call sites change.
 */
export class CorruptCostStateError extends Error {
  constructor(reason: string) {
    super(
      `Refusing to restore persisted cost-engine state: ${reason}. Malformed/corrupt persisted cost state ` +
        `fails closed (baseline section 147, 277) rather than being silently discarded or coerced — silently ` +
        `discarding it would make genuinely-incurred, already-recorded spend disappear, and silently coercing ` +
        `it risks poisoning every future ceiling check with garbage.`
    );
    this.name = "CorruptCostStateError";
  }
}

interface PersistedCostEntry {
  readonly taskId: string;
  readonly agentId?: string;
  readonly projectId?: string;
  readonly runId?: string;
  readonly provider: string;
  readonly modelId: string;
  readonly amountUsd: number;
  readonly timestamp: string;
  readonly reservationId?: string;
}

interface PersistedReservation {
  readonly id: string;
  readonly scope: ReservationOwnership;
  readonly amountUsd: number;
  readonly status: ReservationLedgerStatus;
}

interface PersistedCostState {
  readonly entries: readonly PersistedCostEntry[];
  readonly reservations: readonly PersistedReservation[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertValidPersistedScope(scope: unknown, context: string): asserts scope is ReservationOwnership {
  if (!isPlainObject(scope)) {
    throw new CorruptCostStateError(`${context}.scope is not a plain object`);
  }
  for (const key of ["taskId", "agentId", "projectId", "runId", "provider", "modelId"]) {
    const value = scope[key];
    if (value !== undefined && typeof value !== "string") {
      throw new CorruptCostStateError(`${context}.scope.${key} is neither a string nor undefined`);
    }
  }
}

/**
 * Restore edilen JSON'ın gerçekten geçerli bir `PersistedCostState` olduğunu
 * doğrular — bir dosya sistemi/deserileştirme hatası, elle düzenleme veya
 * eski/uyumsuz bir şema ASLA sessizce kabul edilip toplamları zehirlemez
 * (bkz. bu sınıfın üstündeki fix notu, "no silent spending" hem yönde de
 * geçerlidir).
 */
function assertValidPersistedCostState(data: unknown): asserts data is PersistedCostState {
  if (!isPlainObject(data)) {
    throw new CorruptCostStateError("root value is not a plain object");
  }
  if (!Array.isArray(data.entries)) {
    throw new CorruptCostStateError("'entries' is not an array");
  }
  if (!Array.isArray(data.reservations)) {
    throw new CorruptCostStateError("'reservations' is not an array");
  }
  data.entries.forEach((entry: unknown, index: number) => {
    if (!isPlainObject(entry)) {
      throw new CorruptCostStateError(`entries[${index}] is not a plain object`);
    }
    if (typeof entry.taskId !== "string" || entry.taskId.length === 0) {
      throw new CorruptCostStateError(`entries[${index}].taskId is not a non-empty string`);
    }
    if (typeof entry.provider !== "string" || entry.provider.length === 0) {
      throw new CorruptCostStateError(`entries[${index}].provider is not a non-empty string`);
    }
    if (typeof entry.modelId !== "string" || entry.modelId.length === 0) {
      throw new CorruptCostStateError(`entries[${index}].modelId is not a non-empty string`);
    }
    if (typeof entry.timestamp !== "string" || !isCanonicalIsoTimestamp(entry.timestamp)) {
      throw new CorruptCostStateError(
        `entries[${index}].timestamp is not a canonical ISO-8601 timestamp string ` +
          `(must exactly match Date.prototype.toISOString()'s own output format)`
      );
    }
    if (entry.agentId !== undefined && typeof entry.agentId !== "string") {
      throw new CorruptCostStateError(`entries[${index}].agentId is neither a string nor undefined`);
    }
    if (entry.projectId !== undefined && typeof entry.projectId !== "string") {
      throw new CorruptCostStateError(`entries[${index}].projectId is neither a string nor undefined`);
    }
    if (entry.runId !== undefined && typeof entry.runId !== "string") {
      throw new CorruptCostStateError(`entries[${index}].runId is neither a string nor undefined`);
    }
    if (entry.reservationId !== undefined && typeof entry.reservationId !== "string") {
      throw new CorruptCostStateError(`entries[${index}].reservationId is neither a string nor undefined`);
    }
    try {
      assertValidMonetaryAmount(entry.amountUsd as number, `restored entries[${index}]`);
    } catch (err) {
      throw new CorruptCostStateError(`entries[${index}].amountUsd is invalid (${String(err)})`);
    }
  });
  // P1 fix (31st independent review round, finding 4, "reject duplicate
  // reservation IDs during ledger restore"): `#loadFromStore()` (bkz.
  // aşağısı) inserts each validated reservation into `#reservations` via
  // `Map.set(r.id, ...)` — a persisted/corrupt ledger file containing TWO
  // reservation records that happen to share the same `id` (a hand edit,
  // a merge conflict, or a corrupted write) would have the Map silently
  // OVERWRITE the first with the second, with no error and no trace —
  // the first reservation's protected capacity (and, if it had already
  // gone RECONCILIATION_FAILED, its unresolved-cost protection) simply
  // vanishes from authoritative state. Fixed the same way this function
  // already refuses every other invalid persisted record: reject the
  // WHOLE restore, before a single reservation ever reaches
  // `#reservations`, the moment any two records share an id.
  const seenReservationIds = new Set<string>();
  data.reservations.forEach((reservation: unknown, index: number) => {
    if (!isPlainObject(reservation)) {
      throw new CorruptCostStateError(`reservations[${index}] is not a plain object`);
    }
    if (typeof reservation.id !== "string" || reservation.id.length === 0) {
      throw new CorruptCostStateError(`reservations[${index}].id is not a non-empty string`);
    }
    if (seenReservationIds.has(reservation.id)) {
      throw new CorruptCostStateError(
        `reservations[${index}].id '${reservation.id}' duplicates an earlier reservation's id — restoring both ` +
          `would let Map insertion silently discard one of them`
      );
    }
    seenReservationIds.add(reservation.id);
    assertValidPersistedScope(reservation.scope, `reservations[${index}]`);
    try {
      assertValidMonetaryAmount(reservation.amountUsd as number, `restored reservations[${index}]`);
    } catch (err) {
      throw new CorruptCostStateError(`reservations[${index}].amountUsd is invalid (${String(err)})`);
    }
    if (reservation.status !== "ACTIVE" && reservation.status !== "RECONCILIATION_FAILED") {
      throw new CorruptCostStateError(`reservations[${index}].status is neither "ACTIVE" nor "RECONCILIATION_FAILED"`);
    }
  });
}

/**
 * P1 fix (29th independent review round, finding 6, "persisted cost
 * timestamps must be canonical"): the previous check
 * (`!Number.isNaN(Date.parse(entry.timestamp))`) only proved the string
 * was SOME date `Date.parse()` happens to understand — `Date.parse()`
 * accepts a wide, implementation-defined range of non-ISO-8601 formats
 * (date-only strings, space instead of "T", missing milliseconds/timezone,
 * locale-ish forms), several of which are ALSO fed into engine-specific
 * fallback parsing with no cross-engine guarantee. `totalInWindow()`
 * (bkz. aşağıdaki metot) does a plain LEXICAL (string) comparison —
 * `e.timestamp >= sinceIso` — which is only chronologically correct when
 * EVERY timestamp shares the exact canonical form `record()` itself always
 * produces (`Date.prototype.toISOString()`: `YYYY-MM-DDTHH:mm:ss.sssZ`).
 * A persisted entry in ANY other Date.parse-able-but-differently-shaped
 * form (e.g. a date-only string, or a timezone-offset instead of `Z`)
 * could sort BEFORE `sinceIso` lexically even though it genuinely falls
 * WITHIN the current day/month — silently vanishing from daily/monthly
 * budget ceiling totals despite being real, already-incurred spend
 * (baseline section 147's "no silent spending" cuts both ways — see this
 * file's own persistence fix note above). Fixed: a persisted timestamp is
 * now required to be in EXACTLY the canonical form — verified by a
 * round-trip (`new Date(value).toISOString() === value`), which only ever
 * holds for a string already in that one canonical shape — rather than
 * merely "parseable somehow." Fail closed on anything else, per this
 * file's established persisted-state philosophy.
 */
function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

/**
 * P1 fix (30th independent review round, finding 1, "preserve run identity
 * through reservation commits"): `runId` (round 29's addition to
 * `CostScope`/`ReservationOwnership`, for `perRunUsd` scoping) was never
 * compared here — a caller committing under a DIFFERENT (or omitted)
 * `runId` than the one the reservation was actually created under passed
 * this check regardless, exactly like `taskId`/`projectId`/`agentId`
 * always have been compared. Added the same way those three are: an
 * unconditional equality check (both sides default to `undefined` when a
 * caller never supplies one, so this is a no-op for every pre-existing
 * caller that doesn't use `runId` at all).
 */
function ownershipMismatches(reservationScope: Readonly<ReservationOwnership>, suppliedScope: ReservationOwnership): boolean {
  const reservedProvider = reservationScope.provider;
  const reservedModelId = reservationScope.modelId;
  return (
    suppliedScope.taskId !== reservationScope.taskId ||
    suppliedScope.projectId !== reservationScope.projectId ||
    suppliedScope.agentId !== reservationScope.agentId ||
    suppliedScope.runId !== reservationScope.runId ||
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
  #reservations = new Map<string, ReservationEntry>();
  #reservationSeq = 0;

  /**
   * `now` enjekte edilebilir bir saat fonksiyonudur — varsayılan olarak
   * gerçek zamanı kullanır, ancak testler (özellikle günlük/aylık bütçe
   * sıfırlanma senaryoları) belirli bir ana "sabitlenmiş" kayıtlar
   * üretebilmek için bunu değiştirebilir (bkz. runtime/budget/budget.ts).
   *
   * P1 fix (28th independent review round, finding 6, "make cost ledger
   * clock runtime-private" — same root class as this file's own `#entries`/
   * `#reservations`/`#reservationSeq`, round 26 finding 2): this used to be
   * a TypeScript compile-time-only `private readonly` constructor-parameter
   * property — an ordinary, enumerable instance property in the emitted
   * JS. `(engine as any).now = () => new Date("2099-01-01")` from any
   * caller holding a `CostEngine` reference would silently backdate/
   * future-date every subsequently recorded `CostEntry.timestamp`, which
   * `totalInWindow()`'s daily/monthly ceiling queries compare directly —
   * an attacker could make every future spend appear to fall outside the
   * current period (or, backdating, poison a PAST period's total).
   * Converted to a genuine ECMAScript `#now` private field.
   */
  readonly #now: () => Date;

  /**
   * P1 fix (28th independent review round, finding 4, "persist cost
   * entries and reservations across restarts"): when supplied, this
   * ledger's mutating state is durably synchronized to `persistence.store`
   * — see the fix note above this class for the full rationale.
   */
  readonly #persistenceStore?: StateStore;
  readonly #persistencePath?: string;
  readonly #lockOptions?: FileLockOptions;

  constructor(
    now: () => Date = () => new Date(),
    persistence?: { readonly store: StateStore; readonly path: string; readonly lockOptions?: FileLockOptions }
  ) {
    this.#now = now;
    if (persistence) {
      this.#persistenceStore = persistence.store;
      this.#persistencePath = persistence.path;
      this.#lockOptions = persistence.lockOptions;
      this.#loadFromStore();
    }
  }

  /**
   * `this.#entries`/`#reservations`/`#reservationSeq`'i, `#persistenceStore`'un
   * O ANKİ (mümkün olan en güncel) içeriğiyle DEĞİŞTİRİR — yapıcı ve
   * `#withDurableMutation()`'ın kilit altındaki kritik bölümü tarafından
   * paylaşılan tek kaynak (bkz. `#withDurableMutation()`'ın fix notu, 30th
   * independent review round finding 3).
   */
  #loadFromStore(): void {
    if (!this.#persistenceStore || this.#persistencePath === undefined) return;
    const restored: unknown = this.#persistenceStore.read(this.#persistencePath);
    if (restored === undefined) return;
    assertValidPersistedCostState(restored);
    this.#entries = restored.entries.map((e) => freezeRecord({ ...e }));
    this.#reservations = new Map();
    let maxSeq = 0;
    for (const r of restored.reservations) {
      this.#reservations.set(r.id, { scope: freezeRecord({ ...r.scope }), amountUsd: r.amountUsd, status: r.status });
      const match = /^res-(\d+)-/.exec(r.id);
      if (match) maxSeq = Math.max(maxSeq, Number(match[1]));
    }
    this.#reservationSeq = maxSeq;
  }

  /**
   * P1 fix (30th independent review round, finding 3, "serialize persistent
   * cost-ledger updates"): every one of this class's mutating public
   * methods (`record()`/`createReservation()`/`commitReservation()`/
   * `releaseReservation()`/`markReservationReconciliationFailed()`) used to
   * mutate `this.#entries`/`#reservations` — populated ONCE, at
   * CONSTRUCTION time — and then unconditionally OVERWRITE the entire
   * durable file with that in-memory state via `#persist()`. Codex
   * reproduced the classic cross-instance "lost update" this causes: two
   * `CostEngine` instances sharing the same `persistence.path` (the
   * ordinary way two processes — or even two objects in one process —
   * cooperate on one durable ledger) each read the file ONCE at
   * construction; if instance A commits a real cost AFTER instance B was
   * constructed, B's own next mutation still overwrites the ENTIRE file
   * from its own (now stale) in-memory copy — silently ERASING A's
   * already-durably-recorded spend the moment B persists, with no error,
   * no conflict, and no trace (baseline section 147's "no silent
   * spending" forbids exactly this: a real, previously recorded cost
   * disappearing). Fixed the SAME way `runtime/cache/file-cache.ts`'s
   * `set()` already fixed the identical class of bug (16th independent
   * review round): every mutating method now runs its ENTIRE body inside
   * `#withDurableMutation()`, which (only when persistence is configured —
   * an in-memory-only engine has no shared file to race over, so it runs
   * `mutator` directly) acquires a REAL cross-process `acquireFileLock()`
   * (bkz. runtime/cache/file-lock.ts — the SAME hardened primitive
   * `FileCache` already relies on, not a new locking mechanism), then
   * calls `#loadFromStore()` to replace `this.#entries`/`#reservations`
   * with the LATEST durable content — never a snapshot taken before the
   * lock was acquired — before `mutator` performs its own single
   * domain-level change and persists. Since every mutating method already
   * calls `#persist()` (writing the COMPLETE current in-memory state)
   * before returning on every code path (including failure paths, per
   * this file's own established "no silent spending" persistence
   * philosophy), the durable file is always an accurate reflection of
   * `#entries`/`#reservations` by the time the lock is released — so
   * re-loading it at the START of the NEXT locked mutation (whether on
   * THIS instance or a sibling one) can never lose a committed cost or
   * reservation another instance already durably recorded.
   */
  /**
   * `commitReservation()` calls the PUBLIC `record()` internally (bkz.
   * aşağısı) — both are wrapped in `#withDurableMutation()`, so a naive
   * implementation would try to acquire the SAME cross-process file lock
   * TWICE, from the SAME synchronous call stack, deadlocking against
   * itself (a real OS-level file lock is not reentrant). `#lockDepth`
   * tracks whether THIS instance's own call stack already holds the lock:
   * when it does, the nested call runs `mutator` directly — no re-lock, no
   * re-sync needed, since nothing else could have interleaved while this
   * synchronous call stack has held the lock continuously.
   */
  #lockDepth = 0;

  #withDurableMutation<R>(mutator: () => R): R {
    if (!this.#persistenceStore || this.#persistencePath === undefined) {
      return mutator();
    }
    if (this.#lockDepth > 0) {
      return mutator();
    }
    const release = acquireFileLock(`${this.#persistencePath}.lock`, this.#lockOptions);
    this.#lockDepth++;
    try {
      this.#loadFromStore();
      return mutator();
    } finally {
      this.#lockDepth--;
      release();
    }
  }

  /**
   * P1 fix (31st independent review round, finding 1, "recheck ceilings
   * inside the persistent-ledger lock"): `#withDurableMutation()` above
   * already makes a MUTATION (record/createReservation/commitReservation/
   * releaseReservation) safe against a sibling `CostEngine` instance's
   * concurrent write — but `BudgetGuard.reserve()`/`spend()` (bkz.
   * runtime/budget/budget.ts) each perform a SEPARATE step BEFORE ever
   * calling into one of those mutating methods: reading this engine's
   * CURRENT totals (`totalFor()`/`reservedTotal()`/`totalInWindow()`) to
   * decide whether a ceiling would be exceeded. That read happened
   * OUTSIDE any lock, against whatever this instance's in-memory
   * `#entries`/`#reservations` happened to hold at that moment — which,
   * for two `BudgetGuard`/`CostEngine` instances sharing one persisted
   * ledger, can be arbitrarily stale relative to a sibling instance's own
   * already-durably-committed writes. Codex reproduced: two guards, each
   * over its OWN `CostEngine` instance pointed at the SAME persistence
   * path, each check "$0 committed + $0 reserved + my $0.60" against a
   * $1.00 ceiling, both pass (each reading its own stale, empty-looking
   * ledger), and only THEN does each call `createReservation()` — which
   * IS lock-protected and DOES reload the latest state first, but by then
   * the ceiling decision has already been made against stale data; the
   * reload happens too late to change a decision that was never rechecked
   * against it. Fixed: this method exposes the SAME lock-acquire +
   * reload-latest-state critical section `#withDurableMutation()` already
   * uses, but PUBLICLY, so a caller (`BudgetGuard`) can run its OWN
   * ceiling-check logic — which itself calls back into this engine's
   * `totalFor()`/`reservedTotal()`/`totalInWindow()` read methods — as
   * part of the SAME serialized transaction that then performs the
   * reservation/spend mutation, rather than as a separate, unprotected
   * step beforehand. Because `#lockDepth` is already reentrant (bkz.
   * `#withDurableMutation()`'ın üstündeki not), a mutating call
   * (`createReservation()`/`record()`) made from INSIDE `mutator` here
   * sees `#lockDepth > 0` and runs directly against the state THIS call
   * already reloaded, never re-acquiring or re-reloading — so the ceiling
   * check and the mutation it gates are guaranteed to observe the exact
   * same authoritative snapshot, with no gap in which a sibling instance
   * could interleave. When no persistence is configured, this degrades to
   * a plain synchronous call (identical to `#withDurableMutation()`'s own
   * no-persistence branch) — a single in-memory ledger has no sibling to
   * race against, so there is nothing to serialize.
   */
  withLedgerLock<R>(mutator: () => R): R {
    return this.#withDurableMutation(mutator);
  }

  /**
   * Bu motorun mutasyona uğrayan HER durumunu (`#entries`/`#reservations`)
   * yapılandırılmış kalıcı depoya senkron olarak yazar — `persistence`
   * enjekte edilmediyse hiçbir şey yapmaz (eski, yalnızca-bellek içi
   * davranış korunur). `FileStateStore.write()`'ın ATOMİK (geçici dosya +
   * rename) yazma garantisi sayesinde, bu çağrı sırasında bir çökme,
   * bilinen-son-iyi kalıcı durumu ASLA bozamaz (bkz. file-store.ts).
   */
  #persist(): void {
    if (!this.#persistenceStore || this.#persistencePath === undefined) return;
    const data: PersistedCostState = {
      entries: this.#entries,
      reservations: [...this.#reservations.entries()].map(([id, r]) => ({
        id,
        scope: r.scope,
        amountUsd: r.amountUsd,
        status: r.status
      }))
    };
    this.#persistenceStore.write(this.#persistencePath, data);
  }

  /**
   * P2 fix (36th independent review round, finding 11, "roll back ledger
   * mutations when persistence fails"): every mutating method below used to
   * mutate `#entries`/`#reservations` DIRECTLY (a `.push()`, a `.set()`, a
   * `.delete()`, or — worse — a property write on a reservation object
   * already living inside `#reservations`) and only THEN call `#persist()`.
   * If that `#persist()` call threw (a durable-storage I/O error, a full
   * disk, a permissions change mid-run), the exception propagated to the
   * caller — but the in-memory mutation had ALREADY happened and was never
   * undone. From that point on, for the remaining lifetime of this process,
   * `this.#entries`/`#reservations` (and therefore every `total()`/
   * `totalFor()`/`reservedTotal()` read) reflected a cost or reservation
   * change the durable file never received: RAM said "new state," disk said
   * "old state," and a caller catching the thrown error had no way to know
   * which one was authoritative — exactly the "the record actually stored
   * and what a later read of it accepts disagree" defect class this file's
   * OWN `assertValidPersistedCostState()` already exists to prevent for
   * MALFORMED data, now reproduced for a WELL-FORMED mutation whose
   * persistence merely failed. Fixed by inverting the order at every call
   * site: each mutating method now computes the COMPLETE next
   * `entries`/`reservations` snapshot WITHOUT touching the live fields, then
   * calls this method — which stages that snapshot onto the live fields,
   * attempts `#persist()`, and on failure immediately restores the exact
   * previous `#entries`/`#reservations` references before rethrowing. A
   * caller observing an exception from ANY mutating method is now
   * guaranteed that this engine's in-memory state is byte-for-byte
   * unchanged from before the call — "compute next → persist next →
   * publish next," never "mutate now, persist maybe." This also required
   * making every reservation'S OWN state TRANSITION (e.g.
   * `RECONCILIATION_FAILED`) go through a freshly-constructed reservation
   * object placed into a freshly-copied `Map`, rather than a property write
   * on the object already stored in `#reservations` — see `ReservationEntry`
   * above (now with a `readonly status`, so the compiler itself rejects any
   * future in-place `reservation.status = ...` write) — since mutating that
   * shared object in place would corrupt the "previous" snapshot this
   * method rolls back to, defeating the rollback entirely.
   */
  #publish(nextEntries: CostEntry[], nextReservations: Map<string, ReservationEntry>): void {
    const previousEntries = this.#entries;
    const previousReservations = this.#reservations;
    this.#entries = nextEntries;
    this.#reservations = nextReservations;
    try {
      this.#persist();
    } catch (err) {
      this.#entries = previousEntries;
      this.#reservations = previousReservations;
      throw err;
    }
  }

  /**
   * P1 fix (32nd independent review round, finding 1, "reservation id must
   * not be caller-forgeable"): this method's parameter type used to be
   * `Omit<CostEntry, "timestamp">` — which STILL includes `reservationId`
   * (an OPTIONAL field on `CostEntry`, so `Omit<..., "timestamp">` does not
   * remove it). Codex reproduced: any ordinary caller holding a
   * `CostEngine` reference (this method has always been public — direct
   * `record()` calls bypassing `BudgetGuard` entirely are an explicitly
   * supported, already-documented path, see this method's own prior fix
   * notes) could call `record({ ..., amountUsd: 0, reservationId: realId })`
   * where `realId` is a genuine, currently-ACTIVE reservation's id (learned
   * legitimately, e.g. as the caller who created it) — `#commitReservationInner()`'s
   * idempotency check (`this.#entries.find((e) => e.reservationId === id)`,
   * added 29th round finding 1 specifically to make a RETRY of a real commit
   * safe) cannot distinguish that forged $0 entry from a genuine prior
   * commit: the next legitimate `commitReservation(realId, actualEntry)`
   * call finds the forged entry, treats it as "already committed", silently
   * DELETES the real reservation, and NEVER records the actual incurred
   * cost — the exact "silent spending" bölüm 147 forbids (a genuine
   * provider cost simply vanishes, protected capacity is freed for nothing).
   * Fixed at the type AND the runtime boundary: `record()`'s public
   * parameter type no longer includes `reservationId` at all, and — since
   * TypeScript's structural typing does not stop a caller who holds a
   * WIDER-typed variable from passing an extra property through at runtime
   * regardless of the parameter's declared type — the snapshot below is
   * built as an explicit field-by-field copy that NEVER reads
   * `entry.reservationId`, so even a caller that manages to pass one (via
   * `as any`, a wider-typed variable, or plain JS with no type checking at
   * all) has it silently ignored, never reaching `#entries`. The ONLY path
   * that may attach a `reservationId` to a `CostEntry` is the private
   * `#recordCommitted()` below, callable exclusively from
   * `#commitReservationInner()` — the one place that has ALREADY validated
   * the reservation exists, is not already committed, and matches the
   * caller's ownership scope. Ordinary cost recording (this method) and
   * reservation-commit recording (`#recordCommitted()`) are now two
   * genuinely separate code paths sharing only their validation/persistence
   * plumbing, exactly as the finding requires — no forged `reservationId`
   * can ever satisfy or remove a real reservation, and a genuine retry of
   * `commitReservation()` on the SAME id remains exactly as idempotent as
   * the 29th round's fix made it (the idempotency check itself, and the
   * entries it matches against, are unchanged — only which callers may
   * PRODUCE a `reservationId`-bearing entry has narrowed).
   */
  record(entry: Omit<CostEntry, "timestamp" | "reservationId">): CostEntry {
    // P1 fix (27th independent review round, finding 7, "snapshot spend
    // entries before checking them" — same root class as
    // runtime/budget/budget.ts's `spend()`/`commit()`): `entry.amountUsd`
    // used to be read HERE (for validation) and then read AGAIN one line
    // below via the `{ ...entry, timestamp }` spread — two separate reads
    // of a caller-owned object that, if getter/Proxy-backed, need not
    // agree. A validated-small/valid amount could differ from the amount
    // that actually ends up durably recorded. Fixed: every field is read
    // ONCE into `snapshot` — a genuine, static plain object, and one that
    // deliberately never reads `entry.reservationId` (see this method's own
    // fix note above) — so validation and the recorded `full` entry both
    // derive from this SAME, reservationId-free snapshot.
    const snapshot: Omit<CostEntry, "timestamp" | "reservationId"> = {
      taskId: entry.taskId,
      agentId: entry.agentId,
      projectId: entry.projectId,
      runId: entry.runId,
      provider: entry.provider,
      modelId: entry.modelId,
      amountUsd: entry.amountUsd
    };
    // Doğrudan record() çağrıları da (BudgetGuard'ı atlayan çağrılar dahil)
    // korunur — bozuk bir tutarın toplamlara sızmasına asla izin verilmez.
    assertValidMonetaryAmount(snapshot.amountUsd, `CostEngine.record(taskId=${snapshot.taskId})`);
    return this.#recordSnapshot(snapshot, undefined);
  }

  /**
   * Ortak yazma/kalıcılaştırma yolu — hem genel `record()` (her zaman
   * `reservationId: undefined`) hem de `#commitReservationInner()`'ın
   * ÖZEL `#recordCommitted()`'ı (her zaman ZATEN doğrulanmış, gerçek bir
   * rezervasyonun kimliğiyle) TARAFINDAN kullanılır — bkz. `record()`'un
   * üstündeki fix notu. `reservationId` parametresi BU dosyanın DIŞINDAN
   * asla erişilemez.
   */
  #recordSnapshot(snapshot: Omit<CostEntry, "timestamp" | "reservationId">, reservationId: string | undefined): CostEntry {
    // P2 fix (36th independent review round, finding 10): bkz.
    // `assertValidCostEntryIdentity()`'in üstündeki fix notu — checked HERE,
    // the ONE shared choke point every `record()`/`#recordCommitted()` call
    // already funnels through, so no future caller of either can ever reach
    // `#entries.push()`/`#persist()` below with an identity restore would
    // refuse.
    assertValidCostEntryIdentity(snapshot, `CostEngine (taskId=${String(snapshot.taskId)})`);
    // P1 fix (30th independent review round, finding 3, "serialize
    // persistent cost-ledger updates"): the actual mutation (push + persist)
    // now runs inside `#withDurableMutation()` — bkz. bu sınıfın üstündeki
    // fix notu — so a sibling `CostEngine` instance's already-durably-
    // recorded entries are always re-synced into memory FIRST, never
    // clobbered by this call's own (otherwise potentially stale) write.
    return this.#withDurableMutation(() => {
      const full: CostEntry = { ...snapshot, reservationId, timestamp: this.#now().toISOString() };
      // İç diziye eklenen nesne İLE dışarı döndürülen nesne KASITLI OLARAK
      // aynı referans DEĞİLDİR: çağıran döndürülen kaydı (ör. amountUsd'yi
      // NaN'a) mutasyona uğratsa bile, iç toplamlar (total/totalFor/
      // totalInWindow) her zaman motorun kendi, asla dışarı sızmamış
      // kopyasını okur. Object.freeze, bu ayrımın atlanamamasını (örn.
      // "as any" ile alan ataması) TypeError'a çevirerek garanti eder.
      // P2 fix (36th independent review round, finding 11): bkz. `#publish()`'in
      // üstündeki fix notu — the next array is computed WITHOUT touching
      // `this.#entries` yet, so a persistence failure inside `#publish()`
      // leaves `this.#entries` completely untouched (rolled back).
      this.#publish([...this.#entries, full], this.#reservations);
      return freezeRecord(full);
    });
  }

  /**
   * `#commitReservationInner()` TARAFINDAN, YALNIZCA zaten var olduğu,
   * henüz commit edilmediği VE çağıranın sahiplik kapsamıyla eşleştiği
   * doğrulanmış GERÇEK bir rezervasyon için çağrılır — bkz. `record()`'un
   * üstündeki fix notu. Genel `record()` API'sinin ASLA erişemediği tek
   * yol budur.
   */
  #recordCommitted(snapshot: Omit<CostEntry, "timestamp" | "reservationId">, reservationId: string): CostEntry {
    assertValidMonetaryAmount(snapshot.amountUsd, `CostEngine.commitReservation(taskId=${snapshot.taskId})`);
    return this.#recordSnapshot(snapshot, reservationId);
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
   *
   * P1 fix (27th independent review round, finding 8, "require unforgeable
   * reservation ownership"): the reservation id used to be a purely
   * SEQUENTIAL, predictable string (`res-1`, `res-2`, ...) — Codex pointed
   * out that neither the id NOR the `ReservationOwnership` scope fields
   * (`taskId`/`projectId`/`agentId`/`provider`/`modelId`) are secrets: they
   * are ordinary, often business-predictable identifiers, so an unrelated
   * caller who could guess or already legitimately knows a project's task
   * naming scheme could, in principle, ALSO guess a sequential reservation
   * id and present a matching scope to `commitReservation()`/
   * `releaseReservation()` — the existing ownership-scope check (24th/25th
   * rounds) compares two things neither of which is actually secret. Fixed
   * by making the id ITSELF the unguessable capability/handle the finding
   * asks for: it now embeds a genuine `randomBytes(16)` (128 bits) suffix
   * — astronomically infeasible to guess or enumerate — in addition to the
   * existing monotonic counter (kept purely for human-readable ordering in
   * logs, never itself load-bearing for security). `commitReservation()`/
   * `releaseReservation()` already require the caller to present the exact
   * id string (there is no `list()`/enumeration method exposed anywhere on
   * `CostEngine` — bkz. bu sınıfın diğer metodları — so an id can only ever
   * be OBTAINED from `reserve()`'s own return value, or from legitimate
   * `AuditLog` access), so "knows the unguessable id" now stands ALONGSIDE
   * "supplies the matching scope" as a second, genuinely unforgeable
   * factor — an unrelated caller who merely guesses/knows the human-
   * meaningful scope fields still cannot operate a reservation without
   * ALSO knowing its cryptographically random id. `getReservation()`
   * already never lets a caller who has the id fish out the `scope`
   * needed to pass the OTHER check (26th round) — combined, no public API
   * on this class ever hands out reusable authorization material for a
   * reservation the caller was not already given.
   */
  createReservation(scope: ReservationOwnership, amountUsd: number): LedgerReservation {
    assertValidMonetaryAmount(amountUsd, "CostEngine.createReservation");
    // P1 fix (30th independent review round, finding 3, "serialize
    // persistent cost-ledger updates"): bkz. `record()`'un üstündeki fix
    // notu — `#withDurableMutation()`'ın kilit altındaki resenkronizasyonu
    // sayesinde `++this.#reservationSeq` de her zaman en güncel sıraya göre
    // ilerler, bir kardeş instance'ın zaten ilerlettiği sırayı asla
    // görmezden gelmez.
    return this.#withDurableMutation(() => {
      const id = `res-${++this.#reservationSeq}-${randomBytes(16).toString("hex")}`;
      const frozenScope = freezeRecord({ ...scope });
      // P2 fix (36th independent review round, finding 11): bkz. `#publish()`'in
      // üstündeki fix notu — a fresh Map (copied from the current one) is
      // built and populated BEFORE `this.#reservations` is ever touched.
      const nextReservations = new Map(this.#reservations);
      nextReservations.set(id, { scope: frozenScope, amountUsd, status: "ACTIVE" });
      this.#publish(this.#entries, nextReservations);
      return freezeRecord({ id, scope: frozenScope, amountUsd, status: "ACTIVE" as ReservationLedgerStatus });
    });
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

  // P1 fix (34th independent review round, finding 2 / root class 1,
  // "require ownership for reconciliation state changes"): a public
  // `markReservationReconciliationFailed(id: string): void` used to live
  // here — a reservation-status mutation reachable by ANY caller holding a
  // `CostEngine` reference, with NO ownership proof required at all (unlike
  // every other reservation-lifecycle mutation — `commitReservation()`/
  // `releaseReservation()`/`markReservationUnresolved()` — which all
  // require a matching `callerScope`). An unrelated caller who merely
  // learned (or predicted) another caller's reservation id could call it
  // directly and strand that reservation in `RECONCILIATION_FAILED`
  // forever, with no relationship to it whatsoever. It was never actually
  // called from anywhere in this file (`#commitReservationInner()` mutates
  // `reservation.status` in place directly, not through this method) — its
  // only caller was a test exercising `releaseReservation()`'s own
  // rejection of a RECONCILIATION_FAILED reservation. Removed entirely
  // rather than merely made `#private`: `markReservationUnresolved(id,
  // callerScope)` (added the 33rd round for the identical purpose, WITH an
  // ownership check) is the one authoritative, externally-safe way to
  // reach this state from outside; the test now uses that instead.

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
  /**
   * P1 fix (29th independent review round, finding 1, "make persisted cost
   * commits atomic/idempotent"): Codex reproduced a real double-spend
   * window: `record()` below PUSHES the incurred cost into `#entries`
   * (in-memory) and only THEN calls `#persist()` — if THAT persist call
   * throws (a durable-storage I/O error), the in-memory push has ALREADY
   * happened, `record()`'s exception still propagates, this method's own
   * catch marks the reservation `RECONCILIATION_FAILED` and attempts its
   * OWN `#persist()` (which may itself fail too), then rethrows. Nothing
   * about `commitReservation()` ever checked the reservation's OWN status
   * before proceeding, so `UnresolvedReconciliationError` (which DOES
   * block a RECONCILIATION_FAILED reservation from `releaseReservation()`)
   * never protected `commitReservation()` itself — exactly the "retry
   * commit() on this same reservation id" path `UnresolvedReconciliationError`'s
   * own message documents as "the only safe path forward" would, without
   * this fix, call `record()` a SECOND time for the SAME real-world
   * provider cost, pushing a SECOND `CostEntry` — the same durable dollar
   * amount counted twice in every future ceiling check. The same failure
   * shape also exists one step later: if `record()`'s OWN persist call
   * happens to succeed but THIS method's later `this.#reservations.delete(id);
   * this.#persist();` fails, the reservation lingers (never removed) even
   * though its cost was already durably recorded — a caller retrying
   * `commitReservation(id, ...)` on that lingering reservation would ALSO
   * double-record. Fixed via idempotency keyed on a durable identity: every
   * entry `commitReservation()` ever records is tagged with the
   * reservation's OWN id (`reservationId`, persisted alongside the entry —
   * bkz. `CostEntry.reservationId`'s fix note above). Before doing ANYTHING
   * else, this method checks whether `id` already has a matching entry in
   * `#entries` — if so, the real cost was ALREADY recorded (durably, since
   * an entry only ever reaches `#entries` via a `record()` call that itself
   * persists successfully OR whose failure was already handled by a PRIOR
   * commitReservation() attempt's own catch-block persist), so this call is
   * a retry: it returns the SAME already-recorded entry (never records a
   * second one) and — since the earlier attempt's REMOVAL step is what may
   * have failed — opportunistically finishes removing the now-redundant
   * reservation if it is still present, giving that removal another chance
   * to durably persist. This makes retrying commitReservation() on the SAME
   * id safe to call any number of times: the real cost is recorded exactly
   * once, and the reservation's RECONCILIATION_FAILED protection (bkz.
   * aşağıdaki catch bloğu) remains fully intact for the genuine "record()
   * never actually succeeded yet" case, where this idempotency check finds
   * nothing and the normal commit path runs exactly as before.
   */
  /**
   * P1 fix (30th independent review round, finding 3, "serialize
   * persistent cost-ledger updates"): the public `commitReservation()`
   * below now only wraps this method's ENTIRE body in
   * `#withDurableMutation()` — a genuinely private helper so that this
   * method's own internal `this.record(...)` call (bkz. aşağısı) can
   * reach the PUBLIC `record()` API (which is ITSELF `#withDurableMutation`-
   * wrapped) without a caller ever observing an intermediate, not-yet-
   * locked state. `#withDurableMutation()`'s `#lockDepth` tracking makes
   * that inner `record()` call a no-op re-lock/re-sync — see its own fix
   * note above.
   */
  #commitReservationInner(id: string, entry: Omit<CostEntry, "timestamp" | "reservationId">): CostEntry {
    const alreadyCommitted = this.#entries.find((e) => e.reservationId === id);
    if (alreadyCommitted) {
      // P1 fix (34th independent review round, finding 7, "validate
      // idempotent retries before returning authoritative entry"): this
      // branch used to return `alreadyCommitted` unconditionally — ANY
      // caller presenting `id` (a genuinely committed reservation id,
      // whether learned legitimately or merely guessed/predicted — ids are
      // sequential, `res-1`, `res-2`, ...) got back the FULL authoritative
      // `CostEntry`, including its true `taskId`/`agentId`/`projectId`/
      // `runId`/`provider`/`modelId`/`amountUsd`, with NO check that this
      // caller's OWN `entry` argument bears any resemblance to it at all.
      // A retry is only genuinely idempotent when it is the SAME logical
      // operation repeated — the caller-supplied `entry` for THIS attempt
      // must match the already-recorded ownership scope AND the exact
      // committed amount, the same identity `ownershipMismatches()`
      // already enforces for a FIRST commit (bkz. aşağısı). Fixed: the
      // retry's own `entry` is validated against `alreadyCommitted` BEFORE
      // it is ever returned — a caller whose scope OR amount disagrees is
      // rejected with `ReservationOwnershipMismatchError`, exactly as a
      // mismatched first-time commit already is, rather than silently
      // handed back someone else's authoritative committed entry.
      const retrySnapshot: Omit<CostEntry, "timestamp" | "reservationId"> = {
        taskId: entry.taskId,
        agentId: entry.agentId,
        projectId: entry.projectId,
        runId: entry.runId,
        provider: entry.provider,
        modelId: entry.modelId,
        amountUsd: entry.amountUsd
      };
      if (ownershipMismatches(alreadyCommitted, retrySnapshot) || retrySnapshot.amountUsd !== alreadyCommitted.amountUsd) {
        throw new ReservationOwnershipMismatchError("commit", id, alreadyCommitted, retrySnapshot);
      }
      // P1 fix (30th independent review round, finding 2, "persist
      // reservation deletion on idempotent retry"): this used to call
      // `#persist()` ONLY `if (this.#reservations.has(id))` — but that
      // in-memory check answers the WRONG question. Consider: the FIRST
      // `commitReservation()` attempt's `record()` call succeeds (entry
      // durably persisted), then `this.#reservations.delete(id)` succeeds
      // IN MEMORY, but the immediately-following `#persist()` call itself
      // throws (a transient durable-storage I/O failure) — the exception
      // propagates to the caller, but `#reservations` has ALREADY had the
      // id removed from the in-memory Map. A caller that (correctly, per
      // this method's own documented retry contract) calls
      // `commitReservation(id, ...)` again lands HERE: `alreadyCommitted`
      // is found, but `this.#reservations.has(id)` is now FALSE (it was
      // already deleted in memory before the failed persist), so the old
      // code did NOTHING — leaving the DURABLE file forever showing this
      // reservation as still present, even though it was genuinely
      // committed and removed. A process restart then RESTORES that stale
      // reservation from disk, resurrecting already-consumed budget
      // capacity out of nowhere. Fixed: this branch now unconditionally
      // removes `id` from the in-memory map (a no-op if already absent)
      // and unconditionally calls `#persist()` — `#persist()` always
      // serializes the CURRENT, correct in-memory state in full (bkz. bu
      // dosyanın üstündeki `#persist()`'in notu), so repeating it costs
      // nothing when nothing was actually stale, and REPAIRS the durable
      // file the moment it does not yet agree with memory. Every retry is
      // now a genuine "reconcile durable state to match memory" step, not
      // merely "retry whatever step didn't run last time."
      // P2 fix (36th independent review round, finding 11): bkz. `#publish()`'in
      // üstündeki fix notu.
      const nextReservations = new Map(this.#reservations);
      nextReservations.delete(id);
      this.#publish(this.#entries, nextReservations);
      return freezeRecord(alreadyCommitted);
    }

    const reservation = this.#reservations.get(id);
    if (!reservation) {
      throw new UnknownReservationError(id);
    }
    // P1 fix (27th independent review round, finding 7, "snapshot spend
    // entries before checking them" — same root class as `record()`
    // above and `runtime/budget/budget.ts`'s `spend()`/`commit()`):
    // `entry` used to be read separately by `ownershipMismatches()`, then
    // AGAIN by `assertValidMonetaryAmount(entry.amountUsd, ...)`, then
    // AGAIN inside `record()`'s own spread — three separate reads of a
    // caller-owned object. A getter/Proxy-backed `entry` could pass the
    // ownership check with one identity, then have its `amountUsd` (or
    // even its identity, for the record ultimately kept) answer
    // differently by the time anything is actually recorded. `snapshot`
    // is a genuine, static copy — read once, used everywhere below.
    // P1 fix (32nd independent review round, finding 1, "reservation id
    // must not be caller-forgeable"): `snapshot` deliberately never reads
    // `entry.reservationId` (mirroring `record()`'s own fix note above) —
    // this method's caller-supplied `entry` is never itself trusted to
    // carry a `reservationId`; the ONLY reservationId that can ever attach
    // to the resulting `CostEntry` is `id`, the parameter this method was
    // actually invoked with (which `commitReservation()` binds ONLY after
    // `#reservations.get(id)` above already proved a genuine, matching
    // reservation exists).
    const snapshot: Omit<CostEntry, "timestamp" | "reservationId"> = {
      taskId: entry.taskId,
      agentId: entry.agentId,
      projectId: entry.projectId,
      runId: entry.runId,
      provider: entry.provider,
      modelId: entry.modelId,
      amountUsd: entry.amountUsd
    };
    if (ownershipMismatches(reservation.scope, snapshot)) {
      // NOT routed through `#publish()` (bkz. onun üstündeki 36th round
      // finding 11 fix notu) — deliberately, and unlike every OTHER
      // mutation in this file. This transition is a FAIL-SAFE LOCK, not an
      // ordinary state change: it exists precisely because whether a real
      // provider cost was already incurred is now UNCERTAIN, so the
      // protection it grants (never silently releasable — bkz.
      // `UnresolvedReconciliationError`'ın notu) must hold in THIS
      // process's memory even if the write recording that fact durably
      // fails. Rolling this specific transition back on a persistence
      // failure (as `#publish()` would) would silently UNDO the exact
      // protection this branch exists to establish — reverting the
      // reservation to ACTIVE-and-releasable at the one moment its true
      // cost is least certain, regressing the 28th round's own "every
      // failed commit must enter RECONCILIATION_FAILED" invariant. So the
      // new reservation object is applied to the live Map UNCONDITIONALLY
      // (never rolled back), and `#persist()` is still attempted — best
      // effort, exactly as before — but its outcome does not gate whether
      // the in-memory protection sticks.
      this.#reservations.set(id, { ...reservation, status: "RECONCILIATION_FAILED" });
      this.#persist();
      throw new ReservationOwnershipMismatchError("commit", id, reservation.scope, snapshot);
    }
    // P1 fix (28th independent review round, finding 10, "every failed
    // commit must enter RECONCILIATION_FAILED"): this used to validate
    // `snapshot.amountUsd` in its OWN try/catch, protecting the
    // reservation ONLY against that ONE specific failure mode — a failure
    // from ANY other cause during the actual recording step (`record()`
    // itself, including its own — now persistence-backed, bkz. bu
    // dosyanın üstündeki fix notu — write, which can fail for reasons
    // entirely unrelated to the amount, e.g. a durable-storage I/O error)
    // fell OUTSIDE any try/catch entirely: the reservation would be left
    // "ACTIVE" — releasable, and NOT protected — even though the provider
    // call this reservation exists to protect against may already have
    // incurred real cost by the time `commitReservation()` was called at
    // all. The entire "attempt to actually record this cost" step is now
    // ONE try/catch: ANY failure inside it — amount validation (still
    // enforced, now via `record()`'s own internal check, so no longer
    // duplicated here) OR a persistence-layer failure OR any other cause —
    // marks this reservation RECONCILIATION_FAILED and preserves it
    // (never deleted), exactly the same fail-safe outcome regardless of
    // WHICH step inside recording failed.
    let recorded: CostEntry;
    try {
      // P1 fix (32nd independent review round, finding 1, "reservation id
      // must not be caller-forgeable"): this used to call the PUBLIC
      // `record()` with a caller-shaped `{ ...snapshot, reservationId: id }`
      // object — the record-level `reservationId` field this method
      // attaches was correct HERE (this call site legitimately knows `id`
      // is real), but going through the SAME public entry point ordinary
      // callers use meant nothing distinguished a legitimate internal
      // commit from an external caller who separately learned/forged a
      // real reservation's id and called `record()` directly with it (bkz.
      // `record()`'un üstündeki fix notu). `#recordCommitted()` is a
      // private method reachable ONLY from here — after `#reservations.get(id)`
      // and the ownership-match check above have ALREADY proven this is a
      // genuine, currently-open reservation belonging to this caller.
      recorded = this.#recordCommitted(snapshot, id);
    } catch (err) {
      // Rezervasyon SİLİNMEZ — "RECONCILIATION_FAILED" olarak işaretlenip
      // KORUNUR (bkz. üstteki not); ÇAĞIRANIN (BudgetGuard) kendi audit/
      // hata işleme mantığı bu hatayı zaten sarmalar.
      // Deliberately NOT routed through `#publish()` (bkz. onun üstündeki
      // 36th round finding 11 fix notu, ve `ownershipMismatches()` dalının
      // aynı gerekçeli notu hemen yukarıda) — this is the SAME fail-safe
      // lock, reached via a DIFFERENT failure (any error from
      // `#recordCommitted()` above, not only an ownership mismatch,
      // including — per THIS round's own finding 11 — `record()`'s own
      // `#publish()` call failing to persist the cost entry itself). Since
      // whether that failure means a real provider cost was already
      // incurred is exactly as uncertain here as in the ownership-mismatch
      // branch, this transition must hold in memory REGARDLESS of whether
      // `#persist()` below itself succeeds — rolling it back on a second,
      // independent persistence failure would silently return an
      // uncertain-cost reservation to ACTIVE-and-releasable, regressing
      // the 28th round's "every failed commit must enter
      // RECONCILIATION_FAILED" invariant (bkz. bunun altındaki regression
      // testi).
      this.#reservations.set(id, { ...reservation, status: "RECONCILIATION_FAILED" });
      this.#persist();
      throw err;
    }
    // P2 fix (36th independent review round, finding 11): bkz. `#publish()`'in
    // üstündeki fix notu.
    const nextReservations = new Map(this.#reservations);
    nextReservations.delete(id);
    this.#publish(this.#entries, nextReservations);
    return recorded;
  }

  commitReservation(id: string, entry: Omit<CostEntry, "timestamp" | "reservationId">): CostEntry {
    return this.#withDurableMutation(() => this.#commitReservationInner(id, entry));
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
    // P1 fix (30th independent review round, finding 3, "serialize
    // persistent cost-ledger updates"): bkz. `record()`'un üstündeki fix
    // notu.
    return this.#withDurableMutation(() => {
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
      // P2 fix (36th independent review round, finding 11): bkz. `#publish()`'in
      // üstündeki fix notu.
      const nextReservations = new Map(this.#reservations);
      nextReservations.delete(id);
      this.#publish(this.#entries, nextReservations);
      return freezeRecord({ id, scope: reservation.scope, amountUsd: reservation.amountUsd, status: reservation.status });
    });
  }

  /**
   * P1 fix (33rd independent review round, finding 1 / root class F,
   * "billable provider failure reconciliation"): a provider call can fail
   * AFTER the external provider has already accepted and possibly billed
   * the request (a timeout waiting for a response that was already
   * generated, a connection drop after submission, a 5xx returned once
   * work already started) — `ModelGateway.invoke()` used to treat EVERY
   * provider throw identically to `releaseReservation()`'s own documented
   * "nothing was ever incurred" case, silently assuming zero cost with no
   * actual evidence either way. This method is the missing THIRD outcome:
   * for a failure the caller cannot prove incurred zero cost, the
   * reservation is neither deleted (as `releaseReservation()` would) nor
   * quietly left "ACTIVE" as if nothing happened — it transitions into the
   * SAME `RECONCILIATION_FAILED` protection `commitReservation()`'s own
   * failure path already established (round 12/28: "a reservation whose
   * true cost could not be safely recorded must remain protected, and
   * `releaseReservation()` must refuse it — bkz. `UnresolvedReconciliationError`'ın
   * notu"). Reusing that EXACT status, rather than inventing a fourth,
   * parallel one, means every existing protection already proven for it —
   * restore-time validation (`assertValidPersistedCostState()`), rejection
   * by `releaseReservation()`, safe retry via `commitReservation()` once
   * the real cost becomes known — applies here with no new state machine
   * to separately re-verify. Ownership is checked the SAME way
   * `releaseReservation()`'s own does (25th independent review round):
   * only the caller who actually holds this reservation's scope may
   * transition it — an attacker who merely learns a reservation id cannot
   * mark someone else's ACTIVE reservation as unresolved. Already-
   * RECONCILIATION_FAILED is accepted as a idempotent no-op (a second,
   * independent provider failure signal about the same reservation is not
   * an error — the reservation is already exactly as protected as this
   * call would have made it).
   *
   * P1 fix (34th independent review round, finding 1, "check ownership
   * before returning failed reservations"): the idempotent-no-op branch
   * above used to run BEFORE the ownership check — Codex reproduced that
   * caller B, merely knowing (or predicting) caller A's reservation id,
   * could call this method on an ALREADY-`RECONCILIATION_FAILED`
   * reservation and receive back the FULL `LedgerReservation`, including
   * `scope` — A's authoritative ownership — with NO relationship to that
   * reservation whatsoever, since the early return happened before
   * `ownershipMismatches()` ever ran. This is exactly the class of leak
   * `getReservation()`'s own 26th-round fix closed for the read path; here
   * it reopened via a WRITE path's idempotency shortcut. Fixed: the
   * ownership check now runs FIRST, unconditionally, for every status —
   * only after `callerScope` is proven to match does either branch (the
   * idempotent already-failed case, or the genuine ACTIVE-to-
   * RECONCILIATION_FAILED transition) ever construct a `scope`-bearing
   * return value, mirroring `releaseReservation()`'s own ordering (whose
   * status-based short-circuit is safe only because it THROWS
   * `UnresolvedReconciliationError`, a scope-free error, never returns
   * `scope` itself).
   */
  markReservationUnresolved(id: string, callerScope: ReservationOwnership): LedgerReservation {
    return this.#withDurableMutation(() => {
      const reservation = this.#reservations.get(id);
      if (!reservation) {
        throw new UnknownReservationError(id);
      }
      if (ownershipMismatches(reservation.scope, callerScope)) {
        throw new ReservationOwnershipMismatchError("reconcile", id, reservation.scope, callerScope);
      }
      if (reservation.status === "RECONCILIATION_FAILED") {
        return freezeRecord({ id, scope: reservation.scope, amountUsd: reservation.amountUsd, status: reservation.status });
      }
      // Deliberately NOT routed through `#publish()` (bkz. onun üstündeki
      // 36th round finding 11 fix notu, ve `#commitReservationInner()`'ın
      // AYNI gerekçeli iki notu) — this method exists SPECIFICALLY to mark
      // a reservation's true cost as uncertain (bkz. bu sınıfın üstündeki
      // 33rd round fix notu, "billable provider failure reconciliation");
      // rolling the transition back on a persistence failure would defeat
      // its entire purpose by silently returning an uncertain-cost
      // reservation to ACTIVE-and-releasable. The new object is applied to
      // the live Map unconditionally; `#persist()` is still attempted best
      // effort.
      const updated: ReservationEntry = { ...reservation, status: "RECONCILIATION_FAILED" };
      this.#reservations.set(id, updated);
      this.#persist();
      return freezeRecord({ id, scope: updated.scope, amountUsd: updated.amountUsd, status: updated.status });
    });
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
    (scope.projectId === undefined || entry.projectId === scope.projectId) &&
    (scope.runId === undefined || entry.runId === scope.runId)
  );
}
