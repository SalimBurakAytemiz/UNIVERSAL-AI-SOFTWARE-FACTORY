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

import { execFileSync } from "node:child_process";
import { isAuthenticatedVerificationArtifact, isOutcomeVerifiedEvidenceRef, type EvidenceRef } from "../requirements-traceability/traceability.js";
import type { InvariantGuard, InvariantGuardReport } from "../invariants/invariant-guard.js";
import type { InvariantViolation } from "../invariants/invariant-guard.js";
import { ScopeLock, expectedLedgerSourceForPhaseState } from "./scope-lock.js";
import type { FounderDecisionLedger } from "../decisions/decision-ledger.js";
import { computeRealityMatrix, type RealityMatrixSummary } from "./reality-matrix.js";
import type { StateStore } from "../state/file-store.js";
import { assertFilesystemConfinement } from "../sandbox/sandbox.js";
import { acquireFileLock, type FileLockOptions } from "../cache/file-lock.js";
import { deepFreezeClone } from "../util/immutable.js";
import { isNonBlankIdentity } from "../util/identity.js";
import { isCanonicalIsoTimestamp } from "../cost/cost-engine.js";

/**
 * P1 fix (independent Codex review, "phase closure must reject incomplete
 * authoritative P0 requirements", finding 2): the ONLY statuses that
 * represent genuinely closure-ready work — either evidence-backed
 * completion (UNIT_TESTED or higher, per `traceability.ts`'s own
 * `PROGRESS_ORDER`) or an explicit, deliberate retirement
 * (DEPRECATED/SUPERSEDED, which baseline section 294 already treats as
 * "no longer an active progress claim", never a blocker). Every OTHER
 * status this registry recognizes — DEFINED, PLANNED,
 * IMPLEMENTATION_IN_PROGRESS, IMPLEMENTED, BLOCKED, and the reality
 * matrix's own derived `UNSUPPORTED_CLAIM` — represents work that is
 * DEFINED but not yet PROVEN, and must never silently permit a phase to
 * close around it. This closed the exact reproduction: the real P0
 * registry's own `blockedRequirementIds`-only check (bkz. aşağısı) let
 * `guardClean` report `true` while 1 DEFINED and 6
 * IMPLEMENTATION_IN_PROGRESS requirements — none of them BLOCKED — sat
 * genuinely unfinished in the SAME authoritative registry this function
 * itself computes `realityMatrix` from.
 */
const CLOSURE_READY_EFFECTIVE_STATUSES: ReadonlySet<string> = new Set([
  "UNIT_TESTED",
  "INTEGRATION_TESTED",
  "PROOF_VERIFIED",
  "PRODUCTION_VERIFIED",
  "DEPRECATED",
  "SUPERSEDED"
]);

/**
 * P1 fix (independent Codex review, "bind the closing SHA to trusted
 * repository state", finding 5): thrown when this repository's actual,
 * checked-out commit cannot be resolved from a trusted source (git
 * itself) — a closure attempt can never fall back to trusting a caller's
 * own claim about what HEAD is when the trusted source is unavailable;
 * FAIL CLOSED instead.
 */
export class UntrustedRepositoryIdentityError extends Error {
  constructor(rootDir: string, cause?: unknown) {
    super(
      `Could not resolve the actual repository HEAD commit at '${rootDir}' from a trusted source (git). A phase ` +
        `closure attempt can never trust a caller's own claim about which commit is being closed — if the real, ` +
        `checked-out repository identity cannot be independently verified, closure fails closed rather than ` +
        `proceeding on unverifiable trust.`,
      { cause }
    );
    this.name = "UntrustedRepositoryIdentityError";
  }
}

const GIT_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

/**
 * P1 fix (independent review, "reject recovery intents for another phase
 * or manifest" / "match recovered decisions against an already-closed
 * phase", findings 6 & 7): `recoverPendingPhaseClosure()` used to treat a
 * persisted intent record found AT the requested `(phaseId, manifestId)`
 * path as automatically BELONGING to that exact target — but
 * `intentPath()`/`manifestPath()` join `phaseId`/`manifestId` with a plain
 * `-` separator, and `assertSafeGovernanceIdentifier()` ALLOWS `-` inside
 * either identifier: `phaseId="P0-sub"`/`manifestId="manifest"` and
 * `phaseId="P0"`/`manifestId="sub-manifest"` both resolve to the IDENTICAL
 * file `P0-sub-manifest.intent.json` — a genuine path collision between
 * two DIFFERENT closure attempts. Recovery also never verified an
 * ALREADY-CLOSED phase's own authoritative `decisionId` (bkz.
 * `ScopeLock.get()`) actually matches `intent.decisionId` before
 * finalizing — it only ASSUMED consistency because `ScopeLock.loadFrom()`
 * validates records at RESTORE time, never re-checking that assumption
 * against the SPECIFIC intent being recovered right here. Either gap lets
 * a colliding/forged/stale intent be silently promoted to a real
 * governance outcome for the WRONG phase or the WRONG decision. Fixed:
 * `recoverPendingPhaseClosure()` now verifies exact identity consistency
 * (requested phaseId/manifestId, the intent's own persisted
 * phaseId/manifestId, `intent.attempt.phaseId`, and — when the phase is
 * already CLOSED — the phase's live, authoritative `decisionId` AND its
 * matching Decision Ledger record) BEFORE taking any recovery action,
 * throwing this error (never silently returning `undefined`, which a
 * caller could misread as the unremarkable "nothing pending" case) and
 * writing NOTHING — no phase transition, no finalized manifest — on any
 * mismatch.
 */
export class MismatchedClosureIntentError extends Error {
  constructor(detail: string) {
    super(
      `Refusing to recover a phase-closure intent: ${detail}. A persisted intent's identity must exactly match ` +
        `the requested recovery target before any recovery action is taken — this is fail-closed governance ` +
        `state, never resolved by trusting whichever record happens to be found on disk.`
    );
    this.name = "MismatchedClosureIntentError";
  }
}

/**
 * P1 fix (independent Codex review, "bind the closing SHA to trusted
 * repository state", finding 5): the ONE trusted source of "what commit is
 * actually checked out here" — `git rev-parse HEAD`, run directly against
 * `rootDir`, never a value any caller supplies. Comparing TWO
 * caller-controlled fields against each other (the prior behavior this
 * finding reproduced: `closingCommitSha` vs. `review.reviewedCommitSha`,
 * both attacker/caller-suppliable) proves only that the caller was
 * internally consistent, never which revision is genuinely being closed.
 * `attemptPhaseClosure()` below binds BOTH of those caller-supplied fields
 * against THIS independently-resolved value, so a caller can no longer
 * declare an arbitrary "closing" identity — transitively, a review must
 * have reviewed the EXACT commit this repository's own git metadata says
 * is checked out right now.
 */
export function resolveTrustedRepositoryHeadSha(rootDir: string): string {
  let sha: string;
  try {
    sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim();
  } catch (err) {
    throw new UntrustedRepositoryIdentityError(rootDir, err);
  }
  if (!GIT_COMMIT_SHA_PATTERN.test(sha)) {
    throw new UntrustedRepositoryIdentityError(rootDir, new Error(`unexpected 'git rev-parse HEAD' output: '${sha}'`));
  }
  return sha;
}

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
  /**
   * P1 fix (independent Codex review, "phase verification and independent
   * review must use verified outcome artifacts", finding 4): this used to
   * be a bare `string` path — mere file EXISTENCE (`isVerifiedEvidenceRef()`)
   * was the entire check, so any existing file (a random source module,
   * `package.json`) satisfied it. Now a full `EvidenceRef` (bkz.
   * `requirements-traceability/traceability.ts`), authenticated via the
   * SAME Evidence Gate `isOutcomeVerifiedEvidenceRef()`/`isAuthenticatedVerificationArtifact()`
   * hardened for finding 3 — the artifact must be shaped like a genuine
   * verification-flow output and name a recognized `verificationSource`,
   * never merely "a file that happens to exist".
   */
  readonly evidenceRef: EvidenceRef;
}

export interface PhaseClosureAttempt {
  readonly phaseId: string;
  readonly requestedBy: string;
  readonly reason: string;
  /**
   * P1 fix (independent Codex review, "phase verification and independent
   * review must use verified outcome artifacts", finding 4): bare
   * `string` paths (mere existence) no longer satisfy this — every entry
   * must be an outcome-verified `EvidenceRef` (bkz.
   * `IndependentReviewEvidence.evidenceRef`'in fix notu). Must be
   * non-empty.
   */
  readonly verificationEvidenceRefs: readonly EvidenceRef[];
  readonly independentReview: IndependentReviewEvidence;
  /**
   * The commit SHA this closure attempt CLAIMS to be closing. Compared
   * against `independentReview.reviewedCommitSha` (a review of commit A
   * must never be allowed to close commit B) AND — per finding 5, "bind
   * the closing SHA to trusted repository state" — against the
   * INDEPENDENTLY resolved actual repository HEAD (bkz.
   * `resolveTrustedRepositoryHeadSha()`'in üstündeki fix notu); comparing
   * only the first pair proves nothing but the caller's own internal
   * consistency, since both were, until this fix, equally caller-suppliable.
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
  /**
   * P1 fix (independent Codex review, "phase closure must reject
   * incomplete authoritative P0 requirements", finding 2): every
   * requirement in the authoritative Implementation Reality Matrix whose
   * `effectiveStatus` is not yet closure-ready (bkz.
   * `CLOSURE_READY_EFFECTIVE_STATUSES`'in üstündeki fix notu) — a strict
   * SUPERSET of `blockedRequirementIds` (BLOCKED is one of several
   * not-yet-ready statuses), kept as its own field so the manifest states
   * plainly WHY closure was refused, not only which requirements were
   * outright BLOCKED.
   */
  readonly incompleteRequirementIds: readonly string[];
  readonly verificationEvidenceRefs: readonly EvidenceRef[];
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
  /**
   * P1 fix (independent Codex review, "bind the closing SHA to trusted
   * repository state", finding 5): resolves the ACTUAL repository HEAD
   * commit from a trusted source — defaults to
   * `resolveTrustedRepositoryHeadSha()` (real `git rev-parse HEAD`).
   * Overridable ONLY so tests can exercise this gate deterministically
   * without needing a real git checkout at their temp `rootDir`; every
   * genuine call site should rely on the real default.
   */
  readonly resolveHeadCommitSha?: (rootDir: string) => string;
  /**
   * P1 fix (P0 final closure remediation, finding 8, "closure manifest
   * identities must be atomically reserved"): forwarded to the
   * per-manifest `acquireFileLock()` call this function's own duplicate
   * check now runs inside — bkz. `attemptPhaseClosure()`'ın fix notu.
   * Mirrors `FileCache`'s own identical `lockOptions` constructor
   * parameter; overridable ONLY so tests can exercise lock contention
   * deterministically (a short `timeoutMs`) without waiting out the real
   * default — every genuine call site should leave this unset.
   */
  readonly lockOptions?: FileLockOptions;
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
 *
 * P2 fix (P0 closure remediation, current 7-finding round, finding 5,
 * "encode manifest identities without delimiter collisions"): reproduced —
 * `SAFE_GOVERNANCE_IDENTIFIER_PATTERN` explicitly PERMITS `-` inside either
 * `phaseId` or `manifestId` (bkz. onun üstündeki pattern), yet the filename
 * below used to join the two with a plain, literal `-`:
 * `("P0-sub", "manifest")` and `("P0", "sub-manifest")` both resolved to the
 * IDENTICAL file `P0-sub-manifest.json` — not merely a recovery-time
 * identity-confusion risk (bkz. `MismatchedClosureIntentError`'ın fix notu,
 * findings 6 & 7, which detects but does not PREVENT this collision), but a
 * genuine durable-storage COLLISION: two closure attempts for two entirely
 * different, independently valid (phaseId, manifestId) pairs would
 * literally share one file on disk, so whichever commits second silently
 * overwrites the first's manifest. Fixed with a length-prefixed encoding
 * (`encodeGovernanceIdentityComponent()` below) for EACH identifier before
 * they are ever concatenated: the explicit length prefix makes the exact
 * boundary between the two encoded identifiers unambiguous regardless of
 * what characters (including `-` or digits) either identifier itself
 * contains — this is a structurally collision-free representation, never a
 * delimiter search that a crafted identifier could confuse. `.` is used as
 * the (never-identifier-valid, since `.` is rejected by
 * `SAFE_GOVERNANCE_IDENTIFIER_PATTERN`) separator between the length prefix
 * and the identifier it bounds, purely for filename readability — the
 * length prefix, not the `.`, is what actually guarantees no collision.
 */
function encodeGovernanceIdentityComponent(id: string): string {
  return `${id.length}.${id}`;
}

export function manifestPath(manifestDir: string, phaseId: string, manifestId: string): string {
  assertSafeGovernanceIdentifier("phaseId", phaseId);
  assertSafeGovernanceIdentifier("manifestId", manifestId);
  return assertFilesystemConfinement(
    manifestDir,
    `${encodeGovernanceIdentityComponent(phaseId)}.${encodeGovernanceIdentityComponent(manifestId)}.json`
  );
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
export function intentPath(manifestDir: string, phaseId: string, manifestId: string): string {
  assertSafeGovernanceIdentifier("phaseId", phaseId);
  assertSafeGovernanceIdentifier("manifestId", manifestId);
  return assertFilesystemConfinement(
    manifestDir,
    `${encodeGovernanceIdentityComponent(phaseId)}.${encodeGovernanceIdentityComponent(manifestId)}.intent.json`
  );
}

type PendingClosureIntentStatus = "PREPARED" | "COMMITTED" | "ABANDONED";

/**
 * P1 fix (independent Codex review, "recovery must revalidate persisted
 * phase-closure intents", finding 6): this record used to ALSO persist
 * `guardReport` and the fully-computed `manifest` — the CONCLUSION of
 * evaluating the original attempt — and `recoverPendingPhaseClosure()`
 * trusted both blindly, never re-deriving them from live state. A forged
 * or stale intent (mismatched `phaseId`/`manifestId`, a fabricated
 * `guardReport.allBlockingSatisfied: true`, empty verification evidence,
 * incomplete independent-review data, a fake SHA) was promoted straight to
 * CLOSED with NOTHING re-checked. Fixed: this record now persists ONLY the
 * ORIGINAL REQUEST (`attempt`) — the untrusted input a caller made, never
 * this module's own prior conclusion about it. `recoverPendingPhaseClosure()`
 * re-runs the EXACT SAME gate `attemptPhaseClosure()` itself uses
 * (`evaluateClosureAttempt()`, bkz. aşağısı) against LIVE authoritative
 * state before ever completing or finalizing anything.
 */
interface PendingClosureIntent {
  readonly status: PendingClosureIntentStatus;
  readonly phaseId: string;
  readonly manifestId: string;
  readonly decisionId: string;
  readonly attempt: PhaseClosureAttempt;
  readonly createdAt: string;
}

function describeEvidenceRef(ref: EvidenceRef): string {
  return typeof ref === "string" ? ref : ref.path;
}

/**
 * TR (BLOCKER 2 fix notu, "FINAL P0 CLOSURE REMEDIATION" — UASF-REQ-0045,
 * baseline §149/§303): Bu fonksiyon eklenmeden ÖNCE, `independentReview`
 * alanının doğrulaması TAMAMEN çağıranın kendi tipli iddiasına (reviewId,
 * reviewerIdentity, outcome vb.) ve `evidenceRef`'in yalnızca YOL ŞEKLİNE
 * (bkz. `isAuthenticatedVerificationArtifact()`) dayanıyordu — dosyanın
 * GERÇEK İÇERİĞİ hiçbir zaman okunmuyordu. Bağımsız inceleme, bunun tam
 * olarak ne anlama geldiğini gösterdi: bir kapanış denemesi, GERÇEK bir
 * inceleme hiç olmamışken, uydurulmuş `reviewId`/`reviewerIdentity` alanları
 * VE depodaki rastgele, var olan herhangi bir `proofs/**\/*.test.ts`
 * dosyasına işaret eden bir `evidenceRef` ile CLOSED durumuna ulaşabiliyordu
 * — çünkü o dosya "proofs/" desenine uyuyordu ve var olduğu için
 * `isAuthenticatedVerificationArtifact()` onu kabul ediyordu, ama dosyanın
 * İÇİNDE iddia edilen incelemeyle ilgili TEK BİR SATIR bile yoktu.
 *
 * Kök neden: "kanıt referansı var olan bir dosyaya işaret ediyor" ile
 * "o dosya, iddia edilen incelemeyi GERÇEKTEN kaydediyor" birbirine
 * karıştırılmıştı (bölüm 303'ün "no claim without evidence" ilkesinin
 * doğrudan ihlali — iddiayı destekleyen şey yine çağıranın kendi sözüydü).
 *
 * Çözüm (mevcut mimariyle uyumlu EN KÜÇÜK mekanizma — yeni bir imza/kriptografik
 * zincir icat etmeden): bağımsız incelemenin `evidenceRef`'i artık
 * (1) `type: "REVIEW_RESULT"` taşıyan yapılandırılmış bir referans olmalı
 * (bir TEST_RESULT/PROOF_RESULT referansı asla inceleme kanıtı olarak kabul
 * edilmez), (2) `isAuthenticatedVerificationArtifact()`'ın mevcut yol-şekli/
 * `verificationSource` kontrolünden geçmeli, (3) GERÇEKTEN VAR OLAN bir
 * `.json` dosyasına çözülmeli (bir `.test.ts` kaynak dosyası asla inceleme
 * kanıtı olamaz — kaynak kodu, makine tarafından doğrulanabilir bir
 * inceleme sonucu TAŞIMAZ), VE (4) o JSON dosyasının İÇERİĞİ, çağıranın
 * `IndependentReviewEvidence` nesnesinde iddia ettiği reviewId/
 * reviewerIdentity/reviewedCommitSha/reviewedBranch/reviewTimestamp/outcome
 * alanlarının HER BİRİYLE TAM OLARAK EŞLEŞMELİDİR. Bu, sahte üstverinin tek
 * başına yeterli olmasını engeller: bir çağıran artık hem tipli iddiayı HEM
 * DE onu birebir doğrulayan kalıcı bir JSON kaydını üretmek zorundadır —
 * biri diğeriyle tutarsızsa (ör. başka bir commit için yazılmış gerçek bir
 * inceleme kaydına işaret edip reviewedCommitSha'yı değiştirerek), bu
 * fonksiyon reddeder. Bu hâlâ kriptografik olarak sahteye karşı kanıtlanamaz
 * bir mekanizma değildir, ama "var olan herhangi bir dosyaya işaret et,
 * geri kalanını uydur" saldırısını kapatır — kapanmasını gereken tam sınıf.
 */
export interface IndependentReviewRecordFile {
  readonly kind: "INDEPENDENT_REVIEW_RECORD";
  readonly reviewId: string;
  readonly reviewerIdentity: string;
  readonly reviewedCommitSha: string;
  readonly reviewedBranch?: string;
  readonly reviewTimestamp: string;
  readonly outcome: IndependentReviewResult;
}

function isGenuineIndependentReviewRecord(value: unknown): value is IndependentReviewRecordFile {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.kind === "INDEPENDENT_REVIEW_RECORD" &&
    isNonBlankIdentity(v.reviewId) &&
    isNonBlankIdentity(v.reviewerIdentity) &&
    isNonBlankIdentity(v.reviewedCommitSha) &&
    typeof v.reviewTimestamp === "string" &&
    isCanonicalIsoTimestamp(v.reviewTimestamp) &&
    (v.outcome === "CLEAN" || v.outcome === "PENDING" || v.outcome === "FOUND_ISSUES") &&
    (v.reviewedBranch === undefined || typeof v.reviewedBranch === "string")
  );
}

/**
 * TR: BLOCKER 2'nin asıl doğrulama kapısı — bkz. yukarıdaki fix notu.
 * Yalnızca `evaluateClosureAttempt()` tarafından çağrılır; hem taze bir
 * `attemptPhaseClosure()` denemesi hem de kurtarılmış (`recoverPendingPhaseClosure()`)
 * bir deneme AYNI bu fonksiyondan geçer — ikinci, farklı kapsamlı bir kopya
 * asla oluşturulmaz (bu dosyanın genel tasarım ilkesi: "tek yetkili geçit").
 */
function isContentAuthenticatedIndependentReview(
  review: IndependentReviewEvidence,
  rootDir: string,
  store: StateStore
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (typeof review.evidenceRef === "string") {
    return {
      ok: false,
      reason:
        "independent review evidenceRef must be a structured REVIEW_RESULT reference (path/type/outcome/" +
        "verificationSource) — a bare legacy path does not resolve to a genuine, recognized, trusted " +
        "verification artifact and makes no verifiable claim about what it is"
    };
  }
  if (review.evidenceRef.type !== "REVIEW_RESULT") {
    return {
      ok: false,
      reason: `independent review evidenceRef must have type 'REVIEW_RESULT', got '${review.evidenceRef.type}'`
    };
  }
  if (!isAuthenticatedVerificationArtifact(review.evidenceRef, rootDir)) {
    return {
      ok: false,
      reason:
        `independent review evidenceRef '${describeEvidenceRef(review.evidenceRef)}' does not resolve to a ` +
        `genuine, recognized, trusted verification artifact`
    };
  }

  let resolved: string;
  try {
    resolved = assertFilesystemConfinement(rootDir, review.evidenceRef.path);
  } catch {
    return { ok: false, reason: "independent review evidenceRef path could not be safely resolved within the repository root" };
  }

  // TR: Kaynak dosyaları (.test.ts vb.) "proofs/"/"__tests__/" desenine
  // uyduğu için yol-şekli kontrolünü geçebilir, ama bunlar makine
  // tarafından ayrıştırılabilir bir inceleme SONUCU taşımaz — yalnızca
  // GERÇEK bir JSON kaydı, iddia edilen kimlik/sonuç alanlarını taşıyıp
  // taşımadığı doğrulanabilecek bir içerik sunar.
  if (!resolved.endsWith(".json")) {
    return {
      ok: false,
      reason:
        "independent review evidenceRef must reference a JSON evidence record whose content genuinely attests " +
        "the claimed review (reviewId/reviewerIdentity/reviewedCommitSha/reviewTimestamp/outcome) — a source or " +
        "test file's mere existence on disk proves nothing about what any review actually concluded"
    };
  }

  // TR: `store.read()` (bkz. `file-store.ts`) malformed/geçersiz JSON için
  // `JSON.parse`'ın kendi `SyntaxError`'ını YAKALAMADAN fırlatır — bir
  // saldırgan (veya kazara bozulmuş) kanıt dosyası bu geçidi "kapalı
  // başarısız olmak" yerine TÜM `attemptPhaseClosure()` çağrısını
  // çökertmemelidir; bu yüzden okuma burada try/catch içine alınır ve
  // ayrıştırma hatası da tıpkı "geçerli bir kayıt değil" gibi ele alınır.
  let record: unknown;
  try {
    record = store.read<unknown>(resolved);
  } catch (err) {
    return {
      ok: false,
      reason: `independent review evidenceRef at '${review.evidenceRef.path}' could not be read as valid JSON: ${String(err)}`
    };
  }
  if (!isGenuineIndependentReviewRecord(record)) {
    return {
      ok: false,
      reason:
        `independent review evidenceRef at '${review.evidenceRef.path}' does not contain a genuine, well-formed ` +
        `INDEPENDENT_REVIEW_RECORD (kind/reviewId/reviewerIdentity/reviewedCommitSha/reviewTimestamp/outcome)`
    };
  }

  const claimedBranch = review.reviewedBranch ?? undefined;
  const recordedBranch = record.reviewedBranch ?? undefined;
  if (
    record.reviewId !== review.reviewId ||
    record.reviewerIdentity !== review.reviewerIdentity ||
    record.reviewedCommitSha !== review.reviewedCommitSha ||
    record.reviewTimestamp !== review.reviewTimestamp ||
    record.outcome !== review.outcome ||
    claimedBranch !== recordedBranch
  ) {
    return {
      ok: false,
      reason:
        `independent review evidenceRef content at '${review.evidenceRef.path}' does not match the claimed review ` +
        `metadata — the durable evidence record must genuinely corroborate reviewId/reviewerIdentity/` +
        `reviewedCommitSha/reviewedBranch/reviewTimestamp/outcome, never merely exist alongside an unrelated claim`
    };
  }

  return { ok: true };
}

/**
 * P1 fix (independent Codex review): the ONE authoritative gate — shared
 * verbatim by `attemptPhaseClosure()` (a fresh request) AND
 * `recoverPendingPhaseClosure()` (finding 6: re-validating a persisted,
 * UNTRUSTED intent) — so a crash-recovered closure can never be evaluated
 * by a second, differently-scoped copy of this logic. Deliberately does
 * NOT check `attempt.phaseId`'s current ScopeLock state: `attemptPhaseClosure()`
 * requires it to be exactly `LOCKED_FOR_CLOSURE`, while `recoverPendingPhaseClosure()`
 * legitimately re-runs this same gate when the phase may ALREADY be
 * `CLOSED` (steps (2)-(4) already durably completed; only finalize
 * remains) — each caller applies its own, correctly-scoped state check
 * around this shared evaluation.
 */
function evaluateClosureAttempt(
  attempt: PhaseClosureAttempt,
  deps: {
    readonly invariantGuard: InvariantGuard;
    readonly requirementsDir: string;
    readonly rootDir: string;
    // TR (BLOCKER 2 fix notu): `isContentAuthenticatedIndependentReview()`'in
    // iddia edilen inceleme kaydının GERÇEK JSON içeriğini okuyabilmesi için
    // gerekli — bkz. o fonksiyonun üstündeki fix notu.
    readonly store: StateStore;
    readonly resolveHeadCommitSha?: (rootDir: string) => string;
  }
): { readonly rejectionReasons: string[]; readonly guardReport: InvariantGuardReport; readonly realityMatrix: RealityMatrixSummary } {
  const rejectionReasons: string[] = [];

  if (attempt.verificationEvidenceRefs.length === 0) {
    rejectionReasons.push(
      "no verification evidence references were supplied — a bare 'tests passed' claim is never sufficient " +
        "for phase closure (this round's own Part D/G requirement)"
    );
  } else {
    // P1 fix (independent Codex review, "phase verification and
    // independent review must use verified outcome artifacts", finding
    // 4): `isVerifiedEvidenceRef()` (mere existence) is no longer
    // sufficient here — bkz. `IndependentReviewEvidence.evidenceRef`'in
    // fix notu. Reuses the SAME, finding-3-hardened Evidence Gate every
    // other outcome claim in this codebase now goes through.
    const unresolved = attempt.verificationEvidenceRefs.filter((ref) => !isOutcomeVerifiedEvidenceRef(ref, deps.rootDir));
    if (unresolved.length > 0) {
      rejectionReasons.push(
        `${unresolved.length} verification evidence reference(s) are not outcome-verified, trusted evidence ` +
          `(a genuine, recognized verification artifact naming a trusted source and a successful outcome): ` +
          unresolved.map(describeEvidenceRef).join(", ")
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
  // P1 fix (independent Codex review, "phase closure must reject
  // incomplete authoritative P0 requirements", finding 2): bkz.
  // `CLOSURE_READY_EFFECTIVE_STATUSES`'in üstündeki fix notu — a strict
  // superset of the old BLOCKED-only check.
  const incompleteEntries = realityMatrix.entries.filter((e) => !CLOSURE_READY_EFFECTIVE_STATUSES.has(e.effectiveStatus));
  if (incompleteEntries.length > 0) {
    rejectionReasons.push(
      `${incompleteEntries.length} requirement(s) in the authoritative Implementation Reality Matrix have not ` +
        `yet reached a closure-ready status (UNIT_TESTED or higher, or DEPRECATED/SUPERSEDED): ` +
        incompleteEntries.map((e) => `${e.requirementId} (status: ${e.effectiveStatus})`).join(", ")
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
  // P1 fix (independent review, "require meaningful independent-review
  // metadata", finding 8): the checks above used bare TRUTHINESS
  // (`!review.reviewerIdentity`) — a whitespace-only string like `"   "`
  // is truthy, so it satisfied this check while naming no genuine
  // reviewer at all; a `reviewTimestamp` of `"yesterday-ish"` passed
  // identically, since nothing here ever confirmed it was a real,
  // parseable moment in time. Fixed: `reviewId`/`reviewerIdentity`/
  // `reviewedCommitSha` now go through the SAME `isNonBlankIdentity()`
  // (trim + non-empty) this codebase already requires for every other
  // "who/what genuinely did this" field (approver identities, founder
  // confirmations), and `reviewTimestamp` must be a canonical ISO-8601
  // timestamp (reusing `cost-engine.ts`'s own established round-trip
  // check, never a second, differently-scoped date-parsing rule) — a
  // merely `Date.parse()`-able informal string no longer qualifies.
  if (
    !isNonBlankIdentity(review.reviewId) ||
    !isNonBlankIdentity(review.reviewerIdentity) ||
    !isNonBlankIdentity(review.reviewedCommitSha) ||
    typeof review.reviewTimestamp !== "string" ||
    !isCanonicalIsoTimestamp(review.reviewTimestamp)
  ) {
    rejectionReasons.push(
      "independent review evidence is incomplete or malformed — reviewId, reviewerIdentity and " +
        "reviewedCommitSha must each be a genuine, non-blank identity (never merely a truthy string), and " +
        "reviewTimestamp must be a canonical ISO-8601 timestamp (e.g. new Date().toISOString()); a bare outcome " +
        "string, a blank/whitespace identity, or an informal timestamp are never sufficient for phase closure"
    );
  } else if (isNonBlankIdentity(attempt.requestedBy) && review.reviewerIdentity.trim().toLowerCase() === attempt.requestedBy.trim().toLowerCase()) {
    // TR (BLOCKER 2 fix notu, "reviewer independence requirements"): bir
    // kapanışı İSTEYEN kişi/süreç, KENDİ isteğinin bağımsız incelemesini
    // yapamaz — reviewerIdentity, requestedBy ile (baş/son boşluk ve büyük/
    // küçük harf farkı yok sayılarak) AYNIYSA bu, tanım gereği bağımsız bir
    // inceleme değildir (UASF-REQ-0045'in "independent" sözcüğünün kendisi).
    rejectionReasons.push(
      `independent review reviewerIdentity ('${review.reviewerIdentity}') is the same identity as ` +
        `requestedBy ('${attempt.requestedBy}') — a closure requester can never also be its own independent ` +
        `reviewer; independence requires a genuinely distinct reviewer identity`
    );
  } else {
    const contentCheck = isContentAuthenticatedIndependentReview(review, deps.rootDir, deps.store);
    if (!contentCheck.ok) {
      // P1 fix (independent Codex review, finding 4) + BLOCKER 2 fix
      // (bkz. `isContentAuthenticatedIndependentReview()`'in üstündeki fix
      // notu): the review's OWN evidence artifact must be a genuine,
      // recognized, trustworthy-sourced artifact whose ACTUAL CONTENT
      // corroborates the claimed review — never merely a file that happens
      // to exist and merely LOOKS shaped like evidence.
      rejectionReasons.push(contentCheck.reason);
    }
  }
  if (review.reviewedCommitSha !== attempt.closingCommitSha) {
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

  // P1 fix (independent Codex review, "bind the closing SHA to trusted
  // repository state", finding 5): `attempt.closingCommitSha` (and,
  // transitively via the check above, `review.reviewedCommitSha`) is now
  // bound against the ACTUAL, independently-resolved repository HEAD —
  // never only against each other, which proves nothing but the caller's
  // own internal consistency.
  try {
    const trustedHeadSha = (deps.resolveHeadCommitSha ?? resolveTrustedRepositoryHeadSha)(deps.rootDir);
    if (trustedHeadSha !== attempt.closingCommitSha) {
      rejectionReasons.push(
        `attempt.closingCommitSha ('${attempt.closingCommitSha}') does not match the actual, independently-` +
          `resolved repository HEAD ('${trustedHeadSha}') — a caller can never declare which commit is being ` +
          `closed; repository identity is resolved from a trusted source, never from caller-supplied text`
      );
    }
  } catch (err) {
    rejectionReasons.push(`repository identity could not be independently verified from a trusted source: ${String(err)}`);
  }

  return { rejectionReasons, guardReport, realityMatrix };
}

function buildManifest(
  attempt: PhaseClosureAttempt,
  manifestId: string,
  outcome: PhaseClosureOutcome,
  rejectionReasons: readonly string[],
  guardReport: InvariantGuardReport,
  realityMatrix: RealityMatrixSummary,
  decisionId?: string
): PhaseClosureManifestRecord {
  return {
    manifestId,
    phaseId: attempt.phaseId,
    outcome,
    requestedBy: attempt.requestedBy,
    reason: attempt.reason,
    createdAt: new Date().toISOString(),
    invariantViolations: guardReport.violations,
    blockedRequirementIds: realityMatrix.blockedRequirementIds,
    incompleteRequirementIds: realityMatrix.entries
      .filter((e) => !CLOSURE_READY_EFFECTIVE_STATUSES.has(e.effectiveStatus))
      .map((e) => e.requirementId),
    verificationEvidenceRefs: attempt.verificationEvidenceRefs,
    independentReview: attempt.independentReview,
    closingCommitSha: attempt.closingCommitSha,
    rejectionReasons,
    ...(outcome === "CLOSED" && decisionId !== undefined ? { decisionId } : {})
  };
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
 * P1 fix (P0 closure remediation, current 7-finding round, finding 2,
 * "serialize governance writes under one shared state lock"): both
 * `attemptPhaseClosure()` and `recoverPendingPhaseClosure()` mutate and
 * durably persist the SAME two shared files (`scopeLockPath`/`ledgerPath`)
 * — but the ONLY lock either used to acquire was scoped to an individual
 * manifest's own identity (`${manifestPath}.lock`, bkz.
 * `attemptPhaseClosure()`'ın finding-8 fix notu), and `recoverPendingPhaseClosure()`
 * acquired no lock at all. Two processes closing DIFFERENT phases or
 * manifest ids after each loading its OWN in-memory snapshot of the SAME
 * shared Decision Ledger / Scope Lock therefore never contended on any
 * common lock: both could run their entire critical section concurrently,
 * each end by calling `scopeLock.saveTo()`/`ledger.saveTo()` with a
 * snapshot that only knows about ITS OWN phase's transition — the second
 * writer's `saveTo()` silently overwrites the whole shared file, losing
 * the first writer's transition even though its own manifest was already
 * durably written as CLOSED. `governanceStateLockPath()` derives ONE
 * shared lock file from `scopeLockPath` — the single logical governance
 * domain both functions mutate — so every closure/recovery attempt for
 * ANY phase or manifest fully serializes through the same critical
 * section, exactly like `cost-engine.ts`'s own `withLedgerLock()` fully
 * serializes every mutation against ITS one shared ledger file.
 */
function governanceStateLockPath(scopeLockPath: string): string {
  return `${scopeLockPath}.governance.lock`;
}

/**
 * P1 fix (P0 closure remediation, current 7-finding round, finding 2):
 * thrown when persisting a closure/recovery transition would overwrite
 * durable Scope Lock state that has changed since the caller's own
 * `scopeLock` snapshot was loaded — i.e. some OTHER process, holding the
 * SAME shared governance lock at a different moment, already recorded a
 * transition this caller's in-memory copy does not yet reflect. Never
 * silently overwritten: the caller must reload the latest authoritative
 * state (`ScopeLock.loadFrom()`/`FounderDecisionLedger.loadFrom()`) and
 * retry — exactly the "one cleanly waits/retries" outcome this finding's
 * own regression explicitly accepts as correct, the SAME shape
 * `DuplicateClosureManifestError` already establishes for the sibling
 * manifest-identity race (finding 8 of the prior closure round).
 */
export class ConcurrentGovernanceStateChangedError extends Error {
  constructor(context: string) {
    super(
      `Refusing to persist a governance-state transition (${context}): a shared, durable governance file ` +
        `(the Scope Lock OR the Founder Decision Ledger) has changed since this caller's own in-memory ` +
        `snapshot was loaded — a concurrent process has already recorded a transition (for this phase/decision ` +
        `or another) that this snapshot does not yet reflect. Reload the latest authoritative ` +
        `ScopeLock/FounderDecisionLedger state and retry; never blindly overwrite it.`
    );
    this.name = "ConcurrentGovernanceStateChangedError";
  }
}

/**
 * Fail-closed staleness check for the shared governance state, run ONLY
 * once inside the shared `governanceStateLockPath()` critical section and
 * ONLY immediately before a closure/recovery attempt is about to durably
 * mutate it (an outcome that never touches ScopeLock/the ledger at all —
 * e.g. an ordinary REJECTED manifest — has nothing to lose and skips
 * this). Reads the RAW persisted phase records the exact same way
 * `ScopeLock.loadFrom()` itself does (bkz. onun üstündeki fix notu) —
 * never trusting `scopeLock`'s own possibly-stale in-memory view as
 * ground truth — and compares each one against what `scopeLock` (the
 * caller's own snapshot) already knows via its existing, unchanged
 * `get()` API. Any phase the file now records that `scopeLock` does not
 * know about YET, or records with a DIFFERENT `state`/`decisionId` than
 * `scopeLock` believes, means this snapshot is stale relative to the
 * authoritative file — this function throws rather than letting the
 * caller's eventual `saveTo()` silently discard that concurrently-
 * recorded transition.
 *
 * TR (bkz. blocker-1 fix notu, aşağısı `assertLedgerStateNotStale()`): bu
 * fonksiyon YALNIZCA Scope Lock dosyasını kontrol eder — Decision Ledger'ı
 * DEĞİL. Bu fonksiyonun TEK BAŞINA çağrılması, "kararlar sessizce
 * kaybolabilir" (bkz. `assertLedgerStateNotStale`'ın kendi fix notu)
 * açığını KAPATMAZ; her iki paylaşımlı dosya da her mutasyondan önce
 * kontrol edilmelidir — bu yüzden bu fonksiyonun HER çağrı noktası artık
 * `assertLedgerStateNotStale()` ile BİRLİKTE (ikisi de aynı paylaşımlı kilit
 * içinde) çağrılır, asla tek başına değil.
 */
function assertGovernanceStateNotStale(store: StateStore, scopeLockPath: string, scopeLock: ScopeLock, phaseId: string): void {
  const persisted = store.read<unknown[]>(scopeLockPath);
  if (!persisted) {
    return;
  }
  for (const raw of persisted) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const candidate = raw as { phaseId?: unknown; state?: unknown; decisionId?: unknown };
    if (typeof candidate.phaseId !== "string") {
      continue;
    }
    const known = scopeLock.get(candidate.phaseId);
    if (!known || known.state !== candidate.state || known.decisionId !== candidate.decisionId) {
      throw new ConcurrentGovernanceStateChangedError(`scope-lock record for phase '${phaseId}'`);
    }
  }
}

/**
 * P1 fix (FINAL P0 CLOSURE REMEDIATION, blocker 1, "phase closure can lose
 * authoritative Founder decision history"): reproduced — `attemptPhaseClosure()`'ın
 * ve `recoverPendingPhaseClosureLocked()`'ın staged commit protokolü, PAYLAŞIMLI
 * `governanceStateLockPath()` kilidi İÇİNDE bile, mutasyondan hemen önce
 * SADECE `assertGovernanceStateNotStale()`'ı (yalnızca Scope Lock dosyasını)
 * çağırıyordu — Decision Ledger dosyasının kendisi HİÇ tazelik kontrolünden
 * geçmiyordu. Somut kesişim senaryosu: Kapanış A, adım (3)'te
 * `ledger.saveTo()`'yu BAŞARIYLA çalıştırır (kendi kararını kalıcı Ledger
 * dosyasına yazar), ardından adım (4)'te `scopeLock.saveTo()`'dan ÖNCE
 * çöker — Scope Lock dosyası hâlâ ESKİ (LOCKED_FOR_CLOSURE) durumu
 * gösterir. Kapanış B (FARKLI bir phase için), A'nın Ledger yazmasından
 * ÖNCE alınmış eski bir Ledger anlık görüntüsüyle başlar; Scope Lock dosyası
 * A tarafından hiç değiştirilmediği için B'nin `assertGovernanceStateNotStale()`
 * çağrısı SORUNSUZ geçer — oysa Ledger dosyası GERÇEKTEN A tarafından
 * ilerletilmiştir. B daha sonra kendi `ledger.saveTo()`'sunu çalıştırdığında,
 * kendi belleğindeki (A'nın kararını İÇERMEYEN) Ledger anlık görüntüsünü
 * kalıcı dosyaya yazar — A'nın az önce eklediği yetkili Founder kararını
 * SESSİZCE SİLER. Bu, UASF-REQ-0010/UASF-REQ-0044'ün (bölüm 46, karar
 * geçmişinin korunması) doğrudan ihlalidir. Düzeltme: `assertGovernanceStateNotStale()`
 * ile TAM OLARAK AYNI desende — kalıcı dosyadaki HER karar kaydı çağıranın
 * kendi `ledger.get()` görünümüyle karşılaştırılır — yeni bir
 * `assertLedgerStateNotStale()` eklendi. Artık kalıcı Ledger dosyasındaki HER
 * `decisionId`, çağıranın kendi bellek-içi görünümüyle (`status`,
 * `supersededBy`) BİREBİR eşleşmelidir; eşleşmezse (ya çağıranın hiç
 * bilmediği YENİ bir karar, ya da durumu DEĞİŞMİŞ bir karar tespit edilirse)
 * bu fonksiyon fail-closed olarak fırlatır — B'nin kendi `saveTo()`'su asla
 * çalışmaz, A'nın kararı ASLA sessizce üzerine yazılmaz. Bu kontrol, HER İKİ
 * mutasyon noktasında (`attemptPhaseClosure()` ve
 * `recoverPendingPhaseClosureLocked()`) `assertGovernanceStateNotStale()` ile
 * BİRLİKTE, aynı paylaşımlı `governanceStateLockPath()` kilidi içinde
 * çağrılır — böylece hem Scope Lock hem Decision Ledger için tazelik garanti
 * edilir, sadece biri için değil.
 */
function assertLedgerStateNotStale(store: StateStore, ledgerPath: string, ledger: FounderDecisionLedger): void {
  const persisted = store.read<unknown[]>(ledgerPath);
  if (!persisted) {
    return;
  }
  for (const raw of persisted) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const candidate = raw as { decisionId?: unknown; status?: unknown; supersededBy?: unknown };
    if (typeof candidate.decisionId !== "string") {
      continue;
    }
    const known = ledger.get(candidate.decisionId);
    if (!known || known.status !== candidate.status || known.supersededBy !== candidate.supersededBy) {
      throw new ConcurrentGovernanceStateChangedError(`decision-ledger record '${candidate.decisionId}'`);
    }
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
  callerAttempt: PhaseClosureAttempt,
  manifestId: string,
  decisionId: string,
  deps: AttemptPhaseClosureDeps
): PhaseClosureManifestRecord {
  // P1 fix (P0 final closure remediation, finding 7, "closure evaluation
  // and persistence must use one snapshot"): reproduced — every field
  // this function reads from the caller-supplied `attempt` (most
  // dangerously `attempt.independentReview.outcome`, but the SAME class
  // applies to any other field) used to be read MULTIPLE times across
  // this function's body: once by `evaluateClosureAttempt()` to DECIDE
  // `willClose`, and again — separately — by `buildManifest()` when
  // constructing the record that eventually gets persisted (itself only
  // detached from the caller by `deepFreezeClone()`'s `structuredClone()`
  // AFTER `buildManifest()` already ran). A caller whose `independentReview`
  // exposes `outcome` as a STATEFUL GETTER (first read: "CLEAN", every
  // later read: "FOUND_ISSUES") could therefore pass the evaluation gate
  // on the FIRST read, then have the SECOND read (captured into the
  // persisted manifest, and read AGAIN by `structuredClone()` inside
  // `deepFreezeClone()`) show a completely different, non-CLEAN outcome —
  // a durably persisted "CLOSED" manifest whose own `independentReview`
  // field contradicts the very evidence that supposedly justified
  // closing. Fixed the same way this codebase already snapshots any
  // caller-controlled input read across more than one step (bkz.
  // `policy-engine.ts`'in risk-snapshot, `gateway.ts`'in execution-scope
  // fix notları): `attempt` is detached into a single, fully immutable
  // snapshot via `deepFreezeClone()` (one `structuredClone()` call — every
  // getter anywhere in the object graph is evaluated EXACTLY ONCE, right
  // here, before anything else happens) and EVERY subsequent read in this
  // function — evaluation, manifest construction, the intent record,
  // persistence — uses that SAME frozen `attempt`, never the caller's
  // original, still-live object again.
  const attempt = deepFreezeClone(callerAttempt);
  const path = manifestPath(deps.manifestDir, attempt.phaseId, manifestId);

  // P1 fix (P0 final closure remediation, finding 8, "closure manifest
  // identities must be atomically reserved"): reproduced — the duplicate
  // check above used to be `deps.store.exists(path)` immediately followed
  // (many synchronous statements, but no ATOMICITY between the two) by
  // this function's own eventual `deps.store.write(path, frozen)` — a
  // classic check-then-write TOCTOU race. Two concurrent closure attempts
  // for the SAME (phaseId, manifestId) could each observe `exists() ===
  // false` before either had written anything, then both proceed to
  // evaluate and (eventually) write — the second write silently
  // OVERWRITING the first's manifest, destroying it as durable evidence
  // (exactly what `DuplicateClosureManifestError`'s own contract promises
  // never happens). `attemptPhaseClosure()` is entirely synchronous (no
  // `await` anywhere in its body), so the fix reuses the EXACT same
  // synchronous, non-`await`-spanning `acquireFileLock()` critical-section
  // pattern this codebase already established for `file-cache.ts`'s own
  // check-then-claim races — never a bespoke locking mechanism. The lock
  // is held for this function's ENTIRE remaining body: the (now genuinely
  // exclusive) duplicate check, evaluation, and every write this attempt
  // could make — so a concurrent second attempt for the identical
  // identity blocks until the first one has completely finished, then
  // itself observes the first attempt's manifest via `exists()` and fails
  // closed with `DuplicateClosureManifestError`, exactly as intended.
  // P1 fix (P0 closure remediation, current 7-finding round, finding 2,
  // "serialize governance writes under one shared state lock"): acquired
  // BEFORE (and released AFTER) the per-manifest lock below — bkz.
  // `governanceStateLockPath()`'in üstündeki fix notu for the full
  // reproduction this closes. Always acquired in this SAME outer-then-
  // inner order (never the reverse) so two concurrent attempts can never
  // deadlock against each other.
  const releaseGovernanceLock = acquireFileLock(governanceStateLockPath(deps.scopeLockPath), deps.lockOptions);
  try {
    const releaseManifestLock = acquireFileLock(`${path}.lock`, deps.lockOptions);
    try {
      if (deps.store.exists(path)) {
        throw new DuplicateClosureManifestError(attempt.phaseId, manifestId);
      }

      const { rejectionReasons, guardReport, realityMatrix } = evaluateClosureAttempt(attempt, deps);

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
      const frozen = deepFreezeClone(
        buildManifest(attempt, manifestId, outcome, rejectionReasons, guardReport, realityMatrix, willClose ? decisionId : undefined)
      );

      if (!willClose) {
        // A rejection makes no authoritative-state claim at all — a single
        // durable write is already atomic (no partial-commit window exists).
        deps.store.write(path, frozen);
        return frozen;
      }

      // P1 fix (P0 closure remediation, current 7-finding round, finding 2):
      // this is the ONE point where `deps.scopeLock`'s own in-memory snapshot
      // is about to be trusted as the basis for a durable, shared-file
      // mutation (`close()` + `saveTo()` below) — bkz.
      // `assertGovernanceStateNotStale()`'in üstündeki fix notu. Checked
      // here, inside the shared governance lock, BEFORE the staged commit
      // protocol writes anything at all (including the PREPARE intent), so
      // a stale attempt leaves no trace whatsoever and fails closed rather
      // than silently discarding a concurrently-recorded sibling transition.
      assertGovernanceStateNotStale(deps.store, deps.scopeLockPath, deps.scopeLock, attempt.phaseId);
      // P1 fix (FINAL P0 CLOSURE REMEDIATION, blocker 1): `deps.ledger`'ın da
      // AYNI şekilde tazelik kontrolünden geçmesi gerekir — bkz.
      // `assertLedgerStateNotStale()`'ın üstündeki fix notu for the exact
      // "Closure A persists its ledger entry, crashes before scope-lock
      // persists, Closure B's stale ledger snapshot then silently overwrites
      // A's decision" reproduction this closes. Checked here, in the SAME
      // shared governance lock, BEFORE the staged commit protocol writes
      // anything — a stale ledger snapshot fails closed exactly like a stale
      // scope-lock snapshot does.
      assertLedgerStateNotStale(deps.store, deps.ledgerPath, deps.ledger);

      // --- Staged, crash-recoverable commit protocol (willClose === true) ---
      const iPath = intentPath(deps.manifestDir, attempt.phaseId, manifestId);
      // P1 fix (independent Codex review, "recovery must revalidate persisted
      // phase-closure intents", finding 6): persists ONLY the original
      // request (`attempt`) — bkz. `PendingClosureIntent`'in üstündeki fix
      // notu — never this function's own computed `guardReport`/`manifest`
      // conclusion, which `recoverPendingPhaseClosure()` must independently
      // re-derive, never trust.
      const intent: PendingClosureIntent = {
        status: "PREPARED",
        phaseId: attempt.phaseId,
        manifestId,
        decisionId,
        attempt,
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
    } finally {
      releaseManifestLock();
    }
  } finally {
    releaseGovernanceLock();
  }
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
  /**
   * P1 fix (independent Codex review, "recovery must revalidate persisted
   * phase-closure intents", finding 6): a PREPARED intent is UNTRUSTED
   * persisted input — recovery must re-run the FULL closure gate
   * (`evaluateClosureAttempt()`) against LIVE authoritative state, so it
   * needs the SAME authoritative sources `attemptPhaseClosure()` itself
   * reads, never a value trusted from the intent record.
   */
  readonly invariantGuard: InvariantGuard;
  readonly requirementsDir: string;
  readonly rootDir: string;
  readonly resolveHeadCommitSha?: (rootDir: string) => string;
  /**
   * P1 fix (P0 closure remediation, current 7-finding round, finding 2,
   * "serialize governance writes under one shared state lock"): forwarded
   * to the shared `governanceStateLockPath()` critical section this
   * function's own recovery-commit path now runs inside — mirrors
   * `AttemptPhaseClosureDeps.lockOptions`'s identical purpose; overridable
   * ONLY so tests can exercise lock contention deterministically — every
   * genuine call site should leave this unset.
   */
  readonly lockOptions?: FileLockOptions;
}

/**
 * P1 fix (independent Codex review, "recovery must revalidate persisted
 * phase-closure intents", finding 6): Codex reproduced a malformed,
 * fabricated PREPARED intent (mismatched phaseId/manifestId, a forged
 * `allBlockingSatisfied: true`, empty verification evidence, incomplete
 * review data, a fake SHA) being promoted straight to CLOSED — the old
 * implementation trusted `intent.guardReport`/`intent.manifest` as already-
 * decided fact and only ever replayed the mechanical persistence steps
 * (2)-(6), never re-checking whether the underlying claim actually holds.
 * Fixed: a PREPARED intent now names ONLY the ORIGINAL REQUEST
 * (`intent.attempt`) — recovery re-runs `evaluateClosureAttempt()` (the
 * EXACT SAME gate `attemptPhaseClosure()` uses for a fresh request)
 * against LIVE state before completing or finalizing anything. A
 * malformed/stale intent that no longer holds up (or never genuinely did)
 * is ABANDONED and an honest REJECTED manifest is durably recorded
 * reflecting what live re-evaluation actually found — never silently
 * discarded (preserving "why didn't this close?"), and never promoted to
 * CLOSED on the strength of a persisted claim alone.
 */
export function recoverPendingPhaseClosure(
  phaseId: string,
  manifestId: string,
  deps: RecoverPendingPhaseClosureDeps
): PhaseClosureManifestRecord | undefined {
  // P1 fix (P0 closure remediation, current 7-finding round, finding 2,
  // "serialize governance writes under one shared state lock" — "Use the
  // same locking discipline in recovery paths"): this function used to
  // acquire NO lock at all, even though its own `LOCKED_FOR_CLOSURE`
  // branch below mutates and persists the exact same shared
  // `scopeLockPath`/`ledgerPath` files `attemptPhaseClosure()` does — bkz.
  // `governanceStateLockPath()`'in üstündeki fix notu for the full
  // reproduction. Held for this function's entire body (every early
  // return below is a pure read/validation with nothing else to
  // serialize against).
  const releaseGovernanceLock = acquireFileLock(governanceStateLockPath(deps.scopeLockPath), deps.lockOptions);
  try {
    return recoverPendingPhaseClosureLocked(phaseId, manifestId, deps);
  } finally {
    releaseGovernanceLock();
  }
}

function recoverPendingPhaseClosureLocked(
  phaseId: string,
  manifestId: string,
  deps: RecoverPendingPhaseClosureDeps
): PhaseClosureManifestRecord | undefined {
  const path = manifestPath(deps.manifestDir, phaseId, manifestId);
  const iPath = intentPath(deps.manifestDir, phaseId, manifestId);

  const existingManifest = deps.store.read<PhaseClosureManifestRecord>(path);
  if (existingManifest) {
    // P1 fix (P0 final closure remediation, finding 6, "recovery must
    // validate existing manifest identity"): reproduced — this
    // "already fully committed" early-return trusted WHATEVER manifest
    // record `manifestPath()` happened to resolve to as genuinely
    // belonging to the REQUESTED (phaseId, manifestId), with no identity
    // check at all. `manifestPath()`/`intentPath()` join phaseId/
    // manifestId with a plain `-`, which `-` is itself a permitted
    // identifier character — `("P0-sub", "manifest")` and `("P0",
    // "sub-manifest")` collide onto the exact same file path. A caller
    // recovering `("P0", "sub-manifest")` could therefore be handed back
    // an unrelated phase's genuinely-CLOSED manifest and treat that
    // phase as closed too. This is the SAME class of bug this function's
    // own PREPARED-intent branch below already guards against (bkz.
    // MismatchedClosureIntentError'ın fix notu, finding 6 in the prior
    // batch) — fixed identically here: the manifest's OWN recorded
    // identity is verified against what was actually requested BEFORE it
    // is trusted as authoritative.
    if (existingManifest.phaseId !== phaseId || existingManifest.manifestId !== manifestId) {
      throw new MismatchedClosureIntentError(
        `the persisted manifest at '${path}' identifies phaseId='${existingManifest.phaseId}'/` +
          `manifestId='${existingManifest.manifestId}', but recovery was requested for phaseId='${phaseId}'/` +
          `manifestId='${manifestId}' — this is either a colliding governance-identifier path or a forged/corrupt ` +
          `manifest record`
      );
    }
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

  // P1 fix (independent review, "reject recovery intents for another phase
  // or manifest", finding 6): `intentPath()`/`manifestPath()` join
  // `phaseId`/`manifestId` with a plain `-`, which `-` is itself a
  // permitted character inside either identifier — `("P0-sub", "manifest")`
  // and `("P0", "sub-manifest")` collide on the SAME file. An intent
  // genuinely prepared for a DIFFERENT (phaseId, manifestId) pair — or one
  // whose own `attempt.phaseId` disagrees with either — must never be
  // treated as belonging to THIS recovery call: verified here, BEFORE any
  // state inspection or recovery action, against the intent's own
  // persisted identity fields (captured at PREPARE time, bkz.
  // `PendingClosureIntent`'in üstündeki fix notu).
  if (intent.phaseId !== phaseId || intent.manifestId !== manifestId || intent.attempt.phaseId !== phaseId) {
    throw new MismatchedClosureIntentError(
      `the persisted intent at '${iPath}' identifies phaseId='${intent.phaseId}'/manifestId='${intent.manifestId}'/` +
        `attempt.phaseId='${intent.attempt.phaseId}', but recovery was requested for phaseId='${phaseId}'/` +
        `manifestId='${manifestId}' — this is either a colliding governance-identifier path or a forged/corrupt ` +
        `intent record`
    );
  }

  const currentState = deps.scopeLock.getState(phaseId);
  if (currentState === "OPEN") {
    // Something has reopened this phase since the crash — resurrecting a
    // stale closure over that would silently override an explicit,
    // presumably-later governance decision. Abandon, never resume. Checked
    // BEFORE re-evaluating the gate: an explicit later reopen decision is
    // never second-guessed by re-running the ORIGINAL request's own gate.
    deps.store.write(iPath, { ...intent, status: "ABANDONED" as PendingClosureIntentStatus });
    return undefined;
  }

  // P1 fix (P0 closure remediation, current 7-finding round, finding 3,
  // "preserve already-closed authoritative outcomes during recovery"):
  // reproduced — a phase can reach `currentState === "CLOSED"` here
  // meaning steps (2)-(4) of `attemptPhaseClosure()`'s own staged commit
  // protocol ALREADY durably ran and persisted (ScopeLock + Decision
  // Ledger both genuinely, permanently transitioned) — only the final
  // manifest write (step 5/6) was interrupted by the crash. The OLD code
  // still called `evaluateClosureAttempt()` UNCONDITIONALLY below,
  // re-checking mutable LIVE state (repository HEAD, evidence artifacts on
  // disk, the Central Invariant Guard, the Implementation Reality Matrix)
  // that can genuinely have changed in the time since the original,
  // already-successful attempt ran — if that fresh re-evaluation found
  // ANY new rejection reason, the `rejectionReasons.length > 0` branch
  // recorded an ABANDONED intent and a REJECTED manifest for a phase whose
  // OWN ScopeLock record already, permanently says CLOSED: durable,
  // directly contradictory evidence (ScopeLock: CLOSED; manifest:
  // REJECTED) for the exact same governance transition. This is the SAME
  // "never second-guess an already-decided transition by re-running the
  // gate against possibly-changed live state" principle the `OPEN` branch
  // immediately above already applies in the opposite direction — applied
  // here for `CLOSED` too. Fixed: this branch now runs BEFORE
  // `evaluateClosureAttempt()` is ever called (moved up from its own
  // former position, after the identity-verification, in the `else`
  // branch below) — the identity check against this phase's OWN live
  // ScopeLock/Ledger record (bkz. finding 7'in fix notu, hâlâ değişmedi)
  // still runs and can still throw `MismatchedClosureIntentError` for a
  // forged/stale intent, but once verified, this function finalizes
  // straight to CLOSED — a freshly-computed `guardReport`/`realityMatrix`
  // still populate the manifest's own evidence fields (honest, current
  // information), but neither is ever allowed to gate the OUTCOME, which
  // is already permanently decided.
  if (currentState === "CLOSED") {
    // P1 fix (independent review, "match recovered decisions against an
    // already-closed phase", finding 7): a stale or forged intent sharing
    // this phase's `(phaseId, manifestId)` path (bkz. finding 6's fix
    // notu for how that collision can happen) but naming a WRONG
    // `decisionId` used to be finalized here anyway — the manifest below
    // would then attribute this phase's closure to a decision that never
    // actually closed it. Verified here, directly, against this phase's
    // OWN live, authoritative `ScopeLock` record AND its matching
    // Decision Ledger entry — never merely assumed from `loadFrom()`'s
    // separate, general restore-time check.
    const phaseRecord = deps.scopeLock.get(phaseId);
    if (!phaseRecord || phaseRecord.decisionId !== intent.decisionId) {
      throw new MismatchedClosureIntentError(
        `phase '${phaseId}' is CLOSED under decisionId='${phaseRecord?.decisionId ?? "(none)"}', but the ` +
          `recovered intent claims decisionId='${intent.decisionId}' — this intent did not produce this phase's ` +
          `actual closure`
      );
    }
    const closingDecision = deps.ledger.get(intent.decisionId);
    const expectedSource = expectedLedgerSourceForPhaseState("CLOSED");
    if (!closingDecision || closingDecision.project !== phaseId || closingDecision.source !== expectedSource) {
      throw new MismatchedClosureIntentError(
        `decisionId='${intent.decisionId}' has no matching Decision Ledger record for phase '${phaseId}' closed ` +
          `via '${expectedSource}' — the intent's claimed decision does not check out against authoritative ` +
          `ledger evidence`
      );
    }
    const guardReport = deps.invariantGuard.runAll();
    const realityMatrix = computeRealityMatrix(deps.requirementsDir, deps.rootDir);
    const closedManifest = deepFreezeClone(
      buildManifest(intent.attempt, manifestId, "CLOSED", [], guardReport, realityMatrix, intent.decisionId)
    );
    deps.store.write(path, closedManifest);
    deps.store.write(iPath, { ...intent, status: "COMMITTED" as PendingClosureIntentStatus });
    return closedManifest;
  }

  // currentState === "LOCKED_FOR_CLOSURE": nothing has been authoritatively
  // decided yet — steps (2)-(4) never ran (or never durably landed), so
  // re-running the FULL gate against LIVE authoritative state is exactly
  // right here (bkz. finding 6'in fix notu), using ONLY `intent.attempt`
  // (the untrusted original request) — never `intent`'s own persisted
  // conclusion about it.
  const { rejectionReasons, guardReport, realityMatrix } = evaluateClosureAttempt(intent.attempt, deps);

  if (rejectionReasons.length > 0) {
    // The persisted intent no longer holds up (authoritative state
    // genuinely changed since PREPARE) — OR never genuinely did (a
    // forged/malformed intent). Either way: FAIL CLOSED. Never promote to
    // CLOSED on the strength of a persisted claim; record the honest,
    // freshly-computed REJECTED outcome instead.
    deps.store.write(iPath, { ...intent, status: "ABANDONED" as PendingClosureIntentStatus });
    const rejected = deepFreezeClone(
      buildManifest(intent.attempt, manifestId, "REJECTED", rejectionReasons, guardReport, realityMatrix)
    );
    deps.store.write(path, rejected);
    return rejected;
  }

  // P1 fix (P0 closure remediation, current 7-finding round, finding 2):
  // same staleness check `attemptPhaseClosure()` runs immediately before
  // its own analogous mutation — bkz. `assertGovernanceStateNotStale()`'in
  // üstündeki fix notu.
  assertGovernanceStateNotStale(deps.store, deps.scopeLockPath, deps.scopeLock, phaseId);
  // P1 fix (FINAL P0 CLOSURE REMEDIATION, blocker 1): recovery'nin de
  // AYNI ledger tazelik kontrolünden geçmesi gerekir — bkz.
  // `assertLedgerStateNotStale()`'ın üstündeki fix notu. Recovery, tıpkı
  // `attemptPhaseClosure()` gibi, birazdan `deps.ledger.saveTo()` çağıracak
  // (aşağısı) — bu kontrol olmadan, recovery de az önce tanımlanan
  // "eski Ledger anlık görüntüsü, başka bir closure'ın YENİ kararını
  // sessizce siler" açığına aynı şekilde açık kalırdı.
  assertLedgerStateNotStale(deps.store, deps.ledgerPath, deps.ledger);
  if (deps.ledger.get(intent.decisionId)) {
    // Step (3) already durably ran in an earlier process, but step (4)
    // never captured it — reconcile from the ALREADY-existing ledger
    // evidence rather than re-recording it (close() would throw
    // DuplicateDecisionError attempting to record it a second time).
    deps.scopeLock.reconcileFromExistingDecision(phaseId, "CLOSED", intent.attempt.reason, intent.decisionId);
  } else {
    // Step (2)/(3) never ran at all — safe to run the transition fresh,
    // using the FRESHLY re-derived guardReport (never a persisted one)
    // and the decisionId already captured durably in the intent record.
    deps.scopeLock.close(phaseId, intent.attempt.reason, guardReport, intent.decisionId);
  }
  deps.ledger.saveTo(deps.store, deps.ledgerPath);
  deps.scopeLock.saveTo(deps.store, deps.scopeLockPath);

  const closedManifest = deepFreezeClone(
    buildManifest(intent.attempt, manifestId, "CLOSED", [], guardReport, realityMatrix, intent.decisionId)
  );
  deps.store.write(path, closedManifest);
  deps.store.write(iPath, { ...intent, status: "COMMITTED" as PendingClosureIntentStatus });
  return closedManifest;
}

export function readPhaseClosureManifest(
  store: StateStore,
  manifestDir: string,
  phaseId: string,
  manifestId: string
): PhaseClosureManifestRecord | undefined {
  return store.read<PhaseClosureManifestRecord>(manifestPath(manifestDir, phaseId, manifestId));
}
