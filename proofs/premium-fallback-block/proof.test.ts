// Proof D (baseline section 306): "Premium fallback is blocked by default
// if not authorized." AUTO_PREMIUM_FALLBACK = FALSE (section 64).
import { describe, expect, it } from "vitest";
import { createDefaultModelRegistry } from "../../runtime/models/registry.js";
import { ModelGateway } from "../../runtime/models/gateway.js";
import { MockProvider } from "../../runtime/models/providers/mock-provider.js";
import { CheapestCapableModelRouter, PremiumFallbackBlockedError } from "../../runtime/models/router.js";
import { PolicyEngine, lowRiskAllowRule } from "../../runtime/policy-engine/policy-engine.js";
import { CostEngine } from "../../runtime/cost/cost-engine.js";
import { BudgetGuard } from "../../runtime/budget/budget.js";

describe("Proof: Premium fallback blocked by default", () => {
  it("refuses to escalate to a costlier model when the caller did not explicitly opt in", async () => {
    const registry = createDefaultModelRegistry();
    const gateway = new ModelGateway();
    gateway.registerProvider(new MockProvider());
    const router = new CheapestCapableModelRouter(registry);
    const policy = new PolicyEngine();
    policy.addRule(lowRiskAllowRule(5));
    const budget = new BudgetGuard(new CostEngine(), { perRunUsd: 100 });

    const alwaysFails = () => false;

    await expect(
      router.routeAndExecute(
        { taskId: "risky-classification", risk: 0, requiredCapabilities: ["classification"] },
        gateway,
        { prompt: "classify this" },
        alwaysFails,
        policy,
        budget
        // no options passed -> allowPremiumFallback defaults to false
      )
    ).rejects.toThrow(PremiumFallbackBlockedError);
  });
});
