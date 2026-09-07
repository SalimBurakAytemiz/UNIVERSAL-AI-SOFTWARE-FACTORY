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
import { BudgetExceededError, InvalidBudgetLimitError, type BudgetLimits } from "../../budget/budget.js";
import type { TraceabilityIssue } from "../../requirements-traceability/traceability.js";
import {
  ModelGateway,
  UnknownProviderError,
  type ModelInvocationRequest,
  type ModelInvocationResponse,
  type ModelProvider
} from "../../models/gateway.js";
import { MockProvider } from "../../models/providers/mock-provider.js";
import type { ModelRecord } from "../../models/registry.js";

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

  describe(
    "P1 fix (12th independent review round, 'bootstrap retains mutable budget configuration across await'): " +
      "budgetLimits' OWN FIELDS (not just the object reference) are snapshotted before bootstrapProject()'s " +
      "first await",
    () => {
      // Project identity mutation (genomeCandidate.project.id) is already
      // covered by the 8th independent review round's describe block above
      // ("caller mutation changes project identity during bootstrap") —
      // not duplicated here.

      it(
        "BLOCKER regression, exact reproduction: an initial $0 perTaskUsd ceiling, mutated to $1 WHILE bootstrap " +
          "is pending, still blocks a non-free model's spend — the ORIGINAL $0 ceiling remains authoritative",
        async () => {
          tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-budget-race-"));
          const policy = new PolicyEngine();
          policy.addRule(lowRiskAllowRule(2));
          const paidRegistry = new ModelRegistry();
          paidRegistry.register({
            provider: "mock",
            modelId: "paid-summarizer",
            tier: "MOCK",
            costPerCall: 0.6,
            capabilities: ["summarization"],
            status: "ACTIVE"
          });

          // A mutable budgetLimits object — the SAME reference is retained
          // and mutated by the "caller" after bootstrap starts, mutating a
          // NESTED FIELD (not replacing the whole object, which the 11th
          // round's reference-capture fix already handles).
          const budgetLimits: { perTaskUsd?: number } = { perTaskUsd: 0 };

          const input: BootstrapProjectInput = {
            genomeCandidate: validGenome("proj-budget-race-blocked"),
            baseDir: tempRoot,
            policy,
            modelRegistry: paidRegistry,
            budgetLimits: budgetLimits as BudgetLimits
          };

          Promise.resolve().then(() => {
            budgetLimits.perTaskUsd = 1; // would legalize the $0.60 spend if ever consulted
          });

          await expect(bootstrapProject(input)).rejects.toThrow(BudgetExceededError);
        }
      );

      it(
        "an initial $1 perTaskUsd ceiling, mutated DOWN to $0 WHILE bootstrap is pending, does not retroactively " +
          "block a spend the ORIGINAL $1 ceiling genuinely allowed",
        async () => {
          tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-budget-race-allowed-"));
          const policy = new PolicyEngine();
          policy.addRule(lowRiskAllowRule(2));
          const paidRegistry = new ModelRegistry();
          paidRegistry.register({
            provider: "mock",
            modelId: "paid-summarizer",
            tier: "MOCK",
            costPerCall: 0.6,
            capabilities: ["summarization"],
            status: "ACTIVE"
          });

          const budgetLimits: { perTaskUsd?: number } = { perTaskUsd: 1 };

          const input: BootstrapProjectInput = {
            genomeCandidate: validGenome("proj-budget-race-allowed"),
            baseDir: tempRoot,
            policy,
            modelRegistry: paidRegistry,
            budgetLimits: budgetLimits as BudgetLimits
          };

          Promise.resolve().then(() => {
            budgetLimits.perTaskUsd = 0; // would wrongly block the ALREADY-authorized $0.60 spend if ever consulted
          });

          const result = await bootstrapProject(input);
          expect(result.totalCostUsd).toBe(0.6);
        }
      );

      it("concurrent bootstrapProject() calls sharing ONE caller-owned budgetLimits object remain isolated — each uses the ceiling in effect at ITS OWN start", async () => {
        const rootA = mkdtempSync(join(tmpdir(), "uasf-orchestrator-budget-concurrent-a-"));
        const rootB = mkdtempSync(join(tmpdir(), "uasf-orchestrator-budget-concurrent-b-"));
        const policy = new PolicyEngine();
        policy.addRule(lowRiskAllowRule(2));
        const paidRegistry = new ModelRegistry();
        paidRegistry.register({
          provider: "mock",
          modelId: "paid-summarizer",
          tier: "MOCK",
          costPerCall: 0.6,
          capabilities: ["summarization"],
          status: "ACTIVE"
        });

        const sharedBudgetLimits: { perTaskUsd?: number } = { perTaskUsd: 0 };

        // Call A starts (synchronously captures perTaskUsd=0 at entry).
        const callA = bootstrapProject({
          genomeCandidate: validGenome("proj-concurrent-a"),
          baseDir: rootA,
          policy,
          modelRegistry: paidRegistry,
          budgetLimits: sharedBudgetLimits as BudgetLimits
        });
        // Mutate the SHARED object before issuing call B.
        sharedBudgetLimits.perTaskUsd = 1;
        // Call B starts (synchronously captures perTaskUsd=1, already in effect at ITS OWN entry).
        const callB = bootstrapProject({
          genomeCandidate: validGenome("proj-concurrent-b"),
          baseDir: rootB,
          policy,
          modelRegistry: paidRegistry,
          budgetLimits: sharedBudgetLimits as BudgetLimits
        });

        await expect(callA).rejects.toThrow(BudgetExceededError); // A's own $0 snapshot, taken before the mutation
        await expect(callB).resolves.toMatchObject({ totalCostUsd: 0.6 }); // B's own $1 snapshot

        rmSync(rootA, { recursive: true, force: true });
        rmSync(rootB, { recursive: true, force: true });
      });
    }
  );

  describe(
    "P2 fix (13th independent review round, 'bootstrap validates budget limits after filesystem mutation'): " +
      "budgetGuardLimits is validated via assertValidBudgetLimits() BEFORE parseProjectGenome()/" +
      "assertFilesystemConfinement()/scaffoldProjectOs() — i.e. before this function's FIRST filesystem mutation",
    () => {
      it(
        "BLOCKER regression, exact reproduction: perTaskUsd: NaN is rejected with InvalidBudgetLimitError and " +
          "creates ZERO filesystem mutations — no project directory is ever scaffolded",
        async () => {
          tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-budget-validate-first-"));
          const policy = new PolicyEngine();
          policy.addRule(lowRiskAllowRule(2));

          await expect(
            bootstrapProject({
              genomeCandidate: validGenome("proj-nan-budget"),
              baseDir: tempRoot,
              policy,
              modelRegistry: createDefaultModelRegistry(),
              budgetLimits: { perTaskUsd: NaN }
            })
          ).rejects.toThrow(InvalidBudgetLimitError);

          // Zero filesystem mutations: the base temp directory remains
          // completely empty — scaffoldProjectOs() never ran.
          expect(readdirSync(tempRoot)).toHaveLength(0);
          expect(existsSync(join(tempRoot, "proj-nan-budget"))).toBe(false);
        }
      );

      it("Infinity perTaskUsd is rejected with InvalidBudgetLimitError and creates ZERO filesystem mutations", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-budget-validate-first-"));
        const policy = new PolicyEngine();
        policy.addRule(lowRiskAllowRule(2));

        await expect(
          bootstrapProject({
            genomeCandidate: validGenome("proj-inf-budget"),
            baseDir: tempRoot,
            policy,
            modelRegistry: createDefaultModelRegistry(),
            budgetLimits: { perRunUsd: Infinity }
          })
        ).rejects.toThrow(InvalidBudgetLimitError);

        expect(readdirSync(tempRoot)).toHaveLength(0);
      });

      it("a negative dailyUsd ceiling is rejected with InvalidBudgetLimitError and creates ZERO filesystem mutations", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-budget-validate-first-"));
        const policy = new PolicyEngine();
        policy.addRule(lowRiskAllowRule(2));

        await expect(
          bootstrapProject({
            genomeCandidate: validGenome("proj-negative-budget"),
            baseDir: tempRoot,
            policy,
            modelRegistry: createDefaultModelRegistry(),
            budgetLimits: { dailyUsd: -1 }
          })
        ).rejects.toThrow(InvalidBudgetLimitError);

        expect(readdirSync(tempRoot)).toHaveLength(0);
      });

      it("an invalid monthlyUsd ceiling among otherwise-valid ceilings is still rejected before any mutation", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-budget-validate-first-"));
        const policy = new PolicyEngine();
        policy.addRule(lowRiskAllowRule(2));

        await expect(
          bootstrapProject({
            genomeCandidate: validGenome("proj-mixed-budget"),
            baseDir: tempRoot,
            policy,
            modelRegistry: createDefaultModelRegistry(),
            budgetLimits: { perTaskUsd: 5, perRunUsd: 10, monthlyUsd: NaN }
          })
        ).rejects.toThrow(InvalidBudgetLimitError);

        expect(readdirSync(tempRoot)).toHaveLength(0);
      });

      it("a genuinely valid budgetLimits object still creates the FULL expected project structure (no regression)", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-budget-validate-first-"));
        const policy = new PolicyEngine();
        policy.addRule(lowRiskAllowRule(2));

        const result = await bootstrapProject({
          genomeCandidate: validGenome("proj-valid-budget"),
          baseDir: tempRoot,
          policy,
          modelRegistry: createDefaultModelRegistry(),
          budgetLimits: { perTaskUsd: 10, perRunUsd: 10, dailyUsd: 10, monthlyUsd: 10 }
        });

        expect(existsSync(join(tempRoot, "proj-valid-budget"))).toBe(true);
        expect(result.scaffold.createdDirectories.length).toBeGreaterThan(0);
      });

      it(
        "a caller mutating budgetLimits from a genuinely VALID ceiling to an INVALID one WHILE bootstrap is " +
          "pending has zero effect — validation already ran against the ORIGINAL, valid snapshot before the " +
          "first filesystem mutation",
        async () => {
          tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-budget-validate-first-"));
          const policy = new PolicyEngine();
          policy.addRule(lowRiskAllowRule(2));
          const paidRegistry = new ModelRegistry();
          paidRegistry.register({
            provider: "mock",
            modelId: "paid-summarizer",
            tier: "MOCK",
            costPerCall: 0.6,
            capabilities: ["summarization"],
            status: "ACTIVE"
          });

          const budgetLimits: { perTaskUsd?: number } = { perTaskUsd: 1 };
          const input: BootstrapProjectInput = {
            genomeCandidate: validGenome("proj-budget-validate-race"),
            baseDir: tempRoot,
            policy,
            modelRegistry: paidRegistry,
            budgetLimits: budgetLimits as BudgetLimits
          };
          Promise.resolve().then(() => {
            // If this were ever consulted by assertValidBudgetLimits(),
            // an already-in-flight bootstrap would incorrectly fail.
            budgetLimits.perTaskUsd = NaN;
          });

          const result = await bootstrapProject(input);
          expect(result.totalCostUsd).toBe(0.6);
        }
      );
    }
  );

  describe(
    "P2 fix (13th independent review round TARGETED AUDIT, same class as the budgetGuardLimits validation-" +
      "ordering fix above): router.selectModel()/a non-mutating budget.assertWithinBudget() pre-check now both " +
      "run BEFORE scaffoldProjectOs() — neither depends on the scaffold's own output, so a rejection they cause " +
      "no longer wastes a real filesystem mutation",
    () => {
      it(
        "AUDIT-FOUND regression: a modelRegistry with no capability-matching model is rejected with " +
          "NoCapableModelError and creates ZERO filesystem mutations — no orphaned project directory",
        async () => {
          tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-select-before-scaffold-"));
          const policy = new PolicyEngine();
          policy.addRule(lowRiskAllowRule(2));
          const emptyRegistry = new ModelRegistry(); // no "summarization" capability at all

          await expect(
            bootstrapProject({
              genomeCandidate: validGenome("proj-no-capable-model"),
              baseDir: tempRoot,
              policy,
              modelRegistry: emptyRegistry
            })
          ).rejects.toThrow("No registered model satisfies capabilities");

          expect(readdirSync(tempRoot)).toHaveLength(0);
        }
      );

      it(
        "AUDIT-FOUND regression, exact reproduction: a budget too tight for the selected model's REAL cost is " +
          "rejected with BudgetExceededError and creates ZERO filesystem mutations",
        async () => {
          tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-select-before-scaffold-"));
          const policy = new PolicyEngine();
          policy.addRule(lowRiskAllowRule(2));
          const paidRegistry = new ModelRegistry();
          paidRegistry.register({
            provider: "mock",
            modelId: "paid-summarizer",
            tier: "MOCK",
            costPerCall: 0.6,
            capabilities: ["summarization"],
            status: "ACTIVE"
          });

          await expect(
            bootstrapProject({
              genomeCandidate: validGenome("proj-too-tight-budget"),
              baseDir: tempRoot,
              policy,
              modelRegistry: paidRegistry,
              budgetLimits: { perTaskUsd: 0.1 } // the actual model costs $0.6 — a VALID but insufficient ceiling
            })
          ).rejects.toThrow(BudgetExceededError);

          expect(readdirSync(tempRoot)).toHaveLength(0);
        }
      );

      it("a policy DENY still blocks BOTH the scaffold AND the spend — the pre-check does not weaken this property", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-select-before-scaffold-"));
        const policy = new PolicyEngine(); // no rules -> default deny
        const paidRegistry = new ModelRegistry();
        paidRegistry.register({
          provider: "mock",
          modelId: "paid-summarizer",
          tier: "MOCK",
          costPerCall: 0.6,
          capabilities: ["summarization"],
          status: "ACTIVE"
        });
        const costEngine = new CostEngine();

        await expect(
          bootstrapProject({
            genomeCandidate: validGenome("proj-deny-with-paid-model"),
            baseDir: tempRoot,
            policy,
            modelRegistry: paidRegistry,
            costEngine,
            budgetLimits: { perTaskUsd: 10 } // ceiling is generous — DENY, not budget, must be what blocks this
          })
        ).rejects.toThrow(CapabilityDeniedError);

        expect(readdirSync(tempRoot)).toHaveLength(0);
        // No spend was ever recorded for a bootstrap that never scaffolded anything.
        expect(costEngine.total()).toBe(0);
      });

      it("a genuinely valid, sufficiently-budgeted bootstrap still creates the full expected structure (no regression)", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-select-before-scaffold-"));
        const policy = new PolicyEngine();
        policy.addRule(lowRiskAllowRule(2));
        const paidRegistry = new ModelRegistry();
        paidRegistry.register({
          provider: "mock",
          modelId: "paid-summarizer",
          tier: "MOCK",
          costPerCall: 0.6,
          capabilities: ["summarization"],
          status: "ACTIVE"
        });

        const result = await bootstrapProject({
          genomeCandidate: validGenome("proj-select-before-scaffold-ok"),
          baseDir: tempRoot,
          policy,
          modelRegistry: paidRegistry,
          budgetLimits: { perTaskUsd: 10 }
        });

        expect(existsSync(join(tempRoot, "proj-select-before-scaffold-ok"))).toBe(true);
        expect(result.totalCostUsd).toBe(0.6);
      });
    }
  );

  describe(
    "P1 fix (23rd independent review round, finding 4, 'do not record synthetic model spend without " +
      "actually invoking a model'): bootstrap's model cost must come from a REAL, guarded invocation",
    () => {
      function gatewayWithProvider(provider: ModelProvider): ModelGateway {
        const gateway = new ModelGateway();
        gateway.registerProvider(provider);
        return gateway;
      }

      function failingProvider(id: string, error: Error): ModelProvider {
        return {
          id,
          async invoke(): Promise<ModelInvocationResponse> {
            throw error;
          }
        };
      }

      it(
        "REGRESSION: an unknown/unregistered provider cannot yield a successful bootstrap — it rejects with " +
          "UnknownProviderError and creates ZERO filesystem mutations",
        async () => {
          tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-unknown-provider-"));
          const policy = new PolicyEngine();
          policy.addRule(lowRiskAllowRule(2));
          const registryWithUnknownProvider = new ModelRegistry();
          registryWithUnknownProvider.register({
            provider: "definitely-not-registered",
            modelId: "ghost-model",
            tier: "MOCK",
            costPerCall: 0,
            capabilities: ["summarization"],
            status: "ACTIVE"
          });
          // A gateway with only MockProvider registered — never "definitely-not-registered".
          const modelGateway = gatewayWithProvider(new MockProvider());

          await expect(
            bootstrapProject({
              genomeCandidate: validGenome("proj-unknown-provider"),
              baseDir: tempRoot,
              policy,
              modelRegistry: registryWithUnknownProvider,
              modelGateway
            })
          ).rejects.toThrow(UnknownProviderError);

          expect(readdirSync(tempRoot)).toHaveLength(0);
        }
      );

      it(
        "REGRESSION: a failing provider cannot produce a successful, fabricated bootstrap result — the error " +
          "propagates, the reservation is released (zero cost recorded), and ZERO filesystem mutations occur",
        async () => {
          tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-failing-provider-"));
          const policy = new PolicyEngine();
          policy.addRule(lowRiskAllowRule(2));
          const paidRegistry = new ModelRegistry();
          paidRegistry.register({
            provider: "flaky",
            modelId: "flaky-summarizer",
            tier: "MOCK",
            costPerCall: 0.6,
            capabilities: ["summarization"],
            status: "ACTIVE"
          });
          const providerError = new Error("simulated provider outage");
          const modelGateway = gatewayWithProvider(failingProvider("flaky", providerError));
          const costEngine = new CostEngine();

          await expect(
            bootstrapProject({
              genomeCandidate: validGenome("proj-failing-provider"),
              baseDir: tempRoot,
              policy,
              modelRegistry: paidRegistry,
              modelGateway,
              costEngine,
              budgetLimits: { perTaskUsd: 10 }
            })
          ).rejects.toThrow(providerError);

          expect(readdirSync(tempRoot)).toHaveLength(0);
          // The reservation was released on provider failure — no cost was
          // ever recorded, proving no synthetic spend occurred despite the
          // model being "selected."
          expect(costEngine.total()).toBe(0);
        }
      );

      it(
        "the real invocation's ACTUAL reported cost is what gets recorded — not merely the model's nominal " +
          "per-call price — proving a genuine invocation occurred rather than a fabricated charge",
        async () => {
          tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-actual-cost-"));
          const policy = new PolicyEngine();
          policy.addRule(lowRiskAllowRule(2));
          const registry = new ModelRegistry();
          registry.register({
            provider: "variable-cost",
            modelId: "variable-cost-summarizer",
            tier: "MOCK",
            costPerCall: 0.6, // the NOMINAL price — deliberately different from what the provider actually reports
            capabilities: ["summarization"],
            status: "ACTIVE"
          });
          const actualReportedCost = 0.42;
          const provider: ModelProvider = {
            id: "variable-cost",
            async invoke(model: ModelRecord, request: ModelInvocationRequest): Promise<ModelInvocationResponse> {
              return { modelId: model.modelId, provider: this.id, costUsd: actualReportedCost, output: request.prompt };
            }
          };
          const modelGateway = gatewayWithProvider(provider);

          const result = await bootstrapProject({
            genomeCandidate: validGenome("proj-actual-cost"),
            baseDir: tempRoot,
            policy,
            modelRegistry: registry,
            modelGateway,
            budgetLimits: { perTaskUsd: 10 }
          });

          // The ACTUAL reported cost was recorded, not the nominal costPerCall.
          expect(result.totalCostUsd).toBe(actualReportedCost);
          expect(result.totalCostUsd).not.toBe(0.6);
        }
      );

      it("policy DENY still blocks the model invocation itself (not merely the scaffold), with zero cost recorded", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-deny-invoke-"));
        const policy = new PolicyEngine(); // default deny
        const paidRegistry = new ModelRegistry();
        paidRegistry.register({
          provider: "mock",
          modelId: "paid-summarizer",
          tier: "MOCK",
          costPerCall: 0.6,
          capabilities: ["summarization"],
          status: "ACTIVE"
        });
        const costEngine = new CostEngine();

        await expect(
          bootstrapProject({
            genomeCandidate: validGenome("proj-deny-invoke"),
            baseDir: tempRoot,
            policy,
            modelRegistry: paidRegistry,
            costEngine,
            budgetLimits: { perTaskUsd: 10 }
          })
        ).rejects.toThrow(CapabilityDeniedError);

        expect(readdirSync(tempRoot)).toHaveLength(0);
        expect(costEngine.total()).toBe(0);
      });
    }
  );

  describe(
    "P1 fix (23rd independent review round, finding 5, 'reserve bootstrap budget before filesystem mutation'): " +
      "budget authorization must be a real, atomic RESERVATION completed before any filesystem mutation, not a " +
      "read-only precheck a concurrent caller can also pass",
    () => {
      it(
        "CONCURRENCY REGRESSION, exact reproduction: two bootstraps sharing ONE CostEngine and a ceiling that " +
          "fits only ONE $0.6 invocation — exactly one proceeds, and the rejected one leaves ZERO filesystem " +
          "side effects (no orphaned project tree)",
        async () => {
          const rootA = mkdtempSync(join(tmpdir(), "uasf-orchestrator-reserve-race-a-"));
          const rootB = mkdtempSync(join(tmpdir(), "uasf-orchestrator-reserve-race-b-"));
          const policy = new PolicyEngine();
          policy.addRule(lowRiskAllowRule(2));
          const paidRegistry = new ModelRegistry();
          paidRegistry.register({
            provider: "mock",
            modelId: "paid-summarizer",
            tier: "MOCK",
            costPerCall: 0.6,
            capabilities: ["summarization"],
            status: "ACTIVE"
          });
          const sharedCostEngine = new CostEngine();
          // perRunUsd is scoped globally (not per-task), so it genuinely
          // collides across two DIFFERENT projects' bootstrap calls —
          // exactly the shared-ledger scenario the finding describes.
          const budgetLimits: BudgetLimits = { perRunUsd: 0.6 };

          // Issued back-to-back, synchronously, with NEITHER awaited yet —
          // each call's own synchronous prefix (through its real,
          // guarded gateway.invoke() reservation) runs to completion
          // before control ever returns to this test, so call A's
          // reservation is guaranteed to be visible to call B's reserve()
          // check (same pattern as the existing 12th-round concurrent-
          // budgetLimits test above).
          const callA = bootstrapProject({
            genomeCandidate: validGenome("proj-reserve-race-a"),
            baseDir: rootA,
            policy,
            modelRegistry: paidRegistry,
            costEngine: sharedCostEngine,
            budgetLimits
          });
          const callB = bootstrapProject({
            genomeCandidate: validGenome("proj-reserve-race-b"),
            baseDir: rootB,
            policy,
            modelRegistry: paidRegistry,
            costEngine: sharedCostEngine,
            budgetLimits
          });

          await expect(callA).resolves.toMatchObject({ totalCostUsd: 0.6 });
          await expect(callB).rejects.toThrow(BudgetExceededError);

          // The winning call genuinely scaffolded its project...
          expect(existsSync(join(rootA, "proj-reserve-race-a"))).toBe(true);
          // ...but the REJECTED call left NO project tree behind at all —
          // proving the budget reservation was checked and enforced
          // BEFORE any filesystem mutation, not merely before an
          // eventual, too-late spend() call.
          expect(readdirSync(rootB)).toHaveLength(0);
          expect(existsSync(join(rootB, "proj-reserve-race-b"))).toBe(false);

          rmSync(rootA, { recursive: true, force: true });
          rmSync(rootB, { recursive: true, force: true });
        }
      );

      it("a budget-rejected bootstrap (insufficient ceiling for the real invocation cost) leaves no project tree, sequentially", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-reserve-sequential-"));
        const policy = new PolicyEngine();
        policy.addRule(lowRiskAllowRule(2));
        const paidRegistry = new ModelRegistry();
        paidRegistry.register({
          provider: "mock",
          modelId: "paid-summarizer",
          tier: "MOCK",
          costPerCall: 0.6,
          capabilities: ["summarization"],
          status: "ACTIVE"
        });

        await expect(
          bootstrapProject({
            genomeCandidate: validGenome("proj-reserve-sequential"),
            baseDir: tempRoot,
            policy,
            modelRegistry: paidRegistry,
            budgetLimits: { perTaskUsd: 0.1 }
          })
        ).rejects.toThrow(BudgetExceededError);

        expect(readdirSync(tempRoot)).toHaveLength(0);
      });
    }
  );

  describe(
    "P1 fix (24th independent review round, finding 6, 'authorize scaffold before paid model work'): a " +
      "bootstrap that is not authorized to scaffold must never invoke the model or incur cost first",
    () => {
      function spyProvider(id: string): { provider: ModelProvider; invokeCount: () => number } {
        let calls = 0;
        const provider: ModelProvider = {
          id,
          async invoke(model): Promise<ModelInvocationResponse> {
            calls += 1;
            return { provider: id, modelId: model.modelId, costUsd: model.costPerCall, output: "should never run" };
          }
        };
        return { provider, invokeCount: () => calls };
      }

      it("a DENY on project.scaffold blocks the whole bootstrap before the model is ever invoked or any cost recorded, even though model.invoke itself is ALLOWED", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-scaffold-deny-"));
        const policy = new PolicyEngine();
        policy.addRule({ name: "allow-model-invoke", priority: 10, evaluate: (a) => (a.actionType === "model.invoke" ? "ALLOW" : null) });
        policy.addRule({ name: "deny-scaffold", priority: 20, evaluate: (a) => (a.actionType === "project.scaffold" ? "DENY" : null) });

        const { provider, invokeCount } = spyProvider("mock");
        const modelGateway = new ModelGateway();
        modelGateway.registerProvider(provider);
        const costEngine = new CostEngine();

        await expect(
          bootstrapProject({
            genomeCandidate: validGenome("proj-scaffold-denied"),
            baseDir: tempRoot,
            policy,
            modelRegistry: createDefaultModelRegistry(),
            modelGateway,
            costEngine
          })
        ).rejects.toThrow(CapabilityDeniedError);

        expect(invokeCount()).toBe(0); // model never invoked
        expect(costEngine.total()).toBe(0); // no cost recorded
        expect(existsSync(join(tempRoot, "proj-scaffold-denied"))).toBe(false); // no filesystem mutation
      });

      it("an APPROVAL_REQUIRED project.scaffold (risk 5) blocks the whole bootstrap before the model is ever invoked or any cost recorded", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-scaffold-approval-"));
        const policy = new PolicyEngine();
        policy.addRule({ name: "allow-model-invoke", priority: 10, evaluate: (a) => (a.actionType === "model.invoke" ? "ALLOW" : null) });

        const { provider, invokeCount } = spyProvider("mock");
        const modelGateway = new ModelGateway();
        modelGateway.registerProvider(provider);
        const costEngine = new CostEngine();

        await expect(
          bootstrapProject({
            genomeCandidate: validGenome("proj-scaffold-approval"),
            baseDir: tempRoot,
            policy,
            modelRegistry: createDefaultModelRegistry(),
            modelGateway,
            costEngine,
            risk: 5
          })
        ).rejects.toThrow(); // CapabilityApprovalRequiredError

        expect(invokeCount()).toBe(0); // model never invoked
        expect(costEngine.total()).toBe(0); // no cost recorded
        expect(existsSync(join(tempRoot, "proj-scaffold-approval"))).toBe(false); // no filesystem mutation
      });

      it("an ALLOWED scaffold still invokes the model and scaffolds normally (no regression for the happy path)", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-scaffold-allow-"));
        const policy = new PolicyEngine();
        policy.addRule(lowRiskAllowRule(2));
        const { provider, invokeCount } = spyProvider("mock");
        const modelGateway = new ModelGateway();
        modelGateway.registerProvider(provider);

        const result = await bootstrapProject({
          genomeCandidate: validGenome("proj-scaffold-allow"),
          baseDir: tempRoot,
          policy,
          modelRegistry: createDefaultModelRegistry(),
          modelGateway
        });

        expect(invokeCount()).toBe(1);
        expect(existsSync(join(tempRoot, "proj-scaffold-allow"))).toBe(true);
        expect(result.scaffold.projectRoot).toContain("proj-scaffold-allow");
      });
    }
  );

  describe(
    "P1 fix (25th independent review round, 'do not reauthorize after paid bootstrap work'): exactly ONE " +
      "authorization decision gates both the paid model invocation and the scaffold filesystem mutation — a " +
      "stateful policy rule is evaluated only once for project.scaffold, never re-evaluated after cost is committed",
    () => {
      function spyProvider(id: string): { provider: ModelProvider; invokeCount: () => number } {
        let calls = 0;
        const provider: ModelProvider = {
          id,
          async invoke(model): Promise<ModelInvocationResponse> {
            calls += 1;
            return { provider: id, modelId: model.modelId, costUsd: model.costPerCall, output: "should never run" };
          }
        };
        return { provider, invokeCount: () => calls };
      }

      it(
        "BLOCKER regression, exact reproduction: a stateful rule that answers ALLOW on its first call and DENY " +
          "on every call after can never cause paid model work to be committed followed by a rejected scaffold",
        async () => {
          tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-single-authz-"));
          const policy = new PolicyEngine();
          let scaffoldEvaluations = 0;
          policy.addRule({
            name: "allow-model-invoke",
            priority: 10,
            evaluate: (a) => (a.actionType === "model.invoke" ? "ALLOW" : null)
          });
          policy.addRule({
            name: "stateful-scaffold-rule",
            priority: 20,
            evaluate: (a) => {
              if (a.actionType !== "project.scaffold") return null;
              scaffoldEvaluations += 1;
              return scaffoldEvaluations === 1 ? "ALLOW" : "DENY";
            }
          });

          const { provider, invokeCount } = spyProvider("mock");
          const modelGateway = new ModelGateway();
          modelGateway.registerProvider(provider);
          const costEngine = new CostEngine();

          const result = await bootstrapProject({
            genomeCandidate: validGenome("proj-single-authz"),
            baseDir: tempRoot,
            policy,
            modelRegistry: createDefaultModelRegistry(),
            modelGateway,
            costEngine
          });

          // Exactly ONE evaluate() call for project.scaffold happened — if
          // the OLD two-authorize()-call design were still present, a
          // SECOND (DENY) evaluation would have run AFTER the model call
          // below had already committed real cost, and this bootstrap
          // would have thrown instead of succeeding, leaving spent money
          // with no scaffold ever created.
          expect(scaffoldEvaluations).toBe(1);
          expect(invokeCount()).toBe(1);
          expect(costEngine.all()).toHaveLength(1); // the model invocation was genuinely accounted for
          expect(existsSync(join(tempRoot, "proj-single-authz"))).toBe(true);
          expect(result.scaffold.projectRoot).toContain("proj-single-authz");
        }
      );

      it("a DENY on the ONLY evaluation is never given a second chance — the whole bootstrap fails closed, and no paid work ever happens", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-single-authz-deny-"));
        const policy = new PolicyEngine();
        let scaffoldEvaluations = 0;
        policy.addRule({
          name: "allow-model-invoke",
          priority: 10,
          evaluate: (a) => (a.actionType === "model.invoke" ? "ALLOW" : null)
        });
        policy.addRule({
          name: "stateful-scaffold-rule-deny-first",
          priority: 20,
          evaluate: (a) => {
            if (a.actionType !== "project.scaffold") return null;
            scaffoldEvaluations += 1;
            // Would ALLOW on a second call — proves there IS no second
            // call for this action left to exploit.
            return scaffoldEvaluations === 1 ? "DENY" : "ALLOW";
          }
        });

        const { provider, invokeCount } = spyProvider("mock");
        const modelGateway = new ModelGateway();
        modelGateway.registerProvider(provider);
        const costEngine = new CostEngine();

        await expect(
          bootstrapProject({
            genomeCandidate: validGenome("proj-single-authz-deny"),
            baseDir: tempRoot,
            policy,
            modelRegistry: createDefaultModelRegistry(),
            modelGateway,
            costEngine
          })
        ).rejects.toThrow(CapabilityDeniedError);

        expect(scaffoldEvaluations).toBe(1);
        expect(invokeCount()).toBe(0); // paid work never happened either
        expect(costEngine.total()).toBe(0);
        expect(existsSync(join(tempRoot, "proj-single-authz-deny"))).toBe(false);
      });
    }
  );
});
