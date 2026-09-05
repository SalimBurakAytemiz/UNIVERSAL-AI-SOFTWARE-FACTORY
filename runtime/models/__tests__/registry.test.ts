import { describe, expect, it } from "vitest";
import { ModelRegistry, createDefaultModelRegistry, tierRank } from "../registry.js";

describe("ModelRegistry", () => {
  it("finds only models that support every required capability", () => {
    const registry = createDefaultModelRegistry();
    const capable = registry.findCapable(["critical-architecture"]);
    expect(capable).toHaveLength(1);
    expect(capable[0]!.modelId).toBe("mock-premium-architect");
  });

  it("excludes retired/deprecated models from routing candidates", () => {
    const registry = new ModelRegistry();
    registry.register({
      provider: "mock",
      modelId: "old-model",
      tier: "STANDARD",
      costPerCall: 0.005,
      capabilities: ["classification"],
      status: "RETIRED"
    });
    expect(registry.findCapable(["classification"])).toHaveLength(0);
  });

  it("orders tiers from cheapest-capability class to most capable", () => {
    expect(tierRank("MOCK")).toBeLessThan(tierRank("STANDARD"));
    expect(tierRank("STANDARD")).toBeLessThan(tierRank("PREMIUM"));
    expect(tierRank("PREMIUM")).toBeLessThan(tierRank("CRITICAL_REVIEW"));
  });
});
