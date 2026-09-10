import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Mirrors orchestrator.ts's own `findRepoRoot()` — locates the REAL repo root from this test file's own location. */
function findRepoRootForTest(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error(`Could not locate repository root from ${startDir}`);
}
const REAL_REPO_ROOT = findRepoRootForTest(dirname(fileURLToPath(import.meta.url)));
const REAL_REQUIREMENTS_DIR = join(REAL_REPO_ROOT, "specification", "requirements");
import {
  bootstrapProject,
  computeScaffoldActionIdentityDigest,
  PreflightTraceabilityFailedError,
  type BootstrapProjectInput
} from "../orchestrator.js";
import { scaffoldProjectOs } from "../../project-os/scaffold.js";
import { PolicyEngine, lowRiskAllowRule } from "../../policy-engine/policy-engine.js";
import { CapabilityDeniedError, CapabilityApprovalRequiredError, ApprovalEvidenceMismatchError } from "../../capability-gateway/gateway.js";
import { ApprovalWorkflow } from "../../policy-engine/approval.js";
import { createDefaultModelRegistry, ModelRegistry } from "../../models/registry.js";
import { InvalidProjectGenomeError } from "../../project-genome/genome.js";
import { FileStateStore, type StateStore } from "../../state/file-store.js";
import { FileCache } from "../../cache/file-cache.js";
import { InvalidProjectIdError, PathEscapeError, assertWithinRoot } from "../../sandbox/sandbox.js";
import { CostEngine } from "../../cost/cost-engine.js";
import { BudgetExceededError, InvalidBudgetLimitError, type BudgetLimits } from "../../budget/budget.js";
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

  it(
    "refuses to bootstrap when the requirement registry it actually reads (a real, on-disk, deliberately " +
      "non-compliant fixture registry) has traceability issues — P1 fix (30th independent review round, " +
      "finding 8, 'preflight traceability must come from a trusted source'): a caller can no longer skip " +
      "this check by simply omitting/emptying a claimed-issues array, since bootstrapProject() now always " +
      "genuinely reads and evaluates a real registry on disk",
    async () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-"));
      const registryRoot = join(tempRoot, "fake-registry");
      const requirementsDir = join(registryRoot, "specification", "requirements");
      mkdirSync(requirementsDir, { recursive: true });
      // A genuine, on-disk requirement record claiming UNIT_TESTED with zero
      // evidence of any kind — a real traceability violation, not a
      // caller-fabricated claim. Schema-valid (32nd independent review
      // round, finding 4, "fail closed on empty or malformed requirement
      // registries" — the runtime loader now also enforces
      // schemas/requirement.schema.json, so this fixture must satisfy it
      // to exercise the TRACEABILITY check specifically, not the loader's
      // own malformed-registry rejection).
      writeFileSync(
        join(requirementsDir, "broken.yml"),
        [
          "- id: UASF-REQ-9001",
          "  title: Fixture requirement with no real evidence",
          "  description: Deliberately claims UNIT_TESTED with zero backing evidence.",
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
      const policy = new PolicyEngine();
      policy.addRule(lowRiskAllowRule(2));

      await expect(
        bootstrapProject({
          genomeCandidate: validGenome("proj-blocked"),
          baseDir: tempRoot,
          policy,
          modelRegistry: createDefaultModelRegistry(),
          requirementsRegistry: { requirementsDir, rootDir: registryRoot }
        })
      ).rejects.toThrow(PreflightTraceabilityFailedError);

      // The genome was never even validated, let alone scaffolded.
      expect(existsSync(join(tempRoot, "proj-blocked"))).toBe(false);
  });

  describe(
    "P1 fix (35th independent review round, finding 6, 'always preflight the Factory authoritative " +
      "requirement registry'): a caller-supplied requirementsRegistry can never REPLACE the check against " +
      "the Factory's OWN real registry — it can only add an ADDITIONAL one",
    () => {
      const fixtureFileName = "__round35-temporary-preflight-bypass-test-fixture.yml";
      const fixturePath = join(REAL_REQUIREMENTS_DIR, fixtureFileName);

      afterEach(() => {
        if (existsSync(fixturePath)) unlinkSync(fixturePath);
      });

      it(
        "BLOCKER regression, exact reproduction: the REAL authoritative registry has a genuine, unresolved " +
          "traceability blocker -> caller supplies a CLEAN, entirely separate override registry -> " +
          "bootstrap still FAILS, because the authoritative registry is checked unconditionally",
        async () => {
          // A genuine, on-disk, schema-valid record claiming UNIT_TESTED
          // with zero evidence, written directly into the Factory's OWN
          // real requirements directory (never a substitute location) —
          // this is exactly what the pre-fix code could be bypassed
          // around by supplying a clean `requirementsRegistry` override.
          writeFileSync(
            fixturePath,
            [
              "- id: UASF-REQ-99991",
              "  title: Round 35 temporary preflight-bypass regression fixture",
              "  description: Deliberately claims UNIT_TESTED with zero backing evidence; deleted in afterEach.",
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

          tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-"));
          const cleanRegistryRoot = join(tempRoot, "clean-registry");
          const cleanRequirementsDir = join(cleanRegistryRoot, "specification", "requirements");
          mkdirSync(cleanRequirementsDir, { recursive: true });
          // A genuinely CLEAN override — zero traceability issues of its own.
          writeFileSync(
            join(cleanRequirementsDir, "clean.yml"),
            [
              "- id: UASF-REQ-99981",
              "  title: Round 35 clean override fixture",
              "  description: A genuinely clean, fully-specified requirement with no evidence claim to violate.",
              "  source_baseline: 'BASELINE-V1 section 0 (test fixture)'",
              "  category: P0",
              "  priority: LOW",
              "  status: DEFINED",
              "  implementation_refs: []",
              "  test_refs: []",
              "  proof_refs: []",
              ""
            ].join("\n")
          );

          const policy = new PolicyEngine();
          policy.addRule(lowRiskAllowRule(2));

          await expect(
            bootstrapProject({
              genomeCandidate: validGenome("proj-authoritative-blocked"),
              baseDir: tempRoot,
              policy,
              modelRegistry: createDefaultModelRegistry(),
              requirementsRegistry: { requirementsDir: cleanRequirementsDir, rootDir: cleanRegistryRoot }
            })
          ).rejects.toThrow(PreflightTraceabilityFailedError);

          expect(existsSync(join(tempRoot, "proj-authoritative-blocked"))).toBe(false);
        }
      );

      it("no regression: when both the authoritative registry and a supplied override are clean, bootstrap proceeds", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-"));
        const cleanRegistryRoot = join(tempRoot, "clean-registry-2");
        const cleanRequirementsDir = join(cleanRegistryRoot, "specification", "requirements");
        mkdirSync(cleanRequirementsDir, { recursive: true });
        writeFileSync(
          join(cleanRequirementsDir, "clean.yml"),
          [
            "- id: UASF-REQ-99971",
            "  title: Round 35 clean override fixture 2",
            "  description: A genuinely clean, fully-specified requirement with no evidence claim to violate.",
            "  source_baseline: 'BASELINE-V1 section 0 (test fixture)'",
            "  category: P0",
            "  priority: LOW",
            "  status: DEFINED",
            "  implementation_refs: []",
            "  test_refs: []",
            "  proof_refs: []",
            ""
          ].join("\n")
        );

        const policy = new PolicyEngine();
        policy.addRule(lowRiskAllowRule(2));

        const result = await bootstrapProject({
          genomeCandidate: validGenome("proj-both-clean"),
          baseDir: tempRoot,
          policy,
          modelRegistry: createDefaultModelRegistry(),
          requirementsRegistry: { requirementsDir: cleanRequirementsDir, rootDir: cleanRegistryRoot }
        });
        expect(result.genome.project.id).toBe("proj-both-clean");
      });
    }
  );

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

    it(
      "P1 fix (35th independent review round, finding 8, 'validate all scaffold destinations before paid " +
        "model invocation'), BLOCKER regression, exact reproduction: one scaffold SUBdirectory ('security') " +
        "is a symlink escaping the project root -> bootstrap FAILS -> the paid provider is NEVER invoked " +
        "-> cost remains zero",
      async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-escape-"));
        const outside = mkdtempSync(join(tmpdir(), "uasf-orchestrator-escape-outside-"));
        const projectId = "proj-subdir-escape";
        const projectRoot = join(tempRoot, projectId);
        mkdirSync(projectRoot, { recursive: true });

        let symlinkSupported = true;
        try {
          symlinkSync(outside, join(projectRoot, "security"));
        } catch {
          symlinkSupported = false;
        }
        if (!symlinkSupported) {
          rmSync(outside, { recursive: true, force: true });
          return;
        }

        let invocationCount = 0;
        class CountingProvider implements ModelProvider {
          readonly id = "mock";
          async invoke(model: ModelRecord, _request: ModelInvocationRequest): Promise<ModelInvocationResponse> {
            invocationCount += 1;
            return { modelId: model.modelId, provider: model.provider, costUsd: model.costPerCall, output: "x" };
          }
        }
        const modelGateway = new ModelGateway();
        modelGateway.registerProvider(new CountingProvider());

        const policy = new PolicyEngine();
        policy.addRule(lowRiskAllowRule(2));

        await expect(
          bootstrapProject({
            genomeCandidate: validGenome(projectId),
            baseDir: tempRoot,
            policy,
            modelRegistry: createDefaultModelRegistry(),
            modelGateway
          })
        ).rejects.toThrow(PathEscapeError);

        // The paid model call never happened — cost stayed at exactly zero.
        expect(invocationCount).toBe(0);
        // Nothing was scaffolded into the real (symlinked-to) outside target.
        expect(readdirSync(outside)).toHaveLength(0);
        rmSync(outside, { recursive: true, force: true });
      }
    );

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

          // No PROJECT directory was ever created — the rejection happened
          // before any scaffold mutation. A durable compute-lease artifact
          // for the attempted (and released, per finding 4) invocation
          // claim may legitimately exist directly under tempRoot now (bkz.
          // finding 5's fix notu, "serialize bootstrapProject() transaction
          // claims" — orchestrator.ts's bootstrapTransactionCache), so this
          // no longer asserts the whole directory is empty.
          expect(existsSync(join(tempRoot, "proj-too-tight-budget"))).toBe(false);
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

          // bkz. yukarıdaki "too-tight-budget" testinin fix notu — a
          // released compute-lease artifact under tempRoot is now expected
          // (finding 5); the meaningful invariant is that no PROJECT
          // directory was ever created.
          expect(existsSync(join(tempRoot, "proj-unknown-provider"))).toBe(false);
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

          // bkz. "too-tight-budget" testinin fix notu — a released
          // compute-lease artifact under tempRoot is now expected (finding
          // 5); the meaningful invariant is that no PROJECT directory was
          // ever created.
          expect(existsSync(join(tempRoot, "proj-failing-provider"))).toBe(false);
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
    "P1 fix (30th independent review round, finding 4, 'do not use an ephemeral ledger for paid default " +
      "bootstraps'): a real, priced model invoked with no caller-supplied costEngine must be durably accounted",
    () => {
      it(
        "BLOCKER regression, exact reproduction: a paid bootstrap's spend survives a fresh CostEngine instance " +
          "pointed at the SAME baseDir (real restart proof, no costEngine ever supplied by the caller)",
        async () => {
          tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-durable-default-ledger-"));
          const policy = new PolicyEngine();
          policy.addRule(lowRiskAllowRule(2));
          const paidRegistry = new ModelRegistry();
          paidRegistry.register({
            provider: "mock",
            modelId: "paid-default-ledger",
            tier: "MOCK",
            costPerCall: 0.05,
            capabilities: ["summarization"],
            status: "ACTIVE"
          });

          const result = await bootstrapProject({
            genomeCandidate: validGenome("proj-durable-default-ledger"),
            baseDir: tempRoot,
            policy,
            modelRegistry: paidRegistry
            // Deliberately no `costEngine` — this is exactly the caller
            // mistake finding 4 describes: a real, priced model with no
            // durable ledger explicitly wired in.
          });
          expect(result.totalCostUsd).toBe(0.05);

          // A genuinely FRESH CostEngine, sharing nothing with the one
          // bootstrapProject() constructed internally, reading the SAME
          // baseDir-anchored ledger path — simulates a process restart.
          const restarted = new CostEngine(() => new Date(), {
            store: new FileStateStore(),
            path: join(tempRoot, "cost-ledger.json")
          });
          expect(restarted.totalFor({ projectId: "proj-durable-default-ledger" })).toBe(0.05);
        }
      );

      it("repeated bootstrap calls against the SAME baseDir share one durable ledger (spend accumulates, not resets)", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-durable-default-ledger-accumulate-"));
        const policy = new PolicyEngine();
        policy.addRule(lowRiskAllowRule(2));
        const paidRegistry = new ModelRegistry();
        paidRegistry.register({
          provider: "mock",
          modelId: "paid-default-ledger",
          tier: "MOCK",
          costPerCall: 0.05,
          capabilities: ["summarization"],
          status: "ACTIVE"
        });

        await bootstrapProject({
          genomeCandidate: validGenome("proj-durable-a"),
          baseDir: tempRoot,
          policy,
          modelRegistry: paidRegistry
        });
        await bootstrapProject({
          genomeCandidate: validGenome("proj-durable-b"),
          baseDir: tempRoot,
          policy,
          modelRegistry: paidRegistry
        });

        const ledger = new CostEngine(() => new Date(), {
          store: new FileStateStore(),
          path: join(tempRoot, "cost-ledger.json")
        });
        expect(ledger.total()).toBeCloseTo(0.1);
      });

      it("a $0 (mock/free) model keeps the exact prior in-memory-only default — no cost-ledger.json is created", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-free-model-no-ledger-"));
        const policy = new PolicyEngine();
        policy.addRule(lowRiskAllowRule(2));

        await bootstrapProject({
          genomeCandidate: validGenome("proj-free-no-ledger"),
          baseDir: tempRoot,
          policy,
          modelRegistry: createDefaultModelRegistry()
        });

        expect(existsSync(join(tempRoot, "cost-ledger.json"))).toBe(false);
      });
    }
  );

  describe(
    "P1 fix (37th independent review round, finding 5, 'durably persist real spend even when the STATIC " +
      "per-call cost estimate was zero'): the ephemeral/durable CostEngine choice must be driven by whether " +
      "the model is a KNOWN-free MOCK fixture, never by the registry's merely nominal `costPerCall` estimate " +
      "alone — a non-MOCK model advertising `costPerCall: 0` can still report a genuinely positive ACTUAL cost",
    () => {
      class PositiveActualCostProvider implements ModelProvider {
        readonly id = "custom-real";
        async invoke(model: ModelRecord, _request: ModelInvocationRequest): Promise<ModelInvocationResponse> {
          // The registry's own estimate for this model is exactly zero (see
          // registration below) — but the REAL invocation reports a
          // genuinely positive cost, exactly the divergence finding 5
          // describes ("the actual provider invocation can report a
          // positive real cost that would then be silently lost").
          return { modelId: model.modelId, provider: model.provider, costUsd: 0.12, output: "real-output" };
        }
      }

      it(
        "BLOCKER regression, exact reproduction: a non-MOCK model registered with a $0 estimate, whose provider " +
          "reports a positive ACTUAL cost, is durably recorded and survives a simulated restart",
        async () => {
          tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-zero-estimate-real-cost-"));
          const policy = new PolicyEngine();
          policy.addRule(lowRiskAllowRule(2));

          const zeroEstimateRegistry = new ModelRegistry();
          zeroEstimateRegistry.register({
            provider: "custom-real",
            modelId: "zero-estimate-real-cost",
            // Deliberately NOT "MOCK" — a real, non-test-only tier — with a
            // STATIC estimate of exactly zero. The old `costPerCall > 0`
            // predicate would have (wrongly) treated this as free and used
            // an in-memory-only CostEngine, silently losing the real spend.
            tier: "STANDARD",
            costPerCall: 0,
            capabilities: ["summarization"],
            status: "ACTIVE"
          });
          const modelGateway = new ModelGateway();
          modelGateway.registerProvider(new PositiveActualCostProvider());

          const result = await bootstrapProject({
            genomeCandidate: validGenome("proj-zero-estimate-real-cost"),
            baseDir: tempRoot,
            policy,
            modelRegistry: zeroEstimateRegistry,
            modelGateway
            // Deliberately no `costEngine` — the durable-vs-ephemeral choice
            // must be made internally, exactly as finding 5 describes.
          });
          expect(result.totalCostUsd).toBe(0.12);

          // A genuinely FRESH CostEngine, sharing nothing with the one
          // bootstrapProject() constructed internally, reading the SAME
          // baseDir-anchored ledger path — simulates a process restart.
          const restarted = new CostEngine(() => new Date(), {
            store: new FileStateStore(),
            path: join(tempRoot, "cost-ledger.json")
          });
          expect(restarted.totalFor({ projectId: "proj-zero-estimate-real-cost" })).toBe(0.12);
        }
      );

      it(
        "no-regression: a genuinely free MOCK-tier fixture (tier 'MOCK' AND costPerCall 0) keeps the exact " +
          "prior in-memory-only ephemeral default — no cost-ledger.json is created",
        async () => {
          tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-known-free-mock-still-ephemeral-"));
          const policy = new PolicyEngine();
          policy.addRule(lowRiskAllowRule(2));

          await bootstrapProject({
            genomeCandidate: validGenome("proj-known-free-mock"),
            baseDir: tempRoot,
            policy,
            modelRegistry: createDefaultModelRegistry()
          });

          expect(existsSync(join(tempRoot, "cost-ledger.json"))).toBe(false);
        }
      );
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
          // ...but the REJECTED call left NO PROJECT TREE behind at all —
          // proving the budget reservation was checked and enforced BEFORE
          // any filesystem mutation, not merely before an eventual,
          // too-late spend() call. (A released compute-lease artifact
          // under rootB is now an expected byproduct of finding 5's fix —
          // bkz. the "too-tight-budget" testinin fix notu — so this no
          // longer asserts rootB is completely empty.)
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

        // bkz. "too-tight-budget" testinin fix notu — a released
        // compute-lease artifact under tempRoot is now expected (finding
        // 5); the meaningful invariant is that no PROJECT directory was
        // ever created.
        expect(existsSync(join(tempRoot, "proj-reserve-sequential"))).toBe(false);
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
    "P1 fix (27th independent review round, finding 10, 'provide a real approval path for risk-5 bootstrap')",
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

      it("BLOCKER regression: a risk-5 bootstrap with a genuine, exact-identity-matching APPROVED request succeeds exactly once", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-risk5-approved-"));
        const policy = new PolicyEngine();
        policy.addRule({ name: "allow-model-invoke", priority: 10, evaluate: (a) => (a.actionType === "model.invoke" ? "ALLOW" : null) });

        const { provider, invokeCount } = spyProvider("mock");
        const modelGateway = new ModelGateway();
        modelGateway.registerProvider(provider);
        const costEngine = new CostEngine();

        const projectId = "proj-risk5-approved";
        const approvals = new ApprovalWorkflow();
        const approvalId = "approval-risk5-1";
        approvals.requestFor(approvalId, {
          actionType: "project.scaffold",
          risk: 5,
          description: `Scaffold Project OS for '${projectId}'`,
          projectId,
          identityDigest: computeScaffoldActionIdentityDigest({ projectId, projectRoot: join(tempRoot, projectId) })
        });
        approvals.approve(approvalId, "founder@example.com");

        const result = await bootstrapProject({
          genomeCandidate: validGenome(projectId),
          baseDir: tempRoot,
          policy,
          modelRegistry: createDefaultModelRegistry(),
          modelGateway,
          costEngine,
          risk: 5,
          approvals,
          approvalId
        });

        expect(invokeCount()).toBe(1);
        expect(existsSync(join(tempRoot, projectId))).toBe(true);
        expect(result.scaffold.projectRoot).toContain(projectId);
        // Approval evidence is genuinely consumed exactly once — status is
        // now EXECUTED, not merely APPROVED (bkz. round 27 finding 5's
        // beginExecution()/completeExecution() lifecycle).
        expect(approvals.get(approvalId)?.status).toBe("EXECUTED");

        // A second bootstrap attempt reusing the SAME (now-EXECUTED)
        // approval id must NOT be able to authorize another scaffold —
        // replay protection holds across the orchestrator boundary too.
        await expect(
          bootstrapProject({
            genomeCandidate: validGenome(projectId),
            baseDir: tempRoot,
            policy,
            modelRegistry: createDefaultModelRegistry(),
            modelGateway,
            costEngine,
            risk: 5,
            approvals,
            approvalId
          })
        ).rejects.toThrow();
      });

      it("a PENDING (not yet decided) approval id still blocks the bootstrap", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-risk5-pending-"));
        const policy = new PolicyEngine();
        const { provider, invokeCount } = spyProvider("mock");
        const modelGateway = new ModelGateway();
        modelGateway.registerProvider(provider);

        const projectId = "proj-risk5-pending";
        const approvals = new ApprovalWorkflow();
        const approvalId = "approval-risk5-pending";
        approvals.requestFor(approvalId, {
          actionType: "project.scaffold",
          risk: 5,
          description: `Scaffold Project OS for '${projectId}'`,
          projectId
        });
        // deliberately never approved

        await expect(
          bootstrapProject({
            genomeCandidate: validGenome(projectId),
            baseDir: tempRoot,
            policy,
            modelRegistry: createDefaultModelRegistry(),
            modelGateway,
            risk: 5,
            approvals,
            approvalId
          })
        ).rejects.toThrow();

        expect(invokeCount()).toBe(0);
        expect(existsSync(join(tempRoot, projectId))).toBe(false);
      });

      it("a REJECTED approval still blocks the bootstrap", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-risk5-rejected-"));
        const policy = new PolicyEngine();
        const projectId = "proj-risk5-rejected";
        const approvals = new ApprovalWorkflow();
        const approvalId = "approval-risk5-rejected";
        approvals.requestFor(approvalId, {
          actionType: "project.scaffold",
          risk: 5,
          description: `Scaffold Project OS for '${projectId}'`,
          projectId
        });
        approvals.reject(approvalId, "founder@example.com");

        await expect(
          bootstrapProject({
            genomeCandidate: validGenome(projectId),
            baseDir: tempRoot,
            policy,
            modelRegistry: createDefaultModelRegistry(),
            risk: 5,
            approvals,
            approvalId
          })
        ).rejects.toThrow();

        expect(existsSync(join(tempRoot, projectId))).toBe(false);
      });

      it("a REQUEST_CHANGES approval still blocks the bootstrap", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-risk5-changes-"));
        const policy = new PolicyEngine();
        const projectId = "proj-risk5-changes";
        const approvals = new ApprovalWorkflow();
        const approvalId = "approval-risk5-changes";
        approvals.requestFor(approvalId, {
          actionType: "project.scaffold",
          risk: 5,
          description: `Scaffold Project OS for '${projectId}'`,
          projectId
        });
        approvals.requestChanges(approvalId, "founder@example.com", "need a smaller blast radius first");

        await expect(
          bootstrapProject({
            genomeCandidate: validGenome(projectId),
            baseDir: tempRoot,
            policy,
            modelRegistry: createDefaultModelRegistry(),
            risk: 5,
            approvals,
            approvalId
          })
        ).rejects.toThrow();

        expect(existsSync(join(tempRoot, projectId))).toBe(false);
      });

      it("omitting approvals/approvalId still unconditionally blocks a risk-5 bootstrap (default-deny preserved — this is the OLD safe behavior, not a regression)", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-risk5-no-approvals-"));
        const policy = new PolicyEngine();
        const projectId = "proj-risk5-no-approvals";

        await expect(
          bootstrapProject({
            genomeCandidate: validGenome(projectId),
            baseDir: tempRoot,
            policy,
            modelRegistry: createDefaultModelRegistry(),
            risk: 5
          })
        ).rejects.toThrow(CapabilityApprovalRequiredError);

        expect(existsSync(join(tempRoot, projectId))).toBe(false);
      });

      it("a caller-forged, LOCAL ApprovalWorkflow (never wired into BootstrapProjectInput.approvals) cannot smuggle approval — the exact failure mode this finding fixes", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-risk5-forged-workflow-"));
        const policy = new PolicyEngine();
        const projectId = "proj-risk5-forged";

        // A caller creates their OWN local workflow, approves a matching
        // request on it, but never passes it as `approvals` — simulating
        // an attempt to reuse pre-27th-round call sites that had no way to
        // wire in a real approval store. This must still fail: the
        // orchestrator's internal gateway must use ITS OWN (here: the
        // default, empty) approval store, never one merely constructed
        // and approved by the caller off to the side. Because an
        // `approvalId` IS supplied, the gateway looks it up in its own
        // (empty) store and finds no such request — a genuine
        // `ApprovalEvidenceMismatchError`, not the "no reference supplied
        // at all" `CapabilityApprovalRequiredError` — but the bootstrap is
        // blocked either way, which is the only thing that matters here.
        const forgedApprovals = new ApprovalWorkflow();
        const forgedId = "forged-approval";
        forgedApprovals.requestFor(forgedId, {
          actionType: "project.scaffold",
          risk: 5,
          description: `Scaffold Project OS for '${projectId}'`,
          projectId
        });
        forgedApprovals.approve(forgedId, "attacker@example.com");

        await expect(
          bootstrapProject({
            genomeCandidate: validGenome(projectId),
            baseDir: tempRoot,
            policy,
            modelRegistry: createDefaultModelRegistry(),
            risk: 5,
            approvalId: forgedId
            // note: `approvals: forgedApprovals` deliberately NOT passed
          })
        ).rejects.toThrow(ApprovalEvidenceMismatchError);

        expect(existsSync(join(tempRoot, projectId))).toBe(false);
      });

      it("an approval whose recorded identity does not exactly match the scaffold action (wrong projectId) cannot authorize a different project's bootstrap", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-risk5-mismatch-"));
        const policy = new PolicyEngine();
        const approvals = new ApprovalWorkflow();
        const approvalId = "approval-for-other-project";
        approvals.requestFor(approvalId, {
          actionType: "project.scaffold",
          risk: 5,
          description: "Scaffold Project OS for 'some-other-project'",
          projectId: "some-other-project"
        });
        approvals.approve(approvalId, "founder@example.com");

        const projectId = "proj-risk5-mismatched-target";
        await expect(
          bootstrapProject({
            genomeCandidate: validGenome(projectId),
            baseDir: tempRoot,
            policy,
            modelRegistry: createDefaultModelRegistry(),
            risk: 5,
            approvals,
            approvalId
          })
        ).rejects.toThrow();

        expect(existsSync(join(tempRoot, projectId))).toBe(false);
      });
    }
  );

  describe(
    "P1 fix (independent Codex review, 'bind scaffold approval to the destination root'): an approval " +
      "genuinely requested and APPROVED for a project under one canonical destination root must not authorize " +
      "the SAME project being scaffolded under a DIFFERENT, caller-selected destination root",
    () => {
      it(
        "BLOCKER regression, exact reproduction: approve scaffold under canonical root A, then retry using " +
          "root B with the identical project/action metadata (approvalId, projectId, description, risk) — " +
          "exact approval matching FAILS",
        async () => {
          const tempRootA = mkdtempSync(join(tmpdir(), "uasf-orchestrator-scaffold-root-a-"));
          const tempRootB = mkdtempSync(join(tmpdir(), "uasf-orchestrator-scaffold-root-b-"));
          try {
            const policy = new PolicyEngine();
            policy.addRule({
              name: "allow-model-invoke",
              priority: 10,
              evaluate: (a) => (a.actionType === "model.invoke" ? "ALLOW" : null)
            });
            const projectId = "proj-cross-root-replay";
            const approvals = new ApprovalWorkflow();
            const approvalId = "approval-cross-root-replay";
            // Requested (and approved) with an identity digest bound to
            // root A's canonical destination — exactly what a genuine,
            // honest approval request for THIS bootstrap would compute.
            approvals.requestFor(approvalId, {
              actionType: "project.scaffold",
              risk: 5,
              description: `Scaffold Project OS for '${projectId}'`,
              projectId,
              identityDigest: computeScaffoldActionIdentityDigest({
                projectId,
                projectRoot: join(tempRootA, projectId)
              })
            });
            approvals.approve(approvalId, "founder@example.com");

            // Bootstrapping under root A (the root the approval was
            // genuinely requested for) succeeds.
            await bootstrapProject({
              genomeCandidate: validGenome(projectId),
              baseDir: tempRootA,
              policy,
              modelRegistry: createDefaultModelRegistry(),
              risk: 5,
              approvals,
              approvalId
            });
            expect(existsSync(join(tempRootA, projectId))).toBe(true);

            // Replaying the SAME approvalId/projectId/description/risk —
            // every field `isBoundToExactAction()` used to compare before
            // this fix — but targeting a COMPLETELY DIFFERENT destination
            // root B must NOT be authorized by that same approval. (The
            // approval is already EXECUTED from the call above, which
            // alone would also block a replay — a fresh, never-consumed
            // approval for root A is used below to isolate THIS finding's
            // exact mechanism: identity mismatch, not mere replay.)
            const freshApprovalId = "approval-cross-root-replay-fresh";
            approvals.requestFor(freshApprovalId, {
              actionType: "project.scaffold",
              risk: 5,
              description: `Scaffold Project OS for '${projectId}'`,
              projectId,
              identityDigest: computeScaffoldActionIdentityDigest({
                projectId,
                projectRoot: join(tempRootA, projectId)
              })
            });
            approvals.approve(freshApprovalId, "founder@example.com");

            await expect(
              bootstrapProject({
                genomeCandidate: validGenome(projectId),
                baseDir: tempRootB,
                policy,
                modelRegistry: createDefaultModelRegistry(),
                risk: 5,
                approvals,
                approvalId: freshApprovalId
              })
            ).rejects.toThrow(ApprovalEvidenceMismatchError);

            expect(existsSync(join(tempRootB, projectId))).toBe(false);
          } finally {
            rmSync(tempRootA, { recursive: true, force: true });
            rmSync(tempRootB, { recursive: true, force: true });
          }
        }
      );

      it("no-regression: an approval genuinely requested for the SAME canonical destination root the bootstrap actually uses still succeeds", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-scaffold-root-match-"));
        const policy = new PolicyEngine();
        policy.addRule({
          name: "allow-model-invoke",
          priority: 10,
          evaluate: (a) => (a.actionType === "model.invoke" ? "ALLOW" : null)
        });
        const projectId = "proj-same-root-match";
        const approvals = new ApprovalWorkflow();
        const approvalId = "approval-same-root-match";
        approvals.requestFor(approvalId, {
          actionType: "project.scaffold",
          risk: 5,
          description: `Scaffold Project OS for '${projectId}'`,
          projectId,
          identityDigest: computeScaffoldActionIdentityDigest({ projectId, projectRoot: join(tempRoot, projectId) })
        });
        approvals.approve(approvalId, "founder@example.com");

        await bootstrapProject({
          genomeCandidate: validGenome(projectId),
          baseDir: tempRoot,
          policy,
          modelRegistry: createDefaultModelRegistry(),
          risk: 5,
          approvals,
          approvalId
        });

        expect(existsSync(join(tempRoot, projectId))).toBe(true);
        expect(approvals.get(approvalId)?.status).toBe("EXECUTED");
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

  describe(
    "P1 fix (31st independent review round, finding 3, 'keep all bootstrap writes inside the authorized " +
      "execution'): a protected write (genome/organization/bootstrap-state) failing must never leave a " +
      "risk-5 approval falsely claiming a successful execution",
    () => {
      it(
        "BLOCKER regression, exact reproduction: approved risk-5 bootstrap, force one StateStore.write() " +
          "failure -> operation fails -> approval does NOT remain successful -> failure evidence is " +
          "recorded -> the scaffold was genuinely created (a real filesystem mutation DID happen) but the " +
          "genome.json write never landed",
        async () => {
          tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-risk5-write-failure-"));
          const policy = new PolicyEngine();
          policy.addRule({
            name: "allow-model-invoke",
            priority: 10,
            evaluate: (a) => (a.actionType === "model.invoke" ? "ALLOW" : null)
          });

          const modelGateway = new ModelGateway();
          modelGateway.registerProvider(new MockProvider());
          const costEngine = new CostEngine();

          const projectId = "proj-risk5-write-failure";
          const approvals = new ApprovalWorkflow();
          const approvalId = "approval-risk5-write-failure";
          approvals.requestFor(approvalId, {
            actionType: "project.scaffold",
            risk: 5,
            description: `Scaffold Project OS for '${projectId}'`,
            projectId,
            identityDigest: computeScaffoldActionIdentityDigest({ projectId, projectRoot: join(tempRoot, projectId) })
          });
          approvals.approve(approvalId, "founder@example.com");

          // Delegates to a REAL FileStateStore for every write except the
          // genome.json one, which it deliberately fails — simulating a
          // genuine durable-storage I/O error on ONE of the three protected
          // writes this function performs after scaffolding.
          const realStore = new FileStateStore();
          const genomeWritePath = join("project-genome", "genome.json");
          const failingStore: StateStore = {
            write: (path, data) => {
              if (path.endsWith(genomeWritePath)) {
                throw new Error("simulated durable-storage write failure");
              }
              realStore.write(path, data);
            },
            read: (path) => realStore.read(path),
            exists: (path) => realStore.exists(path)
          };

          await expect(
            bootstrapProject({
              genomeCandidate: validGenome(projectId),
              baseDir: tempRoot,
              policy,
              modelRegistry: createDefaultModelRegistry(),
              modelGateway,
              costEngine,
              stateStore: failingStore,
              risk: 5,
              approvals,
              approvalId
            })
          ).rejects.toThrow("simulated durable-storage write failure");

          // The approval must be an honest EXECUTION_FAILED record, never
          // EXECUTED — this is the crux of the finding.
          expect(approvals.get(approvalId)?.status).toBe("EXECUTION_FAILED");
          expect(approvals.get(approvalId)?.status).not.toBe("EXECUTED");

          // The scaffold's directories (a real filesystem mutation made
          // INSIDE the same execute() callback, before the failing write)
          // did genuinely happen — this finding does not ask for full
          // transactional rollback of the scaffold itself, only that the
          // APPROVAL's own state stay honest about what succeeded.
          expect(existsSync(join(tempRoot, projectId))).toBe(true);
          // But the genome.json write that failed never landed.
          expect(existsSync(join(tempRoot, projectId, "project-genome", "genome.json"))).toBe(false);

          // A retry with a genuinely working store must be rejected too —
          // EXECUTION_FAILED is terminal, exactly like EXECUTED/REJECTED —
          // proving this isn't a silently-retryable half-state.
          await expect(
            bootstrapProject({
              genomeCandidate: validGenome(projectId),
              baseDir: tempRoot,
              policy,
              modelRegistry: createDefaultModelRegistry(),
              modelGateway,
              costEngine,
              risk: 5,
              approvals,
              approvalId
            })
          ).rejects.toThrow();
        }
      );

      it("no regression: when every write succeeds, the approval genuinely reaches EXECUTED and all three protected writes land", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-risk5-write-success-"));
        const policy = new PolicyEngine();
        policy.addRule({
          name: "allow-model-invoke",
          priority: 10,
          evaluate: (a) => (a.actionType === "model.invoke" ? "ALLOW" : null)
        });

        const modelGateway = new ModelGateway();
        modelGateway.registerProvider(new MockProvider());
        const costEngine = new CostEngine();

        const projectId = "proj-risk5-write-success";
        const approvals = new ApprovalWorkflow();
        const approvalId = "approval-risk5-write-success";
        approvals.requestFor(approvalId, {
          actionType: "project.scaffold",
          risk: 5,
          description: `Scaffold Project OS for '${projectId}'`,
          projectId,
          identityDigest: computeScaffoldActionIdentityDigest({ projectId, projectRoot: join(tempRoot, projectId) })
        });
        approvals.approve(approvalId, "founder@example.com");

        const result = await bootstrapProject({
          genomeCandidate: validGenome(projectId),
          baseDir: tempRoot,
          policy,
          modelRegistry: createDefaultModelRegistry(),
          modelGateway,
          costEngine,
          risk: 5,
          approvals,
          approvalId
        });

        expect(approvals.get(approvalId)?.status).toBe("EXECUTED");
        expect(existsSync(join(tempRoot, projectId, "project-genome", "genome.json"))).toBe(true);
        expect(existsSync(join(tempRoot, projectId, "organization", "organization.json"))).toBe(true);
        expect(existsSync(result.statePath)).toBe(true);
      });
    }
  );

  describe(
    "P1 fix (32nd independent review round, finding 8, 'persist the actual policy outcome'): the durable " +
      "bootstrap record must never rewrite a genuine APPROVAL_REQUIRED-then-approved decision into ALLOW",
    () => {
      it(
        "BLOCKER regression, exact reproduction: a risk-5 approved bootstrap persists policyDecision " +
          "APPROVAL_REQUIRED (never ALLOW), with separate, truthful approval evidence and a success outcome",
        async () => {
          tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-policy-outcome-"));
          const policy = new PolicyEngine();
          policy.addRule({
            name: "allow-model-invoke",
            priority: 10,
            evaluate: (a) => (a.actionType === "model.invoke" ? "ALLOW" : null)
          });

          const modelGateway = new ModelGateway();
          modelGateway.registerProvider(new MockProvider());
          const costEngine = new CostEngine();

          const projectId = "proj-policy-outcome";
          const approvals = new ApprovalWorkflow();
          const approvalId = "approval-policy-outcome";
          approvals.requestFor(approvalId, {
            actionType: "project.scaffold",
            risk: 5,
            description: `Scaffold Project OS for '${projectId}'`,
            projectId,
            identityDigest: computeScaffoldActionIdentityDigest({ projectId, projectRoot: join(tempRoot, projectId) })
          });
          approvals.approve(approvalId, "founder@example.com");

          const result = await bootstrapProject({
            genomeCandidate: validGenome(projectId),
            baseDir: tempRoot,
            policy,
            modelRegistry: createDefaultModelRegistry(),
            modelGateway,
            costEngine,
            risk: 5,
            approvals,
            approvalId
          });

          const freshStore = new FileStateStore();
          const persistedState = freshStore.read<{
            policyDecision: string;
            approval: { required: boolean; approvalId?: string; consumed?: boolean };
            executionOutcome: string;
          }>(result.statePath);

          expect(persistedState?.policyDecision).toBe("APPROVAL_REQUIRED");
          expect(persistedState?.policyDecision).not.toBe("ALLOW");
          expect(persistedState?.approval).toEqual({ required: true, approvalId, consumed: true });
          expect(persistedState?.executionOutcome).toBe("SUCCESS");
        }
      );

      it("no regression: a genuinely low-risk (ALLOW) bootstrap still persists policyDecision ALLOW with approval.required false", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-policy-outcome-allow-"));
        const policy = new PolicyEngine();
        policy.addRule(lowRiskAllowRule(2));

        const result = await bootstrapProject({
          genomeCandidate: validGenome("proj-allow-outcome"),
          baseDir: tempRoot,
          policy,
          modelRegistry: createDefaultModelRegistry()
        });

        const freshStore = new FileStateStore();
        const persistedState = freshStore.read<{
          policyDecision: string;
          approval: { required: boolean };
          executionOutcome: string;
        }>(result.statePath);

        expect(persistedState?.policyDecision).toBe("ALLOW");
        expect(persistedState?.approval).toEqual({ required: false });
        expect(persistedState?.executionOutcome).toBe("SUCCESS");
      });
    }
  );

  describe(
    "P1 fix (independent review, finding 8, 'completed paid work lacking a durable checkpoint'): a crash " +
      "between the paid model invocation succeeding and bootstrap finishing must not cause a retry to pay for " +
      "(or invoke) the model a second time",
    () => {
      function gatewayWithCountingProvider(id: string, costUsd: number): { gateway: ModelGateway; invocationCount: () => number } {
        let count = 0;
        const provider: ModelProvider = {
          id,
          async invoke(model: ModelRecord, request: ModelInvocationRequest): Promise<ModelInvocationResponse> {
            count++;
            return { modelId: model.modelId, provider: id, costUsd, output: request.prompt };
          }
        };
        const gateway = new ModelGateway();
        gateway.registerProvider(provider);
        return { gateway, invocationCount: () => count };
      }

      it(
        "BLOCKER regression, exact reproduction: interrupting bootstrap AFTER the paid invocation completes but " +
          "BEFORE scaffolding finishes, then retrying against the SAME baseDir, invokes the model exactly ONCE " +
          "and records exactly ONE charge — not two",
        async () => {
          tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-bootstrap-retry-"));
          const policy = new PolicyEngine();
          policy.addRule(lowRiskAllowRule(2));
          const registry = new ModelRegistry();
          registry.register({
            provider: "counting",
            modelId: "counting-summarizer",
            tier: "MOCK",
            costPerCall: 0.6,
            capabilities: ["summarization"],
            status: "ACTIVE"
          });
          const { gateway: modelGateway, invocationCount } = gatewayWithCountingProvider("counting", 0.6);
          const projectId = "proj-bootstrap-retry";

          // Simulate "crash after the paid call, before scaffolding
          // finishes": a plain FILE pre-placed where scaffoldProjectOs()
          // needs to create the "state" subdirectory makes its mkdirSync
          // throw — AFTER modelGateway.invoke() (inside the SAME execute
          // callback) has already run and been billed.
          mkdirSync(join(tempRoot, projectId), { recursive: true });
          writeFileSync(join(tempRoot, projectId, "state"), "not a directory");

          await expect(
            bootstrapProject({
              genomeCandidate: validGenome(projectId),
              baseDir: tempRoot,
              policy,
              modelRegistry: registry,
              modelGateway,
              budgetLimits: { perTaskUsd: 10 }
            })
          ).rejects.toThrow();

          expect(invocationCount()).toBe(1);
          // P1 fix (independent review, finding 5, "serialize
          // bootstrapProject() transaction claims"): the per-project
          // checkpoint file (one JSON file per project) is superseded by a
          // single, shared durable FileCache — bkz.
          // orchestrator.ts's `bootstrapTransactionCache`'in fix notu —
          // keyed by projectId, at ONE shared path under baseDir.
          const transactionsPath = join(tempRoot, "bootstrap-transactions.json");
          expect(existsSync(transactionsPath)).toBe(true);
          const transactionCache = new FileCache<{ costUsd: number }>(new FileStateStore(), transactionsPath);
          const persistedInvocation = transactionCache.get(projectId);
          expect(persistedInvocation).toBeDefined();
          expect(persistedInvocation?.costUsd).toBe(0.6);

          // "Restart": whatever crashed is fixed, then bootstrap is retried
          // against the SAME baseDir/projectId.
          unlinkSync(join(tempRoot, projectId, "state"));

          const result = await bootstrapProject({
            genomeCandidate: validGenome(projectId),
            baseDir: tempRoot,
            policy,
            modelRegistry: registry,
            modelGateway,
            budgetLimits: { perTaskUsd: 10 }
          });

          // The model was NOT invoked a second time...
          expect(invocationCount()).toBe(1);
          // ...and total recorded cost is still exactly the ONE real charge —
          // not $1.20 (0.6 x 2) as the unfixed defect reproduced.
          expect(result.totalCostUsd).toBe(0.6);
          expect(existsSync(join(result.scaffold.projectRoot, "project-genome", "genome.json"))).toBe(true);
          expect(existsSync(join(result.scaffold.projectRoot, "organization", "organization.json"))).toBe(true);
          expect(existsSync(result.statePath)).toBe(true);
        }
      );

      it(
        "no regression: a bootstrap that completes successfully on its FIRST attempt (no crash/retry) invokes " +
          "the model exactly once and records exactly one charge, exactly as before this fix",
        async () => {
          tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-bootstrap-no-retry-"));
          const policy = new PolicyEngine();
          policy.addRule(lowRiskAllowRule(2));
          const registry = new ModelRegistry();
          registry.register({
            provider: "counting",
            modelId: "counting-summarizer",
            tier: "MOCK",
            costPerCall: 0.6,
            capabilities: ["summarization"],
            status: "ACTIVE"
          });
          const { gateway: modelGateway, invocationCount } = gatewayWithCountingProvider("counting", 0.6);

          const result = await bootstrapProject({
            genomeCandidate: validGenome("proj-bootstrap-no-retry"),
            baseDir: tempRoot,
            policy,
            modelRegistry: registry,
            modelGateway,
            budgetLimits: { perTaskUsd: 10 }
          });

          expect(invocationCount()).toBe(1);
          expect(result.totalCostUsd).toBe(0.6);
        }
      );

      it(
        "a SECOND, independent project (different projectId) under the same baseDir gets its OWN transaction " +
          "record and its OWN genuine invocation — one project's checkpoint never short-circuits another's",
        async () => {
          tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-bootstrap-retry-multi-"));
          const policy = new PolicyEngine();
          policy.addRule(lowRiskAllowRule(2));
          const registry = new ModelRegistry();
          registry.register({
            provider: "counting",
            modelId: "counting-summarizer",
            tier: "MOCK",
            costPerCall: 0.6,
            capabilities: ["summarization"],
            status: "ACTIVE"
          });
          const { gateway: modelGateway, invocationCount } = gatewayWithCountingProvider("counting", 0.6);

          await bootstrapProject({
            genomeCandidate: validGenome("proj-multi-a"),
            baseDir: tempRoot,
            policy,
            modelRegistry: registry,
            modelGateway,
            budgetLimits: { perTaskUsd: 10 }
          });
          expect(invocationCount()).toBe(1);

          const resultB = await bootstrapProject({
            genomeCandidate: validGenome("proj-multi-b"),
            baseDir: tempRoot,
            policy,
            modelRegistry: registry,
            modelGateway,
            budgetLimits: { perTaskUsd: 10 }
          });

          // A distinct project genuinely invokes the model again — its own
          // transaction record is keyed separately by its own projectId.
          expect(invocationCount()).toBe(2);
          expect(resultB.totalCostUsd).toBe(0.6);
        }
      );
    }
  );

  describe(
    "P1 fix (independent review, finding 5, 'serialize bootstrapProject() transaction claims'): two genuinely " +
      "CONCURRENT bootstrapProject() calls for the SAME project must never both invoke (and pay for) the model",
    () => {
      it(
        "BLOCKER regression, exact reproduction: two concurrent bootstrapProject() calls for the SAME project, " +
          "with a compute delay long enough for both to genuinely contend -> the provider is invoked exactly " +
          "ONCE, cost is recorded exactly once, and both calls resolve successfully to the same real cost",
        async () => {
          tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-bootstrap-concurrent-claim-"));
          const policy = new PolicyEngine();
          policy.addRule(lowRiskAllowRule(2));
          const registry = new ModelRegistry();
          registry.register({
            provider: "counting-delayed",
            modelId: "counting-summarizer",
            tier: "MOCK",
            costPerCall: 0.6,
            capabilities: ["summarization"],
            status: "ACTIVE"
          });

          let invocationCount = 0;
          const provider: ModelProvider = {
            id: "counting-delayed",
            async invoke(model: ModelRecord, request: ModelInvocationRequest): Promise<ModelInvocationResponse> {
              invocationCount++;
              // Long enough that BOTH concurrent calls' own synchronous
              // prefixes (through claiming/observing the transaction
              // lease) have genuinely run before either compute()
              // resolves — without finding 5's fix, both calls' plain
              // read-then-write checkpoint check would independently see
              // "no checkpoint yet" and both reach this line.
              await new Promise((resolve) => setTimeout(resolve, 150));
              return { modelId: model.modelId, provider: "counting-delayed", costUsd: 0.6, output: request.prompt };
            }
          };
          const modelGateway = new ModelGateway();
          modelGateway.registerProvider(provider);

          const projectId = "proj-concurrent-claim";
          const makeInput = (): BootstrapProjectInput => ({
            genomeCandidate: validGenome(projectId),
            baseDir: tempRoot,
            policy,
            modelRegistry: registry,
            modelGateway,
            budgetLimits: { perTaskUsd: 10 }
          });

          // Issued back-to-back, synchronously, with NEITHER awaited yet —
          // both calls genuinely contend for the SAME project's
          // transaction claim (same pattern as the existing concurrent-
          // budgetLimits/reserve-race tests elsewhere in this file).
          const [resultA, resultB] = await Promise.all([bootstrapProject(makeInput()), bootstrapProject(makeInput())]);

          expect(invocationCount).toBe(1);
          expect(resultA.totalCostUsd).toBe(0.6);
          expect(resultB.totalCostUsd).toBe(0.6);
          expect(existsSync(join(tempRoot, projectId, "project-genome", "genome.json"))).toBe(true);
        },
        10_000
      );

      it(
        "no-regression: two concurrent bootstrapProject() calls for TWO DIFFERENT projects both genuinely " +
          "invoke the model — one project's transaction claim never blocks an unrelated project's",
        async () => {
          tempRoot = mkdtempSync(join(tmpdir(), "uasf-orchestrator-bootstrap-concurrent-distinct-"));
          const policy = new PolicyEngine();
          policy.addRule(lowRiskAllowRule(2));
          const registry = new ModelRegistry();
          registry.register({
            provider: "counting-parallel",
            modelId: "counting-summarizer",
            tier: "MOCK",
            costPerCall: 0.6,
            capabilities: ["summarization"],
            status: "ACTIVE"
          });

          let invocationCount = 0;
          const provider: ModelProvider = {
            id: "counting-parallel",
            async invoke(model: ModelRecord, request: ModelInvocationRequest): Promise<ModelInvocationResponse> {
              invocationCount++;
              await new Promise((resolve) => setTimeout(resolve, 50));
              return { modelId: model.modelId, provider: "counting-parallel", costUsd: 0.6, output: request.prompt };
            }
          };
          const modelGateway = new ModelGateway();
          modelGateway.registerProvider(provider);

          const [resultA, resultB] = await Promise.all([
            bootstrapProject({
              genomeCandidate: validGenome("proj-parallel-a"),
              baseDir: tempRoot,
              policy,
              modelRegistry: registry,
              modelGateway,
              budgetLimits: { perTaskUsd: 10 }
            }),
            bootstrapProject({
              genomeCandidate: validGenome("proj-parallel-b"),
              baseDir: tempRoot,
              policy,
              modelRegistry: registry,
              modelGateway,
              budgetLimits: { perTaskUsd: 10 }
            })
          ]);

          expect(invocationCount).toBe(2);
          expect(resultA.totalCostUsd).toBe(0.6);
          expect(resultB.totalCostUsd).toBe(0.6);
        },
        10_000
      );
    }
  );
});
