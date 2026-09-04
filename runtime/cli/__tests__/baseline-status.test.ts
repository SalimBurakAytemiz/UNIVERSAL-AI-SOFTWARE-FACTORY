import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { computeBaselineStatus, summarizeRequirements } from "../commands/baseline-status.js";

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
