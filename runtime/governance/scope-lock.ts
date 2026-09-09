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
  return undefined;
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
      updatedAt: new Date().toISOString()
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
      updatedAt: new Date().toISOString()
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
      updatedAt: new Date().toISOString()
    };
    // Same ordering fix as lock()/close() above, same root class.
    this.#ledger.record(decisionId, phaseId, `Phase '${phaseId}' reopened: ${reason}`, "ScopeLock.reopen");
    this.#phases.set(phaseId, record);
    return freezeRecord(record);
  }

  saveTo(store: StateStore, path: string): void {
    store.write(path, [...this.#phases.values()]);
  }

  static loadFrom(store: StateStore, path: string, ledger: FounderDecisionLedger): ScopeLock {
    const lock = new ScopeLock(ledger);
    const records = store.read<unknown[]>(path) ?? [];
    records.forEach((record, index) => {
      const failure = describeInvalidPersistedPhaseLock(record);
      if (failure) {
        throw new CorruptPersistedPhaseLockError(index, failure);
      }
      const candidate = record as MutablePhaseLockRecord;
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
      routedAt: new Date().toISOString()
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

  static loadFrom(store: StateStore, path: string, scopeLock: ScopeLock, ledger: FounderDecisionLedger): BacklogRouter {
    const router = new BacklogRouter(scopeLock, ledger);
    const records = store.read<unknown[]>(path) ?? [];
    records.forEach((record, index) => {
      const failure = describeInvalidPersistedBacklogRecord(record);
      if (failure) {
        throw new CorruptPersistedBacklogRecordError(index, failure);
      }
      const candidate = record as MutableBacklogRouteRecord;
      router.#routed.set(candidate.itemId, { ...candidate });
    });
    return router;
  }
}
