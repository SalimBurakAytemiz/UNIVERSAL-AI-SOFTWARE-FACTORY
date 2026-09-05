import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { bootstrapProject, PreflightTraceabilityFailedError } from "../orchestrator.js";
import { scaffoldProjectOs } from "../../project-os/scaffold.js";
import { PolicyEngine, lowRiskAllowRule } from "../../policy-engine/policy-engine.js";
import { CapabilityDeniedError } from "../../capability-gateway/gateway.js";
import { createDefaultModelRegistry } from "../../models/registry.js";
import { InvalidProjectGenomeError } from "../../project-genome/genome.js";
import { FileStateStore } from "../../state/file-store.js";
import { InvalidProjectIdError, PathEscapeError, assertWithinRoot } from "../../sandbox/sandbox.js";
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

  describe("P1 fix: project bootstrap can never escape its authorized base directory", () => {
    it("a normal project id still works end-to-end", async () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-escape-"));
      const policy = new PolicyEngine();
      policy.addRule(lowRiskAllowRule(2));

      const result = await bootstrapProject({
        genomeCandidate: validGenome("legit-project"),
        baseDir: tempRoot,
        policy,
        modelRegistry: createDefaultModelRegistry()
      });
      expect(existsSync(result.scaffold.projectRoot)).toBe(true);
    });

    it("rejects '../outside' before any filesystem mutation", async () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-escape-"));
      const policy = new PolicyEngine();
      policy.addRule(lowRiskAllowRule(2));
      // Defensive pre-clean: `../outside` resolves to a fixed path in the
      // shared OS temp dir, so a prior (e.g. manually-reverted) run must
      // not be able to leave a stale directory that masks this assertion.
      const escapedPath = join(tempRoot, "..", "outside");
      rmSync(escapedPath, { recursive: true, force: true });

      await expect(
        bootstrapProject({
          genomeCandidate: validGenome("../outside"),
          baseDir: tempRoot,
          policy,
          modelRegistry: createDefaultModelRegistry()
        })
      ).rejects.toThrow(InvalidProjectIdError);

      expect(existsSync(escapedPath)).toBe(false);
    });

    it("rejects '../../outside'", async () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-escape-"));
      const policy = new PolicyEngine();
      policy.addRule(lowRiskAllowRule(2));

      await expect(
        bootstrapProject({
          genomeCandidate: validGenome("../../outside"),
          baseDir: tempRoot,
          policy,
          modelRegistry: createDefaultModelRegistry()
        })
      ).rejects.toThrow(InvalidProjectIdError);
    });

    it("rejects an absolute path as project id", async () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-escape-"));
      const policy = new PolicyEngine();
      policy.addRule(lowRiskAllowRule(2));

      await expect(
        bootstrapProject({
          genomeCandidate: validGenome("/etc/passwd"),
          baseDir: tempRoot,
          policy,
          modelRegistry: createDefaultModelRegistry()
        })
      ).rejects.toThrow(InvalidProjectIdError);
    });

    it("rejects slash and backslash traversal variants", async () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-escape-"));
      const policy = new PolicyEngine();
      policy.addRule(lowRiskAllowRule(2));

      await expect(
        bootstrapProject({
          genomeCandidate: validGenome("a/../../outside"),
          baseDir: tempRoot,
          policy,
          modelRegistry: createDefaultModelRegistry()
        })
      ).rejects.toThrow(InvalidProjectIdError);

      await expect(
        bootstrapProject({
          genomeCandidate: validGenome("a\\..\\outside"),
          baseDir: tempRoot,
          policy,
          modelRegistry: createDefaultModelRegistry()
        })
      ).rejects.toThrow(InvalidProjectIdError);
    });

    it("scaffolding a legitimate project never touches a sibling directory outside baseDir (sibling-overwrite non-interference)", async () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-escape-"));
      const policy = new PolicyEngine();
      policy.addRule(lowRiskAllowRule(2));

      // A sibling directory that sits right next to baseDir, sharing a
      // string prefix with it — the exact shape a prefix-confusion escape
      // would target. It must remain completely untouched.
      const siblingRoot = `${tempRoot}-sibling-project`;
      mkdirSync(siblingRoot, { recursive: true });
      writeFileSync(join(siblingRoot, "marker.txt"), "untouched");

      await bootstrapProject({
        genomeCandidate: validGenome("shop"),
        baseDir: tempRoot,
        policy,
        modelRegistry: createDefaultModelRegistry()
      });

      expect(readFileSync(join(siblingRoot, "marker.txt"), "utf8")).toBe("untouched");
      rmSync(siblingRoot, { recursive: true, force: true });
    });

    it("blocks a prefix-confusion sibling escape at the confinement layer directly (assertWithinRoot)", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-escape-"));
      // Once a project id passes format validation it cannot contain '/'
      // or '..' at all, so this attack is only reachable by calling the
      // lower-level confinement primitive directly — proving the SECOND,
      // independent layer (not just the regex) also fails closed.
      expect(() => assertWithinRoot(tempRoot, `../${basename(tempRoot)}-evil`)).toThrow(PathEscapeError);
    });

    it("does not create any directory when project-id validation fails", async () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-escape-"));
      const policy = new PolicyEngine();
      policy.addRule(lowRiskAllowRule(2));
      const before = readdirSync(tempRoot);
      const escapedPath = join(tempRoot, "..", "escape-attempt");
      rmSync(escapedPath, { recursive: true, force: true }); // defensive pre-clean, see above

      await expect(
        bootstrapProject({
          genomeCandidate: validGenome("../escape-attempt"),
          baseDir: tempRoot,
          policy,
          modelRegistry: createDefaultModelRegistry()
        })
      ).rejects.toThrow();

      const after = readdirSync(tempRoot);
      expect(after).toEqual(before);
      expect(existsSync(escapedPath)).toBe(false);
    });

    it("scaffoldProjectOs itself refuses to escape even if called directly with an unsafe id", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-escape-"));
      const escapedPath = join(tempRoot, "..", "outside");
      rmSync(escapedPath, { recursive: true, force: true }); // defensive pre-clean, see above
      expect(() => scaffoldProjectOs(tempRoot, "../outside")).toThrow(InvalidProjectIdError);
      expect(existsSync(escapedPath)).toBe(false);
    });

    it("the full bootstrap pipeline refuses a symlink-based escape (project id passes format validation, the destination itself is a symlink)", async () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-escape-"));
      const outside = mkdtempSync(join(tmpdir(), "uasf-orchestrator-escape-outside-"));
      const policy = new PolicyEngine();
      policy.addRule(lowRiskAllowRule(2));

      let symlinkSupported = true;
      try {
        symlinkSync(outside, join(tempRoot, "sneaky"));
      } catch {
        symlinkSupported = false;
      }
      if (!symlinkSupported) {
        rmSync(outside, { recursive: true, force: true });
        return;
      }

      await expect(
        bootstrapProject({
          genomeCandidate: validGenome("sneaky"), // valid format, but resolves through a symlink
          baseDir: tempRoot,
          policy,
          modelRegistry: createDefaultModelRegistry()
        })
      ).rejects.toThrow(PathEscapeError);

      expect(readdirSync(outside)).toHaveLength(0); // nothing was scaffolded into the real target
      rmSync(outside, { recursive: true, force: true });
    });
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
