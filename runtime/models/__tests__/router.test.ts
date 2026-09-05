import { describe, expect, it } from "vitest";
import { createDefaultModelRegistry, ModelRegistry } from "../registry.js";
import { ModelGateway } from "../gateway.js";
import { MockProvider } from "../providers/mock-provider.js";
import {
  CheapestCapableModelRouter,
  NoCapableModelError,
  PremiumFallbackBlockedError
} from "../router.js";

function setup() {
  const registry = createDefaultModelRegistry();
  const gateway = new ModelGateway();
  gateway.registerProvider(new MockProvider());
  const router = new CheapestCapableModelRouter(registry);
  return { registry, gateway, router };
}

describe("CheapestCapableModelRouter", () => {
  it("Proof A: a trivial (risk 0) task never selects the premium model", () => {
    const { router } = setup();
    const decision = router.selectModel({
      taskId: "trivial-tagging",
      risk: 0,
      requiredCapabilities: ["tagging"]
    });
    expect(decision.model.tier).not.toBe("PREMIUM");
    expect(decision.model.modelId).toBe("mock-classifier");
  });

  it("selects the cheapest model among all that satisfy the risk floor and capabilities", () => {
    const { router } = setup();
    const decision = router.selectModel({
      taskId: "medium-implementation",
      risk: 3,
      requiredCapabilities: ["implementation"]
    });
    expect(decision.model.modelId).toBe("mock-standard-coder");
  });

  it("throws NoCapableModelError when no registered model satisfies the requirement", () => {
    const { router } = setup();
    expect(() =>
      router.selectModel({ taskId: "impossible", risk: 0, requiredCapabilities: ["nonexistent-capability" as never] })
    ).toThrow(NoCapableModelError);
  });

  it("Proof B: a valid cheap-model result does not escalate", async () => {
    const { router, gateway } = setup();
    const result = await router.routeAndExecute(
      { taskId: "tagging-ok", risk: 0, requiredCapabilities: ["tagging"] },
      gateway,
      { prompt: "tag this" },
      () => true // validation always passes
    );
    expect(result.decision.escalated).toBe(false);
    expect(result.decision.model.tier).toBe("MOCK");
  });

  it("Proof D: premium fallback is blocked by default when validation fails", async () => {
    const { router, gateway } = setup();
    await expect(
      router.routeAndExecute(
        { taskId: "tagging-fails", risk: 0, requiredCapabilities: ["tagging"] },
        gateway,
        { prompt: "tag this" },
        () => false // validation always fails
        // allowPremiumFallback intentionally omitted -> defaults to false
      )
    ).rejects.toThrow(PremiumFallbackBlockedError);
  });

  it("Proof C: a failed low-cost model can escalate when explicitly authorized", async () => {
    const { router, gateway } = setup();
    const result = await router.routeAndExecute(
      { taskId: "implementation-needs-escalation", risk: 3, requiredCapabilities: ["implementation"] },
      gateway,
      { prompt: "implement this" },
      () => false,
      { allowPremiumFallback: true }
    );
    expect(result.decision.escalated).toBe(true);
    expect(result.decision.model.tier).toBe("PREMIUM");
  });
});

/**
 * Regression coverage for a bug where escalation was computed from
 * `initialDecision.requiredTier` (the minimum risk-derived tier) instead
 * of the tier of the model actually selected. When a capability
 * requirement forces a pricier model than the risk floor demands, the old
 * logic could pick the exact same (or an equally weak) model again on
 * "escalation" instead of genuinely moving up a quality level.
 */
function setupCapabilityDrivenPromotionScenario() {
  const registry = new ModelRegistry();
  // No MOCK/LOCAL_FREE/VERY_LOW_COST model supports this capability —
  // only STANDARD and PREMIUM do — so even a risk-0 task is forced above
  // the MOCK tier that minTierForRisk(0) would otherwise imply.
  registry.register({
    provider: "mock",
    modelId: "niche-standard",
    tier: "STANDARD",
    costPerCall: 0.02,
    capabilities: ["niche-capability"],
    status: "ACTIVE"
  });
  registry.register({
    provider: "mock",
    modelId: "niche-premium",
    tier: "PREMIUM",
    costPerCall: 0.5,
    capabilities: ["niche-capability"],
    status: "ACTIVE"
  });

  const gateway = new ModelGateway();
  gateway.registerProvider(new MockProvider());
  const router = new CheapestCapableModelRouter(registry);
  return { registry, gateway, router };
}

describe("CheapestCapableModelRouter escalation (capability-driven initial promotion)", () => {
  it("selects the cheaper STANDARD-tier model for a risk-0 task when only STANDARD/PREMIUM support the capability", () => {
    const { router } = setupCapabilityDrivenPromotionScenario();
    const decision = router.selectModel({
      taskId: "niche-task",
      risk: 0,
      requiredCapabilities: ["niche-capability"]
    });
    // The risk floor (requiredTier) is MOCK, but the actually selected model is STANDARD —
    // these two are legitimately different, which is exactly what the escalation bug ignored.
    expect(decision.requiredTier).toBe("MOCK");
    expect(decision.model.tier).toBe("STANDARD");
    expect(decision.model.modelId).toBe("niche-standard");
  });

  it("escalates to the tier ABOVE the actually-selected model, not a same-or-lower tier reselection", async () => {
    const { router, gateway } = setupCapabilityDrivenPromotionScenario();
    const result = await router.routeAndExecute(
      { taskId: "niche-task", risk: 0, requiredCapabilities: ["niche-capability"] },
      gateway,
      { prompt: "do the niche thing" },
      () => false, // validation always fails
      { allowPremiumFallback: true }
    );

    expect(result.decision.escalated).toBe(true);
    // Must move up from STANDARD to PREMIUM, never reselect the same STANDARD model.
    expect(result.decision.model.tier).toBe("PREMIUM");
    expect(result.decision.model.modelId).toBe("niche-premium");
    expect(result.decision.model.modelId).not.toBe("niche-standard");
  });

  it("premium fallback policy remains enforced in the capability-driven-promotion scenario", async () => {
    const { router, gateway } = setupCapabilityDrivenPromotionScenario();
    await expect(
      router.routeAndExecute(
        { taskId: "niche-task", risk: 0, requiredCapabilities: ["niche-capability"] },
        gateway,
        { prompt: "do the niche thing" },
        () => false
        // allowPremiumFallback intentionally omitted -> defaults to false
      )
    ).rejects.toThrow(PremiumFallbackBlockedError);
  });

  it("throws NoCapableModelError instead of looping when already at the top tier", async () => {
    const registry = new ModelRegistry();
    registry.register({
      provider: "mock",
      modelId: "only-critical",
      tier: "CRITICAL_REVIEW",
      costPerCall: 1,
      capabilities: ["niche-capability"],
      status: "ACTIVE"
    });
    const gateway = new ModelGateway();
    gateway.registerProvider(new MockProvider());
    const router = new CheapestCapableModelRouter(registry);

    await expect(
      router.routeAndExecute(
        { taskId: "already-top", risk: 0, requiredCapabilities: ["niche-capability"] },
        gateway,
        { prompt: "x" },
        () => false,
        { allowPremiumFallback: true }
      )
    ).rejects.toThrow(NoCapableModelError);
  });
});
