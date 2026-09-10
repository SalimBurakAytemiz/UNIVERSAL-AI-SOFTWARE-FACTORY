// 35th independent review round governance mechanism (3 of 4): Phase
// Closure Manifest. Persisted under `project-state/phase-closures/` (one
// JSON file per closure attempt, never overwritten — an attempt, CLOSED or
// REJECTED, is itself a durable, inspectable artifact of "what was checked,
// and what did it say?").
//
// This round's own Part D/G instruction is direct: "Tests passed alone
// must never be sufficient for phase closure." This module makes that a
// structural property of the closure path rather than a review-time
// reminder — `attemptPhaseClosure()` below REJECTS a closure attempt
// unless ALL of the following independently hold:
//   1. At least one verification-evidence reference is supplied, and every
//      one of them ACTUALLY RESOLVES on disk (reusing
//      `runtime/requirements-traceability/traceability.ts`'s
//      `isVerifiedEvidenceRef()` — the SAME evidence-verification
//      primitive the requirement registry itself already uses, per Part G:
//      "consume the EXISTING authoritative evidence/traceability path, do
//      NOT create a duplicate evidence subsystem").
//   2. The Central Invariant Guard (`runtime/invariants/invariant-guard.ts`)
//      reports zero BLOCKING violations.
//   3. The Implementation Reality Matrix (`runtime/governance/reality-matrix.ts`,
//      computed HERE, internally, against the authoritative registry —
//      never accepted as a caller-supplied value; see the "replaceable
//      production authority" fix note on `AttemptPhaseClosureDeps` below)
//      reports zero unresolved BLOCKED requirements.
//   4. An independent review result of exactly "CLEAN" is supplied — a
//      bare "tests passed locally" is categorically insufficient; only an
//      EXTERNAL, independent confirmation can satisfy this field, and
//      nothing in this module can manufacture one on its own.
// Only when every one of those holds does this module call through to
// `ScopeLock.close()` (Part C) — which is what actually flips the phase's
// state AND records the closure into the EXISTING Founder Decision Ledger
// (Part F) — so there remains exactly ONE authoritative place a phase
// transition happens, never a second, parallel "closure" mechanism.

import { isVerifiedEvidenceRef } from "../requirements-traceability/traceability.js";
import type { InvariantGuard, InvariantGuardReport } from "../invariants/invariant-guard.js";
import type { InvariantViolation } from "../invariants/invariant-guard.js";
import { ScopeLock } from "./scope-lock.js";
import type { FounderDecisionLedger } from "../decisions/decision-ledger.js";
import { computeRealityMatrix } from "./reality-matrix.js";
import type { StateStore } from "../state/file-store.js";
import { assertFilesystemConfinement } from "../sandbox/sandbox.js";
import { deepFreezeClone } from "../util/immutable.js";

export type IndependentReviewResult = "CLEAN" | "PENDING" | "FOUND_ISSUES";
export type PhaseClosureOutcome = "CLOSED" | "REJECTED";

/**
 * P1 fix (independent Codex review, "verify independent review evidence
 * before phase closure"): a bare `IndependentReviewResult` string used to
 * be the ENTIRE closure precondition — any caller could type `"CLEAN"`
 * with nothing behind it, and this module had no way to tell a
 * manufactured claim from a genuine reviewer's verdict, nor any way to
 * tell whether the review was even OF the commit actually being closed.
 * Fixed: the review evidence is now this richer, structured record
 * naming WHO reviewed, WHAT commit they reviewed, WHEN, and a durable,
 * independently re-checkable evidence reference — reusing the SAME
 * Evidence Gate (`isVerifiedEvidenceRef()`) every other evidence claim in
 * this codebase already goes through, per baseline's "no claim without
 * evidence" (section 303) extended to WHO is making a closure claim, not
 * only whether a path resolves.
 */
export interface IndependentReviewEvidence {
  readonly reviewId: string;
  readonly reviewerIdentity: string;
  readonly reviewedCommitSha: string;
  readonly reviewedBranch?: string;
  readonly reviewTimestamp: string;
  readonly outcome: IndependentReviewResult;
  /** Repository-relative path to a real, durable, re-checkable artifact recording this review (a review report, an exported transcript, a signed verdict file). */
  readonly evidenceRef: string;
}

export interface PhaseClosureAttempt {
  readonly phaseId: string;
  readonly requestedBy: string;
  readonly reason: string;
  /** Repository-relative paths to real, on-disk verification artifacts (logs, proof files, CI output). Must be non-empty. */
  readonly verificationEvidenceRefs: readonly string[];
  readonly independentReview: IndependentReviewEvidence;
  /**
   * The exact commit SHA this closure attempt is closing. Compared
   * against `independentReview.reviewedCommitSha` — a review of commit A
   * must never be allowed to close commit B (independent Codex review's
   * own explicit regression scenario).
   */
  readonly closingCommitSha: string;
}

export interface PhaseClosureManifestRecord {
  readonly manifestId: string;
  readonly phaseId: string;
  readonly outcome: PhaseClosureOutcome;
  readonly requestedBy: string;
  readonly reason: string;
  readonly createdAt: string;
  readonly invariantViolations: readonly InvariantViolation[];
  readonly blockedRequirementIds: readonly string[];
  readonly verificationEvidenceRefs: readonly string[];
  readonly independentReview: IndependentReviewEvidence;
  readonly closingCommitSha: string;
  readonly rejectionReasons: readonly string[];
  readonly decisionId?: string;
}

/**
 * `requirementsDir` here is the SAME authoritative registry the Central
 * Invariant Guard and every other governance mechanism this round reads —
 * never a caller-suppliable stand-in.
 *
 * P1 targeted-audit fix (35th independent review round, "replaceable
 * production authority" root class — same class this round's own Fix 6
 * closed in project-lifecycle/orchestrator.ts, "a caller-supplied
 * requirementsRegistry can never REPLACE the check against the Factory's
 * OWN real registry"): `PhaseClosureAttempt` used to carry its OWN
 * `blockedRequirementIds` field, supplied by the CALLER rather than
 * computed by this module — a caller (honestly mistaken, or simply
 * passing a stale/wrong value) could claim `blockedRequirementIds: []`
 * while the real, authoritative Implementation Reality Matrix still shows
 * unresolved BLOCKED requirements, and this function had no way to catch
 * the discrepancy; the caller's claim silently REPLACED the authoritative
 * computation instead of being compared against it. Fixed: this function
 * now calls `computeRealityMatrix(deps.requirementsDir, deps.rootDir)`
 * itself, using ITS `blockedRequirementIds` — a caller can no longer
 * substitute a different answer for the one the authoritative registry
 * actually supports.
 */
export interface AttemptPhaseClosureDeps {
  readonly scopeLock: ScopeLock;
  readonly invariantGuard: InvariantGuard;
  readonly rootDir: string;
  readonly requirementsDir: string;
  readonly store: StateStore;
  readonly manifestDir: string;
  /**
   * P1 fix (independent Codex review, "persist phase closure atomically
   * with its manifest"): the SAME Founder Decision Ledger instance backing
   * `scopeLock` — required so this function can durably persist it
   * (`ledger.saveTo()`) as part of the staged closure transaction below,
   * rather than leaving the ledger transition living ONLY in memory (the
   * gap this finding identifies: a process crash after `scopeLock.close()`
   * mutates in-memory state, but before anything durable captures it,
   * used to leave the manifest's own durable `CLOSED` claim with no
   * matching durable ScopeLock/Ledger evidence at all).
   */
  readonly ledger: FounderDecisionLedger;
  readonly scopeLockPath: string;
  readonly ledgerPath: string;
}

const SAFE_GOVERNANCE_IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

/**
 * P1 fix (36th independent review round, finding 2, "confine generated
 * phase-manifest paths"): thrown when `phaseId`/`manifestId` is not a safe,
 * self-contained identifier — same validation shape as `sandbox.ts`'s own
 * `assertValidProjectId()`/`PROJECT_ID_PATTERN`, reused here rather than
 * inventing a second identifier-validation rule.
 */
export class InvalidGovernanceIdentifierError extends Error {
  constructor(kind: string, value: string, reason: string) {
    super(
      `Invalid ${kind} '${value}': ${reason}. A governance identifier must match ` +
        `${SAFE_GOVERNANCE_IDENTIFIER_PATTERN} — letters, digits, '_', and '-' only, starting with an ` +
        `alphanumeric character; no path separators, no '.', no '..'.`
    );
    this.name = "InvalidGovernanceIdentifierError";
  }
}

function assertSafeGovernanceIdentifier(kind: string, value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidGovernanceIdentifierError(kind, String(value), "must be a non-empty string");
  }
  if (!SAFE_GOVERNANCE_IDENTIFIER_PATTERN.test(value)) {
    throw new InvalidGovernanceIdentifierError(
      kind,
      value,
      "contains a disallowed character (path separator, '.', or something else outside [a-zA-Z0-9_-])"
    );
  }
}

/**
 * P1 fix (36th independent review round, finding 2): `phaseId`/`manifestId`
 * used to be interpolated directly into a filename with NO validation —
 * `manifestId = "../../outside"` would resolve OUTSIDE `manifestDir`
 * entirely (`join()` happily collapses `..` segments), letting a caller
 * read or write governance-manifest-shaped data anywhere on disk the
 * process has access to. Fixed with TWO independent layers, mirroring the
 * defense-in-depth already established elsewhere in this codebase
 * (`project-genome`'s id pattern + `sandbox.ts`'s filesystem confinement):
 * (1) `assertSafeGovernanceIdentifier()` rejects any identifier containing
 * a path separator, `.`, `..`, or any character outside a narrow safe set,
 * BEFORE the identifier ever reaches a path operation; (2)
 * `assertFilesystemConfinement()` (the SAME symlink-aware, TOCTOU-hardened
 * primitive `runtime/requirements-traceability/traceability.ts` already
 * reuses for evidence refs) re-validates the constructed filename actually
 * resolves inside `manifestDir`, catching any residual escape a future
 * identifier-pattern change might otherwise reopen.
 */
function manifestPath(manifestDir: string, phaseId: string, manifestId: string): string {
  assertSafeGovernanceIdentifier("phaseId", phaseId);
  assertSafeGovernanceIdentifier("manifestId", manifestId);
  return assertFilesystemConfinement(manifestDir, `${phaseId}-${manifestId}.json`);
}

/**
 * P1 fix (independent Codex review, "persist phase closure atomically
 * with its manifest"): the durable "transaction intent" record for a
 * closure that WILL close the phase — written BEFORE any authoritative
 * governance state is mutated, so a crash before this point leaves
 * nothing behind at all (the phase remains exactly as it was, no false
 * CLOSED claim anywhere — scenario A of this finding's mandatory
 * invariant), and a crash AFTER this point but before the final manifest
 * is written can always be completed (or safely abandoned) by
 * `recoverPendingPhaseClosure()` below using exactly this record. Kept in
 * the SAME `manifestDir` (not a second directory) with a distinct
 * `.intent.json` suffix — one governance-artifact tree, not two.
 */
function intentPath(manifestDir: string, phaseId: string, manifestId: string): string {
  assertSafeGovernanceIdentifier("phaseId", phaseId);
  assertSafeGovernanceIdentifier("manifestId", manifestId);
  return assertFilesystemConfinement(manifestDir, `${phaseId}-${manifestId}.intent.json`);
}

type PendingClosureIntentStatus = "PREPARED" | "COMMITTED" | "ABANDONED";

interface PendingClosureIntent {
  readonly status: PendingClosureIntentStatus;
  readonly phaseId: string;
  readonly manifestId: string;
  readonly decisionId: string;
  readonly reason: string;
  readonly guardReport: InvariantGuardReport;
  readonly manifest: PhaseClosureManifestRecord;
  readonly createdAt: string;
}

/**
 * P1 fix (36th independent review round, finding 3, "reject duplicate
 * closure-manifest identifiers"): closure manifests are append-only
 * historical evidence (baseline section 255, "why didn't this close?" must
 * always be answerable from what was ACTUALLY recorded at the time) —
 * reusing a `phaseId`/`manifestId` pair used to silently OVERWRITE the
 * original manifest with whatever the new attempt concluded, destroying
 * the original durable evidence. Checked here, unconditionally, before ANY
 * other work in `attemptPhaseClosure()` — a caller reusing an id gets a
 * clear, immediate failure regardless of what the new attempt would have
 * decided, and the original file on disk is never touched.
 */
export class DuplicateClosureManifestError extends Error {
  constructor(phaseId: string, manifestId: string) {
    super(
      `A closure manifest already exists for phase '${phaseId}' / manifestId '${manifestId}'. Closure ` +
        `manifests are append-only historical evidence and must never be overwritten — use a new, distinct ` +
        `manifestId for this attempt (referencing the prior one in its own reason/notes if it supersedes it).`
    );
    this.name = "DuplicateClosureManifestError";
  }
}

/**
 * Runs the full closure gate and persists a manifest record for the
 * attempt regardless of outcome (a REJECTED attempt is just as much a
 * durable governance artifact as a CLOSED one — "why didn't this close?"
 * must always be answerable, baseline section 255). Returns the manifest;
 * never throws for an expected-shape rejection (unmet evidence, unresolved
 * invariants, blocked requirements, a non-CLEAN or wrong-commit review, or
 * a phase not currently LOCKED_FOR_CLOSURE) — those are all ordinary
 * REJECTED outcomes, not exceptions. DOES throw for a malformed identifier
 * (`InvalidGovernanceIdentifierError`), a reused manifest id
 * (`DuplicateClosureManifestError`), or a failure to durably persist
 * required governance state — none of those are attempt OUTCOMES, they
 * are reasons this call could not even be evaluated/recorded at all.
 *
 * P1 fix (independent Codex review, "persist phase closure atomically with
 * its manifest"): a `willClose` outcome used to persist the manifest
 * (`outcome: "CLOSED"`) FIRST, then call `deps.scopeLock.close()` — which
 * mutates the ScopeLock/Decision Ledger ONLY IN MEMORY; neither was ever
 * durably persisted (`saveTo()`) by this function. A process crash at ANY
 * point after the manifest write — including immediately after it —
 * left a durable manifest claiming CLOSED with NOTHING durable behind it:
 * `scope-lock.json`/`decision-ledger.json` on disk still showed the phase
 * LOCKED_FOR_CLOSURE. Fixed with a staged, crash-recoverable protocol:
 *   (1) PREPARE — write a durable transaction-intent record (this
 *       function's own `PendingClosureIntent`, at `intentPath()`) BEFORE
 *       mutating any authoritative state. A crash before this point (or
 *       during it, since `StateStore.write()` is itself atomic) leaves
 *       nothing behind at all — the phase remains untouched (scenario A of
 *       this finding's mandatory invariant).
 *   (2) TRANSITION — call `scopeLock.close()` (in-memory; already proven
 *       not to throw, per this function's own decisionId precheck below).
 *   (3) PERSIST LEDGER — `deps.ledger.saveTo()`. Chosen to run BEFORE step
 *       (4) because `ScopeLock.loadFrom()` cross-validates a persisted
 *       phase record's `decisionId` against the Decision Ledger — durably
 *       persisting the ledger first means a crash between (3) and (4)
 *       leaves `scope-lock.json` completely untouched (still
 *       LOCKED_FOR_CLOSURE, still scenario A), rather than a scope-lock
 *       file that references ledger evidence not yet on disk.
 *   (4) PERSIST SCOPE LOCK — `deps.scopeLock.saveTo()`.
 *   (5) FINALIZE — write the real manifest (outcome CLOSED) at `path`.
 *   (6) COMMIT — mark the intent record COMMITTED (cleanup; not required
 *       for correctness, since the manifest at `path` is itself sufficient
 *       proof of full commit — scenario B).
 * `recoverPendingPhaseClosure()` below completes (or safely abandons) a
 * transaction that crashed between steps (1) and (6).
 */
export function attemptPhaseClosure(
  attempt: PhaseClosureAttempt,
  manifestId: string,
  decisionId: string,
  deps: AttemptPhaseClosureDeps
): PhaseClosureManifestRecord {
  const path = manifestPath(deps.manifestDir, attempt.phaseId, manifestId);
  if (deps.store.exists(path)) {
    throw new DuplicateClosureManifestError(attempt.phaseId, manifestId);
  }

  const rejectionReasons: string[] = [];

  if (attempt.verificationEvidenceRefs.length === 0) {
    rejectionReasons.push(
      "no verification evidence references were supplied — a bare 'tests passed' claim is never sufficient " +
        "for phase closure (this round's own Part D/G requirement)"
    );
  } else {
    const unresolved = attempt.verificationEvidenceRefs.filter((ref) => !isVerifiedEvidenceRef(ref, deps.rootDir));
    if (unresolved.length > 0) {
      rejectionReasons.push(
        `${unresolved.length} verification evidence reference(s) do not resolve to a real, on-disk artifact: ${unresolved.join(", ")}`
      );
    }
  }

  const guardReport = deps.invariantGuard.runAll();
  if (!guardReport.allBlockingSatisfied) {
    rejectionReasons.push(
      `the Central Invariant Guard reports unresolved BLOCKING violation(s): ` +
        guardReport.violations
          .filter((v) => v.severity === "BLOCKING")
          .map((v) => `${v.invariantId}: ${v.detail}`)
          .join("; ")
    );
  }

  const realityMatrix = computeRealityMatrix(deps.requirementsDir, deps.rootDir);
  if (realityMatrix.blockedRequirementIds.length > 0) {
    rejectionReasons.push(
      `${realityMatrix.blockedRequirementIds.length} requirement(s) in the authoritative Implementation Reality ` +
        `Matrix are still BLOCKED: ${realityMatrix.blockedRequirementIds.join(", ")}`
    );
  }

  // P1 fix (independent Codex review, "verify independent review evidence
  // before phase closure"): a bare `independentReviewResult` string used
  // to be the whole check — any caller could type "CLEAN". Now every
  // structural field of the review evidence is checked, the evidence
  // reference itself must resolve via the SAME Evidence Gate every other
  // claim in this codebase goes through, AND the review must have
  // reviewed the EXACT commit this attempt is closing — a review of
  // commit A must never be allowed to close commit B.
  const review = attempt.independentReview;
  if (!review.reviewId || !review.reviewerIdentity || !review.reviewTimestamp || !review.reviewedCommitSha) {
    rejectionReasons.push(
      "independent review evidence is incomplete — reviewId, reviewerIdentity, reviewTimestamp and " +
        "reviewedCommitSha are all required; a bare outcome string is never sufficient for phase closure"
    );
  } else if (!isVerifiedEvidenceRef(review.evidenceRef, deps.rootDir)) {
    rejectionReasons.push(
      `independent review evidenceRef '${review.evidenceRef}' does not resolve to a real, on-disk, durable artifact`
    );
  } else if (review.reviewedCommitSha !== attempt.closingCommitSha) {
    rejectionReasons.push(
      `independent review reviewed commit '${review.reviewedCommitSha}', but this attempt is closing commit ` +
        `'${attempt.closingCommitSha}' — a review of one commit must never close a different commit`
    );
  } else if (review.outcome !== "CLEAN") {
    rejectionReasons.push(
      `independent review outcome is '${review.outcome}', not CLEAN — a phase may only close after a LATER ` +
        `independent review of the exact closing commit explicitly returns CLEAN; a locally-run verification ` +
        `suite, however thoroughly it passes, can never itself satisfy this`
    );
  }

  const currentState = deps.scopeLock.getState(attempt.phaseId);
  if (currentState !== "LOCKED_FOR_CLOSURE") {
    rejectionReasons.push(
      `phase '${attempt.phaseId}' is not currently LOCKED_FOR_CLOSURE (current state: ${currentState}) — ` +
        `closure may only be attempted after ScopeLock.lock() has already run`
    );
  }

  // decisionId must be fresh — checked read-only, BEFORE anything is
  // persisted, so a colliding decisionId is an ordinary REJECTED outcome,
  // never a durable "CLOSED" claim for a transition that then fails.
  if (rejectionReasons.length === 0 && deps.scopeLock.hasDecision(decisionId)) {
    rejectionReasons.push(
      `decisionId '${decisionId}' already names an existing Decision Ledger entry — closure requires a fresh, ` +
        `never-before-used decisionId (this is exactly the one precondition ScopeLock.close() itself would ` +
        `otherwise fail on, after durable closure evidence had already been persisted)`
    );
  }

  // Whether this attempt WOULD close the phase, pending only the final
  // commit steps below — no side effect has happened yet at this point.
  const willClose = rejectionReasons.length === 0;
  const outcome: PhaseClosureOutcome = willClose ? "CLOSED" : "REJECTED";

  const manifest: PhaseClosureManifestRecord = {
    manifestId,
    phaseId: attempt.phaseId,
    outcome,
    requestedBy: attempt.requestedBy,
    reason: attempt.reason,
    createdAt: new Date().toISOString(),
    invariantViolations: guardReport.violations,
    blockedRequirementIds: realityMatrix.blockedRequirementIds,
    verificationEvidenceRefs: attempt.verificationEvidenceRefs,
    independentReview: review,
    closingCommitSha: attempt.closingCommitSha,
    rejectionReasons,
    ...(willClose ? { decisionId } : {})
  };
  const frozen = deepFreezeClone(manifest);

  if (!willClose) {
    // A rejection makes no authoritative-state claim at all — a single
    // durable write is already atomic (no partial-commit window exists).
    deps.store.write(path, frozen);
    return frozen;
  }

  // --- Staged, crash-recoverable commit protocol (willClose === true) ---
  const iPath = intentPath(deps.manifestDir, attempt.phaseId, manifestId);
  const intent: PendingClosureIntent = {
    status: "PREPARED",
    phaseId: attempt.phaseId,
    manifestId,
    decisionId,
    reason: attempt.reason,
    guardReport,
    manifest: frozen,
    createdAt: new Date().toISOString()
  };
  // (1) PREPARE. If this throws, nothing else has happened — scenario A.
  deps.store.write(iPath, deepFreezeClone(intent));

  // (2) TRANSITION. Guaranteed not to throw: currentState/guardReport were
  // just re-verified above with no intervening yield point, and the fresh-
  // decisionId precondition was proven moments ago.
  deps.scopeLock.close(attempt.phaseId, attempt.reason, guardReport, decisionId);
  // (3) PERSIST LEDGER, then (4) PERSIST SCOPE LOCK — see this function's
  // own doc comment for why the ledger must be persisted first.
  deps.ledger.saveTo(deps.store, deps.ledgerPath);
  deps.scopeLock.saveTo(deps.store, deps.scopeLockPath);
  // (5) FINALIZE.
  deps.store.write(path, frozen);
  // (6) COMMIT (cleanup only — the manifest at `path` is already
  // sufficient proof of full commit even if this final write is lost).
  deps.store.write(iPath, deepFreezeClone({ ...intent, status: "COMMITTED" as PendingClosureIntentStatus }));

  return frozen;
}

/**
 * P1 fix (independent Codex review, "persist phase closure atomically
 * with its manifest"): completes — or safely abandons — a closure
 * transaction that crashed between `attemptPhaseClosure()`'s own staged
 * commit steps. Idempotent: calling this with nothing pending, or after
 * the transaction already fully committed, is a no-op that simply
 * returns the existing manifest (or `undefined`). `deps.scopeLock` and
 * `deps.ledger` must be freshly restored from `deps.scopeLockPath`/
 * `deps.ledgerPath` (e.g. via `ScopeLock.loadFrom()`/
 * `FounderDecisionLedger.loadFrom()`) for this function's own state
 * inspection (`getState()`/`get()`) to reflect genuinely durable state
 * rather than another live instance's in-memory-only view.
 */
export interface RecoverPendingPhaseClosureDeps {
  readonly scopeLock: ScopeLock;
  readonly ledger: FounderDecisionLedger;
  readonly store: StateStore;
  readonly manifestDir: string;
  readonly scopeLockPath: string;
  readonly ledgerPath: string;
}

export function recoverPendingPhaseClosure(
  phaseId: string,
  manifestId: string,
  deps: RecoverPendingPhaseClosureDeps
): PhaseClosureManifestRecord | undefined {
  const path = manifestPath(deps.manifestDir, phaseId, manifestId);
  const iPath = intentPath(deps.manifestDir, phaseId, manifestId);

  const existingManifest = deps.store.read<PhaseClosureManifestRecord>(path);
  if (existingManifest) {
    // Already fully committed (scenario B) — clean up a lingering PREPARED
    // marker if one somehow survived, but the outcome itself needs nothing.
    const intent = deps.store.read<PendingClosureIntent>(iPath);
    if (intent && intent.status === "PREPARED") {
      deps.store.write(iPath, { ...intent, status: "COMMITTED" as PendingClosureIntentStatus });
    }
    return existingManifest;
  }

  const intent = deps.store.read<PendingClosureIntent>(iPath);
  if (!intent || intent.status !== "PREPARED") {
    // Nothing pending for this id — either it was never attempted, or a
    // REJECTED attempt (which never writes an intent record at all).
    return undefined;
  }

  const currentState = deps.scopeLock.getState(phaseId);
  if (currentState === "OPEN") {
    // Something has reopened this phase since the crash — resurrecting a
    // stale closure over that would silently override an explicit,
    // presumably-later governance decision. Abandon, never resume.
    deps.store.write(iPath, { ...intent, status: "ABANDONED" as PendingClosureIntentStatus });
    return undefined;
  }

  if (currentState === "LOCKED_FOR_CLOSURE") {
    if (deps.ledger.get(intent.decisionId)) {
      // Step (3) already durably ran in an earlier process, but step (4)
      // never captured it — reconcile from the ALREADY-existing ledger
      // evidence rather than re-recording it (close() would throw
      // DuplicateDecisionError attempting to record it a second time).
      deps.scopeLock.reconcileFromExistingDecision(phaseId, "CLOSED", intent.reason, intent.decisionId);
    } else {
      // Step (2)/(3) never ran at all — safe to run the transition fresh,
      // using the SAME guardReport and decisionId already captured
      // durably in the intent record.
      deps.scopeLock.close(phaseId, intent.reason, intent.guardReport, intent.decisionId);
    }
    deps.ledger.saveTo(deps.store, deps.ledgerPath);
    deps.scopeLock.saveTo(deps.store, deps.scopeLockPath);
  }
  // currentState === "CLOSED": steps (2)-(4) already fully, durably
  // consistent (ScopeLock.loadFrom() itself would have refused to restore
  // an inconsistent CLOSED record) — only finalize/commit remain.

  deps.store.write(path, intent.manifest);
  deps.store.write(iPath, { ...intent, status: "COMMITTED" as PendingClosureIntentStatus });
  return intent.manifest;
}

export function readPhaseClosureManifest(
  store: StateStore,
  manifestDir: string,
  phaseId: string,
  manifestId: string
): PhaseClosureManifestRecord | undefined {
  return store.read<PhaseClosureManifestRecord>(manifestPath(manifestDir, phaseId, manifestId));
}
