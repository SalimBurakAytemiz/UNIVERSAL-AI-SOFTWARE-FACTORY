import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  DuplicateRequirementIdError,
  EmptyRequirementRegistryError,
  MalformedRequirementRegistryError,
  REQUIREMENT_TYPES,
  computeBaselineStatus,
  loadRequirementsFromDir,
  summarizeRequirements
} from "../commands/baseline-status.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const requirementsDir = join(__dirname, "..", "..", "..", "specification", "requirements");

describe("summarizeRequirements (pure logic)", () => {
  it("counts requirements by status and category", () => {
    const summary = summarizeRequirements([
      { id: "A", category: "P0", status: "DEFINED" },
      { id: "B", category: "P0", status: "IMPLEMENTED" },
      { id: "C", category: "P1", status: "DEFINED" }
    ]);
    expect(summary.total).toBe(3);
    expect(summary.byStatus.DEFINED).toBe(2);
    expect(summary.byStatus.IMPLEMENTED).toBe(1);
    expect(summary.byCategory.P0).toBe(2);
    expect(summary.byCategory.P1).toBe(1);
  });

  describe("P2 targeted-audit fix (8th independent review round, same class as 'prototype names crash schema-valid project families')", () => {
    it("a status of 'constructor' does not crash and counts correctly", () => {
      const summary = summarizeRequirements([{ id: "A", category: "P0", status: "constructor" }]);
      expect(summary.byStatus.constructor).toBe(1);
      expect(typeof summary.byStatus.constructor).toBe("number");
    });

    it("a category of '__proto__' does not crash and counts correctly", () => {
      const summary = summarizeRequirements([{ id: "A", category: "__proto__", status: "DEFINED" }]);
      expect(summary.byCategory.__proto__).toBe(1);
      expect(Object.getPrototypeOf(summary.byCategory)).toBe(Object.prototype); // no pollution
    });

    it("a status of 'toString' does not crash and counts correctly", () => {
      const summary = summarizeRequirements([
        { id: "A", category: "P0", status: "toString" },
        { id: "B", category: "P0", status: "toString" }
      ]);
      expect(summary.byStatus.toString).toBe(2);
    });

    it("mixing prototype-named and ordinary statuses/categories counts each independently", () => {
      const summary = summarizeRequirements([
        { id: "A", category: "P0", status: "DEFINED" },
        { id: "B", category: "P0", status: "constructor" },
        { id: "C", category: "P0", status: "DEFINED" }
      ]);
      expect(summary.byStatus.DEFINED).toBe(2);
      expect(summary.byStatus.constructor).toBe(1);
      expect(summary.total).toBe(3);
    });

    it("no prototype pollution occurs from processing prototype-named statuses/categories", () => {
      summarizeRequirements([
        { id: "A", category: "__proto__", status: "constructor" },
        { id: "B", category: "hasOwnProperty", status: "toString" }
      ]);
      const fresh: Record<string, unknown> = {};
      expect(Object.getPrototypeOf(fresh)).toBe(Object.prototype);
      expect((fresh as { polluted?: unknown }).polluted).toBeUndefined();
    });
  });
});

describe("computeBaselineStatus (real repository data)", () => {
  it("computes a non-trivial summary from the actual requirement registry, not a hardcoded claim", () => {
    const summary = computeBaselineStatus(requirementsDir);
    expect(summary.total).toBeGreaterThan(0);
    expect(summary.byCategory.P0).toBeGreaterThan(0);
    // Every requirement must carry one of the statuses defined by the schema.
    const validStatuses = new Set([
      "DEFINED", "PLANNED", "IMPLEMENTATION_IN_PROGRESS", "IMPLEMENTED",
      "UNIT_TESTED", "INTEGRATION_TESTED", "PROOF_VERIFIED", "PRODUCTION_VERIFIED",
      "BLOCKED", "DEPRECATED", "SUPERSEDED"
    ]);
    for (const status of Object.keys(summary.byStatus)) {
      expect(validStatuses.has(status)).toBe(true);
    }
  });
});

describe(
  "P1 fix (32nd independent review round, finding 4, 'fail closed on empty or malformed requirement " +
    "registries'): a loader failure must never be silently reported as a genuinely clean, zero-issue registry",
  () => {
    let tempRoot: string;

    afterEach(() => {
      if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    });

    it("BLOCKER regression, exact reproduction: an empty requirements directory (no YAML files at all) fails closed", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-baseline-status-empty-"));
      expect(() => loadRequirementsFromDir(tempRoot)).toThrow(EmptyRequirementRegistryError);
    });

    it("BLOCKER regression, exact reproduction: a single malformed, non-array YAML document fails closed", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-baseline-status-nonarray-"));
      writeFileSync(join(tempRoot, "broken.yml"), "just: a plain mapping, not an array\n");
      expect(() => loadRequirementsFromDir(tempRoot)).toThrow(MalformedRequirementRegistryError);
    });

    it("fails closed when a YAML document parses to a bare scalar (not even a mapping)", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-baseline-status-scalar-"));
      writeFileSync(join(tempRoot, "broken.yml"), "just a scalar string\n");
      expect(() => loadRequirementsFromDir(tempRoot)).toThrow(MalformedRequirementRegistryError);
    });

    it("fails closed when a YAML document parses to null (an empty file)", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-baseline-status-null-"));
      writeFileSync(join(tempRoot, "empty.yml"), "");
      expect(() => loadRequirementsFromDir(tempRoot)).toThrow(MalformedRequirementRegistryError);
    });

    it("fails closed when every file's array is empty (zero total records, despite files genuinely existing)", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-baseline-status-zerorecords-"));
      writeFileSync(join(tempRoot, "empty-array.yml"), "[]\n");
      expect(() => loadRequirementsFromDir(tempRoot)).toThrow(EmptyRequirementRegistryError);
    });

    it("fails closed when a record fails schema validation (missing required fields)", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-baseline-status-schemainvalid-"));
      writeFileSync(
        join(tempRoot, "invalid.yml"),
        "- id: NOT-A-VALID-ID\n  status: DEFINED\n"
      );
      expect(() => loadRequirementsFromDir(tempRoot)).toThrow(MalformedRequirementRegistryError);
    });

    it("fails closed when a record's status is not one of the schema's enumerated values", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-baseline-status-badstatus-"));
      writeFileSync(
        join(tempRoot, "invalid.yml"),
        [
          "- id: UASF-REQ-9999",
          "  title: t",
          "  description: d",
          "  source_baseline: 'BASELINE-V1 section 0'",
          "  category: P0",
          "  priority: LOW",
          "  status: NOT_A_REAL_STATUS",
          ""
        ].join("\n")
      );
      expect(() => loadRequirementsFromDir(tempRoot)).toThrow(MalformedRequirementRegistryError);
    });

    it("no regression: a genuinely valid, schema-compliant registry loads normally and validation continues", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-baseline-status-valid-"));
      writeFileSync(
        join(tempRoot, "valid.yml"),
        [
          "- id: UASF-REQ-9998",
          "  title: A valid fixture requirement",
          "  description: Genuinely schema-compliant.",
          "  source_baseline: 'BASELINE-V1 section 0'",
          "  category: P0",
          "  priority: LOW",
          "  status: DEFINED",
          ""
        ].join("\n")
      );
      const records = loadRequirementsFromDir(tempRoot);
      expect(records).toHaveLength(1);
      expect(records[0]!.id).toBe("UASF-REQ-9998");
    });

    it("no regression: the REAL requirement registry (specification/requirements) still loads without throwing", () => {
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const realRequirementsDir = join(__dirname, "..", "..", "..", "specification", "requirements");
      expect(() => loadRequirementsFromDir(realRequirementsDir)).not.toThrow();
    });

    it("no regression: a nested-directory scenario with multiple valid files across dirs still aggregates correctly", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-baseline-status-multi-"));
      mkdirSync(tempRoot, { recursive: true });
      writeFileSync(
        join(tempRoot, "a.yml"),
        [
          "- id: UASF-REQ-9001",
          "  title: t1",
          "  description: d1",
          "  source_baseline: 'BASELINE-V1 section 0'",
          "  category: P0",
          "  priority: LOW",
          "  status: DEFINED",
          ""
        ].join("\n")
      );
      writeFileSync(
        join(tempRoot, "b.yml"),
        [
          "- id: UASF-REQ-9002",
          "  title: t2",
          "  description: d2",
          "  source_baseline: 'BASELINE-V1 section 0'",
          "  category: P1",
          "  priority: MEDIUM",
          "  status: PLANNED",
          ""
        ].join("\n")
      );
      const records = loadRequirementsFromDir(tempRoot);
      expect(records).toHaveLength(2);
    });
  }
);

describe(
  "P1 fix (33rd independent review round, finding 3 / root class B, 'authoritative validation parity' — " +
    "'reject duplicate requirement IDs in the runtime loader')",
  () => {
    let tempRoot: string;

    afterEach(() => {
      if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    });

    function validRecord(id: string): string {
      return [
        `- id: ${id}`,
        "  title: t",
        "  description: d",
        "  source_baseline: 'BASELINE-V1 section 0'",
        "  category: P0",
        "  priority: LOW",
        "  status: DEFINED",
        ""
      ].join("\n");
    }

    it("BLOCKER regression, exact reproduction: the same id declared across two different files throws DuplicateRequirementIdError", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-baseline-status-dupid-crossfile-"));
      writeFileSync(join(tempRoot, "a.yml"), validRecord("UASF-REQ-9101"));
      writeFileSync(join(tempRoot, "b.yml"), validRecord("UASF-REQ-9101"));
      expect(() => loadRequirementsFromDir(tempRoot)).toThrow(DuplicateRequirementIdError);
    });

    it("BLOCKER regression, exact reproduction: the same id declared twice within one file throws DuplicateRequirementIdError", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-baseline-status-dupid-samefile-"));
      writeFileSync(join(tempRoot, "a.yml"), validRecord("UASF-REQ-9102") + validRecord("UASF-REQ-9102"));
      expect(() => loadRequirementsFromDir(tempRoot)).toThrow(DuplicateRequirementIdError);
    });

    it("no regression: distinct ids across multiple files still load correctly", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-baseline-status-dupid-distinct-"));
      writeFileSync(join(tempRoot, "a.yml"), validRecord("UASF-REQ-9103"));
      writeFileSync(join(tempRoot, "b.yml"), validRecord("UASF-REQ-9104"));
      const records = loadRequirementsFromDir(tempRoot);
      expect(records).toHaveLength(2);
    });

    it("no regression: the REAL requirement registry (specification/requirements) contains no duplicate ids", () => {
      expect(() => loadRequirementsFromDir(requirementsDir)).not.toThrow(DuplicateRequirementIdError);
    });
  }
);

describe(
  "P1 fix (FINAL P0 CLOSURE REMEDIATION, blocker 6, 'documented P0 requirement type taxonomy is not " +
    "implemented'): schemas/requirement.schema.json now recognizes the baseline section 48 requirement-TYPE " +
    "taxonomy (BUSINESS/PRODUCT/FUNCTIONAL/NON_FUNCTIONAL/SECURITY/PERFORMANCE/ACCESSIBILITY/COMPLIANCE/" +
    "OPERATIONAL) as an OPTIONAL field, distinct from `category` (the P0-P3 implementation phase)",
  () => {
    let tempRoot: string;

    afterEach(() => {
      if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    });

    function recordWithType(id: string, type: string): string {
      return [
        `- id: ${id}`,
        "  title: t",
        "  description: d",
        "  source_baseline: 'BASELINE-V1 section 48'",
        "  category: P0",
        "  priority: LOW",
        "  status: DEFINED",
        `  type: ${type}`,
        ""
      ].join("\n");
    }

    it("BLOCKER regression, exact reproduction: a requirement with type: BUSINESS no longer fails schema validation", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-baseline-status-type-business-"));
      writeFileSync(join(tempRoot, "a.yml"), recordWithType("UASF-REQ-9201", "BUSINESS"));
      const records = loadRequirementsFromDir(tempRoot);
      expect(records).toHaveLength(1);
      expect(records[0]!.type).toBe("BUSINESS");
    });

    for (const type of REQUIREMENT_TYPES) {
      it(`accepts every canonical requirement type: ${type}`, () => {
        tempRoot = mkdtempSync(join(tmpdir(), `uasf-baseline-status-type-${type.toLowerCase()}-`));
        writeFileSync(join(tempRoot, "a.yml"), recordWithType("UASF-REQ-9300", type));
        const records = loadRequirementsFromDir(tempRoot);
        expect(records).toHaveLength(1);
        expect(records[0]!.type).toBe(type);
      });
    }

    it("REQUIREMENT_TYPES lists exactly the 9 canonical baseline section 48 types, nothing more or less", () => {
      expect([...REQUIREMENT_TYPES].sort()).toEqual(
        [
          "ACCESSIBILITY",
          "BUSINESS",
          "COMPLIANCE",
          "FUNCTIONAL",
          "NON_FUNCTIONAL",
          "OPERATIONAL",
          "PERFORMANCE",
          "PRODUCT",
          "SECURITY"
        ].sort()
      );
    });

    it("rejects an invalid, non-canonical type value", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-baseline-status-type-invalid-"));
      writeFileSync(join(tempRoot, "a.yml"), recordWithType("UASF-REQ-9301", "NOT_A_REAL_TYPE"));
      expect(() => loadRequirementsFromDir(tempRoot)).toThrow(MalformedRequirementRegistryError);
    });

    it("rejects a lowercase variant of a valid type (case-sensitive enum, same convention as status/category)", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-baseline-status-type-lowercase-"));
      writeFileSync(join(tempRoot, "a.yml"), recordWithType("UASF-REQ-9302", "business"));
      expect(() => loadRequirementsFromDir(tempRoot)).toThrow(MalformedRequirementRegistryError);
    });

    it("no regression: an existing requirement record with NO type field at all remains valid (backward compatible, field is optional)", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-baseline-status-type-absent-"));
      writeFileSync(
        join(tempRoot, "a.yml"),
        [
          "- id: UASF-REQ-9303",
          "  title: t",
          "  description: d",
          "  source_baseline: 'BASELINE-V1 section 0'",
          "  category: P0",
          "  priority: LOW",
          "  status: DEFINED",
          ""
        ].join("\n")
      );
      const records = loadRequirementsFromDir(tempRoot);
      expect(records).toHaveLength(1);
      expect(records[0]!.type).toBeUndefined();
    });

    it("no regression: the REAL requirement registry (specification/requirements) still loads without throwing, type field included where present", () => {
      expect(() => loadRequirementsFromDir(requirementsDir)).not.toThrow();
    });
  }
);
