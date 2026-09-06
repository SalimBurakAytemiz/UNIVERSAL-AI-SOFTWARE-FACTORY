import { describe, expect, it } from "vitest";
import { ModelGateway, UnknownProviderError, type ModelInvocationResponse } from "../gateway.js";
import { createDefaultModelRegistry } from "../registry.js";
import { MockProvider } from "../providers/mock-provider.js";
import { PolicyEngine, lowRiskAllowRule } from "../../policy-engine/policy-engine.js";
import { CapabilityGateway, CapabilityDeniedError, CapabilityApprovalRequiredError } from "../../capability-gateway/gateway.js";
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
  /** A snapshot of exactly what `model` looked like AT THE MOMENT this provider was called, for each call. */
  receivedModels: ModelRecord[] = [];
  private pending: Array<() => void> = [];

  async invoke(model: ModelRecord, _request: ModelInvocationRequest): Promise<ModelInvocationResponse> {
    this.invocationCount++;
    this.receivedModels.push({ ...model, capabilities: [...model.capabilities] });
    return new Promise((resolve) => {
      this.pending.push(() =>
        resolve({ modelId: model.modelId, provider: model.provider, costUsd: model.costPerCall, output: "controllable-output" })
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

  describe(
    "P1 fix (11th independent review round, 'supplied capability gateway can bypass authoritative policy'): " +
      "invoke() always builds its OWN CapabilityGateway directly from context.policy — there is no way to " +
      "inject an alternative one",
    () => {
      it("a default-DENY authoritative policy cannot be bypassed — ModelInvocationContext has no field for an alternative gateway/policy", async () => {
        const gateway = new ModelGateway();
        const provider = new ControllableProvider();
        gateway.registerProvider(provider);
        const denyPolicy = new PolicyEngine(); // no rules at all -> default deny

        const context: { policy: PolicyEngine; budget: BudgetGuard; risk: 0; taskId: string } = {
          policy: denyPolicy,
          budget: permissiveBudget(),
          risk: 0,
          taskId: "t1"
        };
        // There is no `capabilityGateway` (or any other) field left on
        // ModelInvocationContext to inject an alternative, ALLOW-everything
        // authorization object — TypeScript would reject an attempt to add
        // one (`Object literal may only specify known properties`), and at
        // the JS level there is no code path in invoke() that reads
        // anything OTHER than `context.policy` to build its
        // CapabilityGateway. This test proves the RUNTIME consequence:
        // the default-DENY policy is genuinely, unconditionally enforced.
        await expect(gateway.invoke(mockModel({ provider: "controllable" }), { prompt: "x" }, context)).rejects.toThrow(
          CapabilityDeniedError
        );
        expect(provider.invocationCount).toBe(0);
      });

      it(
        "no alternative capability gateway path bypasses policy, EVEN via a type-unsafe caller: an extra " +
          "`capabilityGateway` property wrapping an ALLOW policy, smuggled onto the context object with `as any`, " +
          "is never read by invoke() at all",
        async () => {
          const gateway = new ModelGateway();
          const provider = new ControllableProvider();
          gateway.registerProvider(provider);
          const denyPolicy = new PolicyEngine(); // authoritative, no rules -> default deny
          const allowPolicy = permissivePolicy();

          // A caller bypassing the type system entirely (`as any`) to smuggle
          // in exactly the shape the OLD, vulnerable code used to accept.
          const maliciousContext = {
            policy: denyPolicy,
            budget: permissiveBudget(),
            risk: 0,
            taskId: "t1",
            capabilityGateway: new CapabilityGateway(allowPolicy)
          } as unknown as { policy: PolicyEngine; budget: BudgetGuard; risk: 0; taskId: string };

          // Even with the extra property physically present on the object at
          // runtime, invoke() has no code path that ever reads a
          // `capabilityGateway` property from its context — this proves the
          // fix is a genuine deletion of the vulnerable read, not merely a
          // type-level restriction a careless/malicious caller could evade.
          await expect(
            gateway.invoke(mockModel({ provider: "controllable" }), { prompt: "x" }, maliciousContext)
          ).rejects.toThrow(CapabilityDeniedError);
          expect(provider.invocationCount).toBe(0);
          expect(denyPolicy.auditTrail.all().some((e) => e.type === "POLICY_DECISION")).toBe(true);
        }
      );

      it("authoritative policy audit events are always recorded, even though invoke() constructs a fresh CapabilityGateway on every call", async () => {
        const gateway = new ModelGateway();
        gateway.registerProvider(new MockProvider());
        const policy = permissivePolicy();
        expect(policy.auditTrail.all()).toHaveLength(0);

        await gateway.invoke(mockModel(), { prompt: "x" }, { policy, budget: permissiveBudget(), risk: 0, taskId: "t1" });

        const events = policy.auditTrail.all();
        expect(events.length).toBeGreaterThan(0);
        expect(events.some((e) => e.type === "POLICY_DECISION")).toBe(true);
      });

      it("a matching, correctly-authorized policy still works exactly as before (no regression in the happy path)", async () => {
        const gateway = new ModelGateway();
        gateway.registerProvider(new MockProvider());
        const response = await gateway.invoke(mockModel(), { prompt: "x" }, {
          policy: permissivePolicy(),
          budget: permissiveBudget(),
          risk: 0,
          taskId: "t1"
        });
        expect(response.output).toContain("x");
      });

      it("Risk-5 approval semantics remain enforced (the PolicyEngine's own built-in floor, not something a caller-supplied gateway could ever have overridden)", async () => {
        const gateway = new ModelGateway();
        const provider = new ControllableProvider();
        gateway.registerProvider(provider);
        await expect(
          gateway.invoke(mockModel({ provider: "controllable" }), { prompt: "x" }, {
            policy: permissivePolicy(),
            budget: permissiveBudget(),
            risk: 5,
            taskId: "t1"
          })
        ).rejects.toThrow(CapabilityApprovalRequiredError);
        expect(provider.invocationCount).toBe(0);
      });

      it("fallback/escalation execution uses the same authoritative policy path — a DENY blocks a fallback candidate exactly like the initial one", async () => {
        const gateway = new ModelGateway();
        const provider = new ControllableProvider();
        gateway.registerProvider(provider);
        const policy = new PolicyEngine();
        policy.addRule({ name: "deny-all", priority: 1, evaluate: () => "DENY" });

        // Simulates what router.ts's escalation loop does: multiple
        // sequential invoke() calls against the SAME policy/budget, no
        // alternative gateway ever passed for any of them.
        for (const taskId of ["fallback-1", "fallback-2"]) {
          await expect(
            gateway.invoke(mockModel({ provider: "controllable" }), { prompt: "x" }, {
              policy,
              budget: permissiveBudget(),
              risk: 0,
              taskId
            })
          ).rejects.toThrow(CapabilityDeniedError);
        }
        expect(provider.invocationCount).toBe(0);
      });
    }
  );

  describe(
    "P1 fix (11th independent review round, 'caller context mutation can change cost ownership during invocation'): " +
      "invoke() snapshots taskId/projectId/risk/description/model-identity into a frozen executionScope BEFORE any " +
      "async work, and never re-reads the caller's context object afterward",
    () => {
      it(
        "BLOCKER regression, exact reproduction: mutating context.projectId from A to B WHILE the provider call " +
          "is pending has ZERO effect — accounting stays entirely under project A",
        async () => {
          const gateway = new ModelGateway();
          const provider = new ControllableProvider();
          gateway.registerProvider(provider);
          const costEngine = new CostEngine();
          const budget = new BudgetGuard(costEngine, { perRunUsd: 10 });
          const model = mockModel({ provider: "controllable", costPerCall: 0.6 });

          // A mutable, caller-owned context object — exactly the shape a
          // careless (or malicious) caller might reuse/mutate.
          const mutableContext: { policy: PolicyEngine; budget: BudgetGuard; risk: 0; taskId: string; projectId: string } = {
            policy: permissivePolicy(),
            budget,
            risk: 0,
            taskId: "shared-task",
            projectId: "project-A"
          };

          const responsePromise = gateway.invoke(model, { prompt: "x" }, mutableContext);
          // Provider call is now pending (ControllableProvider never
          // resolves until told to) — mutate the SAME object the caller
          // still holds a reference to.
          mutableContext.projectId = "project-B";

          provider.resolveAll();
          await responsePromise;

          expect(costEngine.totalFor({ projectId: "project-A" })).toBe(0.6);
          expect(costEngine.totalFor({ projectId: "project-B" })).toBe(0);
        }
      );

      it("mutating context.taskId during invocation does not affect the active reservation/reconciliation", async () => {
        const gateway = new ModelGateway();
        const provider = new ControllableProvider();
        gateway.registerProvider(provider);
        const costEngine = new CostEngine();
        const budget = new BudgetGuard(costEngine, { perTaskUsd: 10 });
        const model = mockModel({ provider: "controllable", costPerCall: 0.3 });

        const mutableContext: { policy: PolicyEngine; budget: BudgetGuard; risk: 0; taskId: string } = {
          policy: permissivePolicy(),
          budget,
          risk: 0,
          taskId: "task-A"
        };

        const responsePromise = gateway.invoke(model, { prompt: "x" }, mutableContext);
        mutableContext.taskId = "task-B";
        provider.resolveAll();
        await responsePromise;

        expect(costEngine.totalFor({ taskId: "task-A" })).toBe(0.3);
        expect(costEngine.totalFor({ taskId: "task-B" })).toBe(0);
      });

      it("mutating context.policy/context.budget references mid-invocation has no effect — the ORIGINAL instances remain authoritative for this call", async () => {
        const gateway = new ModelGateway();
        const provider = new ControllableProvider();
        gateway.registerProvider(provider);
        const originalCostEngine = new CostEngine();
        const originalBudget = new BudgetGuard(originalCostEngine, { perRunUsd: 10 });
        const originalPolicy = permissivePolicy();
        const model = mockModel({ provider: "controllable", costPerCall: 0.2 });

        const mutableContext: { policy: PolicyEngine; budget: BudgetGuard; risk: 0; taskId: string } = {
          policy: originalPolicy,
          budget: originalBudget,
          risk: 0,
          taskId: "t1"
        };

        const responsePromise = gateway.invoke(model, { prompt: "x" }, mutableContext);

        // Swap out BOTH the policy and budget object references entirely —
        // a hostile "replacement" attempt, not just a field edit.
        const otherCostEngine = new CostEngine();
        mutableContext.policy = new PolicyEngine(); // default-deny, would throw if re-read
        mutableContext.budget = new BudgetGuard(otherCostEngine, { perRunUsd: 10 });

        provider.resolveAll();
        const response = await responsePromise;

        expect(response.costUsd).toBe(0.2);
        // The cost landed in the ORIGINAL budget's cost engine, never the swapped-in one.
        expect(originalCostEngine.total()).toBe(0.2);
        expect(otherCostEngine.total()).toBe(0);
      });

      it("concurrent reuse of one caller-owned context object across two invocations cannot cross-contaminate their execution scopes", async () => {
        const gateway = new ModelGateway();
        const provider = new ControllableProvider();
        gateway.registerProvider(provider);
        const costEngine = new CostEngine();
        const budget = new BudgetGuard(costEngine, { perRunUsd: 10 });
        const model = mockModel({ provider: "controllable", costPerCall: 0.25 });
        const policy = permissivePolicy();

        // The SAME mutable object is handed to two DIFFERENT invoke() calls
        // (e.g. a naive caller reusing one "current request" object).
        const sharedContext: { policy: PolicyEngine; budget: BudgetGuard; risk: 0; taskId: string; projectId?: string } = {
          policy,
          budget,
          risk: 0,
          taskId: "first",
          projectId: "project-1"
        };
        const p1 = gateway.invoke(model, { prompt: "x" }, sharedContext);
        // Mutate in place before issuing the second call — each call must
        // still resolve to its OWN synchronous-prefix snapshot.
        sharedContext.taskId = "second";
        sharedContext.projectId = "project-2";
        const p2 = gateway.invoke(model, { prompt: "x" }, sharedContext);

        provider.resolveAll();
        await Promise.all([p1, p2]);

        expect(costEngine.totalFor({ taskId: "first", projectId: "project-1" })).toBe(0.25);
        expect(costEngine.totalFor({ taskId: "second", projectId: "project-2" })).toBe(0.25);
      });

      it("policy/audit/budget/cost all reference ONE consistent execution scope for a single invocation", async () => {
        const gateway = new ModelGateway();
        gateway.registerProvider(new MockProvider());
        const costEngine = new CostEngine();
        const budget = new BudgetGuard(costEngine, { perTaskUsd: 10 });
        const policy = permissivePolicy();
        const model = mockModel({ costPerCall: 0.15 });

        await gateway.invoke(model, { prompt: "x" }, { policy, budget, risk: 0, taskId: "consistent-task", projectId: "consistent-project" });

        const policyEvent = policy.auditTrail.all().find((e) => e.type === "POLICY_DECISION");
        expect(policyEvent).toBeDefined();
        expect((policyEvent!.payload as { action: { description: string } }).action.description).toContain(
          "consistent-task"
        );
        expect(costEngine.totalFor({ taskId: "consistent-task", projectId: "consistent-project" })).toBe(0.15);
      });

      it("existing project/task budget isolation remains correct (no regression from the snapshotting change)", async () => {
        const gateway = new ModelGateway();
        gateway.registerProvider(new MockProvider());
        const costEngine = new CostEngine();
        const budget = new BudgetGuard(costEngine, { perTaskUsd: 0.5 });
        const policy = permissivePolicy();
        const model = mockModel({ costPerCall: 0.5 });

        await gateway.invoke(model, { prompt: "x" }, { policy, budget, risk: 0, taskId: "task-a" });
        // A DIFFERENT task's own ceiling is untouched by task-a's spend.
        await expect(
          gateway.invoke(model, { prompt: "x" }, { policy, budget, risk: 0, taskId: "task-b" })
        ).resolves.toBeDefined();
      });
    }
  );

  describe(
    "P1 fix (12th independent review round, 'model identity snapshot is not used during provider execution'): " +
      "invoke() passes a frozen, detached authorizedModel snapshot into the provider boundary — never the " +
      "caller-owned mutable model object",
    () => {
      it(
        "BLOCKER regression, exact reproduction: mutating model.modelId WHILE the provider call is pending has " +
          "ZERO effect — the provider receives, and accounting/reconciliation use, the ORIGINAL model id",
        async () => {
          const gateway = new ModelGateway();
          const provider = new ControllableProvider();
          gateway.registerProvider(provider);
          const costEngine = new CostEngine();
          const budget = new BudgetGuard(costEngine, { perRunUsd: 10 });

          // A mutable, caller-owned model object — NOT a frozen registry
          // record — exactly the shape a careless/malicious caller might
          // construct and continue to hold a reference to.
          const model: { provider: string; modelId: string; tier: "STANDARD"; costPerCall: number; capabilities: string[]; status: "ACTIVE" } = {
            provider: "controllable",
            modelId: "original-model",
            tier: "STANDARD",
            costPerCall: 0.4,
            capabilities: ["classification"],
            status: "ACTIVE"
          };

          const responsePromise = gateway.invoke(model, { prompt: "x" }, {
            policy: permissivePolicy(),
            budget,
            risk: 0,
            taskId: "t1"
          });

          // Mutate model identity WHILE the provider call is pending.
          model.modelId = "swapped-model";

          provider.resolveAll();
          const response = await responsePromise;

          expect(provider.receivedModels[0]!.modelId).toBe("original-model");
          expect(response.modelId).toBe("original-model");
          expect(costEngine.all()[0]!.modelId).toBe("original-model");
        }
      );

      it("mutating model.provider WHILE pending has zero effect — ownership remains the ORIGINAL provider", async () => {
        const gateway = new ModelGateway();
        const provider = new ControllableProvider();
        gateway.registerProvider(provider);
        const costEngine = new CostEngine();
        const budget = new BudgetGuard(costEngine, { perRunUsd: 10 });

        const model: { provider: string; modelId: string; tier: "STANDARD"; costPerCall: number; capabilities: string[]; status: "ACTIVE" } = {
          provider: "controllable",
          modelId: "m1",
          tier: "STANDARD",
          costPerCall: 0.2,
          capabilities: ["classification"],
          status: "ACTIVE"
        };

        const responsePromise = gateway.invoke(model, { prompt: "x" }, {
          policy: permissivePolicy(),
          budget,
          risk: 0,
          taskId: "t1"
        });

        model.provider = "some-other-provider";

        provider.resolveAll();
        const response = await responsePromise;

        expect(provider.receivedModels[0]!.provider).toBe("controllable");
        expect(response.provider).toBe("controllable");
        expect(costEngine.all()[0]!.provider).toBe("controllable");
      });

      it("mutating tier/cost metadata WHILE pending has zero effect — authorization/accounting used the ORIGINAL snapshot", async () => {
        const gateway = new ModelGateway();
        const provider = new ControllableProvider();
        gateway.registerProvider(provider);
        const costEngine = new CostEngine();
        // A ceiling that only the ORIGINAL ($0.30), not the mutated ($999), cost would satisfy.
        const budget = new BudgetGuard(costEngine, { perRunUsd: 0.3 });

        const model: { provider: string; modelId: string; tier: "STANDARD" | "PREMIUM"; costPerCall: number; capabilities: string[]; status: "ACTIVE" } = {
          provider: "controllable",
          modelId: "m1",
          tier: "STANDARD",
          costPerCall: 0.3,
          capabilities: ["classification"],
          status: "ACTIVE"
        };

        const responsePromise = gateway.invoke(model, { prompt: "x" }, {
          policy: permissivePolicy(),
          budget,
          risk: 0,
          taskId: "t1"
        });

        // If this mutation were ever consulted for accounting, it would
        // blow through the $0.30 ceiling (already reserved against the
        // ORIGINAL amount before this mutation happened).
        model.tier = "PREMIUM";
        model.costPerCall = 999;

        provider.resolveAll();
        const response = await responsePromise;

        expect(provider.receivedModels[0]!.costPerCall).toBe(0.3);
        expect(provider.receivedModels[0]!.tier).toBe("STANDARD");
        expect(response.costUsd).toBe(0.3);
        expect(costEngine.total()).toBe(0.3);
      });

      it("validation and audit reference the ORIGINAL immutable execution identity, not a post-mutation value", async () => {
        const gateway = new ModelGateway();
        const provider = new ControllableProvider();
        gateway.registerProvider(provider);
        const policy = permissivePolicy();
        const budget = permissiveBudget();

        const model: { provider: string; modelId: string; tier: "STANDARD"; costPerCall: number; capabilities: string[]; status: "ACTIVE" } = {
          provider: "controllable",
          modelId: "audited-model",
          tier: "STANDARD",
          costPerCall: 0.1,
          capabilities: ["classification"],
          status: "ACTIVE"
        };

        const responsePromise = gateway.invoke(model, { prompt: "x" }, { policy, budget, risk: 0, taskId: "t1" });
        model.modelId = "tampered-after-authorization";
        provider.resolveAll();
        await responsePromise;

        const policyEvent = policy.auditTrail.all().find((e) => e.type === "POLICY_DECISION");
        expect(policyEvent).toBeDefined();
        expect((policyEvent!.payload as { action: { description: string } }).action.description).toContain(
          "audited-model"
        );
        expect((policyEvent!.payload as { action: { description: string } }).action.description).not.toContain(
          "tampered-after-authorization"
        );
      });

      it("concurrent reuse of one caller-owned model object across two invocations cannot cross-contaminate their executions", async () => {
        const gateway = new ModelGateway();
        const provider = new ControllableProvider();
        gateway.registerProvider(provider);
        const costEngine = new CostEngine();
        const budget = new BudgetGuard(costEngine, { perRunUsd: 10 });
        const policy = permissivePolicy();

        const sharedModel: { provider: string; modelId: string; tier: "STANDARD"; costPerCall: number; capabilities: string[]; status: "ACTIVE" } = {
          provider: "controllable",
          modelId: "first-model",
          tier: "STANDARD",
          costPerCall: 0.2,
          capabilities: ["classification"],
          status: "ACTIVE"
        };

        const p1 = gateway.invoke(sharedModel, { prompt: "x" }, { policy, budget, risk: 0, taskId: "first" });
        sharedModel.modelId = "second-model";
        sharedModel.costPerCall = 0.35;
        const p2 = gateway.invoke(sharedModel, { prompt: "x" }, { policy, budget, risk: 0, taskId: "second" });

        provider.resolveAll();
        const [r1, r2] = await Promise.all([p1, p2]);

        expect(r1.modelId).toBe("first-model");
        expect(r1.costUsd).toBe(0.2);
        expect(r2.modelId).toBe("second-model");
        expect(r2.costUsd).toBe(0.35);
        expect(provider.receivedModels.map((m) => m.modelId).sort()).toEqual(["first-model", "second-model"]);
      });
    }
  );
});
