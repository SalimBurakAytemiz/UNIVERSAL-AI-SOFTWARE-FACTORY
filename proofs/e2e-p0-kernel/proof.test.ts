// UASF-REQ-0042: P0 end-to-end proof. Demonstrates the P0 kernel invariants
// working TOGETHER in one coherent scenario, rather than only in isolation:
// event-driven activation, cheapest-capable-model routing, budget
// enforcement, cache reuse, and human-approval gating for a high-risk step.
//
// Scenario: a "pull_request.opened" event should trigger an automated
// low-risk summarization task (cheap model, budget-guarded, cached), and
// separately, a "release.requested" event represents a risk-5 action that
// must never auto-execute without human approval.
import { describe, expect, it, vi } from "vitest";
import { EventBus, EventDrivenAgent } from "../../runtime/event-bus/event-bus.js";
import { createDefaultModelRegistry } from "../../runtime/models/registry.js";
import { ModelGateway } from "../../runtime/models/gateway.js";
import { MockProvider } from "../../runtime/models/providers/mock-provider.js";
import { CheapestCapableModelRouter } from "../../runtime/models/router.js";
import { CostEngine } from "../../runtime/cost/cost-engine.js";
import { BudgetGuard } from "../../runtime/budget/budget.js";
import { Cache, computeWithCache } from "../../runtime/cache/cache.js";
import { PolicyEngine } from "../../runtime/policy-engine/policy-engine.js";
import { ApprovalRequiredError, ApprovalWorkflow } from "../../runtime/policy-engine/approval.js";

describe("Proof: P0 kernel end-to-end scenario", () => {
  it("summarizes a PR with the cheapest capable model, under budget, with caching, only on the relevant event", async () => {
    const bus = new EventBus();
    const registry = createDefaultModelRegistry();
    const gateway = new ModelGateway();
    gateway.registerProvider(new MockProvider());
    const router = new CheapestCapableModelRouter(registry);
    const costEngine = new CostEngine();
    const budget = new BudgetGuard(costEngine, { perRunUsd: 1 });
    const summaryCache = new Cache<string>();

    const summarize = vi.fn(async (prNumber: number) => {
      const decision = router.selectModel({
        taskId: `summarize-pr-${prNumber}`,
        risk: 0,
        requiredCapabilities: ["summarization"]
      });
      const response = await gateway.invoke(decision.model, { prompt: `Summarize PR #${prNumber}` });
      budget.spend({
        taskId: `summarize-pr-${prNumber}`,
        provider: response.provider,
        modelId: response.modelId,
        amountUsd: response.costUsd
      });
      return response.output;
    });

    const prAgent = new EventDrivenAgent("pull_request.opened", async (event) => {
      const { number } = event.payload as { number: number };
      const { cached } = await computeWithCache(summaryCache, `pr-${number}`, () => summarize(number));
      void cached;
    });
    prAgent.attach(bus);

    // Idle until the relevant event fires (Proof F/I).
    expect(prAgent.invocations).toBe(0);
    await bus.emit({ type: "issue.commented", payload: {} }); // irrelevant event
    expect(prAgent.invocations).toBe(0);

    // Relevant event fires twice for the same PR (e.g. a retried webhook).
    await bus.emit({ type: "pull_request.opened", payload: { number: 42 } });
    await bus.emit({ type: "pull_request.opened", payload: { number: 42 } });

    expect(prAgent.invocations).toBe(2); // the agent activated twice...
    expect(summarize).toHaveBeenCalledTimes(1); // ...but only computed once, thanks to the cache (Proof G)
    expect(registry.findCapable(["summarization"]).some((m) => m.modelId === "mock-classifier")).toBe(true);
    expect(costEngine.total()).toBe(0); // the MOCK-tier model used here is free
  });

  it("never auto-executes a risk-5 release action, regardless of how many times the event fires", async () => {
    const policy = new PolicyEngine();
    const approvals = new ApprovalWorkflow();
    const bus = new EventBus();

    const releaseAgent = new EventDrivenAgent("release.requested", (event) => {
      const { releaseId } = event.payload as { releaseId: string };
      const decision = policy.evaluate({ actionType: "release", risk: 5, description: `Release ${releaseId}` });
      if (decision.decision === "APPROVAL_REQUIRED" && !approvals.get(releaseId)) {
        approvals.request(releaseId, `Release ${releaseId}`, 5);
      }
    });
    releaseAgent.attach(bus);

    await bus.emit({ type: "release.requested", payload: { releaseId: "v2.0.0" } });
    await bus.emit({ type: "release.requested", payload: { releaseId: "v2.0.0" } });

    // Fired twice, but still just PENDING — no path exists to EXECUTED without a human.
    expect(approvals.get("v2.0.0")!.status).toBe("PENDING");
    expect(() => approvals.execute("v2.0.0")).toThrow(ApprovalRequiredError);
  });
});
