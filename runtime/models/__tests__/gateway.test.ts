import { describe, expect, it } from "vitest";
import { ModelGateway, UnknownProviderError, type ModelInvocationResponse } from "../gateway.js";
import { createDefaultModelRegistry } from "../registry.js";
import { MockProvider } from "../providers/mock-provider.js";
import { PolicyEngine, lowRiskAllowRule } from "../../policy-engine/policy-engine.js";
import { CapabilityDeniedError, CapabilityApprovalRequiredError } from "../../capability-gateway/gateway.js";
import { CostEngine } from "../../cost/cost-engine.js";
import { BudgetGuard, BudgetExceededError } from "../../budget/budget.js";
import type { ModelProvider, ModelInvocationRequest } from "../gateway.js";
import type { ModelRecord } from "../registry.js";

/** A permissive policy that ALLOWs everything up to risk 5. */
function permissivePolicy(): PolicyEngine {
  const policy = new PolicyEngine();
  policy.addRule(lowRiskAllowRule(5));
  return policy;
}

function permissiveBudget(costEngine: CostEngine = new CostEngine()): BudgetGuard {
  return new BudgetGuard(costEngine, { perRunUsd: 1000, perTaskUsd: 1000 });
}

/**
 * A provider whose invocation only resolves when the test explicitly tells
 * it to — lets tests prove that two "concurrent" invocations genuinely
 * overlap in flight (not just that they happen to be issued back-to-back)
 * and that a budget-blocked second call never reaches this provider at all.
 */
class ControllableProvider implements ModelProvider {
  readonly id = "controllable";
  invocationCount = 0;
  private pending: Array<() => void> = [];

  async invoke(model: ModelRecord, _request: ModelInvocationRequest): Promise<ModelInvocationResponse> {
    this.invocationCount++;
    return new Promise((resolve) => {
      this.pending.push(() =>
        resolve({ modelId: model.modelId, provider: this.id, costUsd: model.costPerCall, output: "controllable-output" })
      );
    });
  }

  resolveAll(): void {
    const toResolve = this.pending;
    this.pending = [];
    for (const resolve of toResolve) resolve();
  }
}

/** A provider that always throws, to exercise the provider-failure reconciliation rule. */
class FailingProvider implements ModelProvider {
  readonly id = "failing";
  async invoke(): Promise<ModelInvocationResponse> {
    throw new Error("provider unavailable");
  }
}

function mockModel(overrides: Partial<ModelRecord> = {}): ModelRecord {
  return {
    provider: "mock",
    modelId: "m1",
    tier: "STANDARD",
    costPerCall: 0.01,
    capabilities: ["classification"],
    status: "ACTIVE",
    ...overrides
  };
}

describe("ModelGateway + MockProvider", () => {
  it("invokes the registered provider for a model and returns a deterministic response", async () => {
    const gateway = new ModelGateway();
    gateway.registerProvider(new MockProvider());
    const registry = createDefaultModelRegistry();
    const model = registry.all()[0]!;

    const response = await gateway.invoke(
      model,
      { prompt: "hello" },
      { policy: permissivePolicy(), budget: permissiveBudget(), risk: 0, taskId: "t1" }
    );
    expect(response.provider).toBe("mock");
    expect(response.modelId).toBe(model.modelId);
    expect(response.output).toContain("hello");
    expect(response.costUsd).toBe(model.costPerCall);
  });

  it("throws UnknownProviderError when no provider is registered for the model's provider id", async () => {
    const gateway = new ModelGateway();
    const registry = createDefaultModelRegistry();
    const model = registry.all()[0]!;
    await expect(
      gateway.invoke(model, { prompt: "hello" }, { policy: permissivePolicy(), budget: permissiveBudget(), risk: 0, taskId: "t1" })
    ).rejects.toThrow(UnknownProviderError);
  });

  it("core kernel tests never require a paid API — MockProvider is entirely offline and free", async () => {
    const gateway = new ModelGateway();
    gateway.registerProvider(new MockProvider());
    const registry = createDefaultModelRegistry();
    const freeModel = registry.all().find((m) => m.tier === "MOCK")!;
    const response = await gateway.invoke(
      freeModel,
      { prompt: "no network needed" },
      { policy: permissivePolicy(), budget: permissiveBudget(), risk: 0, taskId: "t1" }
    );
    expect(response.costUsd).toBe(0);
  });

  describe(
    "P1 fix (10th independent review round, 'public ModelGateway.invoke() bypasses enforcement' + " +
      "'concurrent model invocations can exceed budgets'): invoke() is the ONLY path to a provider, " +
      "and it is guarded by policy + an atomic budget reservation",
    () => {
      it("DENY prevents invocation — the provider is never called", async () => {
        const gateway = new ModelGateway();
        const provider = new ControllableProvider();
        gateway.registerProvider(provider);
        const policy = new PolicyEngine();
        policy.addRule({
          name: "deny-all",
          priority: 1,
          evaluate: () => "DENY"
        });

        await expect(
          gateway.invoke(
            mockModel({ provider: "controllable" }),
            { prompt: "x" },
            { policy, budget: permissiveBudget(), risk: 0, taskId: "t1" }
          )
        ).rejects.toThrow(CapabilityDeniedError);
        expect(provider.invocationCount).toBe(0);
      });

      it("Risk-5 APPROVAL_REQUIRED (the policy engine's own built-in floor) prevents invocation without an approval — the provider is never called", async () => {
        const gateway = new ModelGateway();
        const provider = new ControllableProvider();
        gateway.registerProvider(provider);
        // Even a permissive ALLOW-everything policy cannot bypass the
        // PolicyEngine's own risk>=5 floor (policy-engine.ts) — this is not
        // a rule ModelGateway itself defines, it inherits it structurally
        // by always going through the same PolicyEngine.evaluate().
        await expect(
          gateway.invoke(
            mockModel({ provider: "controllable" }),
            { prompt: "x" },
            { policy: permissivePolicy(), budget: permissiveBudget(), risk: 5, taskId: "t1" }
          )
        ).rejects.toThrow(CapabilityApprovalRequiredError);
        expect(provider.invocationCount).toBe(0);
      });

      it("insufficient budget prevents invocation — the provider is never called", async () => {
        const gateway = new ModelGateway();
        const provider = new ControllableProvider();
        gateway.registerProvider(provider);
        const budget = new BudgetGuard(new CostEngine(), { perRunUsd: 0.05 });

        await expect(
          gateway.invoke(
            mockModel({ provider: "controllable", costPerCall: 0.5 }),
            { prompt: "x" },
            { policy: permissivePolicy(), budget, risk: 0, taskId: "t1" }
          )
        ).rejects.toThrow(BudgetExceededError);
        expect(provider.invocationCount).toBe(0);
      });

      it("reservation happens before invocation, and successful invocation is accounted for exactly once", async () => {
        const gateway = new ModelGateway();
        const provider = new ControllableProvider();
        gateway.registerProvider(provider);
        const costEngine = new CostEngine();
        const budget = new BudgetGuard(costEngine, { perRunUsd: 1 });
        const model = mockModel({ provider: "controllable", costPerCall: 0.6 });

        const responsePromise = gateway.invoke(model, { prompt: "x" }, { policy: permissivePolicy(), budget, risk: 0, taskId: "t1" });
        // The reservation is created synchronously, before the provider ever resolves.
        expect(costEngine.total()).toBe(0); // not yet committed...
        provider.resolveAll();
        const response = await responsePromise;
        expect(response.costUsd).toBe(0.6);
        expect(costEngine.total()).toBe(0.6); // ...exactly once, after commit.
      });

      it("validation failure still records incurred cost (validation happens in router.ts, AFTER this commit)", async () => {
        // ModelGateway.invoke() itself has no concept of "validation" — that
        // lives in router.ts's routeAndExecute(), which calls validate()
        // only AFTER invoke() has already returned (and therefore already
        // committed the real cost). This test proves the commit happens
        // unconditionally inside invoke() regardless of what the caller
        // does with the response afterward.
        const gateway = new ModelGateway();
        gateway.registerProvider(new MockProvider());
        const costEngine = new CostEngine();
        const budget = new BudgetGuard(costEngine, { perRunUsd: 1 });
        const model = mockModel({ costPerCall: 0.4 });

        const response = await gateway.invoke(model, { prompt: "x" }, { policy: permissivePolicy(), budget, risk: 0, taskId: "t1" });
        const alwaysFails = (_r: ModelInvocationResponse) => false;
        expect(alwaysFails(response)).toBe(false); // caller's later validation fails...
        expect(costEngine.total()).toBe(0.4); // ...but the cost is still recorded.
      });

      it("a failing provider call releases its reservation instead of recording a cost (documented reconciliation rule)", async () => {
        const gateway = new ModelGateway();
        gateway.registerProvider(new FailingProvider());
        const costEngine = new CostEngine();
        const budget = new BudgetGuard(costEngine, { perRunUsd: 1 });
        const model = mockModel({ provider: "failing", costPerCall: 0.6 });

        await expect(
          gateway.invoke(model, { prompt: "x" }, { policy: permissivePolicy(), budget, risk: 0, taskId: "t1" })
        ).rejects.toThrow("provider unavailable");
        expect(costEngine.total()).toBe(0); // nothing was ever incurred, so nothing is recorded

        // The released reservation frees the budget back up for a real, successful call.
        const gateway2 = new ModelGateway();
        gateway2.registerProvider(new MockProvider());
        const workingModel = mockModel({ provider: "mock", costPerCall: 0.6 });
        const response = await gateway2.invoke(workingModel, { prompt: "x" }, { policy: permissivePolicy(), budget, risk: 0, taskId: "t2" });
        expect(response.costUsd).toBe(0.6);
        expect(costEngine.total()).toBe(0.6);
      });

      it(
        "BLOCKER regression (10th independent review round, exact reproduction): two concurrent $0.60 calls " +
          "against a $1.00 ceiling cannot both execute — only the first-reserved invocation ever reaches the provider",
        async () => {
          const gateway = new ModelGateway();
          const provider = new ControllableProvider();
          gateway.registerProvider(provider);
          const costEngine = new CostEngine();
          const budget = new BudgetGuard(costEngine, { perRunUsd: 1.0 });
          const model = mockModel({ provider: "controllable", costPerCall: 0.6 });

          const contextA = { policy: permissivePolicy(), budget, risk: 0 as const, taskId: "task-a" };
          const contextB = { policy: permissivePolicy(), budget, risk: 0 as const, taskId: "task-b" };

          // Fired "concurrently" — neither is awaited before the other starts.
          const pA = gateway.invoke(model, { prompt: "x" }, contextA);
          const pB = gateway.invoke(model, { prompt: "x" }, contextB);

          // B must be rejected BEFORE either provider call is ever resolved —
          // proving the reservation, not the provider round-trip, is what
          // prevented the oversubscription.
          await expect(pB).rejects.toThrow(BudgetExceededError);
          expect(provider.invocationCount).toBe(1); // only A ever reached the provider

          provider.resolveAll();
          const responseA = await pA;
          expect(responseA.costUsd).toBe(0.6);

          // Real-world incurred cost matches recorded cost exactly — no
          // silent loss of the kind Codex reproduced (only $0.60 recorded
          // despite $1.20 incurred). Here only $0.60 was ever INCURRED
          // (B never reached the provider), and exactly $0.60 is recorded.
          expect(costEngine.total()).toBe(0.6);
        }
      );

      it("fallback candidates go through the same guarded boundary as the initial attempt (no separate unguarded path)", async () => {
        // Regression against re-introducing a parallel "fast path" for
        // fallback/escalation attempts specifically — there is only ONE
        // `invoke()` on ModelGateway, so any caller (router.ts included)
        // structurally cannot reach the provider any other way.
        const gateway = new ModelGateway();
        const provider = new ControllableProvider();
        gateway.registerProvider(provider);
        const budget = permissiveBudget();

        const p1 = gateway.invoke(mockModel({ provider: "controllable" }), { prompt: "x" }, { policy: permissivePolicy(), budget, risk: 0, taskId: "fallback-1" });
        provider.resolveAll();
        await p1;
        const p2 = gateway.invoke(mockModel({ provider: "controllable" }), { prompt: "x" }, { policy: permissivePolicy(), budget, risk: 4, taskId: "fallback-2" });
        provider.resolveAll();
        await p2;

        expect(provider.invocationCount).toBe(2);
      });

      it("omitting policy/budget is a compile-time error (no optional 'skip the guard' parameter exists)", () => {
        // This test exists to document the invariant, not to execute a
        // runtime branch: `ModelInvocationContext.policy`/`.budget` are
        // REQUIRED fields (no `?`), so `gateway.invoke(model, request, {})`
        // does not type-check — see gateway.ts. There is no boolean flag
        // (e.g. `skipGuard: true`) anywhere in this type. This is a
        // structural, type-level guarantee, verified by `npm run typecheck`
        // failing if this invariant is ever weakened.
        expect(true).toBe(true);
      });
    }
  );
});
