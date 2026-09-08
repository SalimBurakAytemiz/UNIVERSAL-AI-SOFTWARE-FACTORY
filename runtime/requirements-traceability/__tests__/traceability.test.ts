import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { detectTraceabilityIssues } from "../traceability.js";
import { traceRequirements } from "../../cli/commands/trace-requirement.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");
const requirementsDir = join(repoRoot, "specification", "requirements");

describe(
  "detectTraceabilityIssues (pure logic, refs are REAL resolvable repo paths — bkz. 30th independent review " +
    "round finding 7, free-text prose no longer counts as evidence at all)",
  () => {
    it("flags a requirement claiming IMPLEMENTATION_IN_PROGRESS with no implementation_refs", () => {
      const issues = detectTraceabilityIssues(
        [{ id: "R1", status: "IMPLEMENTATION_IN_PROGRESS", implementationRefs: [], testRefs: [], proofRefs: [] }],
        repoRoot
      );
      expect(issues).toEqual([{ requirementId: "R1", issue: "MISSING_IMPLEMENTATION_REFS", status: "IMPLEMENTATION_IN_PROGRESS" }]);
    });

    it("flags a requirement claiming UNIT_TESTED with no test_refs, even if implementation_refs exist", () => {
      const issues = detectTraceabilityIssues(
        [{ id: "R2", status: "UNIT_TESTED", implementationRefs: ["package.json"], testRefs: [], proofRefs: [] }],
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
            implementationRefs: ["package.json"],
            testRefs: ["package.json"],
            proofRefs: []
          }
        ],
        repoRoot
      );
      expect(issues.map((i) => i.issue)).toEqual(["MISSING_PROOF_REFS"]);
    });

    it("does not flag a fully-evidenced requirement (every ref a real, resolvable repository path)", () => {
      const issues = detectTraceabilityIssues(
        [
          {
            id: "R4",
            status: "PROOF_VERIFIED",
            implementationRefs: ["package.json"],
            testRefs: ["package.json"],
            proofRefs: ["package.json"]
          }
        ],
        repoRoot
      );
      expect(issues).toHaveLength(0);
    });

    it(
      "BLOCKER regression, exact reproduction (30th independent review round, finding 7): a free-text " +
        "'manually verified'-style claim NEVER counts as evidence, even alone with nothing else",
      () => {
        const issues = detectTraceabilityIssues(
          [
            {
              id: "R9",
              status: "PROOF_VERIFIED",
              implementationRefs: ["manually verified"],
              testRefs: ["manually verified"],
              proofRefs: ["manually verified"]
            }
          ],
          repoRoot
        );
        expect(issues.map((i) => i.issue).sort()).toEqual(
          ["MISSING_IMPLEMENTATION_REFS", "MISSING_PROOF_REFS", "MISSING_TEST_REFS"].sort()
        );
      }
    );

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

    it(
      "P1 fix (30th independent review round, finding 7, 'reject unverifiable free-text evidence " +
        "references'): a free-text audit note (contains whitespace) is NO LONGER accepted as evidence — " +
        "'no claim without evidence' applies to prose exactly as it does to a fabricated path",
      () => {
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
        expect(issues.map((i) => i.issue).sort()).toEqual(
          ["MISSING_IMPLEMENTATION_REFS", "MISSING_PROOF_REFS", "MISSING_TEST_REFS"].sort()
        );
      }
    );

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

describe(
  "P1 fix (32nd independent review round, finding 5, 'canonicalize evidence paths with filesystem-aware " +
    "confinement'): a lexically-inside-the-root symlink that actually points OUTSIDE the repository must " +
    "never satisfy an evidence-backed status claim",
  () => {
    let tempRoot: string;

    afterEach(() => {
      if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    });

    function makeRoot(): string {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-traceability-symlink-"));
      return tempRoot;
    }

    it(
      "BLOCKER regression, exact reproduction: repo/proofs/evidence -> symlink to a REAL file OUTSIDE the " +
        "repository is rejected, even though it lexically resolves inside the root and genuinely exists",
      () => {
        const root = makeRoot();
        const outsideDir = mkdtempSync(join(tmpdir(), "uasf-traceability-outside-"));
        const outsideFile = join(outsideDir, "secret-outside-file.txt");
        writeFileSync(outsideFile, "genuinely exists, but must never count as this repo's own evidence");
        try {
          mkdirSync(join(root, "proofs"), { recursive: true });
          symlinkSync(outsideFile, join(root, "proofs", "evidence"));

          const issues = detectTraceabilityIssues(
            [
              {
                id: "R16",
                status: "PROOF_VERIFIED",
                implementationRefs: ["proofs/evidence"],
                testRefs: ["proofs/evidence"],
                proofRefs: ["proofs/evidence"]
              }
            ],
            root
          );
          expect(issues.map((i) => i.issue).sort()).toEqual(
            ["MISSING_IMPLEMENTATION_REFS", "MISSING_PROOF_REFS", "MISSING_TEST_REFS"].sort()
          );
        } finally {
          rmSync(outsideDir, { recursive: true, force: true });
        }
      }
    );

    it("BLOCKER regression: a symlinked DIRECTORY pointing outside the repository is also rejected", () => {
      const root = makeRoot();
      const outsideDir = mkdtempSync(join(tmpdir(), "uasf-traceability-outside-dir-"));
      writeFileSync(join(outsideDir, "marker.txt"), "outside");
      try {
        symlinkSync(outsideDir, join(root, "linked-proofs"));

        const issues = detectTraceabilityIssues(
          [{ id: "R17", status: "IMPLEMENTATION_IN_PROGRESS", implementationRefs: ["linked-proofs"], testRefs: [], proofRefs: [] }],
          root
        );
        expect(issues.map((i) => i.issue)).toEqual(["MISSING_IMPLEMENTATION_REFS"]);
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it(
      "no regression (matches assertFilesystemConfinement's own pre-existing, round-6 'project-root alias' " +
        "semantics): a symlink is rejected as evidence even when it happens to point at a REAL location INSIDE " +
        "the same repository root — a caller must reference the real path directly, not an alias of it",
      () => {
        const root = makeRoot();
        mkdirSync(join(root, "runtime"), { recursive: true });
        writeFileSync(join(root, "runtime", "real.ts"), "// real, inside the repo");
        symlinkSync(join(root, "runtime", "real.ts"), join(root, "alias.ts"));

        const issues = detectTraceabilityIssues(
          [{ id: "R18", status: "IMPLEMENTATION_IN_PROGRESS", implementationRefs: ["alias.ts"], testRefs: [], proofRefs: [] }],
          root
        );
        expect(issues.map((i) => i.issue)).toEqual(["MISSING_IMPLEMENTATION_REFS"]);

        // The REAL, non-aliased path is unaffected and still verifies normally.
        const noIssues = detectTraceabilityIssues(
          [{ id: "R18b", status: "IMPLEMENTATION_IN_PROGRESS", implementationRefs: ["runtime/real.ts"], testRefs: [], proofRefs: [] }],
          root
        );
        expect(noIssues).toHaveLength(0);
      }
    );

    it("no regression: an ordinary, non-symlinked directory reference still counts as evidence (the real registry relies on this)", () => {
      const root = makeRoot();
      mkdirSync(join(root, "runtime", "widget"), { recursive: true });

      const issues = detectTraceabilityIssues(
        [{ id: "R19", status: "IMPLEMENTATION_IN_PROGRESS", implementationRefs: ["runtime/widget"], testRefs: [], proofRefs: [] }],
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
