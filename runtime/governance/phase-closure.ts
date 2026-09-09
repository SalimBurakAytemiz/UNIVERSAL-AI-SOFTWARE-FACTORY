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

import { join } from "node:path";
import { isVerifiedEvidenceRef } from "../requirements-traceability/traceability.js";
import type { InvariantGuard } from "../invariants/invariant-guard.js";
import type { InvariantViolation } from "../invariants/invariant-guard.js";
import { ScopeLock, InvalidPhaseTransitionError } from "./scope-lock.js";
import { computeRealityMatrix } from "./reality-matrix.js";
import type { StateStore } from "../state/file-store.js";
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

function manifestPath(manifestDir: string, phaseId: string, manifestId: string): string {
  return join(manifestDir, `${phaseId}-${manifestId}.json`);
}

/**
 * Runs the full closure gate and persists a manifest record for the
 * attempt regardless of outcome (a REJECTED attempt is just as much a
 * durable governance artifact as a CLOSED one — "why didn't this close?"
 * must always be answerable, baseline section 255). Returns the manifest;
 * never throws for an expected-shape rejection (unmet evidence, unresolved
 * invariants, blocked requirements, a non-CLEAN review, or a phase not
 * currently LOCKED_FOR_CLOSURE) — those are all ordinary REJECTED outcomes,
 * not exceptions.
 */
export function attemptPhaseClosure(
  attempt: PhaseClosureAttempt,
  manifestId: string,
  decisionId: string,
  deps: AttemptPhaseClosureDeps
): PhaseClosureManifestRecord {
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

  let outcome: PhaseClosureOutcome = "REJECTED";
  let closedDecisionId: string | undefined;

  if (rejectionReasons.length === 0) {
    try {
      deps.scopeLock.close(attempt.phaseId, attempt.reason, guardReport, decisionId);
      outcome = "CLOSED";
      closedDecisionId = decisionId;
    } catch (err) {
      // Should be unreachable given the currentState check above, but a
      // concurrent transition between that check and this call is exactly
      // the class of race every other authoritative-state mutation in this
      // codebase already fails closed on rather than assuming away — never
      // silently swallow it into a generic rejection reason without saying
      // what actually happened.
      if (err instanceof InvalidPhaseTransitionError) {
        rejectionReasons.push(`phase transitioned concurrently before closure could complete: ${err.message}`);
      } else {
        throw err;
      }
    }
  }

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
    ...(closedDecisionId ? { decisionId: closedDecisionId } : {})
  };

  const frozen = deepFreezeClone(manifest);
  deps.store.write(manifestPath(deps.manifestDir, attempt.phaseId, manifestId), frozen);
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
