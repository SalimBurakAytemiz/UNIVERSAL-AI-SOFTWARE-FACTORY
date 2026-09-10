// 35th independent review round, Part F/G: proves the four new governance
// mechanisms (Central Invariant Guard, Scope Lock + Backlog Router, Phase
// Closure Manifest, Implementation Reality Matrix) genuinely integrate
// with the EXISTING Founder Decision Ledger and the EXISTING requirement/
// evidence/traceability path — never a second, parallel decision-log or
// evidence subsystem. This is an end-to-end wiring test, not a unit test
// of any one module (each module already has its own dedicated test
// file: invariant-guard.test.ts, scope-lock.test.ts, phase-closure.test.ts,
// reality-matrix.test.ts).

import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultInvariantGuard } from "../../invariants/invariant-guard.js";
import { ScopeLock, BacklogRouter } from "../scope-lock.js";
import { attemptPhaseClosure } from "../phase-closure.js";
import { computeRealityMatrix } from "../reality-matrix.js";
import { FounderDecisionLedger } from "../../decisions/decision-ledger.js";
import { FileStateStore } from "../../state/file-store.js";

describe("governance mechanisms: end-to-end integration (Part F/G)", () => {
  let tempRoot: string;
  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it("a clean registry flows through Reality Matrix -> Invariant Guard -> Scope Lock -> Phase Closure Manifest, with every governance action landing in the SAME Founder Decision Ledger", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-governance-e2e-"));
    const requirementsDir = join(tempRoot, "specification", "requirements");
    mkdirSync(requirementsDir, { recursive: true });
    const evidenceFile = join(tempRoot, "proof.log");
    writeFileSync(evidenceFile, "verification suite output");
    writeFileSync(
      join(requirementsDir, "clean.yml"),
      [
        "- id: UASF-REQ-9100",
        "  title: Fixture",
        "  description: Backed by real evidence.",
        "  source_baseline: 'BASELINE-V1 section 0 (test fixture)'",
        "  category: P0",
        "  priority: LOW",
        "  status: UNIT_TESTED",
        "  implementation_refs: []",
        "  test_refs:",
        "    - path: proof.log",
        "      type: TEST_RESULT",
        "      outcome: PASS",
        "      verificationSource: 'npm test (vitest)'",
        "  proof_refs: []",
        ""
      ].join("\n")
    );

    const ledger = new FounderDecisionLedger();
    const scopeLock = new ScopeLock(ledger);
    const backlogRouter = new BacklogRouter(scopeLock, ledger);
    const invariantGuard = createDefaultInvariantGuard(requirementsDir, tempRoot);

    // 1. Implementation Reality Matrix: no unsupported claims, nothing BLOCKED.
    const matrix = computeRealityMatrix(requirementsDir, tempRoot);
    expect(matrix.unsupportedClaimIds).toHaveLength(0);
    expect(matrix.blockedRequirementIds).toHaveLength(0);

    // 2. Central Invariant Guard: zero BLOCKING violations against this SAME registry.
    const guardReport = invariantGuard.runAll();
    expect(guardReport.allBlockingSatisfied).toBe(true);

    // 3. Scope Lock: OPEN -> LOCKED_FOR_CLOSURE, gated by the SAME guard report, recorded in the ledger.
    scopeLock.lock("P0", "local gates passed", guardReport, "d-lock");
    expect(scopeLock.getState("P0")).toBe("LOCKED_FOR_CLOSURE");

    // 4. Backlog Router: a NEW item proposed against the now-locked phase is
    // routed to backlog rather than silently expanding scope, and that
    // denial is recorded in the SAME ledger.
    const routed = backlogRouter.route(
      { itemId: "new-feature-1", phaseId: "P0", description: "an unrelated new ask", category: "FEATURE" },
      "d-backlog"
    );
    expect(routed.decision).toBe("ROUTE_TO_BACKLOG");

    // 5. Phase Closure Manifest: still REJECTED, because no independent
    // review has returned CLEAN yet — this is the P0 auto-close guard.
    const store = new FileStateStore();
    const manifestDir = join(tempRoot, "phase-closures");
    const scopeLockPath = join(tempRoot, "scope-lock.json");
    const ledgerPath = join(tempRoot, "decision-ledger.json");
    const closingCommitSha = "abc123def456";
    const pendingAttempt = attemptPhaseClosure(
      {
        phaseId: "P0",
        requestedBy: "integration-test",
        reason: "attempting closure before independent review",
        verificationEvidenceRefs: ["proof.log"],
        independentReview: {
          reviewId: "rev-1",
          reviewerIdentity: "independent-reviewer",
          reviewedCommitSha: closingCommitSha,
          reviewTimestamp: new Date().toISOString(),
          outcome: "PENDING",
          evidenceRef: "proof.log"
        },
        closingCommitSha
      },
      "manifest-pending",
      "d-close-pending",
      { scopeLock, invariantGuard, rootDir: tempRoot, requirementsDir, store, manifestDir, ledger, scopeLockPath, ledgerPath }
    );
    expect(pendingAttempt.outcome).toBe("REJECTED");
    expect(scopeLock.getState("P0")).toBe("LOCKED_FOR_CLOSURE");

    // 6. Only once an independent review explicitly returns CLEAN does
    // closure succeed, and it is recorded in the SAME ledger as every
    // other governance action above (no separate decision-log subsystem).
    const closedAttempt = attemptPhaseClosure(
      {
        phaseId: "P0",
        requestedBy: "integration-test",
        reason: "independent review returned CLEAN",
        verificationEvidenceRefs: ["proof.log"],
        independentReview: {
          reviewId: "rev-2",
          reviewerIdentity: "independent-reviewer",
          reviewedCommitSha: closingCommitSha,
          reviewTimestamp: new Date().toISOString(),
          outcome: "CLEAN",
          evidenceRef: "proof.log"
        },
        closingCommitSha
      },
      "manifest-closed",
      "d-close-final",
      { scopeLock, invariantGuard, rootDir: tempRoot, requirementsDir, store, manifestDir, ledger, scopeLockPath, ledgerPath }
    );
    expect(closedAttempt.outcome).toBe("CLOSED");
    expect(scopeLock.getState("P0")).toBe("CLOSED");

    // Every governance action above (lock, backlog denial, close) landed
    // in the ONE Founder Decision Ledger, grouped under the phase id.
    const decisions = ledger.allFor("P0");
    expect(decisions.map((d) => d.decisionId).sort()).toEqual(["d-backlog", "d-close-final", "d-lock"].sort());
  });

  it("a registry with an unsupported evidence claim blocks BOTH the Invariant Guard AND surfaces in the Reality Matrix — Scope Lock refuses to lock", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-governance-e2e-"));
    const requirementsDir = join(tempRoot, "specification", "requirements");
    mkdirSync(requirementsDir, { recursive: true });
    writeFileSync(
      join(requirementsDir, "broken.yml"),
      [
        "- id: UASF-REQ-9101",
        "  title: Fixture",
        "  description: Claims UNIT_TESTED with zero evidence.",
        "  source_baseline: 'BASELINE-V1 section 0 (test fixture)'",
        "  category: P0",
        "  priority: LOW",
        "  status: UNIT_TESTED",
        "  implementation_refs: []",
        "  test_refs: []",
        "  proof_refs: []",
        ""
      ].join("\n")
    );
    const ledger = new FounderDecisionLedger();
    const scopeLock = new ScopeLock(ledger);
    const invariantGuard = createDefaultInvariantGuard(requirementsDir, tempRoot);

    const matrix = computeRealityMatrix(requirementsDir, tempRoot);
    expect(matrix.unsupportedClaimIds).toEqual(["UASF-REQ-9101"]);

    const guardReport = invariantGuard.runAll();
    expect(guardReport.allBlockingSatisfied).toBe(false);

    expect(() => scopeLock.lock("P0", "attempting despite issues", guardReport, "d-lock")).toThrow();
    expect(scopeLock.getState("P0")).toBe("OPEN");
    expect(ledger.allFor("P0")).toHaveLength(0);
  });
});
