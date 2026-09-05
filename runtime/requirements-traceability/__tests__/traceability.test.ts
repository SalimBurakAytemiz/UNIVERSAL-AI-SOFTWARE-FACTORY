import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { detectTraceabilityIssues } from "../traceability.js";
import { traceRequirements } from "../../cli/commands/trace-requirement.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const requirementsDir = join(__dirname, "..", "..", "..", "specification", "requirements");

describe("detectTraceabilityIssues (pure logic)", () => {
  it("flags a requirement claiming IMPLEMENTATION_IN_PROGRESS with no implementation_refs", () => {
    const issues = detectTraceabilityIssues([
      { id: "R1", status: "IMPLEMENTATION_IN_PROGRESS", implementationRefs: [], testRefs: [], proofRefs: [] }
    ]);
    expect(issues).toEqual([{ requirementId: "R1", issue: "MISSING_IMPLEMENTATION_REFS", status: "IMPLEMENTATION_IN_PROGRESS" }]);
  });

  it("flags a requirement claiming UNIT_TESTED with no test_refs, even if implementation_refs exist", () => {
    const issues = detectTraceabilityIssues([
      { id: "R2", status: "UNIT_TESTED", implementationRefs: ["src/x.ts"], testRefs: [], proofRefs: [] }
    ]);
    expect(issues.map((i) => i.issue)).toEqual(["MISSING_TEST_REFS"]);
  });

  it("flags a requirement claiming PROOF_VERIFIED with no proof_refs", () => {
    const issues = detectTraceabilityIssues([
      { id: "R3", status: "PROOF_VERIFIED", implementationRefs: ["src/x.ts"], testRefs: ["test/x.test.ts"], proofRefs: [] }
    ]);
    expect(issues.map((i) => i.issue)).toEqual(["MISSING_PROOF_REFS"]);
  });

  it("does not flag a fully-evidenced requirement", () => {
    const issues = detectTraceabilityIssues([
      { id: "R4", status: "PROOF_VERIFIED", implementationRefs: ["src/x.ts"], testRefs: ["test/x.test.ts"], proofRefs: ["proofs/x/proof.test.ts"] }
    ]);
    expect(issues).toHaveLength(0);
  });

  it("does not evaluate BLOCKED, DEPRECATED, or SUPERSEDED requirements", () => {
    const issues = detectTraceabilityIssues([
      { id: "R5", status: "BLOCKED", implementationRefs: [], testRefs: [], proofRefs: [] },
      { id: "R6", status: "DEPRECATED", implementationRefs: [], testRefs: [], proofRefs: [] },
      { id: "R7", status: "SUPERSEDED", implementationRefs: [], testRefs: [], proofRefs: [] }
    ]);
    expect(issues).toHaveLength(0);
  });

  it("a DEFINED requirement with no refs at all is not an issue (nothing claimed yet)", () => {
    const issues = detectTraceabilityIssues([
      { id: "R8", status: "DEFINED", implementationRefs: [], testRefs: [], proofRefs: [] }
    ]);
    expect(issues).toHaveLength(0);
  });
});

describe("detectTraceabilityIssues over the real requirement registry", () => {
  it("the actual specification/requirements/ registry has zero unsupported status upgrades", () => {
    const issues = traceRequirements(requirementsDir);
    expect(issues).toEqual([]);
  });
});
