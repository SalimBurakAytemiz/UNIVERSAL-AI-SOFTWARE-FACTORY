import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attemptPhaseClosure, readPhaseClosureManifest, type PhaseClosureAttempt } from "../phase-closure.js";
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

function baseAttempt(overrides: Partial<PhaseClosureAttempt> = {}): PhaseClosureAttempt {
  return {
    phaseId: "P0",
    requestedBy: "test-suite",
    reason: "all gates passed",
    verificationEvidenceRefs: [],
    independentReviewResult: "PENDING",
    ...overrides
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
    const ledger = new FounderDecisionLedger();
    const scopeLock = new ScopeLock(ledger);
    const store = new FileStateStore();
    const manifestDir = join(tempRoot, "phase-closures");
    return { tempRoot, requirementsDir, ledger, scopeLock, store, manifestDir, invariantGuard: guard, rootDir: tempRoot };
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
});
