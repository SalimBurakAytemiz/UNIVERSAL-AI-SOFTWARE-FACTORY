import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { detectTraceabilityIssues, isOutcomeVerifiedEvidenceRef } from "../traceability.js";
import { traceRequirements } from "../../cli/commands/trace-requirement.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");
const requirementsDir = join(repoRoot, "specification", "requirements");
/**
 * P1 fix (independent Codex review, "do not trust caller-authored evidence
 * outcomes"): a REAL, `.test.ts`-shaped path already on disk — the pattern
 * `isOutcomeVerifiedEvidenceRef()` now requires an outcome-bearing ref's
 * OWN path to match (bkz. traceability.ts'in fix notu), so fixtures that
 * want a genuinely-VERIFIED outcome ref can no longer use `package.json`
 * (a plain manifest, the finding's own reproduction) — this file itself is
 * a stable, always-present stand-in.
 */
const VERIFIED_ARTIFACT_PATH = "runtime/requirements-traceability/__tests__/traceability.test.ts";

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
      // P1 fix (independent Codex review, outcome-backed evidence): testRefs must be
      // outcome-verified to satisfy the TEST claim at this rank; only proofRefs is missing here.
      const issues = detectTraceabilityIssues(
        [
          {
            id: "R3",
            status: "PROOF_VERIFIED",
            implementationRefs: ["package.json"],
            testRefs: [{ path: VERIFIED_ARTIFACT_PATH, type: "TEST_RESULT", outcome: "PASS", verificationSource: "npm test (vitest)" }],
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
            testRefs: [{ path: VERIFIED_ARTIFACT_PATH, type: "TEST_RESULT", outcome: "PASS", verificationSource: "npm test (vitest)" }],
            proofRefs: [{ path: VERIFIED_ARTIFACT_PATH, type: "PROOF_RESULT", outcome: "PASS", verificationSource: "npm test (vitest)" }]
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
  "P1 fix (36th independent review round, finding 5, 'require outcome evidence, not simple path existence'): " +
    "evidence existence alone must never be treated as evidence success",
  () => {
    it("BLOCKER regression, exact reproduction: an existing test artifact recorded with a FAILED outcome cannot support PROOF_VERIFIED", () => {
      const issues = detectTraceabilityIssues(
        [
          {
            id: "R-FAIL",
            status: "PROOF_VERIFIED",
            implementationRefs: ["package.json"],
            testRefs: [{ path: "package.json", type: "TEST_RESULT", outcome: "FAIL" }],
            proofRefs: [{ path: "package.json", type: "PROOF_RESULT", outcome: "FAIL" }]
          }
        ],
        repoRoot
      );
      expect(issues.map((i) => i.issue)).toEqual(
        expect.arrayContaining(["MISSING_TEST_REFS", "MISSING_PROOF_REFS"])
      );
    });

    it("BLOCKER regression, exact reproduction: an existing generic directory ('.') cannot support PROOF_VERIFIED — it 'exists' for every possible claim", () => {
      const issues = detectTraceabilityIssues(
        [
          {
            id: "R-ROOT",
            status: "PROOF_VERIFIED",
            implementationRefs: ["."],
            testRefs: ["."],
            proofRefs: ["."]
          }
        ],
        repoRoot
      );
      expect(issues.map((i) => i.issue)).toEqual(
        expect.arrayContaining(["MISSING_IMPLEMENTATION_REFS", "MISSING_TEST_REFS", "MISSING_PROOF_REFS"])
      );
    });

    it("no-regression: a structured evidence ref with a genuine PASS outcome and named verificationSource DOES count as verified evidence", () => {
      // P1 fix (independent Codex review, outcome-backed evidence): an outcome-bearing
      // ref must also name its verificationSource — see isOutcomeVerifiedEvidenceRef().
      const issues = detectTraceabilityIssues(
        [
          {
            id: "R-PASS",
            status: "PROOF_VERIFIED",
            implementationRefs: ["package.json"],
            testRefs: [{ path: VERIFIED_ARTIFACT_PATH, type: "TEST_RESULT", outcome: "PASS", verificationSource: "npm test (vitest)" }],
            proofRefs: [{ path: VERIFIED_ARTIFACT_PATH, type: "PROOF_RESULT", outcome: "CLEAN", verificationSource: "npm test (vitest)" }]
          }
        ],
        repoRoot
      );
      expect(issues).toHaveLength(0);
    });

    it("no-regression: a structured ARTIFACT_REFERENCE with no outcome still counts for an implementation-level claim (it makes no outcome claim to begin with)", () => {
      // P1 fix (independent Codex review, outcome-backed evidence): ARTIFACT_REFERENCE
      // never satisfies a test/proof OUTCOME claim (see isOutcomeVerifiedEvidenceRef()),
      // so this case is scoped to IMPLEMENTED, where implementationRefs legitimately
      // keeps using the weaker existence-only check.
      const issues = detectTraceabilityIssues(
        [
          {
            id: "R-ARTIFACT",
            status: "IMPLEMENTED",
            implementationRefs: [{ path: "package.json", type: "ARTIFACT_REFERENCE" }],
            testRefs: [],
            proofRefs: []
          }
        ],
        repoRoot
      );
      expect(issues).toHaveLength(0);
    });

    it("no-regression: a genuinely-scoped, previously-accepted module directory still counts for the weaker implementation-level existence claim; the outcome-bearing test claim needs a genuine result artifact, not the bare module directory", () => {
      // P1 fix (independent Codex review, outcome-backed evidence): testRefs
      // must now carry an outcome-bearing structured ref to satisfy UNIT_TESTED;
      // a bare-string ref makes no outcome claim at all (see isOutcomeVerifiedEvidenceRef).
      //
      // P1 fix (independent Codex review, "do not trust caller-authored
      // evidence outcomes"): a bare module DIRECTORY is exactly the "arbitrary
      // directory... must not prove PROOF_VERIFIED" shape this finding
      // targets — it is no longer sufficient as an OUTCOME-bearing ref (the
      // weaker, existence-only implementationRefs check is unaffected, since
      // "this module exists" is a legitimate, narrower claim than "this
      // module's tests passed"). The test claim now needs a genuine
      // recognized-artifact path.
      const issues = detectTraceabilityIssues(
        [
          {
            id: "R-MODULE-DIR",
            status: "UNIT_TESTED",
            implementationRefs: ["runtime/audit"],
            testRefs: [{ path: VERIFIED_ARTIFACT_PATH, type: "TEST_RESULT", outcome: "PASS", verificationSource: "npm test (vitest)" }],
            proofRefs: []
          }
        ],
        repoRoot
      );
      expect(issues).toHaveLength(0);
    });

    it("no-regression: a plain bare-string ref (the legacy shape) still resolves and counts exactly as before, for an implementation-level claim", () => {
      // P1 fix (independent Codex review, outcome-backed evidence): the legacy
      // bare-string shape remains fully sufficient for implementationRefs
      // (an existence claim), but can no longer alone satisfy a test/proof
      // outcome claim — so this no-regression case is scoped to IMPLEMENTED.
      const issues = detectTraceabilityIssues(
        [{ id: "R-LEGACY", status: "IMPLEMENTED", implementationRefs: ["package.json"], testRefs: [], proofRefs: [] }],
        repoRoot
      );
      expect(issues).toHaveLength(0);
    });
  }
);

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

      // P1 fix (independent Codex review, outcome-backed evidence): PROOF_VERIFIED
      // requires an outcome-bearing testRefs/proofRefs entry, not a bare path.
      const issues = detectTraceabilityIssues(
        [
          {
            id: "R10",
            status: "PROOF_VERIFIED",
            implementationRefs: ["proofs/x/proof.test.ts"],
            testRefs: [{ path: "proofs/x/proof.test.ts", type: "TEST_RESULT", outcome: "PASS", verificationSource: "npm test (vitest)" }],
            proofRefs: [{ path: "proofs/x/proof.test.ts", type: "PROOF_RESULT", outcome: "PASS", verificationSource: "npm test (vitest)" }]
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
      // P1 fix (independent Codex review, "do not trust caller-authored
      // evidence outcomes"): an outcome-bearing ref's own path must be
      // shaped like a genuine recognized verification artifact (bkz.
      // traceability.ts'in fix notu) — a plain `real.ts` source file no
      // longer qualifies, so this fixture is a `.test.ts`-named file instead.
      writeFileSync(join(root, "runtime", "real.test.ts"), "// real");

      // P1 fix (independent Codex review, outcome-backed evidence): the genuine
      // ref must be outcome-bearing to satisfy PROOF_VERIFIED's test/proof claims.
      const issues = detectTraceabilityIssues(
        [
          {
            id: "R15",
            status: "PROOF_VERIFIED",
            implementationRefs: ["runtime/real.test.ts"],
            testRefs: ["does/not/exist", { path: "runtime/real.test.ts", type: "TEST_RESULT", outcome: "PASS", verificationSource: "npm test (vitest)" }],
            proofRefs: ["also/does/not/exist", { path: "runtime/real.test.ts", type: "PROOF_RESULT", outcome: "PASS", verificationSource: "npm test (vitest)" }]
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

describe(
  "P1 fix (independent Codex review, 'require outcome-backed evidence references'): evidence " +
    "existence must never be conflated with evidence SUCCESS for a test/proof-level claim",
  () => {
    it("BLOCKER regression, exact reproduction: an existing package.json cited as proof_refs cannot satisfy PROOF_VERIFIED", () => {
      const issues = detectTraceabilityIssues(
        [
          {
            id: "R-PKGJSON",
            status: "PROOF_VERIFIED",
            implementationRefs: ["package.json"],
            testRefs: ["package.json"],
            proofRefs: ["package.json"]
          }
        ],
        repoRoot
      );
      expect(issues.map((i) => i.issue).sort()).toEqual(["MISSING_PROOF_REFS", "MISSING_TEST_REFS"].sort());
    });

    it("BLOCKER regression, exact reproduction: an existing, unexecuted test SOURCE file cannot satisfy PROOF_VERIFIED", () => {
      const issues = detectTraceabilityIssues(
        [
          {
            id: "R-UNEXECUTED",
            status: "PROOF_VERIFIED",
            implementationRefs: ["package.json"],
            testRefs: [{ path: "runtime/requirements-traceability/__tests__/traceability.test.ts", type: "ARTIFACT_REFERENCE" }],
            proofRefs: [{ path: "runtime/requirements-traceability/__tests__/traceability.test.ts", type: "ARTIFACT_REFERENCE" }]
          }
        ],
        repoRoot
      );
      expect(issues.map((i) => i.issue).sort()).toEqual(["MISSING_PROOF_REFS", "MISSING_TEST_REFS"].sort());
    });

    it("BLOCKER regression, exact reproduction: a FAILED test result artifact cannot satisfy PROOF_VERIFIED", () => {
      const issues = detectTraceabilityIssues(
        [
          {
            id: "R-FAILED",
            status: "PROOF_VERIFIED",
            implementationRefs: ["package.json"],
            testRefs: [{ path: "package.json", type: "TEST_RESULT", outcome: "FAIL", verificationSource: "npm test (vitest)" }],
            proofRefs: [{ path: "package.json", type: "PROOF_RESULT", outcome: "FAIL", verificationSource: "npm test (vitest)" }]
          }
        ],
        repoRoot
      );
      expect(issues.map((i) => i.issue).sort()).toEqual(["MISSING_PROOF_REFS", "MISSING_TEST_REFS"].sort());
    });

    it("BLOCKER regression: a caller-written {type, outcome: PASS} with no stated verificationSource cannot satisfy PROOF_VERIFIED", () => {
      const issues = detectTraceabilityIssues(
        [
          {
            id: "R-NO-SOURCE",
            status: "PROOF_VERIFIED",
            implementationRefs: ["package.json"],
            testRefs: [{ path: "package.json", type: "TEST_RESULT", outcome: "PASS" }],
            proofRefs: [{ path: "package.json", type: "PROOF_RESULT", outcome: "PASS" }]
          }
        ],
        repoRoot
      );
      expect(issues.map((i) => i.issue).sort()).toEqual(["MISSING_PROOF_REFS", "MISSING_TEST_REFS"].sort());
    });

    it("no-regression: a valid, signed/authoritative PASS artifact WITH a named verificationSource satisfies the corresponding evidence gate", () => {
      const ref = { path: VERIFIED_ARTIFACT_PATH, type: "TEST_RESULT" as const, outcome: "PASS", verificationSource: "npm test (vitest), full repository suite" };
      expect(isOutcomeVerifiedEvidenceRef(ref, repoRoot)).toBe(true);

      const issues = detectTraceabilityIssues(
        [
          {
            id: "R-VALID",
            status: "PROOF_VERIFIED",
            implementationRefs: ["package.json"],
            testRefs: [ref],
            proofRefs: [{ path: VERIFIED_ARTIFACT_PATH, type: "PROOF_RESULT", outcome: "PASS", verificationSource: "npm test (vitest), full repository suite" }]
          }
        ],
        repoRoot
      );
      expect(issues).toHaveLength(0);
    });

    it("a bare directory reference is rejected as proof — it never carries an outcome-bearing type", () => {
      const ref = "runtime/audit";
      expect(isOutcomeVerifiedEvidenceRef(ref, repoRoot)).toBe(false);
    });
  }
);

describe(
  "P1 fix (independent Codex review, 'do not trust caller-authored evidence outcomes'): a caller's own " +
    "typed type/outcome/verificationSource claim must never, by itself, make an arbitrary file count as " +
    "PROOF_VERIFIED-grade evidence",
  () => {
    it(
      "BLOCKER regression, exact reproduction: {path: 'package.json', type: 'PROOF_RESULT', outcome: 'PASS', " +
        "verificationSource: 'anything'} is REJECTED — package.json is a manifest, not a verification artifact",
      () => {
        const ref = { path: "package.json", type: "PROOF_RESULT" as const, outcome: "PASS", verificationSource: "anything" };
        expect(isOutcomeVerifiedEvidenceRef(ref, repoRoot)).toBe(false);
      }
    );

    it("BLOCKER regression: an otherwise-valid, recognized-artifact ref with verificationSource: 'anything' is still rejected — a caller-invented source name is never authoritative", () => {
      const ref = { path: VERIFIED_ARTIFACT_PATH, type: "PROOF_RESULT" as const, outcome: "PASS", verificationSource: "anything" };
      expect(isOutcomeVerifiedEvidenceRef(ref, repoRoot)).toBe(false);
    });

    it("BLOCKER regression: a generic source file (not a manifest, not package.json, just an ordinary module) claiming PROOF_RESULT is also rejected", () => {
      const ref = {
        path: "runtime/requirements-traceability/traceability.ts",
        type: "PROOF_RESULT" as const,
        outcome: "PASS",
        verificationSource: "npm test (vitest)"
      };
      expect(isOutcomeVerifiedEvidenceRef(ref, repoRoot)).toBe(false);
    });

    it("no-regression: a real proof result generated by this repository's own approved proof flow (proofs/**/*.test.ts) with a recognized verificationSource IS accepted", () => {
      const ref = {
        path: "proofs/cache-reuse/proof.test.ts",
        type: "PROOF_RESULT" as const,
        outcome: "PASS",
        verificationSource: "npm test (vitest), full repository suite"
      };
      expect(isOutcomeVerifiedEvidenceRef(ref, repoRoot)).toBe(true);
    });

    it("no-regression: the real, existing CI workflow that runs this Factory's own verification suite remains a recognized PROOF_RESULT artifact location", () => {
      const ref = {
        path: ".github/workflows/ci.yml",
        type: "PROOF_RESULT" as const,
        outcome: "PASS",
        verificationSource: "npm test (vitest), full repository suite"
      };
      expect(isOutcomeVerifiedEvidenceRef(ref, repoRoot)).toBe(true);
    });

    it("end-to-end: a requirement citing the fabricated package.json PROOF_RESULT is flagged MISSING_PROOF_REFS, not silently accepted as PROOF_VERIFIED", () => {
      const issues = detectTraceabilityIssues(
        [
          {
            id: "R-FAKE-PROOF",
            status: "PROOF_VERIFIED",
            implementationRefs: ["package.json"],
            testRefs: [{ path: VERIFIED_ARTIFACT_PATH, type: "TEST_RESULT", outcome: "PASS", verificationSource: "npm test (vitest)" }],
            proofRefs: [{ path: "package.json", type: "PROOF_RESULT", outcome: "PASS", verificationSource: "anything" }]
          }
        ],
        repoRoot
      );
      expect(issues.map((i) => i.issue)).toEqual(["MISSING_PROOF_REFS"]);
    });
  }
);
