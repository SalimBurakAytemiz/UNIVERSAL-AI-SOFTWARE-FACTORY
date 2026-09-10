import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeRealityMatrix, renderRealityMatrixTurkishSummary } from "../reality-matrix.js";

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

describe("computeRealityMatrix", () => {
  let tempRoot: string;
  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it("BLOCKER: a requirement claiming UNIT_TESTED with zero evidence is reported as UNSUPPORTED_CLAIM, not UNIT_TESTED", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-reality-matrix-"));
    const requirementsDir = join(tempRoot, "specification", "requirements");
    mkdirSync(requirementsDir, { recursive: true });
    writeFileSync(
      join(requirementsDir, "broken.yml"),
      [
        "- id: UASF-REQ-9001",
        "  title: Fixture",
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
    const matrix = computeRealityMatrix(requirementsDir, tempRoot);
    expect(matrix.total).toBe(1);
    expect(matrix.entries[0]!.claimedStatus).toBe("UNIT_TESTED");
    expect(matrix.entries[0]!.effectiveStatus).toBe("UNSUPPORTED_CLAIM");
    expect(matrix.unsupportedClaimIds).toEqual(["UASF-REQ-9001"]);
    expect(matrix.byEffectiveStatus["UNSUPPORTED_CLAIM"]).toBe(1);
  });

  it("no-regression: a requirement with real, resolvable evidence reports its claimed status as-is", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-reality-matrix-"));
    const requirementsDir = join(tempRoot, "specification", "requirements");
    mkdirSync(requirementsDir, { recursive: true });
    // P1 fix (independent Codex review, "do not trust caller-authored
    // evidence outcomes"): an outcome-bearing evidence ref's own path must
    // now be shaped like a genuine recognized verification artifact (bkz.
    // traceability.ts'in fix notu) — a bare `proof.txt` no longer qualifies.
    writeFileSync(join(tempRoot, "proof.test.ts"), "real evidence");
    writeFileSync(
      join(requirementsDir, "clean.yml"),
      [
        "- id: UASF-REQ-9002",
        "  title: Fixture",
        "  description: Backed by a real proof file.",
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
    const matrix = computeRealityMatrix(requirementsDir, tempRoot);
    expect(matrix.entries[0]!.effectiveStatus).toBe("UNIT_TESTED");
    expect(matrix.unsupportedClaimIds).toHaveLength(0);
  });

  it("no-regression: a BLOCKED requirement is reported as BLOCKED, not flagged as an unsupported claim, regardless of missing evidence", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-reality-matrix-"));
    const requirementsDir = join(tempRoot, "specification", "requirements");
    mkdirSync(requirementsDir, { recursive: true });
    writeFileSync(
      join(requirementsDir, "blocked.yml"),
      [
        "- id: UASF-REQ-9003",
        "  title: Fixture",
        "  description: Blocked, no evidence expected.",
        "  source_baseline: 'BASELINE-V1 section 0 (test fixture)'",
        "  category: P0",
        "  priority: LOW",
        "  status: BLOCKED",
        ""
      ].join("\n")
    );
    const matrix = computeRealityMatrix(requirementsDir, tempRoot);
    expect(matrix.entries[0]!.effectiveStatus).toBe("BLOCKED");
    expect(matrix.blockedRequirementIds).toEqual(["UASF-REQ-9003"]);
    expect(matrix.unsupportedClaimIds).toHaveLength(0);
  });

  it("REGRESSION: a returned matrix's entries array cannot be mutated after the fact (deep-frozen)", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-reality-matrix-"));
    const requirementsDir = join(tempRoot, "specification", "requirements");
    mkdirSync(requirementsDir, { recursive: true });
    writeFileSync(
      join(requirementsDir, "x.yml"),
      "- id: UASF-REQ-9004\n  title: x\n  description: x\n  source_baseline: 'BASELINE-V1 section 0'\n  category: P0\n  priority: LOW\n  status: DEFINED\n"
    );
    const matrix = computeRealityMatrix(requirementsDir, tempRoot);
    expect(() => {
      (matrix.entries[0] as { claimedStatus: string }).claimedStatus = "TAMPERED";
    }).toThrow(TypeError);
  });

  it("no-regression: this repository's OWN real, authoritative requirement registry currently reports zero unsupported claims", () => {
    const matrix = computeRealityMatrix(REAL_REQUIREMENTS_DIR, REAL_REPO_ROOT);
    expect(matrix.unsupportedClaimIds).toHaveLength(0);
    expect(matrix.total).toBeGreaterThan(0);
  });
});

describe("renderRealityMatrixTurkishSummary", () => {
  it("mentions unsupported claims by id when present", () => {
    const summary = renderRealityMatrixTurkishSummary({
      total: 2,
      byEffectiveStatus: { UNSUPPORTED_CLAIM: 1, DEFINED: 1 },
      blockedRequirementIds: [],
      unsupportedClaimIds: ["UASF-REQ-9001"],
      entries: [],
      generatedAt: new Date().toISOString()
    });
    expect(summary).toContain("UASF-REQ-9001");
    expect(summary).toContain("kanıtsız iddia");
  });

  it("reports a clean matrix with no warnings", () => {
    const summary = renderRealityMatrixTurkishSummary({
      total: 1,
      byEffectiveStatus: { DEFINED: 1 },
      blockedRequirementIds: [],
      unsupportedClaimIds: [],
      entries: [],
      generatedAt: new Date().toISOString()
    });
    expect(summary).toContain("Hiçbir kanıtsız iddia veya bloke kayıt bulunamadı");
  });
});
