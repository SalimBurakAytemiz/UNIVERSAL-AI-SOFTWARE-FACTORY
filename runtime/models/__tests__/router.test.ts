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
import type { ModelInvocationResponse, ModelProvider } from "../gateway.js";
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
// P1 fix (30th independent review round, finding 5, "store immutable provider bindings"): `ModelGateway`
// now captures a provider's `invoke` binding AT registration time, so a `vi.spyOn(provider, "invoke")`
// installed AFTER `registerProvider()` no longer has any effect on what the gateway actually calls (bkz.
// models/gateway.ts's `captureProviderBinding()`) — exactly the "caller can't redirect an already-
// registered provider" property that fix establishes. A test that needs to observe invocations must spy
// BEFORE the provider is registered; this factory now accepts an optional pre-built (and pre-spied)
// provider instead of always constructing its own fresh, un-spy-able one.
function setupThreeTierEscalationScenario(provider: ModelProvider = new MockProvider()) {
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
    // Spy BEFORE registration (bkz. this file's fix note above the factory
    // function) — the gateway captures whatever `invoke` is bound to the
    // provider AT registration time.
    const rawProvider = new MockProvider();
    const providerInvokeSpy = vi.spyOn(rawProvider, "invoke");
    const { router, gateway } = setupThreeTierEscalationScenario(rawProvider);
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
    const rawProvider = new MockProvider();
    const providerInvokeSpy = vi.spyOn(rawProvider, "invoke");
    const { router, gateway } = setupThreeTierEscalationScenario(rawProvider);
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
    const rawProvider = new MockProvider();
    const providerInvokeSpy = vi.spyOn(rawProvider, "invoke");
    const { router, gateway, policy } = setupThreeTierEscalationScenario(rawProvider);
    const costEngine = new CostEngine();
    // Enough for the free initial (tier-mock, $0) but not the $0.5 premium fallback.
    const budget = new BudgetGuard(costEngine, { perRunUsd: 0.1 });
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

describe(
  "P1 fix (12th independent review round, 'routing retries can change execution ownership and fallback " +
    "permission'): routeAndExecute() snapshots request/options into a frozen routingScope + normalized " +
    "allowPremiumFallback BEFORE the first await, and every selectModel()/invokeAuthorized() call — initial and " +
    "every escalation step — uses ONLY that snapshot",
  () => {
    it(
      "BLOCKER regression, exact reproduction: mutating request.taskId (A -> B) WHILE the initial candidate is " +
        "pending has no effect — every escalation attempt, and all recorded cost, stays under task A",
      async () => {
        const { router, gateway, policy } = setupThreeTierEscalationScenario();
        const costEngine = new CostEngine();
        const isolatedBudget = new BudgetGuard(costEngine, { perRunUsd: 1000 });
        const validate = vi.fn((response: ModelInvocationResponse) => response.modelId === "tier-premium");

        const request: { taskId: string; risk: 0; requiredCapabilities: string[] } = {
          taskId: "task-A",
          risk: 0,
          requiredCapabilities: ["escalation-capability"]
        };

        // Scheduled BEFORE calling routeAndExecute(), landing in the
        // earliest possible microtask slot relative to the function's own
        // internal await-driven resumption — the ordering most favorable
        // to a caller actually winning such a race (same technique
        // verified in prior rounds for gateway.ts/orchestrator.ts).
        Promise.resolve().then(() => {
          request.taskId = "task-B";
        });

        const result = await router.routeAndExecute(
          request,
          gateway,
          { prompt: "x" },
          validate,
          policy,
          isolatedBudget,
          { allowPremiumFallback: true }
        );

        expect(result.decision.model.modelId).toBe("tier-premium");
        expect(costEngine.totalFor({ taskId: "task-A" })).toBeCloseTo(0.5); // tier-mock ($0) + tier-premium ($0.5)
        expect(costEngine.totalFor({ taskId: "task-B" })).toBe(0);
      }
    );

    it("mutating options.allowPremiumFallback (false -> true) WHILE the initial candidate is pending has no effect — fallback stays blocked", async () => {
      const rawProvider = new MockProvider();
      const providerInvokeSpy = vi.spyOn(rawProvider, "invoke");
      const { router, gateway, policy, budget } = setupThreeTierEscalationScenario(rawProvider);
      const validate = vi.fn(() => false); // primary always fails

      const options: { allowPremiumFallback?: boolean } = { allowPremiumFallback: false };
      Promise.resolve().then(() => {
        options.allowPremiumFallback = true;
      });

      await expect(
        router.routeAndExecute(
          { taskId: "t-fallback-flip", risk: 0, requiredCapabilities: ["escalation-capability"] },
          gateway,
          { prompt: "x" },
          validate,
          policy,
          budget,
          options
        )
      ).rejects.toThrow(PremiumFallbackBlockedError);

      // Only the initial (tier-mock) candidate was ever invoked — the
      // fallback permission flip never reached the already-captured snapshot.
      expect(providerInvokeSpy.mock.calls.map((call) => call[0].modelId)).toEqual(["tier-mock"]);
    });

    it("mutating options.allowPremiumFallback (true -> false) WHILE the initial candidate is pending has no effect — a previously-granted permission is not silently revoked mid-flight", async () => {
      const { router, gateway, policy, budget } = setupThreeTierEscalationScenario();
      const validate = vi.fn((response: ModelInvocationResponse) => response.modelId === "tier-premium");

      const options: { allowPremiumFallback?: boolean } = { allowPremiumFallback: true };
      Promise.resolve().then(() => {
        options.allowPremiumFallback = false;
      });

      const result = await router.routeAndExecute(
        { taskId: "t-fallback-flip-2", risk: 0, requiredCapabilities: ["escalation-capability"] },
        gateway,
        { prompt: "x" },
        validate,
        policy,
        budget,
        options
      );

      expect(result.decision.model.modelId).toBe("tier-premium");
    });

    it(
      "risk mutation while pending has no effect (documented invariant: risk is read exactly once, at the " +
        "very first synchronous selectModel() call, in both the pre- and post-fix code — escalation steps " +
        "always pass their next tier explicitly and never re-derive it from risk)",
      async () => {
        const { router, gateway, policy, budget } = setup();
        const request: { taskId: string; risk: 0 | 4; requiredCapabilities: string[] } = {
          taskId: "risk-mutation",
          risk: 0,
          requiredCapabilities: ["tagging"]
        };
        Promise.resolve().then(() => {
          request.risk = 4;
        });

        const decision = await router
          .routeAndExecute(request, gateway, { prompt: "x" }, () => true, policy, budget)
          .then((r) => r.decision);

        // risk=0 -> MOCK tier floor -> the free classifier, never a
        // PREMIUM-floor candidate a mutated risk=4 would have required.
        expect(decision.model.tier).toBe("MOCK");
      }
    );

    it(
      "BLOCKER regression: mutating request.requiredCapabilities WHILE the initial candidate is pending has no " +
        "effect on escalation candidate selection — retries still require the ORIGINALLY captured capabilities",
      async () => {
        const registry = new ModelRegistry();
        registry.register({
          provider: "mock",
          modelId: "narrow-mock",
          tier: "MOCK",
          costPerCall: 0,
          capabilities: ["needs-both-a-and-b"],
          status: "ACTIVE"
        });
        registry.register({
          provider: "mock",
          modelId: "narrow-premium",
          tier: "PREMIUM",
          costPerCall: 0.5,
          capabilities: ["needs-both-a-and-b"],
          status: "ACTIVE"
        });
        // A cheaper PREMIUM-tier model that only satisfies a DIFFERENT
        // (narrower) capability set — this must NEVER be selected on
        // escalation, even if `requiredCapabilities` is mutated to match it.
        registry.register({
          provider: "mock",
          modelId: "wrong-candidate",
          tier: "PREMIUM",
          costPerCall: 0.01,
          capabilities: ["only-a"],
          status: "ACTIVE"
        });

        const gateway = new ModelGateway();
        gateway.registerProvider(new MockProvider());
        const router = new CheapestCapableModelRouter(registry);
        const policy = permissivePolicy();
        const budget = permissiveBudget();
        const validate = vi.fn((response: ModelInvocationResponse) => response.modelId === "narrow-premium");

        const request: { taskId: string; risk: 0; requiredCapabilities: string[] } = {
          taskId: "t-capability-mutation",
          risk: 0,
          requiredCapabilities: ["needs-both-a-and-b"]
        };
        Promise.resolve().then(() => {
          // If this mutation were ever consulted, "wrong-candidate" (only
          // requires "only-a") would become newly eligible and, being
          // cheaper, would be wrongly selected over "narrow-premium".
          request.requiredCapabilities = ["only-a"];
        });

        const result = await router.routeAndExecute(
          request,
          gateway,
          { prompt: "x" },
          validate,
          policy,
          budget,
          { allowPremiumFallback: true }
        );

        expect(result.decision.model.modelId).toBe("narrow-premium");
      }
    );

    it("concurrent routeAndExecute() calls sharing ONE caller-owned request/options object cannot cross-contaminate their snapshots", async () => {
      const { router, gateway, policy, budget, costEngine } = setup();

      const sharedRequest: { taskId: string; risk: 0; requiredCapabilities: string[] } = {
        taskId: "shared-1",
        risk: 0,
        requiredCapabilities: ["tagging"]
      };
      const sharedOptions: { allowPremiumFallback?: boolean } = { allowPremiumFallback: false };

      const p1 = router.routeAndExecute(sharedRequest, gateway, { prompt: "x" }, () => true, policy, budget, sharedOptions);
      // Mutate the SAME shared objects before issuing the second call.
      sharedRequest.taskId = "shared-2";
      sharedOptions.allowPremiumFallback = true;
      const p2 = router.routeAndExecute(sharedRequest, gateway, { prompt: "x" }, () => true, policy, budget, sharedOptions);

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.decision.model.modelId).toBe("mock-classifier");
      expect(r2.decision.model.modelId).toBe("mock-classifier");
      // Each call's own cost landed under its OWN taskId snapshot, not a
      // merged/contaminated one.
      expect(costEngine.totalFor({ taskId: "shared-1" })).toBe(0);
      expect(costEngine.totalFor({ taskId: "shared-2" })).toBe(0);
    });
  }
);

describe(
  "P1 fix (13th independent review round, 'routing drops project ownership'): RoutingRequest.projectId is " +
    "captured into routingScope and propagated into ModelInvocationContext.projectId on every candidate " +
    "invocation — initial, every escalation step, and fallback",
  () => {
    it(
      "BLOCKER regression, exact reproduction: a routed invocation for project P/task A, followed by a DIRECT " +
        "gateway.invoke() for the SAME project/task, share ONE per-task ceiling — the direct call sees the " +
        "budget the routed call already consumed",
      async () => {
        const registry = new ModelRegistry();
        registry.register({
          provider: "mock",
          modelId: "paid-tagger",
          tier: "MOCK",
          costPerCall: 0.5,
          capabilities: ["tagging"],
          status: "ACTIVE"
        });
        const router = new CheapestCapableModelRouter(registry);
        const gateway = new ModelGateway();
        gateway.registerProvider(new MockProvider());
        const policy = permissivePolicy();
        const costEngine = new CostEngine();
        const budget = new BudgetGuard(costEngine, { perTaskUsd: 0.5 });

        // Routed invocation, carrying project ownership via RoutingRequest.projectId.
        await router.routeAndExecute(
          { taskId: "task-A", projectId: "project-P", risk: 0, requiredCapabilities: ["tagging"] },
          gateway,
          { prompt: "x" },
          () => true,
          policy,
          budget
        );
        expect(costEngine.totalFor({ taskId: "task-A", projectId: "project-P" })).toBe(0.5);

        // A DIRECT (non-routed) invocation for the SAME project/task must
        // see the ceiling ALREADY consumed by the routed call above — if
        // routing had dropped project ownership (recording the first
        // spend under taskId ALONE), this direct call's project+task-
        // scoped check would wrongly see $0 already spent and let a
        // SECOND $0.5 through against what should be a single shared
        // $0.5 ceiling.
        const model = registry.findCapable(["tagging"])[0]!;
        await expect(
          gateway.invoke(model, { prompt: "y" }, { policy, budget, risk: 0, taskId: "task-A", projectId: "project-P" })
        ).rejects.toThrow(BudgetExceededError);
      }
    );

    it(
      "BLOCKER regression: two routed invocations for DIFFERENT projects sharing the SAME taskId use INDEPENDENT " +
        "per-project ceilings — routing must not silently downgrade project+task ownership into task-only ownership",
      async () => {
        const registry = new ModelRegistry();
        registry.register({
          provider: "mock",
          modelId: "shared-task-model",
          tier: "MOCK",
          costPerCall: 0.4,
          capabilities: ["tagging"],
          status: "ACTIVE"
        });
        const router = new CheapestCapableModelRouter(registry);
        const gateway = new ModelGateway();
        gateway.registerProvider(new MockProvider());
        const policy = permissivePolicy();
        const costEngine = new CostEngine();
        // Exactly enough for ONE $0.4 spend PER project+task — if project
        // ownership were dropped, both calls would collapse onto the SAME
        // task-only ceiling and the second would be wrongly rejected.
        const budget = new BudgetGuard(costEngine, { perTaskUsd: 0.4 });

        const resultA = await router.routeAndExecute(
          { taskId: "shared-task", projectId: "project-A", risk: 0, requiredCapabilities: ["tagging"] },
          gateway,
          { prompt: "x" },
          () => true,
          policy,
          budget
        );
        const resultB = await router.routeAndExecute(
          { taskId: "shared-task", projectId: "project-B", risk: 0, requiredCapabilities: ["tagging"] },
          gateway,
          { prompt: "x" },
          () => true,
          policy,
          budget
        );

        expect(resultA.response.costUsd).toBe(0.4);
        expect(resultB.response.costUsd).toBe(0.4);
        expect(costEngine.totalFor({ projectId: "project-A" })).toBe(0.4);
        expect(costEngine.totalFor({ projectId: "project-B" })).toBe(0.4);
      }
    );

    it("project identity survives escalation/retry/fallback — every candidate's cost, at every tier, is accounted under the SAME project", async () => {
      const { router, gateway, policy } = setupThreeTierEscalationScenario();
      const costEngine = new CostEngine();
      const budget = new BudgetGuard(costEngine, { perRunUsd: 100 });
      const validate = vi.fn(() => false); // escalate through every tier

      await expect(
        router.routeAndExecute(
          { taskId: "t-project-escalation", projectId: "project-Q", risk: 0, requiredCapabilities: ["escalation-capability"] },
          gateway,
          { prompt: "x" },
          validate,
          policy,
          budget,
          { allowPremiumFallback: true }
        )
      ).rejects.toThrow(EscalationExhaustedError);

      // tier-mock ($0) + tier-premium ($0.5) + tier-critical ($2), ALL under project-Q — including the two
      // escalation/fallback steps that only ever run AFTER the initial candidate's own validation failure.
      expect(costEngine.totalFor({ projectId: "project-Q" })).toBeCloseTo(2.5);
    });

    it("omitting projectId (the pre-existing, still-supported project-agnostic use case) continues to scope the ceiling by taskId alone — no regression for callers that never had a project", async () => {
      const { router, gateway, policy, budget, costEngine } = setup();
      const result = await router.routeAndExecute(
        { taskId: "no-project-task", risk: 0, requiredCapabilities: ["tagging"] },
        gateway,
        { prompt: "x" },
        () => true,
        policy,
        budget
      );
      expect(result.decision.model.modelId).toBe("mock-classifier");
      expect(costEngine.totalFor({ taskId: "no-project-task" })).toBe(0);
    });
  }
);

describe(
  "P1 fix (13th independent review round, 'invocation payload remains caller-mutable during execution'): " +
    "routeAndExecute() snapshots invocationRequest into a frozen invocationScope BEFORE the first await, and " +
    "every escalation/fallback step uses ONLY that snapshot",
  () => {
    it(
      "BLOCKER regression: mutating invocationRequest.prompt WHILE the initial candidate is pending has no " +
        "effect on a LATER escalation attempt — the escalated response reflects the ORIGINAL prompt",
      async () => {
        const { router, gateway, policy, budget } = setupThreeTierEscalationScenario();
        const validate = vi.fn((response: ModelInvocationResponse) => response.modelId === "tier-premium");

        const invocationRequest: { prompt: string } = { prompt: "original-prompt" };
        // Scheduled BEFORE calling routeAndExecute() — by the time the
        // escalation loop's SECOND invokeAuthorized() call runs (strictly
        // after the FIRST candidate's own await has resolved), this
        // microtask has already fired, so this is the ordering most
        // favorable to a caller actually winning such a race.
        Promise.resolve().then(() => {
          invocationRequest.prompt = "attacker-controlled-replacement-prompt";
        });

        const result = await router.routeAndExecute(
          { taskId: "t-payload-mutation", risk: 0, requiredCapabilities: ["escalation-capability"] },
          gateway,
          invocationRequest,
          validate,
          policy,
          budget,
          { allowPremiumFallback: true }
        );

        expect(result.decision.model.modelId).toBe("tier-premium");
        expect(result.response.output).toContain("original-prompt");
        expect(result.response.output).not.toContain("attacker-controlled-replacement-prompt");
      }
    );

    it("concurrent routeAndExecute() calls sharing ONE caller-owned invocationRequest object cannot cross-contaminate their payloads", async () => {
      const { router, gateway, policy, budget } = setup();

      const sharedInvocationRequest: { prompt: string } = { prompt: "first-prompt" };
      const p1 = router.routeAndExecute(
        { taskId: "payload-shared-1", risk: 0, requiredCapabilities: ["tagging"] },
        gateway,
        sharedInvocationRequest,
        () => true,
        policy,
        budget
      );
      sharedInvocationRequest.prompt = "second-prompt";
      const p2 = router.routeAndExecute(
        { taskId: "payload-shared-2", risk: 0, requiredCapabilities: ["tagging"] },
        gateway,
        sharedInvocationRequest,
        () => true,
        policy,
        budget
      );

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.response.output).toContain("first-prompt");
      expect(r2.response.output).toContain("second-prompt");
    });
  }
);

describe(
  "P1 fix (28th independent review round, finding 14, 'initial routing must use the lowest sufficient tier')",
  () => {
    it("BLOCKER regression, exact reproduction: a mispriced PREMIUM model cheaper than a sufficient STANDARD model must NOT be selected for a lower-risk task", () => {
      const registry = new ModelRegistry();
      // A pricing anomaly: the PREMIUM-tier model is numerically cheaper
      // than the STANDARD-tier one. Model prices are registry DATA, not
      // something the router may assume increases with tier.
      registry.register({
        provider: "mock",
        modelId: "mispriced-standard",
        tier: "STANDARD",
        costPerCall: 0.05,
        capabilities: ["implementation"],
        status: "ACTIVE"
      });
      registry.register({
        provider: "mock",
        modelId: "mispriced-premium",
        tier: "PREMIUM",
        costPerCall: 0.01,
        capabilities: ["implementation"],
        status: "ACTIVE"
      });

      const router = new CheapestCapableModelRouter(registry);
      // risk 3 -> minTierForRisk == STANDARD, which already has a capable candidate.
      const decision = router.selectModel({
        taskId: "should-stay-standard",
        risk: 3,
        requiredCapabilities: ["implementation"]
      });

      // The globally cheapest candidate is PREMIUM, but STANDARD is
      // ALREADY sufficient — the router must never reach into a higher
      // tier just because it is numerically cheaper.
      expect(decision.model.tier).toBe("STANDARD");
      expect(decision.model.modelId).toBe("mispriced-standard");
    });

    it("a trivial task never reaches PREMIUM even when PREMIUM is the cheapest model in the entire registry", () => {
      const registry = new ModelRegistry();
      registry.register({
        provider: "mock",
        modelId: "cheap-mock",
        tier: "MOCK",
        costPerCall: 0.02,
        capabilities: ["tagging"],
        status: "ACTIVE"
      });
      registry.register({
        provider: "mock",
        modelId: "free-premium-anomaly",
        tier: "PREMIUM",
        costPerCall: 0, // cheaper than the MOCK model above
        capabilities: ["tagging"],
        status: "ACTIVE"
      });

      const router = new CheapestCapableModelRouter(registry);
      const decision = router.selectModel({
        taskId: "trivial-tagging-2",
        risk: 0,
        requiredCapabilities: ["tagging"]
      });

      expect(decision.model.tier).toBe("MOCK");
      expect(decision.model.modelId).toBe("cheap-mock");
    });

    it("still selects the cheapest candidate WITHIN the lowest sufficient tier when multiple exist at that tier", () => {
      const registry = new ModelRegistry();
      registry.register({
        provider: "mock",
        modelId: "standard-a",
        tier: "STANDARD",
        costPerCall: 0.03,
        capabilities: ["implementation"],
        status: "ACTIVE"
      });
      registry.register({
        provider: "mock",
        modelId: "standard-b",
        tier: "STANDARD",
        costPerCall: 0.01,
        capabilities: ["implementation"],
        status: "ACTIVE"
      });
      registry.register({
        provider: "mock",
        modelId: "premium-c",
        tier: "PREMIUM",
        costPerCall: 0.005,
        capabilities: ["implementation"],
        status: "ACTIVE"
      });

      const router = new CheapestCapableModelRouter(registry);
      const decision = router.selectModel({
        taskId: "within-tier-cheapest",
        risk: 3,
        requiredCapabilities: ["implementation"]
      });

      expect(decision.model.tier).toBe("STANDARD");
      expect(decision.model.modelId).toBe("standard-b");
    });

    it("does escalate into a higher tier when the lowest sufficient tier has no capable candidate at all", () => {
      const registry = new ModelRegistry();
      registry.register({
        provider: "mock",
        modelId: "only-premium",
        tier: "PREMIUM",
        costPerCall: 0.3,
        capabilities: ["rare-capability"],
        status: "ACTIVE"
      });

      const router = new CheapestCapableModelRouter(registry);
      const decision = router.selectModel({
        taskId: "no-standard-available",
        risk: 0,
        requiredCapabilities: ["rare-capability"]
      });

      expect(decision.model.tier).toBe("PREMIUM");
      expect(decision.model.modelId).toBe("only-premium");
    });
  }
);

describe(
  "P1 fix (28th independent review round, root-class B sweep, 'TypeScript private used for authoritative " +
    "mutable state'): CheapestCapableModelRouter's registry is also a genuine #private field now",
  () => {
    it("registry is not reachable as an ordinary JS property, and a forged replacement cannot substitute the authoritative model registry", () => {
      const realRegistry = createDefaultModelRegistry();
      const router = new CheapestCapableModelRouter(realRegistry);

      const asRecord = router as unknown as Record<string, unknown>;
      expect(asRecord.registry).toBeUndefined();

      const forgedRegistry = {
        findCapable: () => [
          { provider: "hijacked", modelId: "hijacked-model", tier: "MOCK", costPerCall: 0, capabilities: ["tagging"], status: "ACTIVE" }
        ]
      };
      asRecord.registry = forgedRegistry;
      const spread: Record<string, unknown> = { ...router };
      expect(spread.registry).toBe(forgedRegistry); // an inert stray property, nothing more

      // selectModel() still consults the REAL registry, not the forged one.
      const decision = router.selectModel({ taskId: "t1", risk: 0, requiredCapabilities: ["tagging"] });
      expect(decision.model.modelId).toBe("mock-classifier");
    });
  }
);
