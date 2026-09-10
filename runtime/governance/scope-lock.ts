// Baseline section 304 (phased plan, P0 before P1 before P2 before P3) +
// CLAUDE.md's own "Scope discipline" section, 35th independent review round
// governance mechanism (2 of 4): Scope Lock + Backlog Router.
//
// A machine-readable phase state (OPEN / LOCKED_FOR_CLOSURE / CLOSED) that
// replaces free-text status prose ("P0 remains open", "P0 is ready for
// review") with an authoritative, transition-checked state machine. Every
// transition is gated by the Central Invariant Guard (Part B,
// `runtime/invariants/invariant-guard.ts`) — a phase cannot be locked for
// closure while a BLOCKING invariant is violated — and every transition is
// recorded into the EXISTING Founder Decision Ledger
// (`runtime/decisions/decision-ledger.ts`), per baseline section 46 and
// this round's own Part F requirement ("do NOT create another decision-log
// subsystem").
//
// The Backlog Router is the other half of the same discipline: once a
// phase is LOCKED_FOR_CLOSURE (or CLOSED), a NEW item proposed against that
// phase is never silently absorbed into its scope — it is routed to the
// backlog instead, and that routing decision is itself recorded in the
// SAME Decision Ledger, so "why didn't X make it into this phase?" is
// always answerable (baseline section 255, Decision Explainability).

import type { InvariantGuardReport } from "../invariants/invariant-guard.js";
import type { FounderDecisionLedger } from "../decisions/decision-ledger.js";
import type { StateStore } from "../state/file-store.js";
import { freezeRecord } from "../util/immutable.js";

export type PhaseLockState = "OPEN" | "LOCKED_FOR_CLOSURE" | "CLOSED";

interface MutablePhaseLockRecord {
  phaseId: string;
  state: PhaseLockState;
  reason: string;
  updatedAt: string;
  /**
   * P1 fix (independent Codex review, "validate restored phase state
   * against the Decision Ledger"): the Decision Ledger id `record()` bound
   * this EXACT transition to (bkz. `lock()`/`close()`/`reopen()`'in
   * gövdesi aşağıda) — persisted alongside the transition itself so
   * `loadFrom()` can later locate the SAME ledger record and verify this
   * phase state genuinely has matching, non-stale governance evidence
   * behind it, rather than trusting the persisted `state` value on its own.
   */
  decisionId: string;
}

export type PhaseLockRecord = Readonly<MutablePhaseLockRecord>;

const VALID_PHASE_LOCK_STATES: readonly PhaseLockState[] = ["OPEN", "LOCKED_FOR_CLOSURE", "CLOSED"];

export class InvalidPhaseTransitionError extends Error {
  constructor(phaseId: string, from: PhaseLockState, to: PhaseLockState) {
    super(
      `Cannot transition phase '${phaseId}' from ${from} to ${to}. Valid forward transitions are ` +
        `OPEN -> LOCKED_FOR_CLOSURE -> CLOSED; a phase may always be reopened (LOCKED_FOR_CLOSURE or CLOSED -> ` +
        `OPEN) via reopen(), never via lock()/close(). Skipping a step (OPEN -> CLOSED directly) is not a valid ` +
        `lifecycle — closure must always pass through the deliberate LOCKED_FOR_CLOSURE checkpoint.`
    );
    this.name = "InvalidPhaseTransitionError";
  }
}

export class GovernanceInvariantViolationError extends Error {
  constructor(phaseId: string, action: string, report: InvariantGuardReport) {
    const detail = report.violations
      .filter((v) => v.severity === "BLOCKING")
      .map((v) => `${v.invariantId}: ${v.detail}`)
      .join("; ");
    super(
      `Refusing to ${action} phase '${phaseId}': the Central Invariant Guard reports unresolved BLOCKING ` +
        `violation(s) (${detail}). A governance action that changes phase state must never proceed while a ` +
        `known invariant is violated (baseline section 147, 303) — fix the violation(s) and re-run the guard, ` +
        `rather than overriding this check.`
    );
    this.name = "GovernanceInvariantViolationError";
  }
}

export class CorruptPersistedPhaseLockError extends Error {
  constructor(index: number, reason: string) {
    super(
      `Persisted phase lock record at index ${index} is corrupt or violates a domain invariant (${reason}) and ` +
        `cannot be restored into authoritative state. Refusing to load rather than silently repairing or ` +
        `dropping the record (same fail-closed philosophy as decisions/decision-ledger.ts's loadFrom()).`
    );
    this.name = "CorruptPersistedPhaseLockError";
  }
}

function describeInvalidPersistedPhaseLock(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "not a plain object";
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.phaseId !== "string" || candidate.phaseId.length === 0) return "missing or invalid 'phaseId'";
  if (!VALID_PHASE_LOCK_STATES.includes(candidate.state as PhaseLockState)) return "invalid 'state'";
  if (typeof candidate.reason !== "string") return "missing or invalid 'reason'";
  if (typeof candidate.updatedAt !== "string" || candidate.updatedAt.length === 0) return "missing or invalid 'updatedAt'";
  if (typeof candidate.decisionId !== "string" || candidate.decisionId.length === 0) {
    return "missing or invalid 'decisionId'";
  }
  return undefined;
}

/**
 * P1 fix (independent Codex review, "validate restored phase state against
 * the Decision Ledger"): maps a persisted phase `state` to the ONE
 * `FounderDecisionLedger.record()` `source` string the live transition
 * method that could have produced it always passes (bkz.
 * `lock()`/`close()`/`reopen()`'in her birinin kendi `this.#ledger.record(...,
 * "ScopeLock.lock"/"ScopeLock.close"/"ScopeLock.reopen")` çağrısı) — this
 * mapping is exhaustive because `#phases.set()` is ONLY ever reached from
 * inside these three methods, each of which records its OWN, distinct
 * source string before doing so.
 */
function expectedLedgerSourceForPhaseState(state: PhaseLockState): string {
  switch (state) {
    case "LOCKED_FOR_CLOSURE":
      return "ScopeLock.lock";
    case "CLOSED":
      return "ScopeLock.close";
    case "OPEN":
      return "ScopeLock.reopen";
  }
}

/**
 * A single decision id is required for every call that mutates state
 * (rather than this module auto-generating one) so callers control their
 * own decision-id naming scheme and the Decision Ledger's own
 * `DuplicateDecisionError` remains the one place a collision is caught —
 * see `FounderDecisionLedger.record()`.
 */
export class ScopeLock {
  /** Genuine ECMAScript private field — same reasoning as every other authoritative-state Map in this codebase (bkz. decision-ledger.ts's #decisions). */
  #phases = new Map<string, MutablePhaseLockRecord>();
  #ledger: FounderDecisionLedger;

  constructor(ledger: FounderDecisionLedger) {
    this.#ledger = ledger;
  }

  /** A phase never explicitly locked is implicitly OPEN — the natural default for a phase still under active work. */
  getState(phaseId: string): PhaseLockState {
    return this.#phases.get(phaseId)?.state ?? "OPEN";
  }

  /**
   * P1 fix (37th independent review round, finding 4, "make phase closure
   * and manifest persistence atomic"): a read-only check for whether
   * `decisionId` is already a known decision in this ScopeLock's backing
   * Decision Ledger — the ONE realistic way `lock()`/`close()` below can
   * still throw (`DuplicateDecisionError`) once a caller has already
   * independently re-verified every OTHER precondition those methods check
   * (`currentState`/`guardReport`) moments before calling them. A caller
   * that must durably persist OTHER evidence (bkz. `phase-closure.ts`'in
   * `attemptPhaseClosure()`'ı, which persists a closure manifest) BEFORE
   * calling `close()` needs to PROVE `close()` cannot fail first — otherwise
   * that evidence could durably claim an outcome (`CLOSED`) the actual state
   * transition then fails to achieve. This is read-only: it never consumes
   * or reserves `decisionId`, it only reports whether calling `record()`
   * with it right now would throw.
   */
  hasDecision(decisionId: string): boolean {
    return this.#ledger.get(decisionId) !== undefined;
  }

  get(phaseId: string): PhaseLockRecord | undefined {
    const record = this.#phases.get(phaseId);
    return record ? freezeRecord(record) : undefined;
  }

  /**
   * OPEN -> LOCKED_FOR_CLOSURE. Requires the Central Invariant Guard to
   * report zero BLOCKING violations — this is what "READY_FOR_INDEPENDENT_
   * REVIEW only if every local mandatory gate passes" means as executable
   * code rather than prose.
   */
  lock(phaseId: string, reason: string, guardReport: InvariantGuardReport, decisionId: string): PhaseLockRecord {
    const currentState = this.getState(phaseId);
    if (currentState !== "OPEN") {
      throw new InvalidPhaseTransitionError(phaseId, currentState, "LOCKED_FOR_CLOSURE");
    }
    if (!guardReport.allBlockingSatisfied) {
      throw new GovernanceInvariantViolationError(phaseId, "lock", guardReport);
    }
    const record: MutablePhaseLockRecord = {
      phaseId,
      state: "LOCKED_FOR_CLOSURE",
      reason,
      updatedAt: new Date().toISOString(),
      decisionId
    };
    // P1 targeted-audit fix (35th independent review round, "pre-audit
    // transition exposure" root class — same class this round's own Fix 2
    // closed in policy-engine/approval.ts): the ledger record is committed
    // BEFORE `#phases` is mutated, not after. If `record()` throws (e.g. a
    // reused decisionId -> DuplicateDecisionError), the phase must remain
    // exactly as it was — never transitioned with no audit trail to show
    // it happened. `FounderDecisionLedger.record()` itself only mutates
    // its OWN state on success, so ordering it first here means a failure
    // here leaves `#phases` untouched (matches approval.ts's `#commit()`:
    // audit first, then a guaranteed-non-throwing assignment).
    this.#ledger.record(decisionId, phaseId, `Phase '${phaseId}' locked for closure: ${reason}`, "ScopeLock.lock");
    this.#phases.set(phaseId, record);
    return freezeRecord(record);
  }

  /**
   * LOCKED_FOR_CLOSURE -> CLOSED. Also requires a clean invariant report.
   * This is the low-level state transition only — the higher-level
   * decision of WHETHER a phase is actually allowed to close (e.g. "an
   * independent review must have returned CLEAN") belongs to the Phase
   * Closure Manifest (`runtime/governance/phase-closure.ts`), which calls
   * this method only after establishing that; ScopeLock itself has no
   * opinion on what closure evidence should look like.
   */
  close(phaseId: string, reason: string, guardReport: InvariantGuardReport, decisionId: string): PhaseLockRecord {
    const currentState = this.getState(phaseId);
    if (currentState !== "LOCKED_FOR_CLOSURE") {
      throw new InvalidPhaseTransitionError(phaseId, currentState, "CLOSED");
    }
    if (!guardReport.allBlockingSatisfied) {
      throw new GovernanceInvariantViolationError(phaseId, "close", guardReport);
    }
    const record: MutablePhaseLockRecord = {
      phaseId,
      state: "CLOSED",
      reason,
      updatedAt: new Date().toISOString(),
      decisionId
    };
    // Same ordering fix as lock() above, same root class.
    this.#ledger.record(decisionId, phaseId, `Phase '${phaseId}' closed: ${reason}`, "ScopeLock.close");
    this.#phases.set(phaseId, record);
    return freezeRecord(record);
  }

  /**
   * Always allowed, from any state, back to OPEN — reopening is the
   * SAFER direction (this repository's own history, e.g. round 21's
   * "reopen P0 status honestly", already established that an honest
   * reopening must never be blocked by anything). No invariant check is
   * required: relaxing scope back to "still under active work" cannot
   * itself violate an invariant the way locking/closing can.
   */
  reopen(phaseId: string, reason: string, decisionId: string): PhaseLockRecord {
    const record: MutablePhaseLockRecord = {
      phaseId,
      state: "OPEN",
      reason,
      updatedAt: new Date().toISOString(),
      decisionId
    };
    // Same ordering fix as lock()/close() above, same root class.
    this.#ledger.record(decisionId, phaseId, `Phase '${phaseId}' reopened: ${reason}`, "ScopeLock.reopen");
    this.#phases.set(phaseId, record);
    return freezeRecord(record);
  }

  saveTo(store: StateStore, path: string): void {
    store.write(path, [...this.#phases.values()]);
  }

  // P1 fix (37th independent review round, finding 11, "live uniqueness
  // invariant not enforced during restore"): this loop used to call
  // `lock.#phases.set(candidate.phaseId, ...)` unconditionally for every
  // persisted record — `Map.set()` on an ALREADY-present key silently
  // OVERWRITES the earlier entry with no error, no warning, and no trace
  // of the discarded one. A persisted phase-lock file containing two
  // records for the SAME `phaseId` (corruption, a concurrent-write race
  // on the underlying `StateStore`, or a hand-edited file) would silently
  // restore only the LAST one, discarding the phase's genuine transition
  // history (e.g. an earlier LOCKED_FOR_CLOSURE record) with no evidence
  // it ever existed — corrupting exactly the authoritative governance
  // state (baseline section 147/303: "no silent architectural deletion")
  // this class exists to protect. The class's OWN live mutators
  // (`lock()`/`close()`/`reopen()`) never need this check because they all
  // route through `getState()`'s transition-validity gate first — restore
  // is the ONE path that bypasses that gate entirely (it re-establishes
  // state directly), so it needs its OWN, explicit uniqueness check. Fixed
  // by failing the ENTIRE restore closed (never repairing/dropping/merging
  // one of the two records) via the SAME `CorruptPersistedPhaseLockError`
  // already used for every other structural-corruption case in this
  // function, exactly matching `FounderDecisionLedger.loadFrom()`'s own
  // "reject wholesale, don't silently accept corrupt persisted state"
  // precedent this file's other error classes already cite.
  // P1 fix (independent Codex review, "validate restored phase state
  // against the Decision Ledger"): the checks above (structural validity,
  // phaseId uniqueness) only ever look AT the persisted phase-lock file
  // itself — a persisted record claiming `state: "CLOSED"` (or
  // `LOCKED_FOR_CLOSURE`) has, until now, been trusted on its own say-so,
  // with NO check that the Decision Ledger this restore was handed
  // actually contains matching, non-stale evidence for that transition. A
  // stale, empty, unrelated, or hand-edited ledger passed alongside a
  // legitimate-LOOKING phase-lock file would restore governance state
  // (e.g. "P0 is CLOSED") with no real decision behind it — exactly the
  // "no claim without evidence" invariant (baseline section 147) this
  // whole class exists to enforce, now applied to RESTORE, not just the
  // live `lock()`/`close()`/`reopen()` path (which already can't reach an
  // inconsistent state, since each commits its own ledger record before
  // ever touching `#phases` — bkz. yukarıdaki "pre-audit transition
  // exposure" fix notu). Every check below runs BEFORE the candidate ever
  // enters `lock.#phases`, so a failure here leaves the whole restore
  // rejected (fail closed), never partially populated.
  static loadFrom(store: StateStore, path: string, ledger: FounderDecisionLedger): ScopeLock {
    const lock = new ScopeLock(ledger);
    const records = store.read<unknown[]>(path) ?? [];
    records.forEach((record, index) => {
      const failure = describeInvalidPersistedPhaseLock(record);
      if (failure) {
        throw new CorruptPersistedPhaseLockError(index, failure);
      }
      const candidate = record as MutablePhaseLockRecord;
      if (lock.#phases.has(candidate.phaseId)) {
        throw new CorruptPersistedPhaseLockError(index, `duplicate phaseId '${candidate.phaseId}'`);
      }

      // Locate the matching Decision Ledger record — missing evidence
      // (an empty, unrelated, or otherwise non-matching ledger) fails
      // closed rather than restoring ungrounded governance state.
      const decision = ledger.get(candidate.decisionId);
      if (!decision) {
        throw new CorruptPersistedPhaseLockError(
          index,
          `decisionId '${candidate.decisionId}' has no matching record in the Decision Ledger — a persisted ` +
            `phase transition must have real, locatable governance evidence behind it`
        );
      }
      // Verify phase identity: the ledger record's `project` field is
      // always set to `phaseId` by every one of lock()/close()/reopen()'s
      // own `record()` calls — a mismatch means this decisionId belongs to
      // a DIFFERENT phase (or was never genuinely tied to this one).
      if (decision.project !== candidate.phaseId) {
        throw new CorruptPersistedPhaseLockError(
          index,
          `decisionId '${candidate.decisionId}' is recorded against project '${decision.project}', not phase ` +
            `'${candidate.phaseId}' — ledger evidence does not belong to this governance transition`
        );
      }
      // Verify the transition itself: the ledger record's `source` names
      // exactly ONE of lock()/close()/reopen() (bkz.
      // `expectedLedgerSourceForPhaseState()`'in fix notu) — a mismatch
      // (e.g. a persisted `state: "CLOSED"` whose ledger evidence was
      // actually recorded by `ScopeLock.reopen()`, or by something
      // entirely unrelated) means the evidence is stale or contradictory,
      // not proof of THIS specific transition.
      const expectedSource = expectedLedgerSourceForPhaseState(candidate.state);
      if (decision.source !== expectedSource) {
        throw new CorruptPersistedPhaseLockError(
          index,
          `decisionId '${candidate.decisionId}' was recorded by '${decision.source}', but a persisted phase in ` +
            `state '${candidate.state}' requires evidence from '${expectedSource}' — ledger evidence is stale or ` +
            `contradicts this governance transition`
        );
      }

      lock.#phases.set(candidate.phaseId, { ...candidate });
    });
    return lock;
  }
}

// ---------------------------------------------------------------------
// Backlog Router
// ---------------------------------------------------------------------

export type BacklogRouteDecision = "ACCEPT_INTO_PHASE" | "ROUTE_TO_BACKLOG";
export type BacklogItemCategory = "FIX" | "FEATURE" | "REFACTOR" | "GOVERNANCE";

export interface BacklogItem {
  readonly itemId: string;
  readonly phaseId: string;
  readonly description: string;
  readonly category: BacklogItemCategory;
}

interface MutableBacklogRouteRecord {
  itemId: string;
  phaseId: string;
  description: string;
  category: BacklogItemCategory;
  decision: BacklogRouteDecision;
  routedAt: string;
  /**
   * P1 fix (independent Codex review's own narrow root-cause audit for
   * class D, "restore governance authority lacks matching Decision Ledger
   * evidence" — found as a direct sibling of the ScopeLock.loadFrom() fix
   * in the SAME file): only ever set for a `ROUTE_TO_BACKLOG` decision —
   * the ledger id `route()` bound that denial to (bkz. aşağıdaki `route()`
   * gövdesi). An `ACCEPT_INTO_PHASE` record never carries one, since
   * `route()` itself never records a ledger entry for that outcome.
   */
  decisionId?: string;
}

export type BacklogRouteRecord = Readonly<MutableBacklogRouteRecord>;

export class DuplicateBacklogItemError extends Error {
  constructor(itemId: string) {
    super(`Backlog item id '${itemId}' has already been routed. Each item may only be routed once.`);
    this.name = "DuplicateBacklogItemError";
  }
}

const VALID_BACKLOG_CATEGORIES: readonly BacklogItemCategory[] = ["FIX", "FEATURE", "REFACTOR", "GOVERNANCE"];
const VALID_BACKLOG_DECISIONS: readonly BacklogRouteDecision[] = ["ACCEPT_INTO_PHASE", "ROUTE_TO_BACKLOG"];

export class CorruptPersistedBacklogRecordError extends Error {
  constructor(index: number, reason: string) {
    super(
      `Persisted backlog route record at index ${index} is corrupt or violates a domain invariant (${reason}) ` +
        `and cannot be restored into authoritative state. Refusing to load rather than silently repairing or ` +
        `dropping the record (same fail-closed philosophy as decisions/decision-ledger.ts's loadFrom()).`
    );
    this.name = "CorruptPersistedBacklogRecordError";
  }
}

function describeInvalidPersistedBacklogRecord(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "not a plain object";
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.itemId !== "string" || candidate.itemId.length === 0) return "missing or invalid 'itemId'";
  if (typeof candidate.phaseId !== "string" || candidate.phaseId.length === 0) return "missing or invalid 'phaseId'";
  if (typeof candidate.description !== "string") return "missing or invalid 'description'";
  if (!VALID_BACKLOG_CATEGORIES.includes(candidate.category as BacklogItemCategory)) return "invalid 'category'";
  if (!VALID_BACKLOG_DECISIONS.includes(candidate.decision as BacklogRouteDecision)) return "invalid 'decision'";
  if (typeof candidate.routedAt !== "string" || candidate.routedAt.length === 0) return "missing or invalid 'routedAt'";
  if (candidate.decision === "ROUTE_TO_BACKLOG") {
    if (typeof candidate.decisionId !== "string" || candidate.decisionId.length === 0) {
      return "missing or invalid 'decisionId' (required for a ROUTE_TO_BACKLOG record)";
    }
  } else if (candidate.decisionId !== undefined) {
    return "'decisionId' must not be present on an ACCEPT_INTO_PHASE record — route() never records one for it";
  }
  return undefined;
}

/**
 * Routes a proposed item against the CURRENT phase state: an OPEN phase
 * accepts new scope directly (ordinary operation, not itself a
 * governance decision worth logging); a LOCKED_FOR_CLOSURE or CLOSED
 * phase routes the item to the backlog instead of silently expanding
 * scope — and THAT denial is what gets recorded into the Decision
 * Ledger (Part F), since it is the deviation from the default path that
 * "why didn't X make it into this phase?" needs to be answerable for.
 */
export class BacklogRouter {
  #routed = new Map<string, MutableBacklogRouteRecord>();
  #scopeLock: ScopeLock;
  #ledger: FounderDecisionLedger;

  constructor(scopeLock: ScopeLock, ledger: FounderDecisionLedger) {
    this.#scopeLock = scopeLock;
    this.#ledger = ledger;
  }

  route(item: BacklogItem, decisionId?: string): BacklogRouteRecord {
    if (this.#routed.has(item.itemId)) {
      throw new DuplicateBacklogItemError(item.itemId);
    }
    const state = this.#scopeLock.getState(item.phaseId);
    const decision: BacklogRouteDecision = state === "OPEN" ? "ACCEPT_INTO_PHASE" : "ROUTE_TO_BACKLOG";
    const record: MutableBacklogRouteRecord = {
      itemId: item.itemId,
      phaseId: item.phaseId,
      description: item.description,
      category: item.category,
      decision,
      routedAt: new Date().toISOString(),
      ...(decision === "ROUTE_TO_BACKLOG" ? { decisionId } : {})
    };
    // P1 targeted-audit fix (35th independent review round, same
    // "pre-audit transition exposure" root class as ScopeLock's own
    // lock()/close()/reopen() fix above): the ledger record (when this is
    // a ROUTE_TO_BACKLOG denial) is committed BEFORE `#routed` is
    // mutated, not after — a `decisionId` collision (`DuplicateDecisionError`)
    // must never leave a backlog-routing decision committed with no audit
    // trail explaining why.
    if (decision === "ROUTE_TO_BACKLOG") {
      if (!decisionId) {
        throw new Error(
          `Routing item '${item.itemId}' to the backlog (phase '${item.phaseId}' is ${state}) requires a ` +
            `decisionId so this denial can be recorded in the Founder Decision Ledger (baseline section 46, 255).`
        );
      }
      this.#ledger.record(
        decisionId,
        item.phaseId,
        `Item '${item.itemId}' (${item.category}: ${item.description}) routed to backlog — phase is ${state}, ` +
          `not accepting new scope`,
        "BacklogRouter.route"
      );
    }
    this.#routed.set(item.itemId, record);
    return freezeRecord(record);
  }

  get(itemId: string): BacklogRouteRecord | undefined {
    const record = this.#routed.get(itemId);
    return record ? freezeRecord(record) : undefined;
  }

  list(): readonly BacklogRouteRecord[] {
    return [...this.#routed.values()].map((r) => freezeRecord(r));
  }

  listBacklogged(): readonly BacklogRouteRecord[] {
    return this.list().filter((r) => r.decision === "ROUTE_TO_BACKLOG");
  }

  saveTo(store: StateStore, path: string): void {
    store.write(path, [...this.#routed.values()]);
  }

  // P2 fix (37th independent review round, finding 12, "live uniqueness
  // invariant not enforced during restore" — same root class as
  // `ScopeLock.loadFrom()`'s own fix above): `route()`'s live path already
  // rejects a duplicate `itemId` outright (`DuplicateBacklogItemError`,
  // bkz. yukarısı) — "each item may only be routed once" is this class's
  // OWN documented invariant. This restore loop used to enforce that
  // invariant NOWHERE: `router.#routed.set(candidate.itemId, ...)` ran
  // unconditionally, so two persisted records sharing an `itemId` would
  // silently collapse into whichever one happened to be read LAST,
  // discarding the other's routing decision/evidence with no error —
  // restore accepting corrupt persisted state the class's own live
  // mutator would have refused outright. Fixed by checking for the SAME
  // duplicate BEFORE inserting, exactly mirroring `route()`'s own live
  // check, and failing the whole restore closed via
  // `CorruptPersistedBacklogRecordError` (this function's own established
  // fail-closed error) rather than silently accepting the corruption.
  //
  // P1 fix (independent Codex review's own narrow root-cause audit for
  // class D, "restore governance authority lacks matching Decision Ledger
  // evidence" — found as a direct sibling of `ScopeLock.loadFrom()`'s own
  // fix, in the SAME file): this loop used to take a `ledger` parameter
  // and thread it only into `new BacklogRouter(scopeLock, ledger)` for
  // LATER live use — it never actually READ from `ledger` during restore
  // itself. A persisted `ROUTE_TO_BACKLOG` record was restored trusting
  // only its own fields, with no way to detect a missing, unrelated, or
  // stale Decision Ledger — exactly the gap `ScopeLock.loadFrom()`
  // (immediately above in this same file) already closed for phase-lock
  // records. Fixed the identical way: every restored `ROUTE_TO_BACKLOG`
  // record's `decisionId` (bkz. `MutableBacklogRouteRecord`'in üstündeki
  // fix notu) must locate a matching Decision Ledger record whose
  // `project` is this exact `phaseId` and whose `source` is
  // `"BacklogRouter.route"` (the ONE source `route()` itself ever records
  // under) — any mismatch fails the whole restore closed.
  static loadFrom(store: StateStore, path: string, scopeLock: ScopeLock, ledger: FounderDecisionLedger): BacklogRouter {
    const router = new BacklogRouter(scopeLock, ledger);
    const records = store.read<unknown[]>(path) ?? [];
    records.forEach((record, index) => {
      const failure = describeInvalidPersistedBacklogRecord(record);
      if (failure) {
        throw new CorruptPersistedBacklogRecordError(index, failure);
      }
      const candidate = record as MutableBacklogRouteRecord;
      if (router.#routed.has(candidate.itemId)) {
        throw new CorruptPersistedBacklogRecordError(index, `duplicate itemId '${candidate.itemId}'`);
      }
      if (candidate.decision === "ROUTE_TO_BACKLOG") {
        const decision = ledger.get(candidate.decisionId!);
        if (!decision) {
          throw new CorruptPersistedBacklogRecordError(
            index,
            `decisionId '${candidate.decisionId}' has no matching record in the Decision Ledger — a persisted ` +
              `ROUTE_TO_BACKLOG denial must have real, locatable governance evidence behind it`
          );
        }
        if (decision.project !== candidate.phaseId) {
          throw new CorruptPersistedBacklogRecordError(
            index,
            `decisionId '${candidate.decisionId}' is recorded against project '${decision.project}', not phase ` +
              `'${candidate.phaseId}' — ledger evidence does not belong to this backlog routing decision`
          );
        }
        if (decision.source !== "BacklogRouter.route") {
          throw new CorruptPersistedBacklogRecordError(
            index,
            `decisionId '${candidate.decisionId}' was recorded by '${decision.source}', not 'BacklogRouter.route' ` +
              `— ledger evidence is stale or contradicts this backlog routing decision`
          );
        }
      }
      router.#routed.set(candidate.itemId, { ...candidate });
    });
    return router;
  }
}
