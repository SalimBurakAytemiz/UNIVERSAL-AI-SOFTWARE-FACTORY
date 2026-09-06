import { describe, expect, it, vi } from "vitest";
import { createDefaultModelRegistry, ModelRegistry } from "../registry.js";
import { ModelGateway } from "../gateway.js";
import { MockProvider } from "../providers/mock-provider.js";
import {
  CheapestCapableModelRouter,
  EscalationExhaustedError,
  NoCapableModelError,
  PremiumFallbackBlockedError
} from "../router.js";
import type { ModelInvocationResponse } from "../gateway.js";
import { PolicyEngine, lowRiskAllowRule } from "../../policy-engine/policy-engine.js";
import { CapabilityDeniedError, CapabilityApprovalRequiredError } from "../../capability-gateway/gateway.js";
import { CostEngine } from "../../cost/cost-engine.js";
import { BudgetGuard, BudgetExceededError } from "../../budget/budget.js";

/** A permissive policy that ALLOWs everything up to risk 5 — the default for tests not exercising the policy gate itself. */
function permissivePolicy(): PolicyEngine {
  const policy = new PolicyEngine();
  policy.addRule(lowRiskAllowRule(5));
  return policy;
}

/** A budget with generous ceilings — the default for tests not exercising the budget gate itself. */
function permissiveBudget(costEngine: CostEngine = new CostEngine()): BudgetGuard {
  return new BudgetGuard(costEngine, { perRunUsd: 1000, perTaskUsd: 1000 });
}

function setup() {
  const registry = createDefaultModelRegistry();
  const gateway = new ModelGateway();
  gateway.registerProvider(new MockProvider());
  const router = new CheapestCapableModelRouter(registry);
  const policy = permissivePolicy();
  const costEngine = new CostEngine();
  const budget = permissiveBudget(costEngine);
  return { registry, gateway, router, policy, budget, costEngine };
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
    const { router, gateway, policy, budget } = setup();
    const result = await router.routeAndExecute(
      { taskId: "tagging-ok", risk: 0, requiredCapabilities: ["tagging"] },
      gateway,
      { prompt: "tag this" },
      () => true, // validation always passes
      policy,
      budget
    );
    expect(result.decision.escalated).toBe(false);
    expect(result.decision.model.tier).toBe("MOCK");
  });

  it("Proof D: premium fallback is blocked by default when validation fails", async () => {
    const { router, gateway, policy, budget } = setup();
    await expect(
      router.routeAndExecute(
        { taskId: "tagging-fails", risk: 0, requiredCapabilities: ["tagging"] },
        gateway,
        { prompt: "tag this" },
        () => false, // validation always fails
        policy,
        budget
        // allowPremiumFallback intentionally omitted -> defaults to false
      )
    ).rejects.toThrow(PremiumFallbackBlockedError);
  });

  it("Proof C: a failed low-cost model can escalate when explicitly authorized, and the escalated response is itself validated", async () => {
    const { router, gateway, policy, budget } = setup();
    const validate = vi.fn((response) => response.modelId === "mock-premium-architect");
    const result = await router.routeAndExecute(
      { taskId: "implementation-needs-escalation", risk: 3, requiredCapabilities: ["implementation"] },
      gateway,
      { prompt: "implement this" },
      validate,
      policy,
      budget,
      { allowPremiumFallback: true }
    );
    expect(result.decision.escalated).toBe(true);
    expect(result.decision.model.tier).toBe("PREMIUM");
    // The validator was invoked for BOTH the initial (STANDARD) and escalated (PREMIUM) response.
    expect(validate).toHaveBeenCalledTimes(2);
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
  const policy = permissivePolicy();
  const budget = permissiveBudget();
  return { registry, gateway, router, policy, budget };
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
    const { router, gateway, policy, budget } = setupCapabilityDrivenPromotionScenario();
    const validate = vi.fn((response) => response.modelId === "niche-premium");
    const result = await router.routeAndExecute(
      { taskId: "niche-task", risk: 0, requiredCapabilities: ["niche-capability"] },
      gateway,
      { prompt: "do the niche thing" },
      validate,
      policy,
      budget,
      { allowPremiumFallback: true }
    );

    expect(result.decision.escalated).toBe(true);
    // Must move up from STANDARD to PREMIUM, never reselect the same STANDARD model.
    expect(result.decision.model.tier).toBe("PREMIUM");
    expect(result.decision.model.modelId).toBe("niche-premium");
    expect(result.decision.model.modelId).not.toBe("niche-standard");
    expect(validate).toHaveBeenCalledTimes(2); // both the initial and escalated response were validated
  });

  it("premium fallback policy remains enforced in the capability-driven-promotion scenario", async () => {
    const { router, gateway, policy, budget } = setupCapabilityDrivenPromotionScenario();
    await expect(
      router.routeAndExecute(
        { taskId: "niche-task", risk: 0, requiredCapabilities: ["niche-capability"] },
        gateway,
        { prompt: "do the niche thing" },
        () => false,
        policy,
        budget
        // allowPremiumFallback intentionally omitted -> defaults to false
      )
    ).rejects.toThrow(PremiumFallbackBlockedError);
  });

  it("fails closed with EscalationExhaustedError instead of looping when already at the top tier", async () => {
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
    const policy = permissivePolicy();
    const budget = permissiveBudget();

    await expect(
      router.routeAndExecute(
        { taskId: "already-top", risk: 0, requiredCapabilities: ["niche-capability"] },
        gateway,
        { prompt: "x" },
        () => false,
        policy,
        budget,
        { allowPremiumFallback: true }
      )
    ).rejects.toThrow(EscalationExhaustedError);
  });
});

/**
 * BLOCKER regression: fallback/escalated model output was previously
 * returned WITHOUT being passed through `validate` at all — a fallback
 * response was trusted merely because it came from a different (pricier)
 * model. Fixed: every candidate response, at every tier, is validated;
 * fallback output is never trusted by default.
 */
function setupThreeTierEscalationScenario() {
  const registry = new ModelRegistry();
  registry.register({
    provider: "mock",
    modelId: "tier-mock",
    tier: "MOCK",
    costPerCall: 0,
    capabilities: ["escalation-capability"],
    status: "ACTIVE"
  });
  registry.register({
    provider: "mock",
    modelId: "tier-premium",
    tier: "PREMIUM",
    costPerCall: 0.5,
    capabilities: ["escalation-capability"],
    status: "ACTIVE"
  });
  registry.register({
    provider: "mock",
    modelId: "tier-critical",
    tier: "CRITICAL_REVIEW",
    costPerCall: 2,
    capabilities: ["escalation-capability"],
    status: "ACTIVE"
  });

  const gateway = new ModelGateway();
  const provider = new MockProvider();
  gateway.registerProvider(provider);
  const router = new CheapestCapableModelRouter(registry);
  const policy = permissivePolicy();
  const budget = permissiveBudget();
  return { registry, gateway, provider, router, policy, budget };
}

describe("CheapestCapableModelRouter fallback output validation", () => {
  it("primary fails, fallback (first escalation) passes -> returns the validated fallback response", async () => {
    const { router, gateway, policy, budget } = setupThreeTierEscalationScenario();
    const validate = vi.fn((response) => response.modelId === "tier-premium");

    const result = await router.routeAndExecute(
      { taskId: "t1", risk: 0, requiredCapabilities: ["escalation-capability"] },
      gateway,
      { prompt: "x" },
      validate,
      policy,
      budget,
      { allowPremiumFallback: true }
    );

    expect(result.decision.model.modelId).toBe("tier-premium");
    expect(validate).toHaveBeenCalledTimes(2); // tier-mock, then tier-premium
  });

  it("primary fails, fallback also fails -> continues escalating, validating every candidate, and fails closed once exhausted", async () => {
    const { router, gateway, policy, budget } = setupThreeTierEscalationScenario();
    const validate = vi.fn((_response: ModelInvocationResponse) => false); // nothing ever validates

    await expect(
      router.routeAndExecute(
        { taskId: "t2", risk: 0, requiredCapabilities: ["escalation-capability"] },
        gateway,
        { prompt: "x" },
        validate,
        policy,
        budget,
        { allowPremiumFallback: true }
      )
    ).rejects.toThrow(EscalationExhaustedError);

    // The validator was invoked for every candidate: MOCK, PREMIUM, CRITICAL_REVIEW.
    // This also demonstrates escalation is bounded — it terminates rather than looping forever.
    expect(validate).toHaveBeenCalledTimes(3);
    expect(validate.mock.calls.map((call) => call[0].modelId)).toEqual([
      "tier-mock",
      "tier-premium",
      "tier-critical"
    ]);
  });

  it("an invalid premium fallback response cannot bypass validation merely because it is a pricier model", async () => {
    const { router, gateway, policy, budget } = setupThreeTierEscalationScenario();
    // The premium response fails validation; only the top (critical) tier would pass.
    const validate = vi.fn((response) => response.modelId === "tier-critical");

    const result = await router.routeAndExecute(
      { taskId: "t3", risk: 0, requiredCapabilities: ["escalation-capability"] },
      gateway,
      { prompt: "x" },
      validate,
      policy,
      budget,
      { allowPremiumFallback: true }
    );

    // Never settled for the invalid PREMIUM response just because it outranks MOCK.
    expect(result.decision.model.modelId).toBe("tier-critical");
    expect(validate).toHaveBeenCalledTimes(3);
  });

  it("retry/escalation limits still apply: at most one attempt per tier, never an unbounded retry loop", async () => {
    const { router, gateway, policy, budget } = setupThreeTierEscalationScenario();
    const validate = vi.fn(() => false);

    await expect(
      router.routeAndExecute(
        { taskId: "t4", risk: 0, requiredCapabilities: ["escalation-capability"] },
        gateway,
        { prompt: "x" },
        validate,
        policy,
        budget,
        { allowPremiumFallback: true }
      )
    ).rejects.toThrow(EscalationExhaustedError);

    // Exactly one attempt per registered tier (3), not repeated retries at the same tier.
    expect(validate).toHaveBeenCalledTimes(3);
  });

  it("premium fallback policy is still enforced before any escalation is attempted in this scenario", async () => {
    const { router, gateway, policy, budget } = setupThreeTierEscalationScenario();
    const validate = vi.fn(() => false);

    await expect(
      router.routeAndExecute(
        { taskId: "t5", risk: 0, requiredCapabilities: ["escalation-capability"] },
        gateway,
        { prompt: "x" },
        validate,
        policy,
        budget
        // allowPremiumFallback intentionally omitted -> defaults to false
      )
    ).rejects.toThrow(PremiumFallbackBlockedError);

    // Blocked immediately after the primary attempt — no escalation happened at all.
    expect(validate).toHaveBeenCalledTimes(1);
  });
});

describe("CheapestCapableModelRouter authorization gate (P1 fix, 9th independent review round: 'fallback execution bypasses policy and budget enforcement')", () => {
  it("a fallback candidate that policy DENYs is never invoked — the provider is never called for it", async () => {
    const { router, gateway, provider } = setupThreeTierEscalationScenario();
    const policy = new PolicyEngine();
    policy.addRule(lowRiskAllowRule(5)); // would otherwise allow everything
    policy.addRule({
      name: "deny-tier-premium",
      priority: 1,
      evaluate: (action) => (action.description.includes("tier-premium") ? "DENY" : null)
    });
    const budget = permissiveBudget();
    // Spy on the underlying PROVIDER (not gateway.invoke, which is now the
    // guarded boundary itself and is legitimately called for every
    // candidate attempt) — this is the thing that must never be reached
    // for a denied candidate.
    const providerInvokeSpy = vi.spyOn(provider, "invoke");
    const validate = vi.fn(() => false); // primary fails -> triggers an escalation attempt

    await expect(
      router.routeAndExecute(
        { taskId: "deny-fallback", risk: 0, requiredCapabilities: ["escalation-capability"] },
        gateway,
        { prompt: "x" },
        validate,
        policy,
        budget,
        { allowPremiumFallback: true }
      )
    ).rejects.toThrow(CapabilityDeniedError);

    // tier-mock (initial, allowed) WAS invoked; tier-premium (denied) never reached the provider.
    expect(providerInvokeSpy.mock.calls.map((call) => call[0].modelId)).toEqual(["tier-mock"]);
  });

  it("a fallback candidate requiring approval is not invoked without a valid approval", async () => {
    const { router, gateway, provider } = setupThreeTierEscalationScenario();
    const policy = new PolicyEngine();
    policy.addRule(lowRiskAllowRule(5));
    // Higher priority than the catch-all ALLOW above: both are non-DENY, so
    // whichever is evaluated first among non-DENY matches wins — this must
    // be considered before the catch-all ALLOW for the assertion below to
    // reflect this rule's decision rather than being shadowed by it.
    policy.addRule({
      name: "approval-required-for-premium",
      priority: 10,
      evaluate: (action) => (action.description.includes("tier-premium") ? "APPROVAL_REQUIRED" : null)
    });
    const budget = permissiveBudget();
    const providerInvokeSpy = vi.spyOn(provider, "invoke");
    const validate = vi.fn(() => false);

    await expect(
      router.routeAndExecute(
        { taskId: "approval-fallback", risk: 0, requiredCapabilities: ["escalation-capability"] },
        gateway,
        { prompt: "x" },
        validate,
        policy,
        budget,
        { allowPremiumFallback: true }
      )
    ).rejects.toThrow(CapabilityApprovalRequiredError);

    expect(providerInvokeSpy.mock.calls.map((call) => call[0].modelId)).toEqual(["tier-mock"]);
  });

  it("insufficient budget blocks a fallback candidate BEFORE any provider call occurs", async () => {
    const { router, gateway, provider, policy } = setupThreeTierEscalationScenario();
    const costEngine = new CostEngine();
    // Enough for the free initial (tier-mock, $0) but not the $0.5 premium fallback.
    const budget = new BudgetGuard(costEngine, { perRunUsd: 0.1 });
    const providerInvokeSpy = vi.spyOn(provider, "invoke");
    const validate = vi.fn(() => false);

    await expect(
      router.routeAndExecute(
        { taskId: "budget-fallback", risk: 0, requiredCapabilities: ["escalation-capability"] },
        gateway,
        { prompt: "x" },
        validate,
        policy,
        budget,
        { allowPremiumFallback: true }
      )
    ).rejects.toThrow(BudgetExceededError);

    // tier-mock (free, within budget) WAS invoked; tier-premium ($0.5, over budget) never reached the provider.
    expect(providerInvokeSpy.mock.calls.map((call) => call[0].modelId)).toEqual(["tier-mock"]);
    expect(costEngine.total()).toBe(0);
  });

  it("the cost of a fallback invocation is recorded even though its output later fails validation", async () => {
    const { router, gateway, policy } = setupThreeTierEscalationScenario();
    const costEngine = new CostEngine();
    const budget = new BudgetGuard(costEngine, { perRunUsd: 100 });
    const validate = vi.fn(() => false); // nothing ever validates -> escalates through every tier

    await expect(
      router.routeAndExecute(
        { taskId: "cost-accounting", risk: 0, requiredCapabilities: ["escalation-capability"] },
        gateway,
        { prompt: "x" },
        validate,
        policy,
        budget,
        { allowPremiumFallback: true }
      )
    ).rejects.toThrow(EscalationExhaustedError);

    // tier-mock ($0) + tier-premium ($0.5) + tier-critical ($2) were all actually invoked
    // and their real cost recorded, even though EVERY one of them failed validate().
    expect(costEngine.total()).toBeCloseTo(2.5);
  });

  it("multiple failed fallback attempts cannot silently exceed the budget ceiling", async () => {
    const { router, gateway, policy } = setupThreeTierEscalationScenario();
    const costEngine = new CostEngine();
    // Enough for tier-mock ($0) + tier-premium ($0.5) but not also tier-critical ($2).
    const budget = new BudgetGuard(costEngine, { perRunUsd: 0.5 });
    const validate = vi.fn(() => false);

    await expect(
      router.routeAndExecute(
        { taskId: "multi-fallback-budget", risk: 0, requiredCapabilities: ["escalation-capability"] },
        gateway,
        { prompt: "x" },
        validate,
        policy,
        budget,
        { allowPremiumFallback: true }
      )
    ).rejects.toThrow(BudgetExceededError);

    // tier-critical's $2 invocation never happened once it would push cumulative
    // spend past the $0.5 ceiling — the ceiling was never silently exceeded.
    expect(costEngine.total()).toBeCloseTo(0.5);
  });

  it("allowPremiumFallback=true is not itself an authorization — a default-deny policy blocks even the initial candidate", async () => {
    const { router, gateway, provider } = setupThreeTierEscalationScenario();
    const policy = new PolicyEngine(); // no rules at all -> default deny
    const budget = permissiveBudget();
    const providerInvokeSpy = vi.spyOn(provider, "invoke");

    await expect(
      router.routeAndExecute(
        { taskId: "no-policy-rules", risk: 0, requiredCapabilities: ["escalation-capability"] },
        gateway,
        { prompt: "x" },
        () => false,
        policy,
        budget,
        { allowPremiumFallback: true }
      )
    ).rejects.toThrow(CapabilityDeniedError);

    // Not even the INITIAL candidate ever reached the provider — routing
    // permission (allowPremiumFallback) is never a substitute for policy
    // authorization.
    expect(providerInvokeSpy).not.toHaveBeenCalled();
  });
});
