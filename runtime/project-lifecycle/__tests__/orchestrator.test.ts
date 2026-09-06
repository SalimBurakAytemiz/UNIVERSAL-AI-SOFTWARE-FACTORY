import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { bootstrapProject, PreflightTraceabilityFailedError, type BootstrapProjectInput } from "../orchestrator.js";
import { scaffoldProjectOs } from "../../project-os/scaffold.js";
import { PolicyEngine, lowRiskAllowRule } from "../../policy-engine/policy-engine.js";
import { CapabilityDeniedError } from "../../capability-gateway/gateway.js";
import { createDefaultModelRegistry, ModelRegistry } from "../../models/registry.js";
import { InvalidProjectGenomeError } from "../../project-genome/genome.js";
import { FileStateStore, type StateStore } from "../../state/file-store.js";
import { InvalidProjectIdError, PathEscapeError, assertWithinRoot } from "../../sandbox/sandbox.js";
import { CostEngine } from "../../cost/cost-engine.js";
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

    it("P1 fix (5th independent review round): a pre-planted dangling symlink at the final state-file destination is blocked, not followed", async () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-escape-"));
      const outside = mkdtempSync(join(tmpdir(), "uasf-orchestrator-escape-outside-"));
      const policy = new PolicyEngine();
      policy.addRule(lowRiskAllowRule(2));

      // First, a completely legitimate bootstrap — this is what creates the
      // real "state" directory that a later attacker could target.
      const first = await bootstrapProject({
        genomeCandidate: validGenome("reused-project"),
        baseDir: tempRoot,
        policy,
        modelRegistry: createDefaultModelRegistry()
      });

      // Attacker (or a prior compromised run) now REPLACES the real file
      // the first bootstrap just wrote with a DANGLING symlink at that
      // exact path, pointing at a location outside baseDir that has never
      // been created.
      const outsideNeverCreated = join(outside, "exfiltrated-state.json");
      unlinkSync(first.statePath); // remove the real file so the symlink can take its place
      let symlinkSupported = true;
      try {
        symlinkSync(outsideNeverCreated, first.statePath);
      } catch {
        symlinkSupported = false;
      }
      if (!symlinkSupported) {
        rmSync(outside, { recursive: true, force: true });
        return;
      }

      // A second, idempotent bootstrap of the SAME project must not follow
      // that dangling symlink and write outside baseDir.
      await expect(
        bootstrapProject({
          genomeCandidate: validGenome("reused-project"),
          baseDir: tempRoot,
          policy,
          modelRegistry: createDefaultModelRegistry()
        })
      ).rejects.toThrow(PathEscapeError);

      expect(existsSync(outsideNeverCreated)).toBe(false); // never followed/created
      rmSync(outside, { recursive: true, force: true });
    });

    it("P1 fix (6th independent review round): a pre-existing project-root alias (baseDir/A -> baseDir/B) cannot overwrite project B's persisted state", async () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-alias-"));
      const policy = new PolicyEngine();
      policy.addRule(lowRiskAllowRule(2));

      // Bootstrap a completely legitimate project B first.
      const b = await bootstrapProject({
        genomeCandidate: validGenome("project-b"),
        baseDir: tempRoot,
        policy,
        modelRegistry: createDefaultModelRegistry()
      });
      const bGenomeBefore = readFileSync(join(b.scaffold.projectRoot, "project-genome", "genome.json"), "utf8");
      const bStateBefore = readFileSync(b.statePath, "utf8");

      // An attacker (or a stale artifact) makes baseDir/project-a an ALIAS
      // of baseDir/project-b — a pre-existing symlink, no race required.
      let symlinkSupported = true;
      try {
        symlinkSync(b.scaffold.projectRoot, join(tempRoot, "project-a"));
      } catch {
        symlinkSupported = false;
      }
      if (!symlinkSupported) return;

      // Bootstrapping project A must be rejected outright, not silently
      // redirected into writing/overwriting project B's real directory.
      await expect(
        bootstrapProject({
          genomeCandidate: validGenome("project-a"),
          baseDir: tempRoot,
          policy,
          modelRegistry: createDefaultModelRegistry()
        })
      ).rejects.toThrow(PathEscapeError);

      // Project B's genome, organization, and state files must be
      // byte-identical to before the rejected project-A bootstrap attempt
      // — no partial mutation occurred, and B's project id was never
      // overwritten with A's.
      expect(readFileSync(join(b.scaffold.projectRoot, "project-genome", "genome.json"), "utf8")).toBe(
        bGenomeBefore
      );
      expect(readFileSync(b.statePath, "utf8")).toBe(bStateBefore);
      expect(JSON.parse(readFileSync(b.statePath, "utf8")).projectId).toBe("project-b");
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

  describe("P1 fix (8th independent review round, 'caller mutation changes project identity during bootstrap')", () => {
    it("mutating the caller's genomeCandidate.project.id AFTER bootstrapProject() has started does not change the authoritative project identity anywhere in the pipeline", async () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-genome-race-"));
      const policy = new PolicyEngine();
      policy.addRule(lowRiskAllowRule(2));
      const genomeCandidate = validGenome("proj-A");

      const promise = bootstrapProject({
        genomeCandidate,
        baseDir: tempRoot,
        policy,
        modelRegistry: createDefaultModelRegistry()
      });

      // Simulate the caller continuing to hold and mutate their own object
      // while bootstrapProject()'s async work is still in flight.
      genomeCandidate.project.id = "proj-B";
      genomeCandidate.project.family = "web";

      const result = await promise;

      // Authorization/root selection/persistence all used project A throughout.
      expect(result.genome.project.id).toBe("proj-A");
      expect(result.genome.project.family).toBe("ecommerce");
      expect(existsSync(join(tempRoot, "proj-A"))).toBe(true);
      expect(existsSync(join(tempRoot, "proj-B"))).toBe(false);

      const persistedGenome = JSON.parse(
        readFileSync(join(result.scaffold.projectRoot, "project-genome", "genome.json"), "utf8")
      );
      expect(persistedGenome.project.id).toBe("proj-A");

      const persistedState = JSON.parse(readFileSync(result.statePath, "utf8"));
      expect(persistedState.projectId).toBe("proj-A");

      // Cost attribution stayed with project A, not the caller's later "B".
      expect(result.totalCostUsd).toBeGreaterThanOrEqual(0);
    });

    it("the genome returned in the bootstrap result is never the same reference as the caller's genomeCandidate", async () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-genome-race-"));
      const policy = new PolicyEngine();
      policy.addRule(lowRiskAllowRule(2));
      const genomeCandidate = validGenome("proj-ownership");

      const result = await bootstrapProject({
        genomeCandidate,
        baseDir: tempRoot,
        policy,
        modelRegistry: createDefaultModelRegistry()
      });

      expect(result.genome).not.toBe(genomeCandidate);
      expect(result.genome.project).not.toBe(genomeCandidate.project);
      // Mutating the caller's object post-hoc cannot reach into the result either.
      genomeCandidate.project.id = "tampered";
      expect(result.genome.project.id).toBe("proj-ownership");
    });

    it("mutating a nested business.capabilities array after bootstrap starts does not change the organization composed from it", async () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-genome-race-"));
      const policy = new PolicyEngine();
      policy.addRule(lowRiskAllowRule(2));
      const genomeCandidate = validGenome("proj-caps");

      const promise = bootstrapProject({
        genomeCandidate,
        baseDir: tempRoot,
        policy,
        modelRegistry: createDefaultModelRegistry()
      });

      genomeCandidate.business.capabilities.push("identity");

      const result = await promise;

      // "identity" would have added the security team for a different
      // reason; here it must never have been observed at all — only the
      // ORIGINAL ["payments"] (still security-triggering, but via the
      // documented payments rule) is authoritative.
      expect(result.organization.rationale.security).toBe("Payments capability requires Security team involvement");
    });
  });

  describe(
    "P1 fix (11th independent review round targeted audit, same class as gateway.ts's 'caller context mutation " +
      "can change cost ownership during invocation'): bootstrapProject() captures every field it needs from " +
      "`input` before its own first `await`, so a caller mutating `input` afterward has no effect",
    () => {
      it("mutating input.costEngine before bootstrapProject's internal await resumes has no effect — accounting stays on the ORIGINALLY-supplied CostEngine", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-cost-race-"));
        const policy = new PolicyEngine();
        policy.addRule(lowRiskAllowRule(2));
        const originalCostEngine = new CostEngine();
        const evilCostEngine = new CostEngine();

        // A registry whose ONLY summarization-capable model is NOT free —
        // the default registry's mock-classifier is $0/call, which would
        // make "original vs. evil costEngine" indistinguishable (both
        // total $0 regardless of which one is actually used).
        const paidRegistry = new ModelRegistry();
        paidRegistry.register({
          provider: "mock",
          modelId: "paid-summarizer",
          tier: "MOCK",
          costPerCall: 0.05,
          capabilities: ["summarization"],
          status: "ACTIVE"
        });

        const input: BootstrapProjectInput & { costEngine?: CostEngine } = {
          genomeCandidate: validGenome("proj-cost-race"),
          baseDir: tempRoot,
          policy,
          modelRegistry: paidRegistry,
          costEngine: originalCostEngine
        };

        // Scheduled BEFORE calling bootstrapProject(), to land in the
        // earliest possible microtask slot relative to bootstrapProject's
        // own internal await-driven resumption — the scenario most
        // favorable to the caller actually winning a race, if one existed.
        Promise.resolve().then(() => {
          (input as { costEngine?: CostEngine }).costEngine = evilCostEngine;
        });

        const result = await bootstrapProject(input);

        expect(result.totalCostUsd).toBe(0.05); // the paid model's real cost
        expect(originalCostEngine.totalFor({ projectId: "proj-cost-race" })).toBe(0.05);
        expect(evilCostEngine.total()).toBe(0); // nothing was ever recorded into the swapped-in engine
      });

      it("mutating input.modelRegistry before bootstrapProject's internal await resumes has no effect — routing stays on the ORIGINALLY-supplied registry", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-registry-race-"));
        const policy = new PolicyEngine();
        policy.addRule(lowRiskAllowRule(2));
        const originalRegistry = createDefaultModelRegistry();
        const evilRegistry = new ModelRegistry(); // empty — would make routing fail entirely if it were ever consulted

        const input: BootstrapProjectInput = {
          genomeCandidate: validGenome("proj-registry-race"),
          baseDir: tempRoot,
          policy,
          modelRegistry: originalRegistry
        };

        Promise.resolve().then(() => {
          (input as { modelRegistry: ModelRegistry }).modelRegistry = evilRegistry;
        });

        // If the swapped-in (empty) registry were ever consulted, this
        // would throw NoCapableModelError instead of succeeding.
        const result = await bootstrapProject(input);
        expect(result.modelDecision.model.modelId).toBeTruthy();
      });

      it("mutating input.stateStore before bootstrapProject's internal await resumes has no effect — persistence stays on the ORIGINALLY-supplied store", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-statestore-race-"));
        const policy = new PolicyEngine();
        policy.addRule(lowRiskAllowRule(2));
        const writes: Array<{ path: string }> = [];
        const originalStore = new FileStateStore();
        const evilStore: StateStore = {
          write: (path: string) => {
            writes.push({ path });
          },
          read: () => undefined,
          exists: () => false
        };

        const input: BootstrapProjectInput = {
          genomeCandidate: validGenome("proj-store-race"),
          baseDir: tempRoot,
          policy,
          modelRegistry: createDefaultModelRegistry(),
          stateStore: originalStore
        };

        Promise.resolve().then(() => {
          (input as { stateStore: StateStore }).stateStore = evilStore;
        });

        const result = await bootstrapProject(input);

        // Everything was persisted via the ORIGINAL FileStateStore, never the swapped-in one.
        expect(writes).toHaveLength(0);
        expect(existsSync(result.statePath)).toBe(true);
      });
    }
  );
});
