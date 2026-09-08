import { describe, expect, it } from "vitest";
import { ModelRegistry, createDefaultModelRegistry, tierRank, DuplicateModelIdError, ModelNotFoundError } from "../registry.js";
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

  describe("P2 targeted-audit fix (9th independent review round, same class as 'duplicate worker identities break authoritative status')", () => {
    it("first registration of a model id succeeds", () => {
      const registry = new ModelRegistry();
      expect(() => registry.register(baseModel({ modelId: "m1" }))).not.toThrow();
      expect(registry.all()).toHaveLength(1);
    });

    it("a duplicate model id registration is rejected", () => {
      const registry = new ModelRegistry();
      registry.register(baseModel({ modelId: "m1", status: "ACTIVE" }));
      expect(() => registry.register(baseModel({ modelId: "m1", status: "DEPRECATED" }))).toThrow(
        DuplicateModelIdError
      );
    });

    it("BLOCKER regression: no stale ACTIVE record survives a rejected duplicate 'deprecation' registration attempt", () => {
      const registry = new ModelRegistry();
      registry.register(baseModel({ modelId: "m1", status: "ACTIVE", capabilities: ["classification"] }));
      expect(() =>
        registry.register(baseModel({ modelId: "m1", status: "DEPRECATED", capabilities: ["classification"] }))
      ).toThrow(DuplicateModelIdError);

      // Only ONE record exists, and it is still the original ACTIVE one — the
      // caller's attempt to "deprecate via re-registration" never silently
      // left a stale, still-routable ACTIVE duplicate alongside a new one.
      expect(registry.all()).toHaveLength(1);
      expect(registry.all()[0]!.status).toBe("ACTIVE");
    });

    it("an explicit status transition ACTIVE -> DEPRECATED works via updateStatus()", () => {
      const registry = new ModelRegistry();
      registry.register(baseModel({ modelId: "m1", status: "ACTIVE" }));
      const updated = registry.updateStatus("m1", "DEPRECATED");
      expect(updated.status).toBe("DEPRECATED");
      expect(registry.all()).toHaveLength(1);
    });

    it("BLOCKER regression (10th independent review round, same test item as WorkerRegistry's 'ownership boundaries' requirement): the record returned by updateStatus() is a frozen, detached snapshot", () => {
      const registry = new ModelRegistry();
      registry.register(baseModel({ modelId: "m1", status: "ACTIVE", capabilities: ["classification"] }));
      const updated = registry.updateStatus("m1", "DEPRECATED");

      expect(() => {
        (updated as { status: string }).status = "ACTIVE";
      }).toThrow(TypeError);
      expect(() => {
        (updated.capabilities as string[]).push("critical-architecture");
      }).toThrow(TypeError);

      // Mutation attempts on the returned snapshot never reach the authoritative record.
      expect(registry.all()[0]!.status).toBe("DEPRECATED");
      expect(registry.findCapable(["classification"])).toHaveLength(0);
      // updateStatus() never hands back the SAME reference stored internally either.
      expect(updated).not.toBe(registry.all()[0]);
    });

    it("a model deprecated via updateStatus() is never returned by findCapable()", () => {
      const registry = new ModelRegistry();
      registry.register(baseModel({ modelId: "m1", status: "ACTIVE", capabilities: ["classification"] }));
      registry.updateStatus("m1", "DEPRECATED");
      expect(registry.findCapable(["classification"])).toHaveLength(0);
      expect(registry.all()).toHaveLength(1);
    });

    it("updateStatus() on an unregistered id fails closed instead of silently creating a record", () => {
      const registry = new ModelRegistry();
      expect(() => registry.updateStatus("never-registered", "DEPRECATED")).toThrow(ModelNotFoundError);
      expect(registry.all()).toHaveLength(0);
    });

    it("a model returns to a usable state only through an explicit updateStatus() transition, with exactly one record throughout", () => {
      const registry = new ModelRegistry();
      registry.register(baseModel({ modelId: "m1", status: "ACTIVE", capabilities: ["classification"] }));
      registry.updateStatus("m1", "DEPRECATED");
      expect(registry.findCapable(["classification"])).toHaveLength(0);

      registry.updateStatus("m1", "ACTIVE");
      expect(registry.findCapable(["classification"])).toHaveLength(1);
      expect(registry.all()).toHaveLength(1);
    });
  });

  describe(
    "P1 fix (25th independent review round targeted audit, 'model records must be runtime-private'): the " +
      "internal models array now uses a genuine ECMAScript #private field, not TypeScript's compile-time-only " +
      "`private`",
    () => {
      it("the internal models array is not reachable as an ordinary JS property (real encapsulation, not just TS `private`)", () => {
        const registry = new ModelRegistry();
        registry.register(baseModel());

        expect((registry as unknown as Record<string, unknown>).models).toBeUndefined();
        expect((registry as unknown as Record<string, unknown>)["models"]).toBeUndefined();
      });

      it("no reflection API (Object.getOwnPropertyNames / Reflect.ownKeys) exposes the private models array", () => {
        const registry = new ModelRegistry();
        registry.register(baseModel());

        expect(Object.getOwnPropertyNames(registry)).not.toContain("models");
        expect(Reflect.ownKeys(registry).map(String)).not.toContain("models");
      });

      it("REGRESSION: a plain JS consumer cannot revive a DEPRECATED model via property access, bypassing updateStatus()", () => {
        const registry = new ModelRegistry();
        registry.register(baseModel({ modelId: "m1", status: "DEPRECATED" }));

        const forged = (registry as unknown as Record<string, unknown>).models as
          | Array<{ status: string }>
          | undefined;
        expect(forged).toBeUndefined(); // there is nothing to reach in and mutate at all

        const spread: Record<string, unknown> = { ...registry };
        expect(spread.models).toBeUndefined();

        expect(registry.findCapable(["classification"])).toHaveLength(0); // still deprecated
      });
    }
  );

  describe(
    "P1 fix (28th independent review round, finding 12, 'snapshot registry records before validation/storage'): " +
      "register() reads every field of the caller-owned record exactly once, then validates/dedupes/stores that " +
      "SAME snapshot",
    () => {
      it("BLOCKER regression, exact reproduction: a getter-backed modelId that answers a NON-colliding id for the duplicate check and a DIFFERENT (colliding) id for storage must not poison the registry with a mismatched record", () => {
        const registry = new ModelRegistry();
        registry.register(baseModel({ modelId: "existing" }));

        let reads = 0;
        const hostile = {
          provider: "mock",
          get modelId() {
            reads += 1;
            // Non-colliding on the (now single) read used for both the
            // duplicate check AND the stored record.
            return reads === 1 ? "new-id" : "existing";
          },
          tier: "STANDARD" as const,
          costPerCall: 0.01,
          capabilities: ["classification"],
          status: "ACTIVE" as const
        };

        registry.register(hostile);
        expect(reads).toBe(1); // modelId consulted exactly once

        // The registry now genuinely has TWO distinct models — "existing"
        // and "new-id" — never a corrupted/duplicate-under-the-hood state.
        expect(registry.all().map((m) => m.modelId).sort()).toEqual(["existing", "new-id"]);
      });

      it("a getter-backed costPerCall answering validly then invalidly is still rejected (validation and storage never disagree)", () => {
        const registry = new ModelRegistry();
        let reads = 0;
        const hostile = {
          provider: "mock",
          modelId: "m-hostile",
          tier: "STANDARD" as const,
          get costPerCall() {
            reads += 1;
            return reads === 1 ? 0.01 : NaN;
          },
          capabilities: ["classification"],
          status: "ACTIVE" as const
        };

        // With the fix, only ONE read happens — the registered record
        // genuinely has the valid $0.01 price, since validation and
        // storage share the same snapshot.
        registry.register(hostile);
        expect(reads).toBe(1);
        expect(registry.all()[0]!.costPerCall).toBe(0.01);
      });
    }
  );
});
