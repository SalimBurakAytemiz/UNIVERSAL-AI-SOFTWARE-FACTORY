import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  InvariantGuard,
  DuplicateInvariantIdError,
  createDefaultInvariantGuard,
  type InvariantCheckResult,
  type InvariantDefinition
} from "../invariant-guard.js";

/** Mirrors orchestrator.test.ts's own helper — locates the REAL repo root from this test file's own location. */
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

describe("InvariantGuard: registration and reporting", () => {
  it("reports allBlockingSatisfied=true when every registered invariant passes", () => {
    const guard = new InvariantGuard();
    guard.register({
      id: "always-true",
      description: "trivially satisfied",
      severity: "BLOCKING",
      check: (): InvariantCheckResult => ({ satisfied: true, detail: "ok" })
    });
    const report = guard.runAll();
    expect(report.allBlockingSatisfied).toBe(true);
    expect(report.violations).toHaveLength(0);
  });

  it("reports allBlockingSatisfied=false when a BLOCKING invariant fails", () => {
    const guard = new InvariantGuard();
    guard.register({
      id: "always-false",
      description: "trivially violated",
      severity: "BLOCKING",
      check: (): InvariantCheckResult => ({ satisfied: false, detail: "nope" })
    });
    const report = guard.runAll();
    expect(report.allBlockingSatisfied).toBe(false);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.invariantId).toBe("always-false");
  });

  it("a WARNING violation is recorded but does not flip allBlockingSatisfied", () => {
    const guard = new InvariantGuard();
    guard.register({
      id: "warn-only",
      description: "warns but does not block",
      severity: "WARNING",
      check: (): InvariantCheckResult => ({ satisfied: false, detail: "heads up" })
    });
    const report = guard.runAll();
    expect(report.allBlockingSatisfied).toBe(true);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.severity).toBe("WARNING");
  });

  it("rejects a duplicate invariant id", () => {
    const guard = new InvariantGuard();
    guard.register({ id: "dup", description: "d", severity: "BLOCKING", check: () => ({ satisfied: true, detail: "" }) });
    expect(() =>
      guard.register({ id: "dup", description: "d2", severity: "BLOCKING", check: () => ({ satisfied: true, detail: "" }) })
    ).toThrow(DuplicateInvariantIdError);
  });

  it("REGRESSION (mirrors round 35 Fix 1/Fix 10's shallow-freeze root class): a violation object returned in " +
    "a prior report cannot be mutated to retroactively rewrite a past finding", () => {
    const guard = new InvariantGuard();
    guard.register({
      id: "always-false",
      description: "d",
      severity: "BLOCKING",
      check: (): InvariantCheckResult => ({ satisfied: false, detail: "original" })
    });
    const report = guard.runAll();
    expect(() => {
      (report.violations[0] as { detail: string }).detail = "tampered";
    }).toThrow(TypeError);
  });

  it("caller mutating its own registered definition object after register() has no effect on later checks", () => {
    const guard = new InvariantGuard();
    const def = {
      id: "mutable-def",
      description: "d",
      severity: "BLOCKING" as const,
      check: (): InvariantCheckResult => ({ satisfied: true, detail: "ok" })
    };
    guard.register(def);
    // Mutate the caller's own reference after registration.
    (def as { severity: string }).severity = "WARNING";
    (def as { check: unknown }).check = () => ({ satisfied: false, detail: "swapped in after registration" });
    const report = guard.runAll();
    expect(report.allBlockingSatisfied).toBe(true);
    expect(report.violations).toHaveLength(0);
  });
});

describe("createDefaultInvariantGuard: 'requirement-registry-loads-cleanly' and 'no-unsupported-evidence-claims'", () => {
  let tempRoot: string;

  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it("BLOCKER: flags a registry directory that does not exist as failing to load", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-invariant-guard-"));
    const missingDir = join(tempRoot, "does-not-exist");
    const guard = createDefaultInvariantGuard(missingDir, tempRoot);
    const report = guard.runAll();
    expect(report.allBlockingSatisfied).toBe(false);
    expect(report.violations.some((v) => v.invariantId === "requirement-registry-loads-cleanly")).toBe(true);
  });

  it("BLOCKER: flags a requirement claiming UNIT_TESTED with zero backing evidence", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-invariant-guard-"));
    const requirementsDir = join(tempRoot, "specification", "requirements");
    mkdirSync(requirementsDir, { recursive: true });
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
    const guard = createDefaultInvariantGuard(requirementsDir, tempRoot);
    const report = guard.runAll();
    expect(report.allBlockingSatisfied).toBe(false);
    expect(report.violations.some((v) => v.invariantId === "no-unsupported-evidence-claims")).toBe(true);
  });

  it("no-regression: a requirement with genuine, resolvable evidence passes both checks", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-invariant-guard-"));
    const requirementsDir = join(tempRoot, "specification", "requirements");
    mkdirSync(requirementsDir, { recursive: true });
    // P1 fix (independent Codex review, "do not trust caller-authored
    // evidence outcomes"): the evidence artifact's path must now be
    // shaped like a genuine recognized verification artifact (bkz.
    // traceability.ts'in fix notu) — `proof.txt` no longer qualifies.
    const proofFile = join(tempRoot, "proof.test.ts");
    writeFileSync(proofFile, "real evidence file");
    writeFileSync(
      join(requirementsDir, "clean.yml"),
      [
        "- id: UASF-REQ-9002",
        "  title: Fixture requirement with real evidence",
        "  description: Claims UNIT_TESTED backed by a real, on-disk proof file.",
        "  source_baseline: 'BASELINE-V1 section 0 (test fixture)'",
        "  category: P0",
        "  priority: LOW",
        "  status: UNIT_TESTED",
        "  implementation_refs: []",
        "  test_refs:",
        "    - path: proof.test.ts",
        "      type: TEST_RESULT",
        "      outcome: PASS",
        "      verificationSource: 'npm test (vitest)'",
        "  proof_refs: []",
        ""
      ].join("\n")
    );
    const guard = createDefaultInvariantGuard(requirementsDir, tempRoot);
    const report = guard.runAll();
    expect(report.allBlockingSatisfied).toBe(true);
    expect(report.violations).toHaveLength(0);
  });

  it("no-regression: this repository's OWN real, authoritative requirement registry currently passes both checks", () => {
    const guard = createDefaultInvariantGuard(REAL_REQUIREMENTS_DIR, REAL_REPO_ROOT);
    const report = guard.runAll();
    expect(report.violations).toHaveLength(0);
    expect(report.allBlockingSatisfied).toBe(true);
  });
});

describe("createDefaultInvariantGuard: 'policy-engine-default-deny'", () => {
  it("no-regression: the real, exported PolicyEngine class still denies an unmatched action by default", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "uasf-invariant-guard-policy-"));
    try {
      const requirementsDir = join(tempRoot, "specification", "requirements");
      mkdirSync(requirementsDir, { recursive: true });
      writeFileSync(join(requirementsDir, "empty.yml"), "- id: UASF-REQ-9003\n  title: x\n  description: x\n  source_baseline: 'BASELINE-V1 section 0'\n  category: P0\n  priority: LOW\n  status: DEFINED\n");
      const guard = createDefaultInvariantGuard(requirementsDir, tempRoot);
      const report = guard.runAll();
      expect(report.violations.some((v) => v.invariantId === "policy-engine-default-deny")).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe(
  "P1 fix (independent Codex review, 'preserve prototype invariant checks during registration'): a " +
    "class-based InvariantDefinition whose check() lives on the prototype must not be silently dropped by register()",
  () => {
    it("BLOCKER regression, exact reproduction: a class-based InvariantDefinition registers successfully and runAll() executes its check normally", () => {
      class AlwaysSatisfiedInvariant implements InvariantDefinition {
        readonly id = "always-satisfied";
        readonly description = "d";
        readonly severity = "BLOCKING" as const;
        check(): InvariantCheckResult {
          return { satisfied: true, detail: "ok" };
        }
      }
      const guard = new InvariantGuard();
      guard.register(new AlwaysSatisfiedInvariant());
      const report = guard.runAll();
      expect(report.allBlockingSatisfied).toBe(true);
      expect(report.violations).toHaveLength(0);
    });

    it("no-regression: caller mutation of the original instance after registration does not mutate the authoritative definition's id/description/severity", () => {
      class MutableInvariant implements InvariantDefinition {
        id = "mutable";
        description = "original";
        severity: "BLOCKING" | "WARNING" = "BLOCKING";
        satisfied = false;
        check(): InvariantCheckResult {
          return { satisfied: this.satisfied, detail: "checked" };
        }
      }
      const def = new MutableInvariant();
      const guard = new InvariantGuard();
      guard.register(def);
      def.description = "tampered";
      def.severity = "WARNING";
      def.satisfied = true;
      const [registered] = guard.list();
      expect(registered.description).toBe("original");
      expect(registered.severity).toBe("BLOCKING");
      // check is bound to the ORIGINAL instance (bkz. register()'in fix
      // notu) so it legitimately still reads `this.satisfied` off it —
      // the finding requires the CHECKER ITSELF survive registration.
      const report = guard.runAll();
      expect(report.violations).toHaveLength(0);
    });
  }
);
