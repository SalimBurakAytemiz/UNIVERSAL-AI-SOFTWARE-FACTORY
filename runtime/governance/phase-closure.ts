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
import type { InvariantGuard } from "../invariants/invariant-guard.js";
import type { InvariantViolation } from "../invariants/invariant-guard.js";
import { ScopeLock } from "./scope-lock.js";
import { computeRealityMatrix } from "./reality-matrix.js";
import type { StateStore } from "../state/file-store.js";
import { assertFilesystemConfinement } from "../sandbox/sandbox.js";
import { deepFreezeClone } from "../util/immutable.js";

export type IndependentReviewResult = "CLEAN" | "PENDING" | "FOUND_ISSUES";
export type PhaseClosureOutcome = "CLOSED" | "REJECTED";

export interface PhaseClosureAttempt {
  readonly phaseId: string;
  readonly requestedBy: string;
  readonly reason: string;
  /** Repository-relative paths to real, on-disk verification artifacts (logs, proof files, CI output). Must be non-empty. */
  readonly verificationEvidenceRefs: readonly string[];
  readonly independentReviewResult: IndependentReviewResult;
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
  readonly independentReviewResult: IndependentReviewResult;
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
 * invariants, blocked requirements, a non-CLEAN review, or a phase not
 * currently LOCKED_FOR_CLOSURE) — those are all ordinary REJECTED outcomes,
 * not exceptions. DOES throw for a malformed identifier
 * (`InvalidGovernanceIdentifierError`), a reused manifest id
 * (`DuplicateClosureManifestError`), or a failure to durably persist the
 * manifest — none of those are attempt OUTCOMES, they are reasons this
 * call could not even be evaluated/recorded at all.
 *
 * P1 fix (36th independent review round, finding 4, "make phase closure
 * and manifest persistence atomic"): the phase transition
 * (`deps.scopeLock.close()`) used to run BEFORE the manifest was built and
 * persisted — if `deps.store.write()` then failed (disk full, permissions,
 * an unserializable value slipping through), the phase was ALREADY
 * authoritatively CLOSED in memory (and in the Decision Ledger) with NO
 * corresponding durable evidence file: `CLOSED` with a missing manifest,
 * exactly the "evidence-backed closure" violation this mechanism exists to
 * prevent. Fixed by reordering to a staged protocol: validate (no side
 * effects) -> construct the manifest -> persist it durably -> ONLY THEN
 * commit the actual phase transition. If persistence fails, `close()` is
 * NEVER called — the phase remains exactly as it was (LOCKED_FOR_CLOSURE),
 * the caller receives the thrown error, and retrying with the SAME
 * `manifestId` is safe (the failed write left no file behind, since
 * `FileStateStore.write()` is itself atomic — write-to-temp-then-rename,
 * established since the 8th independent review round).
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

  if (attempt.independentReviewResult !== "CLEAN") {
    rejectionReasons.push(
      `independent review result is '${attempt.independentReviewResult}', not CLEAN — a phase may only close ` +
        `after a LATER independent review explicitly returns CLEAN; a locally-run verification suite, however ` +
        `thoroughly it passes, can never itself satisfy this`
    );
  }

  const currentState = deps.scopeLock.getState(attempt.phaseId);
  if (currentState !== "LOCKED_FOR_CLOSURE") {
    rejectionReasons.push(
      `phase '${attempt.phaseId}' is not currently LOCKED_FOR_CLOSURE (current state: ${currentState}) — ` +
        `closure may only be attempted after ScopeLock.lock() has already run`
    );
  }

  // P1 fix (37th independent review round, finding 4, "make phase closure
  // and manifest persistence atomic"): `deps.scopeLock.close(...)` below is
  // called AFTER the manifest has already been durably persisted with
  // `outcome: "CLOSED"` (bkz. aşağısı, ve bu fonksiyonun kendi 36th round
  // fix notu, "durable evidence FIRST") — meaning if `close()` itself then
  // throws, the manifest would ALREADY, WRONGLY claim CLOSED for a phase
  // that never actually closed. `close()`'s own preconditions
  // (`currentState`/`guardReport`) are already re-verified with the SAME
  // values just above/below, with no intervening yield point, so they
  // cannot disagree by the time `close()` actually runs — but `close()`
  // has ONE more failure mode neither of those checks covers:
  // `this.#ledger.record(decisionId, ...)` throws `DuplicateDecisionError`
  // if `decisionId` was already used for an earlier decision. Checked HERE,
  // read-only, via `ScopeLock.hasDecision()` — BEFORE anything is persisted
  // — so a colliding `decisionId` becomes an ordinary REJECTED outcome
  // (like every other precondition above), never a durable "CLOSED" claim
  // for a transition that then fails. With this precondition also proven,
  // `close()` below is now guaranteed not to throw.
  if (rejectionReasons.length === 0 && deps.scopeLock.hasDecision(decisionId)) {
    rejectionReasons.push(
      `decisionId '${decisionId}' already names an existing Decision Ledger entry — closure requires a fresh, ` +
        `never-before-used decisionId (this is exactly the one precondition ScopeLock.close() itself would ` +
        `otherwise fail on, after durable closure evidence had already been persisted)`
    );
  }

  // Whether this attempt WOULD close the phase, pending only the final
  // commit step below — no side effect has happened yet at this point.
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
    independentReviewResult: attempt.independentReviewResult,
    rejectionReasons,
    ...(willClose ? { decisionId } : {})
  };
  const frozen = deepFreezeClone(manifest);

  // Durable evidence FIRST. If this throws, `scopeLock.close()` below is
  // never reached — the phase stays exactly as it was, and no manifest
  // file was left behind for this id (see this function's own fix note).
  deps.store.write(path, frozen);

  if (willClose) {
    // In the synchronous, single-process model this module runs in, this
    // cannot fail: `currentState` was checked moments ago with no
    // intervening yield point, and closing the SAME phase re-entrantly
    // from within the invariant guard or the store write above is not a
    // pattern this codebase's own callers use. If it somehow still throws,
    // do not silently fabricate a corrected manifest — closure manifests
    // are append-only (finding 3) and the one just persisted already
    // stands as durable evidence of this attempt; surface the failure
    // loudly instead of returning a value that contradicts it.
    deps.scopeLock.close(attempt.phaseId, attempt.reason, guardReport, decisionId);
  }

  return frozen;
}

export function readPhaseClosureManifest(
  store: StateStore,
  manifestDir: string,
  phaseId: string,
  manifestId: string
): PhaseClosureManifestRecord | undefined {
  return store.read<PhaseClosureManifestRecord>(manifestPath(manifestDir, phaseId, manifestId));
}
