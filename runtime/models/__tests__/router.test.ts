import { describe, expect, it } from "vitest";
import { createDefaultModelRegistry } from "../registry.js";
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
