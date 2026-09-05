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

  describe("P1 fix (targeted ownership audit): registered/returned models cannot be mutated via a leaked reference", () => {
    it("mutating the object passed into register() after registration does not affect routing", () => {
      const registry = new ModelRegistry();
      const model: { provider: string; modelId: string; tier: "STANDARD"; costPerCall: number; capabilities: string[]; status: "RETIRED" | "ACTIVE" } = {
        provider: "mock",
        modelId: "m1",
        tier: "STANDARD",
        costPerCall: 0.01,
        capabilities: ["classification"],
        status: "RETIRED"
      };
      registry.register(model);
      model.status = "ACTIVE"; // caller mutates their own object after the fact

      expect(registry.findCapable(["classification"])).toHaveLength(0); // still excluded
    });

    it("mutating a record returned by all()/findCapable() cannot bias routing (costPerCall, status, capabilities)", () => {
      const registry = new ModelRegistry();
      registry.register({
        provider: "mock",
        modelId: "m1",
        tier: "PREMIUM",
        costPerCall: 0.5,
        capabilities: ["classification"],
        status: "ACTIVE"
      });

      const [model] = registry.all();
      expect(() => {
        (model as { costPerCall: number }).costPerCall = 0;
      }).toThrow(TypeError);
      expect(() => {
        (model.capabilities as string[]).push("critical-architecture");
      }).toThrow(TypeError);

      expect(registry.all()[0]!.costPerCall).toBe(0.5);
      expect(registry.findCapable(["critical-architecture"])).toHaveLength(0);
    });
  });
});
