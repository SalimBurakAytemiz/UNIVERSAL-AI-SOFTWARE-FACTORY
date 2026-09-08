import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { detectTraceabilityIssues } from "../traceability.js";
import { traceRequirements } from "../../cli/commands/trace-requirement.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");
const requirementsDir = join(repoRoot, "specification", "requirements");

describe("detectTraceabilityIssues (pure logic, refs are non-path free-text notes so no real fs verification is exercised)", () => {
  it("flags a requirement claiming IMPLEMENTATION_IN_PROGRESS with no implementation_refs", () => {
    const issues = detectTraceabilityIssues(
      [{ id: "R1", status: "IMPLEMENTATION_IN_PROGRESS", implementationRefs: [], testRefs: [], proofRefs: [] }],
      repoRoot
    );
    expect(issues).toEqual([{ requirementId: "R1", issue: "MISSING_IMPLEMENTATION_REFS", status: "IMPLEMENTATION_IN_PROGRESS" }]);
  });

  it("flags a requirement claiming UNIT_TESTED with no test_refs, even if implementation_refs exist", () => {
    const issues = detectTraceabilityIssues(
      [{ id: "R2", status: "UNIT_TESTED", implementationRefs: ["real evidence note for R2"], testRefs: [], proofRefs: [] }],
      repoRoot
    );
    expect(issues.map((i) => i.issue)).toEqual(["MISSING_TEST_REFS"]);
  });

  it("flags a requirement claiming PROOF_VERIFIED with no proof_refs", () => {
    const issues = detectTraceabilityIssues(
      [
        {
          id: "R3",
          status: "PROOF_VERIFIED",
          implementationRefs: ["real evidence note for R3"],
          testRefs: ["real test note for R3"],
          proofRefs: []
        }
      ],
      repoRoot
    );
    expect(issues.map((i) => i.issue)).toEqual(["MISSING_PROOF_REFS"]);
  });

  it("does not flag a fully-evidenced requirement (free-text notes, no whitespace-free path claimed)", () => {
    const issues = detectTraceabilityIssues(
      [
        {
          id: "R4",
          status: "PROOF_VERIFIED",
          implementationRefs: ["implementation note for R4"],
          testRefs: ["test note for R4"],
          proofRefs: ["proof note for R4"]
        }
      ],
      repoRoot
    );
    expect(issues).toHaveLength(0);
  });

  it("does not evaluate BLOCKED, DEPRECATED, or SUPERSEDED requirements", () => {
    const issues = detectTraceabilityIssues(
      [
        { id: "R5", status: "BLOCKED", implementationRefs: [], testRefs: [], proofRefs: [] },
        { id: "R6", status: "DEPRECATED", implementationRefs: [], testRefs: [], proofRefs: [] },
        { id: "R7", status: "SUPERSEDED", implementationRefs: [], testRefs: [], proofRefs: [] }
      ],
      repoRoot
    );
    expect(issues).toHaveLength(0);
  });

  it("a DEFINED requirement with no refs at all is not an issue (nothing claimed yet)", () => {
    const issues = detectTraceabilityIssues(
      [{ id: "R8", status: "DEFINED", implementationRefs: [], testRefs: [], proofRefs: [] }],
      repoRoot
    );
    expect(issues).toHaveLength(0);
  });
});

describe(
  "P1 fix (29th independent review round, finding 5, 'proof references must resolve to real evidence'): a " +
    "path-shaped ref only counts as evidence if it genuinely exists on disk inside the given root",
  () => {
    let tempRoot: string;

    afterEach(() => {
      if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    });

    function makeRoot(): string {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-traceability-"));
      return tempRoot;
    }

    it("BLOCKER regression, exact reproduction: proof_refs: [\"does/not/exist\"] fails validation", () => {
      const root = makeRoot();
      const issues = detectTraceabilityIssues(
        [
          {
            id: "R9",
            status: "PROOF_VERIFIED",
            implementationRefs: ["does/not/exist"],
            testRefs: ["does/not/exist"],
            proofRefs: ["does/not/exist"]
          }
        ],
        root
      );
      expect(issues.map((i) => i.issue).sort()).toEqual(
        ["MISSING_IMPLEMENTATION_REFS", "MISSING_PROOF_REFS", "MISSING_TEST_REFS"].sort()
      );
    });

    it("a proof_refs entry pointing at a REAL, existing file counts as genuine evidence", () => {
      const root = makeRoot();
      mkdirSync(join(root, "proofs", "x"), { recursive: true });
      writeFileSync(join(root, "proofs", "x", "proof.test.ts"), "// real file");

      const issues = detectTraceabilityIssues(
        [
          {
            id: "R10",
            status: "PROOF_VERIFIED",
            implementationRefs: ["proofs/x/proof.test.ts"],
            testRefs: ["proofs/x/proof.test.ts"],
            proofRefs: ["proofs/x/proof.test.ts"]
          }
        ],
        root
      );
      expect(issues).toHaveLength(0);
    });

    it("a proof_refs entry pointing at a REAL, existing directory also counts as genuine evidence", () => {
      const root = makeRoot();
      mkdirSync(join(root, "runtime", "widget"), { recursive: true });

      const issues = detectTraceabilityIssues(
        [{ id: "R11", status: "IMPLEMENTATION_IN_PROGRESS", implementationRefs: ["runtime/widget"], testRefs: [], proofRefs: [] }],
        root
      );
      expect(issues).toHaveLength(0);
    });

    it("BLOCKER regression: a path-traversal reference attempting to escape the root is rejected, not treated as evidence", () => {
      const root = makeRoot();
      // A file that genuinely exists — but OUTSIDE the root, only reachable via traversal.
      writeFileSync(join(tmpdir(), "uasf-traceability-outside-marker.txt"), "outside");

      const issues = detectTraceabilityIssues(
        [
          {
            id: "R12",
            status: "PROOF_VERIFIED",
            implementationRefs: ["../uasf-traceability-outside-marker.txt"],
            testRefs: ["../uasf-traceability-outside-marker.txt"],
            proofRefs: ["../uasf-traceability-outside-marker.txt"]
          }
        ],
        root
      );
      expect(issues.map((i) => i.issue).sort()).toEqual(
        ["MISSING_IMPLEMENTATION_REFS", "MISSING_PROOF_REFS", "MISSING_TEST_REFS"].sort()
      );
    });

    it("a deleted/moved file that used to be genuine evidence is no longer accepted (evidence rot is caught)", () => {
      const root = makeRoot();
      mkdirSync(join(root, "runtime"), { recursive: true });
      const filePath = join(root, "runtime", "gone.ts");
      writeFileSync(filePath, "// will be deleted");
      rmSync(filePath);

      const issues = detectTraceabilityIssues(
        [{ id: "R13", status: "IMPLEMENTATION_IN_PROGRESS", implementationRefs: ["runtime/gone.ts"], testRefs: [], proofRefs: [] }],
        root
      );
      expect(issues.map((i) => i.issue)).toEqual(["MISSING_IMPLEMENTATION_REFS"]);
    });

    it("a free-text audit note (contains whitespace) is still accepted as non-path evidence, preserving legacy pre-convention records", () => {
      const root = makeRoot(); // deliberately empty — nothing on disk matches any path
      const issues = detectTraceabilityIssues(
        [
          {
            id: "R14",
            status: "PROOF_VERIFIED",
            implementationRefs: ["Session audit: manually verified by the Founder"],
            testRefs: ["Session audit: manually verified by the Founder"],
            proofRefs: ["Session audit: manually verified by the Founder"]
          }
        ],
        root
      );
      expect(issues).toHaveLength(0);
    });

    it("only ONE genuinely-verified ref among several is sufficient (mirrors the pre-existing 'any ref counts' semantics)", () => {
      const root = makeRoot();
      mkdirSync(join(root, "runtime"), { recursive: true });
      writeFileSync(join(root, "runtime", "real.ts"), "// real");

      const issues = detectTraceabilityIssues(
        [
          {
            id: "R15",
            status: "PROOF_VERIFIED",
            implementationRefs: ["runtime/real.ts"],
            testRefs: ["does/not/exist", "runtime/real.ts"],
            proofRefs: ["also/does/not/exist", "runtime/real.ts"]
          }
        ],
        root
      );
      expect(issues).toHaveLength(0);
    });
  }
);

describe("detectTraceabilityIssues over the real requirement registry", () => {
  it("the actual specification/requirements/ registry has zero unsupported status upgrades, with every path-shaped ref genuinely resolving on disk", () => {
    const issues = traceRequirements(requirementsDir, repoRoot);
    expect(issues).toEqual([]);
  });
});
