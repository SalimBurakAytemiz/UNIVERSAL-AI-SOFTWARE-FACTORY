import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attemptPhaseClosure,
  readPhaseClosureManifest,
  recoverPendingPhaseClosure,
  InvalidGovernanceIdentifierError,
  DuplicateClosureManifestError,
  type PhaseClosureAttempt,
  type IndependentReviewEvidence,
  type IndependentReviewResult
} from "../phase-closure.js";
import { ScopeLock } from "../scope-lock.js";
import { FounderDecisionLedger } from "../../decisions/decision-ledger.js";
import { InvariantGuard, type InvariantCheckResult } from "../../invariants/invariant-guard.js";
import { FileStateStore } from "../../state/file-store.js";
import type { EvidenceRef, EvidenceRefType } from "../../requirements-traceability/traceability.js";
import { acquireFileLock, FileLockTimeoutError } from "../../cache/file-lock.js";

/**
 * P1 fix (independent Codex review, "do not trust caller-authored
 * evidence outcomes" / "phase verification and independent review must
 * use verified outcome artifacts"): every outcome-bearing evidence ref
 * used by these fixtures must now be a genuine, recognized-artifact path
 * (bkz. traceability.ts'in fix notu) — bare strings like `"proof.log"`
 * no longer qualify. `makeDeps()` below writes this ONE real file once,
 * reused as the evidence artifact for the registry's own baseline
 * requirement, every attempt's `verificationEvidenceRefs`, and every
 * review's `evidenceRef`.
 */
const EVIDENCE_ARTIFACT_PATH = "proof.test.ts";

function evidenceRef(
  type: EvidenceRefType = "TEST_RESULT",
  path: string = EVIDENCE_ARTIFACT_PATH,
  outcome = "PASS",
  verificationSource = "npm test (vitest)"
): EvidenceRef {
  return { path, type, outcome, verificationSource };
}

function cleanGuard(): InvariantGuard {
  const guard = new InvariantGuard();
  guard.register({ id: "always-clean", description: "d", severity: "BLOCKING", check: (): InvariantCheckResult => ({ satisfied: true, detail: "ok" }) });
  return guard;
}

function dirtyGuard(): InvariantGuard {
  const guard = new InvariantGuard();
  guard.register({ id: "broken", description: "d", severity: "BLOCKING", check: (): InvariantCheckResult => ({ satisfied: false, detail: "simulated" }) });
  return guard;
}

const DEFAULT_COMMIT_SHA = "abc123def456";

/** A structurally-complete, evidence-backed review record — `outcome` is the one field tests usually vary. */
function reviewFor(outcome: IndependentReviewResult, overrides: Partial<IndependentReviewEvidence> = {}): IndependentReviewEvidence {
  return {
    reviewId: "rev-1",
    reviewerIdentity: "independent-reviewer",
    reviewedCommitSha: DEFAULT_COMMIT_SHA,
    reviewTimestamp: new Date().toISOString(),
    outcome,
    evidenceRef: evidenceRef("REVIEW_RESULT"),
    ...overrides
  };
}

interface AttemptOverrides extends Partial<Omit<PhaseClosureAttempt, "independentReview" | "closingCommitSha">> {
  /** Test-only shorthand: translated into a structurally-complete reviewFor(outcome) below. */
  independentReviewResult?: IndependentReviewResult;
  independentReview?: IndependentReviewEvidence;
  closingCommitSha?: string;
}

function baseAttempt(overrides: AttemptOverrides = {}): PhaseClosureAttempt {
  const { independentReviewResult, independentReview, closingCommitSha, ...rest } = overrides;
  return {
    phaseId: "P0",
    requestedBy: "test-suite",
    reason: "all gates passed",
    verificationEvidenceRefs: [],
    independentReview: independentReview ?? reviewFor(independentReviewResult ?? "PENDING"),
    closingCommitSha: closingCommitSha ?? DEFAULT_COMMIT_SHA,
    ...rest
  };
}

describe("attemptPhaseClosure", () => {
  let tempRoot: string;
  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  /**
   * A minimal, valid, evidence-clean registry — one requirement, already
   * closure-ready (UNIT_TESTED, backed by real, outcome-verified evidence
   * — bkz. finding 2's `CLOSURE_READY_EFFECTIVE_STATUSES`), nothing
   * BLOCKED. `resolveHeadCommitSha` is a test-only override (finding 5) —
   * these temp roots have no real git checkout, so `DEFAULT_COMMIT_SHA` is
   * the ONE trusted "actual HEAD" for every test in this file.
   */
  function makeDeps(guard = cleanGuard()) {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-phase-closure-"));
    const requirementsDir = join(tempRoot, "specification", "requirements");
    mkdirSync(requirementsDir, { recursive: true });
    writeFileSync(join(tempRoot, EVIDENCE_ARTIFACT_PATH), "real verification/proof/review artifact");
    writeFileSync(
      join(requirementsDir, "baseline.yml"),
      "- id: UASF-REQ-9200\n  title: x\n  description: x\n  source_baseline: 'BASELINE-V1 section 0'\n  category: P0\n" +
        "  priority: LOW\n  status: UNIT_TESTED\n  implementation_refs: []\n  test_refs:\n" +
        `    - path: ${EVIDENCE_ARTIFACT_PATH}\n      type: TEST_RESULT\n      outcome: PASS\n` +
        `      verificationSource: 'npm test (vitest)'\n  proof_refs: []\n`
    );
    const ledger = new FounderDecisionLedger();
    const scopeLock = new ScopeLock(ledger);
    const store = new FileStateStore();
    const manifestDir = join(tempRoot, "phase-closures");
    const scopeLockPath = join(tempRoot, "scope-lock.json");
    const ledgerPath = join(tempRoot, "decision-ledger.json");
    return {
      tempRoot,
      requirementsDir,
      ledger,
      scopeLock,
      store,
      manifestDir,
      invariantGuard: guard,
      rootDir: tempRoot,
      scopeLockPath,
      ledgerPath,
      resolveHeadCommitSha: () => DEFAULT_COMMIT_SHA
    };
  }

  it("BLOCKER: REJECTED when no verification evidence references are supplied — tests-passed-alone is never sufficient", () => {
    const deps = makeDeps();
    deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");
    const manifest = attemptPhaseClosure(
      baseAttempt({ independentReviewResult: "CLEAN" }),
      "m1",
      "d2",
      deps
    );
    expect(manifest.outcome).toBe("REJECTED");
    expect(manifest.rejectionReasons.some((r) => r.includes("no verification evidence"))).toBe(true);
    expect(deps.scopeLock.getState("P0")).toBe("LOCKED_FOR_CLOSURE");
  });

  it("BLOCKER: REJECTED when a supplied evidence reference does not resolve on disk", () => {
    const deps = makeDeps();
    deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");
    const manifest = attemptPhaseClosure(
      baseAttempt({ verificationEvidenceRefs: ["does/not/exist.log"], independentReviewResult: "CLEAN" }),
      "m1",
      "d2",
      deps
    );
    expect(manifest.outcome).toBe("REJECTED");
    expect(manifest.rejectionReasons.some((r) => r.includes("not outcome-verified"))).toBe(true);
  });

  it("BLOCKER: REJECTED when the invariant guard reports a BLOCKING violation, even with real evidence and a CLEAN review", () => {
    const deps = makeDeps(dirtyGuard());
    const evidenceFile = join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH);
    writeFileSync(evidenceFile, "verification output");
    deps.scopeLock.lock("P0", "ready", { allBlockingSatisfied: true, evaluatedAt: new Date().toISOString(), violations: [] }, "d1");
    const manifest = attemptPhaseClosure(
      baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
      "m1",
      "d2",
      deps
    );
    expect(manifest.outcome).toBe("REJECTED");
    expect(manifest.rejectionReasons.some((r) => r.includes("BLOCKING violation"))).toBe(true);
  });

  it(
    "BLOCKER: REJECTED when there are unresolved BLOCKED requirements in the AUTHORITATIVE Implementation " +
      "Reality Matrix — computed internally from the real registry, never trusted from a caller-supplied value " +
      "(35th independent review round, 'replaceable production authority' root class)",
    () => {
      const deps = makeDeps();
      writeFileSync(
        join(deps.requirementsDir, "blocked.yml"),
        "- id: UASF-REQ-1234\n  title: x\n  description: x\n  source_baseline: 'BASELINE-V1 section 0'\n  category: P0\n  priority: LOW\n  status: BLOCKED\n"
      );
      const evidenceFile = join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH);
      writeFileSync(evidenceFile, "verification output");
      deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");
      const manifest = attemptPhaseClosure(
        baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
        "m1",
        "d2",
        deps
      );
      expect(manifest.outcome).toBe("REJECTED");
      expect(manifest.rejectionReasons.some((r) => r.includes("BLOCKED"))).toBe(true);
      expect(manifest.blockedRequirementIds).toEqual(["UASF-REQ-1234"]);
    }
  );

  it("BLOCKER: REJECTED when independentReviewResult is not exactly CLEAN, no matter how clean everything else is — this is the P0 auto-close guard", () => {
    const deps = makeDeps();
    const evidenceFile = join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH);
    writeFileSync(evidenceFile, "verification output");
    deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");
    const manifest = attemptPhaseClosure(
      baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "PENDING" }),
      "m1",
      "d2",
      deps
    );
    expect(manifest.outcome).toBe("REJECTED");
    expect(manifest.rejectionReasons.some((r) => r.includes("not CLEAN"))).toBe(true);
    expect(deps.scopeLock.getState("P0")).toBe("LOCKED_FOR_CLOSURE");
  });

  it("REJECTED when the phase was never locked (still OPEN)", () => {
    const deps = makeDeps();
    const evidenceFile = join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH);
    writeFileSync(evidenceFile, "verification output");
    const manifest = attemptPhaseClosure(
      baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
      "m1",
      "d2",
      deps
    );
    expect(manifest.outcome).toBe("REJECTED");
    expect(manifest.rejectionReasons.some((r) => r.includes("not currently LOCKED_FOR_CLOSURE"))).toBe(true);
  });

  it("no-regression: CLOSED when every gate genuinely passes, and the closure is recorded in the Decision Ledger", () => {
    const deps = makeDeps();
    const evidenceFile = join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH);
    writeFileSync(evidenceFile, "verification output");
    deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");
    const manifest = attemptPhaseClosure(
      baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
      "m1",
      "d2",
      deps
    );
    expect(manifest.outcome).toBe("CLOSED");
    expect(manifest.decisionId).toBe("d2");
    expect(deps.scopeLock.getState("P0")).toBe("CLOSED");
    expect(deps.ledger.allFor("P0")).toHaveLength(2); // lock + close
  });

  it("persists the manifest for both a REJECTED and a CLOSED attempt, readable via readPhaseClosureManifest", () => {
    const deps = makeDeps();
    const evidenceFile = join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH);
    writeFileSync(evidenceFile, "verification output");
    attemptPhaseClosure(baseAttempt({ independentReviewResult: "PENDING" }), "rejected-1", "d1", deps);
    const rejected = readPhaseClosureManifest(deps.store, deps.manifestDir, "P0", "rejected-1");
    expect(rejected?.outcome).toBe("REJECTED");

    deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d2");
    attemptPhaseClosure(
      baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
      "closed-1",
      "d3",
      deps
    );
    const closed = readPhaseClosureManifest(deps.store, deps.manifestDir, "P0", "closed-1");
    expect(closed?.outcome).toBe("CLOSED");
  });

  it("REGRESSION: a returned manifest's nested invariantViolations array cannot be mutated after the fact", () => {
    const deps = makeDeps(dirtyGuard());
    deps.scopeLock.lock("P0", "ready", { allBlockingSatisfied: true, evaluatedAt: new Date().toISOString(), violations: [] }, "d1");
    const manifest = attemptPhaseClosure(baseAttempt({ independentReviewResult: "PENDING" }), "m1", "d2", deps);
    expect(manifest.invariantViolations.length).toBeGreaterThan(0);
    expect(() => {
      (manifest.invariantViolations[0] as { detail: string }).detail = "tampered";
    }).toThrow(TypeError);
  });

  describe(
    "P1 fix (independent review, 'require meaningful independent-review metadata', finding 8): a merely truthy " +
      "reviewerIdentity/reviewTimestamp must not satisfy the independent-review evidence gate",
    () => {
      it("BLOCKER regression, exact reproduction: reviewerIdentity = '   ' (whitespace-only, truthy) is rejected", () => {
        const deps = makeDeps();
        writeFileSync(join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH), "verification output");
        deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");
        const manifest = attemptPhaseClosure(
          baseAttempt({
            verificationEvidenceRefs: [evidenceRef()],
            independentReview: reviewFor("CLEAN", { reviewerIdentity: "   " })
          }),
          "m1",
          "d2",
          deps
        );
        expect(manifest.outcome).toBe("REJECTED");
        expect(manifest.rejectionReasons.some((r) => r.includes("incomplete or malformed"))).toBe(true);
      });

      it("BLOCKER regression: reviewTimestamp = 'yesterday-ish' (an informal, non-canonical string) is rejected", () => {
        const deps = makeDeps();
        writeFileSync(join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH), "verification output");
        deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");
        const manifest = attemptPhaseClosure(
          baseAttempt({
            verificationEvidenceRefs: [evidenceRef()],
            independentReview: reviewFor("CLEAN", { reviewTimestamp: "yesterday-ish" })
          }),
          "m1",
          "d2",
          deps
        );
        expect(manifest.outcome).toBe("REJECTED");
        expect(manifest.rejectionReasons.some((r) => r.includes("incomplete or malformed"))).toBe(true);
      });

      it("BLOCKER regression: a Date.parse()-able but non-canonical reviewTimestamp (date-only, no time) is also rejected", () => {
        const deps = makeDeps();
        writeFileSync(join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH), "verification output");
        deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");
        const manifest = attemptPhaseClosure(
          baseAttempt({
            verificationEvidenceRefs: [evidenceRef()],
            independentReview: reviewFor("CLEAN", { reviewTimestamp: "2024-01-01" })
          }),
          "m1",
          "d2",
          deps
        );
        expect(manifest.outcome).toBe("REJECTED");
        expect(manifest.rejectionReasons.some((r) => r.includes("incomplete or malformed"))).toBe(true);
      });

      it.each(["reviewId", "reviewedCommitSha"] as const)(
        "BLOCKER regression: a whitespace-only %s is rejected",
        (field) => {
          const deps = makeDeps();
          writeFileSync(join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH), "verification output");
          deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");
          const manifest = attemptPhaseClosure(
            baseAttempt({
              verificationEvidenceRefs: [evidenceRef()],
              independentReview: reviewFor("CLEAN", { [field]: "   " })
            }),
            "m1",
            "d2",
            deps
          );
          expect(manifest.outcome).toBe("REJECTED");
          expect(manifest.rejectionReasons.some((r) => r.includes("incomplete or malformed"))).toBe(true);
        }
      );

      it("no-regression: a genuine, non-blank reviewerIdentity and a canonical ISO-8601 reviewTimestamp (new Date().toISOString()) still close normally", () => {
        const deps = makeDeps();
        writeFileSync(join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH), "verification output");
        deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");
        const manifest = attemptPhaseClosure(
          baseAttempt({
            verificationEvidenceRefs: [evidenceRef()],
            independentReview: reviewFor("CLEAN", {
              reviewerIdentity: "independent-reviewer",
              reviewTimestamp: new Date().toISOString()
            })
          }),
          "m1",
          "d2",
          deps
        );
        expect(manifest.outcome).toBe("CLOSED");
      });
    }
  );

  describe(
    "P1 fix (36th independent review round, finding 2, 'confine generated phase-manifest paths'): " +
      "phaseId/manifestId must be validated as safe identifiers and filesystem-confined",
    () => {
      it("BLOCKER regression, exact reproduction: manifestId = '../../outside' fails closed and creates no file outside the manifest directory", () => {
        const deps = makeDeps();
        const outsideMarker = join(deps.tempRoot, "..", "outside-marker-should-not-exist.json");
        expect(() =>
          attemptPhaseClosure(baseAttempt({ independentReviewResult: "PENDING" }), "../../outside", "d1", deps)
        ).toThrow(InvalidGovernanceIdentifierError);
        expect(existsSync(outsideMarker)).toBe(false);
        expect(existsSync(deps.manifestDir)).toBe(false);
      });

      it("BLOCKER: a phaseId containing a path separator fails closed", () => {
        const deps = makeDeps();
        expect(() =>
          attemptPhaseClosure(
            baseAttempt({ phaseId: "P0/../escape", independentReviewResult: "PENDING" }),
            "m1",
            "d1",
            deps
          )
        ).toThrow(InvalidGovernanceIdentifierError);
      });

      it("BLOCKER: a manifestId of exactly '..' fails closed", () => {
        const deps = makeDeps();
        expect(() => attemptPhaseClosure(baseAttempt({ independentReviewResult: "PENDING" }), "..", "d1", deps)).toThrow(
          InvalidGovernanceIdentifierError
        );
      });

      it("no-regression: readPhaseClosureManifest also rejects a malicious manifestId rather than reading outside the manifest directory", () => {
        const deps = makeDeps();
        expect(() => readPhaseClosureManifest(deps.store, deps.manifestDir, "P0", "../../etc/passwd")).toThrow(
          InvalidGovernanceIdentifierError
        );
      });

      it("no-regression: an ordinary alphanumeric phaseId/manifestId still works exactly as before", () => {
        const deps = makeDeps();
        const manifest = attemptPhaseClosure(baseAttempt({ independentReviewResult: "PENDING" }), "manifest-1", "d1", deps);
        expect(manifest.outcome).toBe("REJECTED");
      });
    }
  );

  describe(
    "P1 fix (36th independent review round, finding 3, 'reject duplicate closure-manifest identifiers'): " +
      "manifests are append-only, a reused manifestId must fail closed without touching the original",
    () => {
      it("BLOCKER regression, exact reproduction: writing manifest X twice fails on the second attempt and leaves the original byte-for-byte unchanged", () => {
        const deps = makeDeps();
        const first = attemptPhaseClosure(baseAttempt({ independentReviewResult: "PENDING" }), "manifest-x", "d1", deps);

        expect(() =>
          attemptPhaseClosure(baseAttempt({ independentReviewResult: "CLEAN" }), "manifest-x", "d2", deps)
        ).toThrow(DuplicateClosureManifestError);

        const stillThere = readPhaseClosureManifest(deps.store, deps.manifestDir, "P0", "manifest-x");
        expect(stillThere).toEqual(first);
      });

      it("rejects a duplicate manifestId even when the phase has since transitioned (LOCKED_FOR_CLOSURE -> the second call would otherwise have closed it)", () => {
        const deps = makeDeps();
        attemptPhaseClosure(baseAttempt({ independentReviewResult: "PENDING" }), "manifest-y", "d1", deps);
        const evidenceFile = join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH);
        writeFileSync(evidenceFile, "verification output");
        deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d2");
        expect(() =>
          attemptPhaseClosure(
            baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
            "manifest-y",
            "d3",
            deps
          )
        ).toThrow(DuplicateClosureManifestError);
        // The phase must not have been closed by the rejected duplicate attempt.
        expect(deps.scopeLock.getState("P0")).toBe("LOCKED_FOR_CLOSURE");
      });
    }
  );

  describe(
    "P1 fix (36th independent review round, finding 4, 'make phase closure and manifest persistence " +
      "atomic'): the phase must never become CLOSED before its manifest is durably persisted",
    () => {
      it(
        "BLOCKER regression, exact reproduction: forcing StateStore.write() to fail during an otherwise-successful " +
          "closure attempt means close() is never invoked and the phase remains LOCKED_FOR_CLOSURE",
        () => {
          const deps = makeDeps();
          const evidenceFile = join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH);
          writeFileSync(evidenceFile, "verification output");
          deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");

          const failingStore: typeof deps.store = {
            write: () => {
              throw new Error("simulated disk failure");
            },
            read: deps.store.read.bind(deps.store),
            exists: deps.store.exists.bind(deps.store)
          };

          expect(() =>
            attemptPhaseClosure(
              baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
              "manifest-atomic",
              "d2",
              { ...deps, store: failingStore }
            )
          ).toThrow("simulated disk failure");

          expect(deps.scopeLock.getState("P0")).toBe("LOCKED_FOR_CLOSURE");
          expect(deps.ledger.allFor("P0")).toHaveLength(1); // only the lock() decision, never a close() decision
          expect(readPhaseClosureManifest(deps.store, deps.manifestDir, "P0", "manifest-atomic")).toBeUndefined();
        }
      );

      it(
        "no-regression: the durable transaction intent is written BEFORE the final manifest, and the final " +
          "manifest is written AFTER the ledger and ScopeLock are both durably persisted (independent Codex " +
          "review, 'persist phase closure atomically with its manifest' — see attemptPhaseClosure()'s staged protocol)",
        () => {
          const deps = makeDeps();
          const evidenceFile = join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH);
          writeFileSync(evidenceFile, "verification output");
          deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");

          const writeOrder: string[] = [];
          const originalWrite = deps.store.write.bind(deps.store);
          const observingStore: typeof deps.store = {
            write: (path: string, data: unknown) => {
              writeOrder.push(path);
              originalWrite(path, data);
            },
            read: deps.store.read.bind(deps.store),
            exists: deps.store.exists.bind(deps.store)
          };

          const manifest = attemptPhaseClosure(
            baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
            "manifest-order",
            "d2",
            { ...deps, store: observingStore }
          );

          expect(manifest.outcome).toBe("CLOSED");
          expect(deps.scopeLock.getState("P0")).toBe("CLOSED");

          const manifestPath = deps.manifestDir + "/P0-manifest-order.json";
          const intentPath = deps.manifestDir + "/P0-manifest-order.intent.json";
          const intentIdx = writeOrder.indexOf(intentPath);
          const ledgerIdx = writeOrder.indexOf(deps.ledgerPath);
          const scopeLockIdx = writeOrder.indexOf(deps.scopeLockPath);
          const manifestIdx = writeOrder.indexOf(manifestPath);

          expect(intentIdx).toBeGreaterThanOrEqual(0);
          expect(ledgerIdx).toBeGreaterThan(intentIdx);
          expect(scopeLockIdx).toBeGreaterThan(ledgerIdx);
          expect(manifestIdx).toBeGreaterThan(scopeLockIdx);
        }
      );
    }
  );

  describe(
    "P1 fix (independent Codex review, 'persist phase closure atomically with its manifest'): crash recovery " +
      "for a staged closure transaction interrupted between persistence stages",
    () => {
      it("a crash BEFORE the intent is written leaves the phase completely untouched — nothing to recover", () => {
        const deps = makeDeps();
        writeFileSync(join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH), "verification output");
        deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");
        // No attemptPhaseClosure() call at all — simulates a crash before step (1).
        const recovered = recoverPendingPhaseClosure("P0", "never-attempted", deps);
        expect(recovered).toBeUndefined();
        expect(deps.scopeLock.getState("P0")).toBe("LOCKED_FOR_CLOSURE");
      });

      it(
        "BLOCKER regression: a crash AFTER the intent is written but BEFORE the ledger/ScopeLock are durably " +
          "persisted is completed by recovery, reaching a fully consistent CLOSED phase + matching ledger + " +
          "finalized manifest",
        () => {
          const deps = makeDeps();
          writeFileSync(join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH), "verification output");
          deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");

          // A store whose write() persists everything EXCEPT the ledger and
          // scope-lock paths — simulating a crash after step (1) (PREPARE)
          // but before steps (3)/(4) ever reach disk. The manifest write at
          // step (5) never happens either, since attemptPhaseClosure() only
          // reaches it after (3)/(4) — so this reproduces exactly "crash
          // right after PREPARE, before anything authoritative is durable".
          const crashingStore: typeof deps.store = {
            write: (path: string, data: unknown) => {
              if (path === deps.ledgerPath || path === deps.scopeLockPath) {
                throw new Error("simulated crash before durable ledger/scope-lock persistence");
              }
              deps.store.write(path, data);
            },
            read: deps.store.read.bind(deps.store),
            exists: deps.store.exists.bind(deps.store)
          };

          expect(() =>
            attemptPhaseClosure(
              baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
              "manifest-crash-1",
              "d2",
              { ...deps, store: crashingStore }
            )
          ).toThrow("simulated crash");

          // Scenario A still holds: no false CLOSED manifest exists yet.
          expect(readPhaseClosureManifest(deps.store, deps.manifestDir, "P0", "manifest-crash-1")).toBeUndefined();

          // Recovery, using the REAL store this time, completes the transaction.
          const recovered = recoverPendingPhaseClosure("P0", "manifest-crash-1", deps);
          expect(recovered?.outcome).toBe("CLOSED");
          expect(deps.scopeLock.getState("P0")).toBe("CLOSED");
          expect(deps.ledger.get("d2")).toBeDefined();
          const finalManifest = readPhaseClosureManifest(deps.store, deps.manifestDir, "P0", "manifest-crash-1");
          expect(finalManifest?.outcome).toBe("CLOSED");

          // Idempotent: calling recovery again is a safe no-op.
          const recoveredAgain = recoverPendingPhaseClosure("P0", "manifest-crash-1", deps);
          expect(recoveredAgain?.outcome).toBe("CLOSED");
        }
      );

      it(
        "BLOCKER regression: a crash AFTER the ledger is durably persisted but BEFORE ScopeLock's own durable " +
          "state captured it is completed by reconciling from the already-existing ledger evidence, never by " +
          "re-recording the decision (which would throw DuplicateDecisionError)",
        () => {
          const deps = makeDeps();
          writeFileSync(join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH), "verification output");
          deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");

          const crashingStore: typeof deps.store = {
            write: (path: string, data: unknown) => {
              if (path === deps.scopeLockPath) {
                throw new Error("simulated crash before durable scope-lock persistence");
              }
              deps.store.write(path, data);
            },
            read: deps.store.read.bind(deps.store),
            exists: deps.store.exists.bind(deps.store)
          };

          expect(() =>
            attemptPhaseClosure(
              baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
              "manifest-crash-2",
              "d2",
              { ...deps, store: crashingStore }
            )
          ).toThrow("simulated crash");

          // The ledger IS already durable at this point (step 3 completed).
          expect(deps.store.read(deps.ledgerPath)).toBeDefined();
          expect(readPhaseClosureManifest(deps.store, deps.manifestDir, "P0", "manifest-crash-2")).toBeUndefined();

          const recovered = recoverPendingPhaseClosure("P0", "manifest-crash-2", deps);
          expect(recovered?.outcome).toBe("CLOSED");
          expect(deps.scopeLock.getState("P0")).toBe("CLOSED");
          // Reconciliation never re-recorded the decision — still exactly one ledger entry for it.
          expect(deps.ledger.allFor("P0").filter((d) => d.decisionId === "d2")).toHaveLength(1);
        }
      );

      it(
        "no-regression: a crash AFTER the final manifest is already written is a pure no-op for recovery — " +
          "the manifest is already sufficient proof of full commit (scenario B)",
        () => {
          const deps = makeDeps();
          writeFileSync(join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH), "verification output");
          deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");

          const manifest = attemptPhaseClosure(
            baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
            "manifest-fully-committed",
            "d2",
            deps
          );
          expect(manifest.outcome).toBe("CLOSED");

          const recovered = recoverPendingPhaseClosure("P0", "manifest-fully-committed", deps);
          expect(recovered).toEqual(manifest);
        }
      );

      it("a phase reopened since the crash abandons the pending intent rather than resurrecting a stale closure", () => {
        const deps = makeDeps();
        writeFileSync(join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH), "verification output");
        deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");

        const crashingStore: typeof deps.store = {
          write: (path: string, data: unknown) => {
            if (path === deps.ledgerPath || path === deps.scopeLockPath) {
              throw new Error("simulated crash");
            }
            deps.store.write(path, data);
          },
          read: deps.store.read.bind(deps.store),
          exists: deps.store.exists.bind(deps.store)
        };

        expect(() =>
          attemptPhaseClosure(
            baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
            "manifest-reopened",
            "d2",
            { ...deps, store: crashingStore }
          )
        ).toThrow("simulated crash");

        // A human explicitly reopens the phase before recovery ever runs.
        deps.scopeLock.reopen("P0", "reopened before recovery ran", "d-reopen");

        const recovered = recoverPendingPhaseClosure("P0", "manifest-reopened", deps);
        expect(recovered).toBeUndefined();
        expect(deps.scopeLock.getState("P0")).toBe("OPEN");
        expect(readPhaseClosureManifest(deps.store, deps.manifestDir, "P0", "manifest-reopened")).toBeUndefined();
      });
    }
  );

  describe(
    "P1 fix (independent Codex review, 'verify independent review evidence before phase closure'): a bare " +
      "outcome string can never satisfy closure — the review evidence must be structurally complete, resolve " +
      "on disk, and match the exact commit being closed",
    () => {
      it("BLOCKER regression, exact reproduction: review evidence with no evidenceRef backing it cannot close a phase", () => {
        const deps = makeDeps();
        writeFileSync(join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH), "verification output");
        deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");
        const manifest = attemptPhaseClosure(
          baseAttempt({
            verificationEvidenceRefs: [evidenceRef()],
            independentReview: reviewFor("CLEAN", { evidenceRef: "does/not/exist.log" })
          }),
          "m-bad-evidence",
          "d2",
          deps
        );
        expect(manifest.outcome).toBe("REJECTED");
        expect(manifest.rejectionReasons.some((r) => r.includes("does not resolve"))).toBe(true);
      });

      it(
        "BLOCKER regression, exact reproduction: a review of commit A must never be allowed to close commit B",
        () => {
          const deps = makeDeps();
          writeFileSync(join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH), "verification output");
          deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");
          const manifest = attemptPhaseClosure(
            baseAttempt({
              verificationEvidenceRefs: [evidenceRef()],
              independentReview: reviewFor("CLEAN", { reviewedCommitSha: "commit-A" }),
              closingCommitSha: "commit-B"
            }),
            "m-wrong-commit",
            "d2",
            deps
          );
          expect(manifest.outcome).toBe("REJECTED");
          expect(manifest.rejectionReasons.some((r) => r.includes("must never close a different commit"))).toBe(true);
          expect(deps.scopeLock.getState("P0")).toBe("LOCKED_FOR_CLOSURE");
        }
      );

      it("no-regression: a fully-structured, evidence-backed review of the EXACT closing commit with outcome CLEAN closes the phase", () => {
        const deps = makeDeps();
        writeFileSync(join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH), "verification output");
        deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");
        const manifest = attemptPhaseClosure(
          baseAttempt({
            verificationEvidenceRefs: [evidenceRef()],
            independentReview: reviewFor("CLEAN"),
            closingCommitSha: DEFAULT_COMMIT_SHA
          }),
          "m-valid-review",
          "d2",
          deps
        );
        expect(manifest.outcome).toBe("CLOSED");
      });
    }
  );

  describe(
    "P1 fix (37th independent review round, finding 4, 'make phase closure and manifest persistence " +
      "atomic'): a durable manifest must never claim CLOSED for a closure that scopeLock.close() itself " +
      "would then refuse — a colliding decisionId is now a REJECTED precondition, never a post-persist surprise",
    () => {
      it(
        "BLOCKER regression, exact reproduction: attempting closure with a decisionId that ALREADY names an " +
          "existing Decision Ledger entry (the one precondition ScopeLock.close() itself still checks) is " +
          "REJECTED up front — the phase never closes and no manifest is ever left durably claiming CLOSED",
        () => {
          const deps = makeDeps();
          const evidenceFile = join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH);
          writeFileSync(evidenceFile, "verification output");
          // "d1" is already a real decision (the lock() call itself).
          deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");

          // Attempting closure while REUSING "d1" as the closure's own
          // decisionId — before this fix, `deps.store.write()` (manifest,
          // outcome: CLOSED) would have run FIRST, and only THEN would
          // `scopeLock.close(..., "d1")` throw `DuplicateDecisionError` —
          // leaving a durable manifest that WRONGLY claims CLOSED for a
          // phase that never actually closed.
          const manifest = attemptPhaseClosure(
            baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
            "manifest-reused-decision",
            "d1",
            deps
          );

          expect(manifest.outcome).toBe("REJECTED");
          expect(manifest.rejectionReasons.some((r) => r.includes("already names an existing Decision Ledger entry"))).toBe(
            true
          );
          expect(deps.scopeLock.getState("P0")).toBe("LOCKED_FOR_CLOSURE");
          expect(deps.ledger.allFor("P0")).toHaveLength(1); // only the original lock() decision — no false close()

          // The durable manifest genuinely reflects REJECTED, on disk —
          // never a stale/incorrect CLOSED claim.
          const stored = readPhaseClosureManifest(deps.store, deps.manifestDir, "P0", "manifest-reused-decision");
          expect(stored?.outcome).toBe("REJECTED");
        }
      );

      it("no regression: a genuinely fresh, never-before-used decisionId still closes normally", () => {
        const deps = makeDeps();
        const evidenceFile = join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH);
        writeFileSync(evidenceFile, "verification output");
        deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");

        const manifest = attemptPhaseClosure(
          baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
          "manifest-fresh-decision",
          "d-fresh",
          deps
        );

        expect(manifest.outcome).toBe("CLOSED");
        expect(deps.scopeLock.getState("P0")).toBe("CLOSED");
      });
    }
  );

  describe(
    "P1 fix (independent Codex review, 'phase closure must reject incomplete authoritative P0 requirements', " +
      "finding 2): DEFINED/PLANNED/IMPLEMENTATION_IN_PROGRESS/IMPLEMENTED requirements block closure exactly " +
      "like BLOCKED ones, not only BLOCKED",
    () => {
      it.each(["DEFINED", "PLANNED", "IMPLEMENTATION_IN_PROGRESS", "IMPLEMENTED"])(
        "BLOCKER regression, exact reproduction: a %s requirement (not BLOCKED) still prevents closure",
        (status) => {
          const deps = makeDeps();
          writeFileSync(
            join(deps.requirementsDir, "incomplete.yml"),
            // implementation_refs is real/resolvable so this fixture is
            // flagged for its genuine, honestly-claimed status (DEFINED/
            // PLANNED/IMPLEMENTATION_IN_PROGRESS/IMPLEMENTED) — never
            // downgraded to a SEPARATE traceability "UNSUPPORTED_CLAIM"
            // (a different check entirely; this test isolates finding 2's
            // own closure-readiness classification).
            `- id: UASF-REQ-8000\n  title: x\n  description: x\n  source_baseline: 'BASELINE-V1 section 0'\n  category: P0\n  priority: LOW\n  status: ${status}\n  implementation_refs: ["${EVIDENCE_ARTIFACT_PATH}"]\n`
          );
          deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");
          const manifest = attemptPhaseClosure(
            baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
            "m-incomplete",
            "d2",
            deps
          );
          expect(manifest.outcome).toBe("REJECTED");
          expect(manifest.rejectionReasons.some((r) => r.includes("closure-ready status") && r.includes(status))).toBe(true);
          expect(manifest.incompleteRequirementIds).toContain("UASF-REQ-8000");
        }
      );

      it("no-regression: DEPRECATED/SUPERSEDED requirements never block closure — they are not active progress claims", () => {
        const deps = makeDeps();
        writeFileSync(
          join(deps.requirementsDir, "retired.yml"),
          "- id: UASF-REQ-8001\n  title: x\n  description: x\n  source_baseline: 'BASELINE-V1 section 0'\n  category: P0\n  priority: LOW\n  status: DEPRECATED\n"
        );
        deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");
        const manifest = attemptPhaseClosure(
          baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
          "m-retired",
          "d2",
          deps
        );
        expect(manifest.outcome).toBe("CLOSED");
        expect(manifest.incompleteRequirementIds).toHaveLength(0);
      });
    }
  );

  describe(
    "P1 fix (independent Codex review, 'phase verification and independent review must use verified outcome " +
      "artifacts', finding 4): existence-only evidence (e.g. package.json) can no longer satisfy " +
      "verificationEvidenceRefs or the independent review's own evidenceRef",
    () => {
      it("BLOCKER regression, exact reproduction: verificationEvidenceRefs: ['package.json'] is REJECTED, not accepted as tests-passed evidence", () => {
        const deps = makeDeps();
        deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");
        const manifest = attemptPhaseClosure(
          baseAttempt({ verificationEvidenceRefs: ["package.json"], independentReviewResult: "CLEAN" }),
          "m-fake-verification",
          "d2",
          deps
        );
        expect(manifest.outcome).toBe("REJECTED");
        expect(manifest.rejectionReasons.some((r) => r.includes("not outcome-verified"))).toBe(true);
      });

      it("BLOCKER regression, exact reproduction: independent review evidenceRef: 'package.json' is REJECTED, not accepted as genuine review evidence", () => {
        const deps = makeDeps();
        deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");
        const manifest = attemptPhaseClosure(
          baseAttempt({
            verificationEvidenceRefs: [evidenceRef()],
            independentReview: reviewFor("CLEAN", { evidenceRef: "package.json" })
          }),
          "m-fake-review",
          "d2",
          deps
        );
        expect(manifest.outcome).toBe("REJECTED");
        expect(manifest.rejectionReasons.some((r) => r.includes("does not resolve to a genuine"))).toBe(true);
      });
    }
  );

  describe(
    "P1 fix (independent Codex review, 'bind the closing SHA to trusted repository state', finding 5): a " +
      "caller-declared closingCommitSha is checked against the ACTUAL, independently-resolved repository HEAD, " +
      "not only against the review's own (equally caller-suppliable) reviewedCommitSha",
    () => {
      it(
        "BLOCKER regression, exact reproduction: closingCommitSha and reviewedCommitSha agree with EACH OTHER " +
          "('not-head') but NEITHER matches the actual, trusted repository HEAD — closure is REJECTED",
        () => {
          const deps = makeDeps();
          deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");
          const manifest = attemptPhaseClosure(
            baseAttempt({
              verificationEvidenceRefs: [evidenceRef()],
              independentReview: reviewFor("CLEAN", { reviewedCommitSha: "not-head" }),
              closingCommitSha: "not-head"
            }),
            "m-fake-head",
            "d2",
            deps
          );
          expect(manifest.outcome).toBe("REJECTED");
          expect(
            manifest.rejectionReasons.some((r) => r.includes("does not match the actual, independently-"))
          ).toBe(true);
          expect(deps.scopeLock.getState("P0")).toBe("LOCKED_FOR_CLOSURE");
        }
      );

      it("BLOCKER regression: repository identity resolution failing (e.g. no git available) fails closed rather than trusting the caller", () => {
        const deps = makeDeps();
        deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");
        const manifest = attemptPhaseClosure(
          baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
          "m-no-git",
          "d2",
          {
            ...deps,
            resolveHeadCommitSha: () => {
              throw new Error("simulated: git not available");
            }
          }
        );
        expect(manifest.outcome).toBe("REJECTED");
        expect(manifest.rejectionReasons.some((r) => r.includes("could not be independently verified"))).toBe(true);
      });

      it("no-regression: closingCommitSha genuinely matching the trusted repository HEAD closes normally", () => {
        const deps = makeDeps();
        deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");
        const manifest = attemptPhaseClosure(
          baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
          "m-real-head",
          "d2",
          deps
        );
        expect(manifest.outcome).toBe("CLOSED");
      });
    }
  );

  describe(
    "P1 fix (independent Codex review, 'recovery must revalidate persisted phase-closure intents', finding 6): " +
      "a malformed/forged PREPARED intent must never be blindly promoted to CLOSED by recovery",
    () => {
      it(
        "BLOCKER regression, exact reproduction: a PREPARED intent whose original request is missing " +
          "verification evidence (the exact malformed shape an attacker or corruption could produce) is " +
          "ABANDONED by recovery, never promoted to CLOSED — a fresh, honest REJECTED manifest is recorded instead",
        () => {
          const deps = makeDeps();
          deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");

          // Fabricate a PREPARED intent DIRECTLY on disk — simulating either
          // a forged intent, or one whose backing evidence was legitimately
          // valid at PREPARE time but no longer resolves (evidence rot).
          const manifestId = "manifest-malformed";
          const intentPath = join(deps.manifestDir, `P0-${manifestId}.intent.json`);
          const malformedAttempt = baseAttempt({
            verificationEvidenceRefs: [], // malformed: no evidence at all
            independentReviewResult: "CLEAN"
          });
          deps.store.write(intentPath, {
            status: "PREPARED",
            phaseId: "P0",
            manifestId,
            decisionId: "d-forged",
            attempt: malformedAttempt,
            createdAt: new Date().toISOString()
          });

          const recovered = recoverPendingPhaseClosure("P0", manifestId, deps);

          expect(recovered?.outcome).toBe("REJECTED");
          expect(recovered?.rejectionReasons.some((r) => r.includes("no verification evidence"))).toBe(true);
          expect(deps.scopeLock.getState("P0")).toBe("LOCKED_FOR_CLOSURE");
          expect(deps.ledger.get("d-forged")).toBeUndefined();

          // The durable manifest honestly reflects REJECTED — never a
          // resurrected CLOSED claim for a request that never genuinely
          // satisfied the gate.
          const stored = readPhaseClosureManifest(deps.store, deps.manifestDir, "P0", manifestId);
          expect(stored?.outcome).toBe("REJECTED");
        }
      );

      it(
        "BLOCKER regression: a PREPARED intent with a fabricated closingCommitSha that does not match the " +
          "trusted repository HEAD is ABANDONED by recovery, never promoted to CLOSED",
        () => {
          const deps = makeDeps();
          deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");

          const manifestId = "manifest-fake-sha";
          const intentPath = join(deps.manifestDir, `P0-${manifestId}.intent.json`);
          const forgedAttempt = baseAttempt({
            verificationEvidenceRefs: [evidenceRef()],
            independentReview: reviewFor("CLEAN", { reviewedCommitSha: "attacker-chosen-sha" }),
            closingCommitSha: "attacker-chosen-sha"
          });
          deps.store.write(intentPath, {
            status: "PREPARED",
            phaseId: "P0",
            manifestId,
            decisionId: "d-forged-2",
            attempt: forgedAttempt,
            createdAt: new Date().toISOString()
          });

          const recovered = recoverPendingPhaseClosure("P0", manifestId, deps);

          expect(recovered?.outcome).toBe("REJECTED");
          expect(deps.scopeLock.getState("P0")).toBe("LOCKED_FOR_CLOSURE");
          expect(deps.ledger.get("d-forged-2")).toBeUndefined();
        }
      );

      it("no-regression: a genuine, valid PREPARED intent (crash between PREPARE and ledger/scopeLock persistence) still completes normally via recovery", () => {
        const deps = makeDeps();
        deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");

        const crashingStore: typeof deps.store = {
          write: (path: string, data: unknown) => {
            if (path === deps.ledgerPath || path === deps.scopeLockPath) {
              throw new Error("simulated crash");
            }
            deps.store.write(path, data);
          },
          read: deps.store.read.bind(deps.store),
          exists: deps.store.exists.bind(deps.store)
        };

        expect(() =>
          attemptPhaseClosure(
            baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
            "manifest-genuine-crash",
            "d-genuine",
            { ...deps, store: crashingStore }
          )
        ).toThrow("simulated crash");

        const recovered = recoverPendingPhaseClosure("P0", "manifest-genuine-crash", deps);
        expect(recovered?.outcome).toBe("CLOSED");
        expect(deps.scopeLock.getState("P0")).toBe("CLOSED");
        expect(deps.ledger.get("d-genuine")).toBeDefined();
      });
    }
  );

  describe(
    "P1 fix (independent review, 'reject recovery intents for another phase or manifest', finding 6): a " +
      "persisted intent whose own identity disagrees with the requested recovery target must be rejected, never " +
      "silently treated as belonging to it",
    () => {
      it(
        "BLOCKER regression, exact reproduction: (phaseId='P0', manifestId='sub-manifest') and " +
          "(phaseId='P0-sub', manifestId='manifest') collide on the SAME intent file path — recovering the " +
          "SECOND identity against an intent genuinely prepared for the FIRST throws, rather than silently " +
          "acting on the mismatched intent",
        () => {
          const deps = makeDeps();
          writeFileSync(join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH), "verification output");
          deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");

          const crashingStore: typeof deps.store = {
            write: (path: string, data: unknown) => {
              if (path === deps.ledgerPath || path === deps.scopeLockPath) {
                throw new Error("simulated crash before durable ledger/scope-lock persistence");
              }
              deps.store.write(path, data);
            },
            read: deps.store.read.bind(deps.store),
            exists: deps.store.exists.bind(deps.store)
          };

          // Genuinely prepares an intent for (phaseId="P0", manifestId=
          // "sub-manifest") — crashing right after the intent write, per
          // the established crash-recovery test pattern above.
          expect(() =>
            attemptPhaseClosure(
              baseAttempt({ phaseId: "P0", verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
              "sub-manifest",
              "d2",
              { ...deps, store: crashingStore }
            )
          ).toThrow("simulated crash");

          // Sanity: the collision is real — both identities resolve to the
          // identical intent file on disk.
          const collidingPath = join(deps.manifestDir, "P0-sub-manifest.intent.json");
          expect(existsSync(collidingPath)).toBe(true);

          // Recovering under the OTHER identity that collides on the same
          // path must throw — never silently complete (or reject) a
          // closure for phase "P0-sub" using an intent that was actually
          // prepared for phase "P0".
          expect(() => recoverPendingPhaseClosure("P0-sub", "manifest", deps)).toThrow(
            /identifies phaseId='P0'/
          );

          // "P0-sub" — the OTHER identity colliding on this same path —
          // was never touched at all by the rejected recovery attempt.
          expect(deps.scopeLock.getState("P0-sub")).toBe("OPEN");
          expect(readPhaseClosureManifest(deps.store, deps.manifestDir, "P0-sub", "manifest")).toBeUndefined();

          // The ORIGINAL, correctly-identified recovery still works fine.
          const recovered = recoverPendingPhaseClosure("P0", "sub-manifest", deps);
          expect(recovered?.outcome).toBe("CLOSED");
        }
      );

      it("no-regression: a genuinely matching intent (requested identity equals the intent's own persisted identity) still recovers normally", () => {
        const deps = makeDeps();
        writeFileSync(join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH), "verification output");
        deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");

        const crashingStore: typeof deps.store = {
          write: (path: string, data: unknown) => {
            if (path === deps.ledgerPath || path === deps.scopeLockPath) {
              throw new Error("simulated crash");
            }
            deps.store.write(path, data);
          },
          read: deps.store.read.bind(deps.store),
          exists: deps.store.exists.bind(deps.store)
        };

        expect(() =>
          attemptPhaseClosure(
            baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
            "manifest-matching",
            "d2",
            { ...deps, store: crashingStore }
          )
        ).toThrow("simulated crash");

        const recovered = recoverPendingPhaseClosure("P0", "manifest-matching", deps);
        expect(recovered?.outcome).toBe("CLOSED");
      });
    }
  );

  describe(
    "P1 fix (P0 final closure remediation, finding 6, 'recovery must validate existing manifest identity'): " +
      "the 'already fully committed' early-return in recoverPendingPhaseClosure() must verify the persisted " +
      "manifest's OWN identity before trusting it as belonging to the requested (phaseId, manifestId)",
    () => {
      it(
        "BLOCKER regression, exact reproduction: (phaseId='P0-sub', manifestId='manifest') and (phaseId='P0', " +
          "manifestId='sub-manifest') collide on the SAME manifest file path — a genuinely-closed manifest for " +
          "the FIRST identity must never be handed back as recovery output for the SECOND",
        () => {
          const deps = makeDeps();
          writeFileSync(join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH), "verification output");

          // Genuinely, successfully close phase "P0-sub" under manifestId
          // "manifest" — this writes a REAL manifest file directly (no
          // crash, no intent involved), landing at the colliding path.
          deps.scopeLock.lock("P0-sub", "ready", deps.invariantGuard.runAll(), "d-lock");
          const genuine = attemptPhaseClosure(
            baseAttempt({ phaseId: "P0-sub", verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
            "manifest",
            "d-real",
            deps
          );
          expect(genuine.outcome).toBe("CLOSED");

          // Sanity: the collision is real.
          const collidingPath = join(deps.manifestDir, "P0-sub-manifest.json");
          expect(existsSync(collidingPath)).toBe(true);

          // "P0" phase was never locked/closed at all — no intent exists
          // for ("P0", "sub-manifest") either, so recovery reaches the
          // "already fully committed" branch directly via the colliding
          // path, reading the SAME file just written for "P0-sub".
          expect(() => recoverPendingPhaseClosure("P0", "sub-manifest", deps)).toThrow(/identifies phaseId='P0-sub'/);

          // Phase "P0" itself was never touched by the rejected recovery.
          expect(deps.scopeLock.getState("P0")).toBe("OPEN");

          // The genuinely-matching identity still recovers correctly.
          const recovered = recoverPendingPhaseClosure("P0-sub", "manifest", deps);
          expect(recovered?.outcome).toBe("CLOSED");
        }
      );

      it("no-regression: a genuinely matching, already-committed manifest still recovers normally with no intent involved", () => {
        const deps = makeDeps();
        writeFileSync(join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH), "verification output");
        deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d-lock2");
        attemptPhaseClosure(
          baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
          "manifest-plain",
          "d-close2",
          deps
        );
        const recovered = recoverPendingPhaseClosure("P0", "manifest-plain", deps);
        expect(recovered?.outcome).toBe("CLOSED");
      });
    }
  );

  describe(
    "P1 fix (P0 final closure remediation, finding 7, 'closure evaluation and persistence must use one " +
      "snapshot'): attemptPhaseClosure() must detach the caller's attempt into ONE immutable snapshot before " +
      "evaluating it, so a stateful/getter-backed field cannot answer differently at evaluation time than at " +
      "persistence time",
    () => {
      it(
        "BLOCKER regression, exact reproduction: independentReview.outcome is a getter returning 'CLEAN' on its " +
          "first read and 'FOUND_ISSUES' on every later read — the persisted manifest must never end up CLOSED " +
          "with a non-CLEAN independentReview.outcome inside it",
        () => {
          const deps = makeDeps();
          writeFileSync(join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH), "verification output");
          deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");

          let reads = 0;
          const statefulReview: IndependentReviewEvidence = {
            reviewId: "rev-1",
            reviewerIdentity: "independent-reviewer",
            reviewedCommitSha: DEFAULT_COMMIT_SHA,
            reviewTimestamp: new Date().toISOString(),
            evidenceRef: evidenceRef(),
            get outcome(): IndependentReviewResult {
              reads++;
              return reads === 1 ? "CLEAN" : "FOUND_ISSUES";
            }
          };

          const manifest = attemptPhaseClosure(
            baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReview: statefulReview }),
            "stateful-review",
            "d2",
            deps
          );

          // Whichever outcome this attempt settled on, its OWN persisted
          // independentReview.outcome must be internally consistent with
          // it — never CLOSED while the persisted evidence itself reads
          // as a non-CLEAN outcome (the exact contradiction the un-fixed
          // multi-read bug could produce).
          if (manifest.outcome === "CLOSED") {
            expect(manifest.independentReview.outcome).toBe("CLEAN");
          } else {
            expect(manifest.rejectionReasons.length).toBeGreaterThan(0);
          }
        }
      );

      it("no-regression: an ordinary, non-stateful CLEAN review still closes normally with a consistent persisted record", () => {
        const deps = makeDeps();
        writeFileSync(join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH), "verification output");
        deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");

        const manifest = attemptPhaseClosure(
          baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
          "plain-review",
          "d2",
          deps
        );
        expect(manifest.outcome).toBe("CLOSED");
        expect(manifest.independentReview.outcome).toBe("CLEAN");
      });
    }
  );

  describe(
    "P1 fix (independent review, 'match recovered decisions against an already-closed phase', finding 7): " +
      "recovery for an ALREADY-CLOSED phase must verify the phase's OWN authoritative decisionId (and matching " +
      "Decision Ledger record) against the recovered intent's claimed decisionId before finalizing anything",
    () => {
      it(
        "BLOCKER regression, exact reproduction: phase 'P0' is genuinely CLOSED under decisionId 'd-real', but a " +
          "forged/stale PREPARED intent for a DIFFERENT manifestId claims decisionId 'd-forged' — recovery " +
          "throws instead of finalizing a manifest attributing this closure to a decision that never produced it",
        () => {
          const deps = makeDeps();
          writeFileSync(join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH), "verification output");
          deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");

          // Genuinely close "P0" under a REAL decisionId.
          const realManifest = attemptPhaseClosure(
            baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
            "manifest-real",
            "d-real",
            deps
          );
          expect(realManifest.outcome).toBe("CLOSED");
          expect(deps.scopeLock.getState("P0")).toBe("CLOSED");

          // Fabricate a forged PREPARED intent for a DIFFERENT manifestId
          // (so recovery does not short-circuit on an already-existing
          // manifest), claiming a decisionId that never actually closed
          // this phase.
          const forgedIntentPath = join(deps.manifestDir, "P0-manifest-fake.intent.json");
          deps.store.write(forgedIntentPath, {
            status: "PREPARED",
            phaseId: "P0",
            manifestId: "manifest-fake",
            decisionId: "d-forged",
            attempt: baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
            createdAt: new Date().toISOString()
          });

          expect(() => recoverPendingPhaseClosure("P0", "manifest-fake", deps)).toThrow(
            /did not produce this phase's actual closure/
          );

          // Nothing was finalized under the forged identity, and the REAL
          // closure remains exactly as it was.
          expect(readPhaseClosureManifest(deps.store, deps.manifestDir, "P0", "manifest-fake")).toBeUndefined();
          expect(deps.ledger.get("d-forged")).toBeUndefined();
          expect(deps.scopeLock.get("P0")?.decisionId).toBe("d-real");
        }
      );

      it(
        "no-regression: recovery for a phase that is ALREADY CLOSED (ScopeLock/ledger durably transitioned) but " +
          "whose FINAL MANIFEST write has not yet landed still finalizes normally when the intent's decisionId " +
          "genuinely matches the phase's own authoritative decision",
        () => {
          const deps = makeDeps();
          writeFileSync(join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH), "verification output");
          deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");

          const manifestFilePath = join(deps.manifestDir, "P0-manifest-already-closed.json");
          // Crash AFTER ScopeLock/ledger are durably transitioned to
          // CLOSED, but BEFORE the final manifest file itself is written —
          // reproducing "currentState is already CLOSED going INTO
          // recovery, with no manifest yet" without relying on a second,
          // separate recovery call to get there.
          const crashingStore: typeof deps.store = {
            write: (path: string, data: unknown) => {
              if (path === manifestFilePath) {
                throw new Error("simulated crash before the final manifest write");
              }
              deps.store.write(path, data);
            },
            read: deps.store.read.bind(deps.store),
            exists: deps.store.exists.bind(deps.store)
          };

          expect(() =>
            attemptPhaseClosure(
              baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
              "manifest-already-closed",
              "d2",
              { ...deps, store: crashingStore }
            )
          ).toThrow("simulated crash before the final manifest write");

          // ScopeLock/ledger are already genuinely, durably CLOSED — only
          // the manifest file itself is missing.
          expect(deps.scopeLock.getState("P0")).toBe("CLOSED");
          expect(readPhaseClosureManifest(deps.store, deps.manifestDir, "P0", "manifest-already-closed")).toBeUndefined();

          // Recovery (now with the REAL, non-crashing store) hits finding
          // 7's check for an already-CLOSED phase — the intent's
          // decisionId ('d2') genuinely matches ScopeLock's own
          // authoritative decisionId for "P0", so it finalizes normally.
          const recovered = recoverPendingPhaseClosure("P0", "manifest-already-closed", deps);
          expect(recovered?.outcome).toBe("CLOSED");
          expect(readPhaseClosureManifest(deps.store, deps.manifestDir, "P0", "manifest-already-closed")?.outcome).toBe(
            "CLOSED"
          );
        }
      );
    }
  );

  describe(
    "P1 fix (P0 final closure remediation, finding 8, 'closure manifest identities must be atomically " +
      "reserved'): attemptPhaseClosure() must reserve its manifest path exclusively (via a real file lock), " +
      "never via an exists()-then-write() check with no atomicity between the two",
    () => {
      it(
        "BLOCKER regression, exact reproduction: with the manifest's lock already held by someone else, " +
          "attemptPhaseClosure() genuinely contends for it (times out) rather than proceeding as though the " +
          "duplicate check and the eventual write were atomic on their own",
        () => {
          const deps = makeDeps();
          writeFileSync(join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH), "verification output");
          deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");

          const manifestPathForLock = join(deps.manifestDir, "P0-contended.json");
          const releaseExternalLock = acquireFileLock(`${manifestPathForLock}.lock`);
          try {
            expect(() =>
              attemptPhaseClosure(
                baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
                "contended",
                "d2",
                { ...deps, lockOptions: { timeoutMs: 50, pollIntervalMs: 5 } }
              )
            ).toThrow(FileLockTimeoutError);
          } finally {
            releaseExternalLock();
          }

          // Nothing was ever written or committed while contended — the
          // lock genuinely gated every write this attempt could have made.
          expect(existsSync(manifestPathForLock)).toBe(false);
          expect(deps.scopeLock.getState("P0")).toBe("LOCKED_FOR_CLOSURE");

          // Once the lock is free, the identical attempt proceeds and
          // closes normally.
          const recovered = attemptPhaseClosure(
            baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
            "contended",
            "d3",
            deps
          );
          expect(recovered.outcome).toBe("CLOSED");
        }
      );

      it(
        "BLOCKER regression: a SECOND attempt for the SAME manifest identity, made while the first attempt's " +
          "own internal lock is still held (simulated by pre-holding it, since the real function is fully " +
          "synchronous and cannot itself be interrupted mid-flight), must never silently overwrite a manifest " +
          "the first attempt already committed — it must observe DuplicateClosureManifestError once the lock " +
          "is free, never a corrupted/mixed manifest",
        () => {
          const deps = makeDeps();
          writeFileSync(join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH), "verification output");
          deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");

          const first = attemptPhaseClosure(
            baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
            "race-target",
            "d2",
            deps
          );
          expect(first.outcome).toBe("CLOSED");

          // A second attempt for the IDENTICAL identity, after the first
          // already fully committed, must fail closed — never silently
          // replace the first attempt's own durable manifest.
          expect(() =>
            attemptPhaseClosure(
              baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
              "race-target",
              "d3",
              deps
            )
          ).toThrow(DuplicateClosureManifestError);

          // The original manifest survives, byte-for-byte, with its
          // ORIGINAL decisionId — never overwritten by the second attempt.
          const surviving = readPhaseClosureManifest(deps.store, deps.manifestDir, "P0", "race-target");
          expect(surviving?.decisionId).toBe("d2");
        }
      );

      it("no-regression: ordinary, uncontended closure attempts still succeed with no lock artifacts left behind", () => {
        const deps = makeDeps();
        writeFileSync(join(deps.tempRoot, EVIDENCE_ARTIFACT_PATH), "verification output");
        deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");
        const manifest = attemptPhaseClosure(
          baseAttempt({ verificationEvidenceRefs: [evidenceRef()], independentReviewResult: "CLEAN" }),
          "uncontended",
          "d2",
          deps
        );
        expect(manifest.outcome).toBe("CLOSED");
        expect(existsSync(join(deps.manifestDir, "P0-uncontended.json.lock"))).toBe(false);
      });
    }
  );
});
