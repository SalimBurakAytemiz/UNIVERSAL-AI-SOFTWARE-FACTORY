import { describe, expect, it } from "vitest";
import { deriveSafeAssumptions, selectClarificationQuestions, type DiscoveryItem } from "../discovery-engine.js";

const items: DiscoveryItem[] = [
  { topic: "payment-provider", classification: "CRITICAL", question: "Which payment provider?" },
  { topic: "target-region", classification: "CRITICAL", question: "Which region launches first?" },
  { topic: "refund-policy", classification: "IMPORTANT", question: "What is the refund window?" },
  { topic: "brand-colors", classification: "OPTIONAL", question: "Preferred brand colors?" },
  { topic: "timezone-format", classification: "DERIVABLE", question: "Which timezone format?" }
];

describe("selectClarificationQuestions", () => {
  it("always includes every CRITICAL item, never dropping one for batch size", () => {
    const manyCritical: DiscoveryItem[] = Array.from({ length: 10 }, (_, i) => ({
      topic: `critical-${i}`,
      classification: "CRITICAL",
      question: `Question ${i}?`
    }));
    const selected = selectClarificationQuestions(manyCritical, 7);
    expect(selected).toHaveLength(10); // all critical items survive even beyond the 7-question soft cap
  });

  it("never asks OPTIONAL or DERIVABLE items directly", () => {
    const selected = selectClarificationQuestions(items);
    expect(selected.map((i) => i.classification)).not.toContain("OPTIONAL");
    expect(selected.map((i) => i.classification)).not.toContain("DERIVABLE");
  });

  it("fills remaining capacity with IMPORTANT items after all CRITICAL are included", () => {
    const selected = selectClarificationQuestions(items, 7);
    expect(selected.map((i) => i.topic)).toEqual(
      expect.arrayContaining(["payment-provider", "target-region", "refund-policy"])
    );
  });
});

describe("deriveSafeAssumptions", () => {
  it("converts an unasked IMPORTANT item into a safe assumption candidate", () => {
    const assumptions = deriveSafeAssumptions(items, new Set());
    expect(assumptions.map((a) => a.topic)).toEqual(["refund-policy"]);
  });

  it("does not re-derive an assumption for a topic that was already asked", () => {
    const assumptions = deriveSafeAssumptions(items, new Set(["refund-policy"]));
    expect(assumptions).toHaveLength(0);
  });
});
