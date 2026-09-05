// Proof A (baseline section 306): "A trivial task does not automatically
// use a premium model." This proof stands separately from the router's own
// unit tests (runtime/models/__tests__/router.test.ts) because it is a
// baseline-mandated deliverable in its own right (section 305, item 17).
import { describe, expect, it } from "vitest";
import { createDefaultModelRegistry } from "../../runtime/models/registry.js";
import { CheapestCapableModelRouter } from "../../runtime/models/router.js";

describe("Proof: Cheapest Capable Model routing", () => {
  it("never selects a PREMIUM-tier model for a trivial (risk 0) task", () => {
    const router = new CheapestCapableModelRouter(createDefaultModelRegistry());
    const decision = router.selectModel({
      taskId: "summarize-changelog",
      risk: 0,
      requiredCapabilities: ["summarization"]
    });
    expect(decision.model.tier).not.toBe("PREMIUM");
    expect(decision.model.costPerCall).toBe(0);
  });

  it("selects the cheapest model that actually satisfies a higher-risk requirement, not the most expensive one available", () => {
    const router = new CheapestCapableModelRouter(createDefaultModelRegistry());
    const decision = router.selectModel({
      taskId: "code-review",
      risk: 3,
      requiredCapabilities: ["code-review"]
    });
    // mock-standard-coder ($0.01) satisfies this, not mock-premium-architect ($0.20)
    expect(decision.model.modelId).toBe("mock-standard-coder");
  });
});
