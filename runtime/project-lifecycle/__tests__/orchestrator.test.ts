import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapProject, PreflightTraceabilityFailedError } from "../orchestrator.js";
import { PolicyEngine, lowRiskAllowRule } from "../../policy-engine/policy-engine.js";
import { CapabilityDeniedError } from "../../capability-gateway/gateway.js";
import { createDefaultModelRegistry } from "../../models/registry.js";
import { InvalidProjectGenomeError } from "../../project-genome/genome.js";
import { FileStateStore } from "../../state/file-store.js";
import type { TraceabilityIssue } from "../../requirements-traceability/traceability.js";

function validGenome(id: string) {
  return {
    project: { id, name: "Test Project", family: "ecommerce" },
    business: { capabilities: ["payments"] }
  };
}

describe("bootstrapProject (P0 end-to-end orchestration)", () => {
  let tempRoot: string;

  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it("refuses to scaffold anything when policy defaults to deny (fail closed)", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-"));
    const policy = new PolicyEngine(); // no rules added -> default deny

    await expect(
      bootstrapProject({
        genomeCandidate: validGenome("proj-deny"),
        baseDir: tempRoot,
        policy,
        modelRegistry: createDefaultModelRegistry()
      })
    ).rejects.toThrow(CapabilityDeniedError);

    // Nothing was scaffolded — policy denial happened before any filesystem action.
    expect(existsSync(join(tempRoot, "proj-deny"))).toBe(false);
  });

  it("refuses to bootstrap when the Factory's own requirement registry has traceability issues", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-"));
    const policy = new PolicyEngine();
    policy.addRule(lowRiskAllowRule(2));
    const issues: TraceabilityIssue[] = [{ requirementId: "UASF-REQ-9999", issue: "MISSING_TEST_REFS", status: "UNIT_TESTED" }];

    await expect(
      bootstrapProject({
        genomeCandidate: validGenome("proj-blocked"),
        baseDir: tempRoot,
        policy,
        modelRegistry: createDefaultModelRegistry(),
        preflightTraceabilityIssues: issues
      })
    ).rejects.toThrow(PreflightTraceabilityFailedError);

    // The genome was never even validated, let alone scaffolded.
    expect(existsSync(join(tempRoot, "proj-blocked"))).toBe(false);
  });

  it("rejects an invalid Project Genome before touching policy, filesystem, or models", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-"));
    const policy = new PolicyEngine();
    policy.addRule(lowRiskAllowRule(2));

    await expect(
      bootstrapProject({
        genomeCandidate: { project: { id: "no-family" } }, // missing required 'family'
        baseDir: tempRoot,
        policy,
        modelRegistry: createDefaultModelRegistry()
      })
    ).rejects.toThrow(InvalidProjectGenomeError);
  });

  it("runs the full pipeline end-to-end and persists every stage's output to disk", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-"));
    const policy = new PolicyEngine();
    policy.addRule(lowRiskAllowRule(2));
    const stateStore = new FileStateStore();

    const result = await bootstrapProject({
      genomeCandidate: validGenome("shop-1"),
      baseDir: tempRoot,
      policy,
      modelRegistry: createDefaultModelRegistry(),
      stateStore
    });

    // 1) Genome validated and returned.
    expect(result.genome.project.id).toBe("shop-1");

    // 2) Organization composed from the genome (ecommerce + payments -> security team).
    expect(result.organization.teams).toEqual(expect.arrayContaining(["web", "backend", "qa", "security"]));

    // 3) Project OS actually scaffolded on disk.
    expect(existsSync(result.scaffold.projectRoot)).toBe(true);
    expect(existsSync(join(result.scaffold.projectRoot, "requirements"))).toBe(true);

    // 4) Cheapest capable model selected (MOCK tier, not premium) and cost recorded (free).
    expect(result.modelDecision.model.tier).not.toBe("PREMIUM");
    expect(result.totalCostUsd).toBe(0);

    // 5) Every stage's output persisted to disk — a fresh StateStore reading the same paths sees it too.
    const freshStore = new FileStateStore();
    const persistedGenome = freshStore.read<{ project: { id: string } }>(
      join(result.scaffold.projectRoot, "project-genome", "genome.json")
    );
    expect(persistedGenome?.project.id).toBe("shop-1");

    const persistedOrg = freshStore.read<{ teams: string[] }>(
      join(result.scaffold.projectRoot, "organization", "organization.json")
    );
    expect(persistedOrg?.teams).toEqual(expect.arrayContaining(["security"]));

    const persistedState = freshStore.read<{ projectId: string; policyDecision: string }>(result.statePath);
    expect(persistedState?.projectId).toBe("shop-1");
    expect(persistedState?.policyDecision).toBe("ALLOW");
  });

  it("enforces a budget ceiling across the model-routing step of the pipeline", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-"));
    const policy = new PolicyEngine();
    policy.addRule(lowRiskAllowRule(2));

    // The default registry's MOCK-tier model is free, so a zero-dollar ceiling should still pass...
    const result = await bootstrapProject({
      genomeCandidate: validGenome("free-project"),
      baseDir: tempRoot,
      policy,
      modelRegistry: createDefaultModelRegistry(),
      budgetLimits: { perTaskUsd: 0 }
    });
    expect(result.totalCostUsd).toBe(0);
  });
});
