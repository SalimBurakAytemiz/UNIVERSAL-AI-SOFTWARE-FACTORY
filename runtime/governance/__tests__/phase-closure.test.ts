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
    evidenceRef: "review.log",
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

  /** A minimal, valid, evidence-clean registry — one DEFINED requirement, no evidence required, nothing BLOCKED. */
  function makeDeps(guard = cleanGuard()) {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-phase-closure-"));
    const requirementsDir = join(tempRoot, "specification", "requirements");
    mkdirSync(requirementsDir, { recursive: true });
    writeFileSync(
      join(requirementsDir, "baseline.yml"),
      "- id: UASF-REQ-9200\n  title: x\n  description: x\n  source_baseline: 'BASELINE-V1 section 0'\n  category: P0\n  priority: LOW\n  status: DEFINED\n"
    );
    writeFileSync(join(tempRoot, "review.log"), "independent review transcript");
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
      ledgerPath
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
    expect(manifest.rejectionReasons.some((r) => r.includes("do not resolve"))).toBe(true);
  });

  it("BLOCKER: REJECTED when the invariant guard reports a BLOCKING violation, even with real evidence and a CLEAN review", () => {
    const deps = makeDeps(dirtyGuard());
    const evidenceFile = join(deps.tempRoot, "proof.log");
    writeFileSync(evidenceFile, "verification output");
    deps.scopeLock.lock("P0", "ready", { allBlockingSatisfied: true, evaluatedAt: new Date().toISOString(), violations: [] }, "d1");
    const manifest = attemptPhaseClosure(
      baseAttempt({ verificationEvidenceRefs: ["proof.log"], independentReviewResult: "CLEAN" }),
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
      const evidenceFile = join(deps.tempRoot, "proof.log");
      writeFileSync(evidenceFile, "verification output");
      deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");
      const manifest = attemptPhaseClosure(
        baseAttempt({ verificationEvidenceRefs: ["proof.log"], independentReviewResult: "CLEAN" }),
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
    const evidenceFile = join(deps.tempRoot, "proof.log");
    writeFileSync(evidenceFile, "verification output");
    deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");
    const manifest = attemptPhaseClosure(
      baseAttempt({ verificationEvidenceRefs: ["proof.log"], independentReviewResult: "PENDING" }),
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
    const evidenceFile = join(deps.tempRoot, "proof.log");
    writeFileSync(evidenceFile, "verification output");
    const manifest = attemptPhaseClosure(
      baseAttempt({ verificationEvidenceRefs: ["proof.log"], independentReviewResult: "CLEAN" }),
      "m1",
      "d2",
      deps
    );
    expect(manifest.outcome).toBe("REJECTED");
    expect(manifest.rejectionReasons.some((r) => r.includes("not currently LOCKED_FOR_CLOSURE"))).toBe(true);
  });

  it("no-regression: CLOSED when every gate genuinely passes, and the closure is recorded in the Decision Ledger", () => {
    const deps = makeDeps();
    const evidenceFile = join(deps.tempRoot, "proof.log");
    writeFileSync(evidenceFile, "verification output");
    deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");
    const manifest = attemptPhaseClosure(
      baseAttempt({ verificationEvidenceRefs: ["proof.log"], independentReviewResult: "CLEAN" }),
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
    const evidenceFile = join(deps.tempRoot, "proof.log");
    writeFileSync(evidenceFile, "verification output");
    attemptPhaseClosure(baseAttempt({ independentReviewResult: "PENDING" }), "rejected-1", "d1", deps);
    const rejected = readPhaseClosureManifest(deps.store, deps.manifestDir, "P0", "rejected-1");
    expect(rejected?.outcome).toBe("REJECTED");

    deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d2");
    attemptPhaseClosure(
      baseAttempt({ verificationEvidenceRefs: ["proof.log"], independentReviewResult: "CLEAN" }),
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
        const evidenceFile = join(deps.tempRoot, "proof.log");
        writeFileSync(evidenceFile, "verification output");
        deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d2");
        expect(() =>
          attemptPhaseClosure(
            baseAttempt({ verificationEvidenceRefs: ["proof.log"], independentReviewResult: "CLEAN" }),
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
          const evidenceFile = join(deps.tempRoot, "proof.log");
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
              baseAttempt({ verificationEvidenceRefs: ["proof.log"], independentReviewResult: "CLEAN" }),
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
          const evidenceFile = join(deps.tempRoot, "proof.log");
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
            baseAttempt({ verificationEvidenceRefs: ["proof.log"], independentReviewResult: "CLEAN" }),
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
        writeFileSync(join(deps.tempRoot, "proof.log"), "verification output");
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
          writeFileSync(join(deps.tempRoot, "proof.log"), "verification output");
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
              baseAttempt({ verificationEvidenceRefs: ["proof.log"], independentReviewResult: "CLEAN" }),
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
          writeFileSync(join(deps.tempRoot, "proof.log"), "verification output");
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
              baseAttempt({ verificationEvidenceRefs: ["proof.log"], independentReviewResult: "CLEAN" }),
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
          writeFileSync(join(deps.tempRoot, "proof.log"), "verification output");
          deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");

          const manifest = attemptPhaseClosure(
            baseAttempt({ verificationEvidenceRefs: ["proof.log"], independentReviewResult: "CLEAN" }),
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
        writeFileSync(join(deps.tempRoot, "proof.log"), "verification output");
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
            baseAttempt({ verificationEvidenceRefs: ["proof.log"], independentReviewResult: "CLEAN" }),
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
        writeFileSync(join(deps.tempRoot, "proof.log"), "verification output");
        deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");
        const manifest = attemptPhaseClosure(
          baseAttempt({
            verificationEvidenceRefs: ["proof.log"],
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
          writeFileSync(join(deps.tempRoot, "proof.log"), "verification output");
          deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");
          const manifest = attemptPhaseClosure(
            baseAttempt({
              verificationEvidenceRefs: ["proof.log"],
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
        writeFileSync(join(deps.tempRoot, "proof.log"), "verification output");
        deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");
        const manifest = attemptPhaseClosure(
          baseAttempt({
            verificationEvidenceRefs: ["proof.log"],
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
          const evidenceFile = join(deps.tempRoot, "proof.log");
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
            baseAttempt({ verificationEvidenceRefs: ["proof.log"], independentReviewResult: "CLEAN" }),
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
        const evidenceFile = join(deps.tempRoot, "proof.log");
        writeFileSync(evidenceFile, "verification output");
        deps.scopeLock.lock("P0", "ready", deps.invariantGuard.runAll(), "d1");

        const manifest = attemptPhaseClosure(
          baseAttempt({ verificationEvidenceRefs: ["proof.log"], independentReviewResult: "CLEAN" }),
          "manifest-fresh-decision",
          "d-fresh",
          deps
        );

        expect(manifest.outcome).toBe("CLOSED");
        expect(deps.scopeLock.getState("P0")).toBe("CLOSED");
      });
    }
  );
});
