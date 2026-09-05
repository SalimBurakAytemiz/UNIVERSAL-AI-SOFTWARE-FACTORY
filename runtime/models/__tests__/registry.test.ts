import { describe, expect, it } from "vitest";
import { ModelRegistry, createDefaultModelRegistry, tierRank } from "../registry.js";
import { InvalidMonetaryAmountError } from "../../cost/cost-engine.js";

function baseModel(overrides: Partial<Parameters<ModelRegistry["register"]>[0]> = {}) {
  return {
    provider: "mock",
    modelId: "m1",
    tier: "STANDARD" as const,
    costPerCall: 0.01,
    capabilities: ["classification"],
    status: "ACTIVE" as const,
    ...overrides
  };
}

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

  describe("P2 regression (7th independent review round, 'invalid model prices corrupt cheapest-capable routing')", () => {
    it("rejects NaN costPerCall before the record ever reaches the registry", () => {
      const registry = new ModelRegistry();
      expect(() => registry.register(baseModel({ costPerCall: Number.NaN }))).toThrow(InvalidMonetaryAmountError);
      expect(registry.all()).toHaveLength(0);
    });

    it("rejects +Infinity costPerCall", () => {
      const registry = new ModelRegistry();
      expect(() => registry.register(baseModel({ costPerCall: Number.POSITIVE_INFINITY }))).toThrow(InvalidMonetaryAmountError);
      expect(registry.all()).toHaveLength(0);
    });

    it("rejects -Infinity costPerCall", () => {
      const registry = new ModelRegistry();
      expect(() => registry.register(baseModel({ costPerCall: Number.NEGATIVE_INFINITY }))).toThrow(InvalidMonetaryAmountError);
      expect(registry.all()).toHaveLength(0);
    });

    it("rejects a negative costPerCall", () => {
      const registry = new ModelRegistry();
      expect(() => registry.register(baseModel({ costPerCall: -0.01 }))).toThrow(InvalidMonetaryAmountError);
      expect(registry.all()).toHaveLength(0);
    });

    it("accepts a zero costPerCall (free models must remain valid)", () => {
      const registry = new ModelRegistry();
      expect(() => registry.register(baseModel({ costPerCall: 0 }))).not.toThrow();
      expect(registry.all()).toHaveLength(1);
    });

    it("accepts an ordinary positive costPerCall", () => {
      const registry = new ModelRegistry();
      expect(() => registry.register(baseModel({ costPerCall: 0.005 }))).not.toThrow();
      expect(registry.all()).toHaveLength(1);
    });

    it("a rejected registration does not corrupt findCapable() results for previously-registered valid models", () => {
      const registry = new ModelRegistry();
      registry.register(baseModel({ modelId: "valid-model", costPerCall: 0.02 }));
      expect(() => registry.register(baseModel({ modelId: "poisoned-model", costPerCall: Number.NaN }))).toThrow(
        InvalidMonetaryAmountError
      );
      const capable = registry.findCapable(["classification"]);
      expect(capable).toHaveLength(1);
      expect(capable[0]!.modelId).toBe("valid-model");
    });

    it("REGRESSION: a premium candidate registered FIRST with a poisoned NaN price would previously beat a genuinely cheaper free candidate — this can no longer happen because registration itself now fails closed", () => {
      const registry = new ModelRegistry();
      expect(() =>
        registry.register(
          baseModel({ modelId: "premium-poisoned", tier: "PREMIUM", costPerCall: Number.NaN, capabilities: ["coding"] })
        )
      ).toThrow(InvalidMonetaryAmountError);
      registry.register(baseModel({ modelId: "free-capable", tier: "MOCK", costPerCall: 0, capabilities: ["coding"] }));

      const capable = registry.findCapable(["coding"]);
      // Only the genuinely valid, cheap candidate ever entered the registry —
      // there is no poisoned NaN-priced record left to corrupt a
      // cheapest-of(candidates) reduce/sort anywhere downstream (router.ts).
      expect(capable).toHaveLength(1);
      expect(capable[0]!.modelId).toBe("free-capable");
      expect(capable[0]!.costPerCall).toBe(0);
    });

    it("createDefaultModelRegistry()'s built-in models all carry valid, finite, non-negative prices", () => {
      const registry = createDefaultModelRegistry();
      for (const model of registry.all()) {
        expect(Number.isFinite(model.costPerCall)).toBe(true);
        expect(model.costPerCall).toBeGreaterThanOrEqual(0);
      }
    });

    it("the InvalidMonetaryAmountError message identifies the offending model for debuggability", () => {
      const registry = new ModelRegistry();
      try {
        registry.register(baseModel({ modelId: "bad-model", costPerCall: Number.NaN }));
        throw new Error("expected register() to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidMonetaryAmountError);
        expect((err as Error).message).toContain("bad-model");
      }
    });
  });
});
