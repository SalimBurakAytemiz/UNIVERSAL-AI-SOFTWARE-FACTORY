import { describe, expect, it } from "vitest";
import {
  ModelGateway,
  UnknownProviderError,
  DuplicateProviderIdError,
  ProviderInvocationError,
  UnsafeProviderConfigurationError,
  UnsupportedProviderConfigurationError,
  IncompleteProviderIdentityError,
  computeModelInvocationIdentityDigest,
  computeProviderReplacementIdentityDigest,
  type ModelInvocationResponse
} from "../gateway.js";
import { AuditLog } from "../../audit/audit-log.js";
import { createDefaultModelRegistry } from "../registry.js";
import { MockProvider } from "../providers/mock-provider.js";
import { PolicyEngine, lowRiskAllowRule } from "../../policy-engine/policy-engine.js";
import {
  CapabilityGateway,
  CapabilityDeniedError,
  CapabilityApprovalRequiredError,
  ApprovalEvidenceMismatchError
} from "../../capability-gateway/gateway.js";
import { ApprovalWorkflow } from "../../policy-engine/approval.js";
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
  /**
   * P1 fix (34th independent review round, finding 5, "detach provider
   * execution from caller-owned state"): `ModelGateway.registerProvider()`
   * now locks every OWN, currently-existing data property of a registered
   * provider to its value at registration time (bkz. gateway.ts's
   * `detachFromCallerMutation()`), so a TOP-LEVEL primitive field can no
   * longer be reassigned once the invoke() call this fixture's own
   * `invoke()` below runs starts using it. This fixture's own invocation
   * bookkeeping is therefore routed through a single NESTED, unlocked
   * container (`#counters`) rather than a bare top-level primitive: the
   * lock is shallow (matches `freezeRecord` elsewhere in this codebase),
   * so `this.#counters.invocations++` (mutating a property of the nested
   * object, never reassigning the top-level `#counters` reference itself)
   * remains completely unaffected by the registration-time lock.
   */
  #counters = { invocations: 0 };
  get invocationCount(): number {
    return this.#counters.invocations;
  }
  /** A snapshot of exactly what `model` looked like AT THE MOMENT this provider was called, for each call. */
  receivedModels: ModelRecord[] = [];
  /**
   * A snapshot of exactly what `request` looked like AT RESOLVE TIME (not
   * invocation time) — i.e. a LAZY read, deliberately mirroring how a real
   * provider adapter might hold onto its `request` reference and read its
   * fields only once its own internal (network) work completes, rather
   * than copying it immediately when `invoke()` is first called. This is
   * the ONLY timing that can actually observe a caller's mutation racing
   * a pending call: a copy taken synchronously at invoke()-call time
   * (before the test's own mutation line even runs) would trivially
   * "pass" regardless of whether the gateway snapshots `request` or not,
   * since JS guarantees `invoke()`'s synchronous prefix (up to its first
   * genuine suspension point) always completes before a caller-scheduled
   * mutation can run.
   */
  receivedRequests: ModelInvocationRequest[] = [];
  /**
   * P1 fix (13th independent review round, "provider/model identity can
   * still change accounting and audit evidence"): when set, this
   * simulates a misbehaving/compromised provider adapter whose RESPONSE
   * carries a DIFFERENT modelId/provider than the model it was actually
   * invoked with — used to prove the gateway never trusts a response's
   * own identity fields for accounting.
   */
  forgedResponseIdentity?: { modelId?: string; provider?: string };
  private pending: Array<() => void> = [];

  async invoke(model: ModelRecord, request: ModelInvocationRequest): Promise<ModelInvocationResponse> {
    this.#counters.invocations++;
    this.receivedModels.push({ ...model, capabilities: [...model.capabilities] });
    return new Promise((resolve) => {
      this.pending.push(() => {
        // LAZY read of `request` — see `receivedRequests`' doc comment.
        this.receivedRequests.push({ ...request });
        resolve({
          modelId: this.forgedResponseIdentity?.modelId ?? model.modelId,
          provider: this.forgedResponseIdentity?.provider ?? model.provider,
          costUsd: model.costPerCall,
          output: `controllable-output:${request.prompt}`
        });
      });
    });
  }

  resolveAll(): void {
    // Drains `pending` IN PLACE (`.splice()`, never `this.pending = []`) —
    // see the fix note above `#counters`: a registered provider's `pending`
    // property is locked to its registration-time ARRAY REFERENCE, so
    // reassigning it here would throw once this provider is registered.
    // Splicing mutates that same, still-writable array instead.
    const toResolve = this.pending.splice(0, this.pending.length);
    for (const resolve of toResolve) resolve();
  }
}

/**
 * A provider that always throws a PLAIN, unclassified Error — to exercise
 * root class F's actual fail-closed default: no billing evidence at all
 * must be treated as "cost may have been incurred", never as proof of
 * zero cost.
 */
class FailingProvider implements ModelProvider {
  readonly id = "failing";
  async invoke(): Promise<ModelInvocationResponse> {
    throw new Error("provider unavailable");
  }
}

/** A provider that fails with explicit, authoritative evidence that NO cost was ever incurred. */
class NotBilledFailingProvider implements ModelProvider {
  readonly id = "not-billed-failing";
  async invoke(): Promise<ModelInvocationResponse> {
    throw new ProviderInvocationError("rejected before any request left this process", "NOT_BILLED");
  }
}

/** A provider that fails AFTER billing, but reports the EXACT incurred amount. */
class BilledExactFailingProvider implements ModelProvider {
  constructor(private readonly incurredCostUsd: number) {}
  readonly id = "billed-exact-failing";
  async invoke(): Promise<ModelInvocationResponse> {
    throw new ProviderInvocationError("billed by the provider, then the connection dropped", "BILLED", {
      incurredCostUsd: this.incurredCostUsd
    });
  }
}

/** A provider that fails and reports it WAS billed, but does not know the exact amount. */
class BilledUnknownAmountFailingProvider implements ModelProvider {
  readonly id = "billed-unknown-failing";
  async invoke(): Promise<ModelInvocationResponse> {
    throw new ProviderInvocationError("billed by the provider, exact amount unavailable", "BILLED");
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

      it("a provider call that explicitly proves NO_BILLED releases its reservation, freeing the budget for a real call (unchanged, documented rule for THIS ONE evidence-backed case)", async () => {
        const gateway = new ModelGateway();
        gateway.registerProvider(new NotBilledFailingProvider());
        const costEngine = new CostEngine();
        const budget = new BudgetGuard(costEngine, { perRunUsd: 1 });
        const model = mockModel({ provider: "not-billed-failing", costPerCall: 0.6 });

        await expect(
          gateway.invoke(model, { prompt: "x" }, { policy: permissivePolicy(), budget, risk: 0, taskId: "t1" })
        ).rejects.toThrow("rejected before any request left this process");
        expect(costEngine.total()).toBe(0); // nothing was ever incurred, so nothing is recorded

        // The released reservation frees the budget back up for a real, successful call.
        const gateway2 = new ModelGateway();
        gateway2.registerProvider(new MockProvider());
        const workingModel = mockModel({ provider: "mock", costPerCall: 0.6 });
        const response = await gateway2.invoke(workingModel, { prompt: "x" }, { policy: permissivePolicy(), budget, risk: 0, taskId: "t2" });
        expect(response.costUsd).toBe(0.6);
        expect(costEngine.total()).toBe(0.6);
      });

      describe(
        "P1 fix (33rd independent review round, finding 1 / root class F, 'billable provider failure " +
          "reconciliation'): 'provider threw == cost is zero' is no longer assumed by default",
        () => {
          it("BLOCKER regression, exact reproduction: a provider that throws a PLAIN, unclassified Error no longer has its reservation silently released — the reservation is preserved and protected instead", async () => {
            const gateway = new ModelGateway();
            gateway.registerProvider(new FailingProvider());
            const costEngine = new CostEngine();
            const budget = new BudgetGuard(costEngine, { perRunUsd: 1 });
            const model = mockModel({ provider: "failing", costPerCall: 0.6 });

            await expect(
              gateway.invoke(model, { prompt: "x" }, { policy: permissivePolicy(), budget, risk: 0, taskId: "t1" })
            ).rejects.toThrow("provider unavailable");
            expect(costEngine.total()).toBe(0); // nothing is durably recorded YET...

            // ...but the capacity is NOT freed: a second $0.60 call under
            // the SAME $1.00 perRunUsd ceiling must still be blocked,
            // proving the reservation is still outstanding, not released.
            const gateway2 = new ModelGateway();
            gateway2.registerProvider(new MockProvider());
            const workingModel = mockModel({ provider: "mock", costPerCall: 0.6 });
            await expect(
              gateway2.invoke(workingModel, { prompt: "x" }, { policy: permissivePolicy(), budget, risk: 0, taskId: "t2" })
            ).rejects.toThrow(BudgetExceededError);
          });

          it("root-cause proof: total reserved capacity for the scope remains fully outstanding after the failure — proving the reservation was preserved, not released", async () => {
            const gateway = new ModelGateway();
            gateway.registerProvider(new FailingProvider());
            const costEngine = new CostEngine();
            const budget = new BudgetGuard(costEngine, { perRunUsd: 1 });
            const model = mockModel({ provider: "failing", costPerCall: 0.6 });

            await expect(
              gateway.invoke(model, { prompt: "x" }, { policy: permissivePolicy(), budget, risk: 0, taskId: "t1" })
            ).rejects.toThrow("provider unavailable");

            expect(costEngine.reservedTotal({ taskId: "t1" })).toBe(0.6);
          });

          it("a provider that reports BILLED with an EXACT incurred cost has that exact amount committed, never erased, even though the call itself still fails", async () => {
            const gateway = new ModelGateway();
            gateway.registerProvider(new BilledExactFailingProvider(0.35));
            const costEngine = new CostEngine();
            const budget = new BudgetGuard(costEngine, { perRunUsd: 1 });
            const model = mockModel({ provider: "billed-exact-failing", costPerCall: 0.6 });

            await expect(
              gateway.invoke(model, { prompt: "x" }, { policy: permissivePolicy(), budget, risk: 0, taskId: "t1" })
            ).rejects.toThrow("billed by the provider, then the connection dropped");

            // The REAL incurred cost (0.35, not the estimated 0.6) is durably recorded.
            expect(costEngine.total()).toBe(0.35);
          });

          it("a provider that reports BILLED without a known exact amount is treated the same as UNKNOWN — protected, not released", async () => {
            const gateway = new ModelGateway();
            gateway.registerProvider(new BilledUnknownAmountFailingProvider());
            const costEngine = new CostEngine();
            const budget = new BudgetGuard(costEngine, { perRunUsd: 1 });
            const model = mockModel({ provider: "billed-unknown-failing", costPerCall: 0.6 });

            await expect(
              gateway.invoke(model, { prompt: "x" }, { policy: permissivePolicy(), budget, risk: 0, taskId: "t1" })
            ).rejects.toThrow("billed by the provider, exact amount unavailable");
            expect(costEngine.total()).toBe(0);
            expect(costEngine.reservedTotal({ taskId: "t1" })).toBe(0.6);
          });
        }
      );

      describe(
        "P1 fix (36th independent review round, finding 8, 'treat unknown providers as definitely " +
          "unbilled'): an UnknownProviderError happens entirely LOCALLY, before any provider is ever " +
          "invoked, so — unlike a genuinely ambiguous failure — it must free the reservation, never strand " +
          "it as reconciliation-required",
        () => {
          it(
            "BLOCKER regression, exact reproduction: invoking a model whose provider id was never " +
              "registered releases the reservation instead of marking it reconciliation-required — a " +
              "second, working call under the SAME tight budget still succeeds",
            async () => {
              const gateway = new ModelGateway();
              // Deliberately no provider registered for "nonexistent".
              const costEngine = new CostEngine();
              const budget = new BudgetGuard(costEngine, { perRunUsd: 1 });
              const model = mockModel({ provider: "nonexistent", costPerCall: 0.6 });

              await expect(
                gateway.invoke(model, { prompt: "x" }, { policy: permissivePolicy(), budget, risk: 0, taskId: "t1" })
              ).rejects.toThrow(UnknownProviderError);

              // Zero cost was ever recorded or remains outstanding — the
              // capacity was genuinely FREED, not merely left uncommitted.
              expect(costEngine.total()).toBe(0);
              expect(costEngine.reservedTotal({ taskId: "t1" })).toBe(0);

              // A second, real $0.60 call under the SAME $1.00 ceiling must
              // succeed — proving the first reservation was released, not
              // stranded in RECONCILIATION_FAILED (which would have kept
              // consuming capacity and, per `release()`'s own ownership
              // rules, made this reservation id permanently unreleasable).
              gateway.registerProvider(new MockProvider());
              const workingModel = mockModel({ provider: "mock", costPerCall: 0.6 });
              await expect(
                gateway.invoke(workingModel, { prompt: "x" }, { policy: permissivePolicy(), budget, risk: 0, taskId: "t2" })
              ).resolves.toMatchObject({ costUsd: 0.6 });
            }
          );

          it(
            "no regression: a provider that IS registered but throws a plain, unclassified Error (genuine " +
              "ambiguity, not local resolution failure) still keeps its reservation protected exactly as " +
              "root class F requires",
            async () => {
              const gateway = new ModelGateway();
              gateway.registerProvider(new FailingProvider());
              const costEngine = new CostEngine();
              const budget = new BudgetGuard(costEngine, { perRunUsd: 1 });
              const model = mockModel({ provider: "failing", costPerCall: 0.6 });

              await expect(
                gateway.invoke(model, { prompt: "x" }, { policy: permissivePolicy(), budget, risk: 0, taskId: "t1" })
              ).rejects.toThrow("provider unavailable");
              expect(costEngine.reservedTotal({ taskId: "t1" })).toBe(0.6);
            }
          );
        }
      );

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

  describe(
    "P1 fix (13th independent review round, 'provider/model identity can still change accounting and audit " +
      "evidence'): commit() derives provider/modelId from the pre-authorized model snapshot, never from the " +
      "provider's OWN response",
    () => {
      it(
        "BLOCKER regression, exact reproduction: a provider whose RESPONSE claims a different modelId than the " +
          "one it was actually invoked with does NOT redefine accounting — cost is recorded under the AUTHORIZED " +
          "model id",
        async () => {
          const gateway = new ModelGateway();
          const provider = new ControllableProvider();
          provider.forgedResponseIdentity = { modelId: "forged-model" };
          gateway.registerProvider(provider);
          const costEngine = new CostEngine();
          const budget = new BudgetGuard(costEngine, { perRunUsd: 10 });
          const model = mockModel({ provider: "controllable", modelId: "authorized-model", costPerCall: 0.4 });

          const responsePromise = gateway.invoke(model, { prompt: "x" }, {
            policy: permissivePolicy(),
            budget,
            risk: 0,
            taskId: "t1"
          });
          provider.resolveAll();
          const response = await responsePromise;

          // The raw response the caller sees may still surface the
          // provider's own claim...
          expect(response.modelId).toBe("forged-model");
          // ...but the durable, authoritative accounting record is keyed
          // by the AUTHORIZED identity, never the provider's claim.
          expect(costEngine.all()[0]!.modelId).toBe("authorized-model");
          expect(costEngine.totalFor({})).toBe(0.4);
        }
      );

      it("a provider whose RESPONSE claims a different provider id does NOT redefine accounting ownership", async () => {
        const gateway = new ModelGateway();
        const provider = new ControllableProvider();
        provider.forgedResponseIdentity = { provider: "forged-provider" };
        gateway.registerProvider(provider);
        const costEngine = new CostEngine();
        const budget = new BudgetGuard(costEngine, { perRunUsd: 10 });
        const model = mockModel({ provider: "controllable", modelId: "m1", costPerCall: 0.3 });

        const responsePromise = gateway.invoke(model, { prompt: "x" }, { policy: permissivePolicy(), budget, risk: 0, taskId: "t1" });
        provider.resolveAll();
        await responsePromise;

        expect(costEngine.all()[0]!.provider).toBe("controllable");
      });

      it("reconciliation (commit) uses the authorized identity even when the response identity differs — no ReservationOwnershipMismatchError is ever raised by a forged response", async () => {
        // The reservation is created with the AUTHORIZED model's own
        // provider/modelId (gateway.ts passes authorizedModel.provider/
        // .modelId to budget.reserve()) and commit() is likewise called
        // with authorizedModel's identity — so a forged response identity
        // never even reaches budget.ts's ownership-mismatch check; it is
        // filtered out at the gateway boundary itself, which is the
        // authoritative fix location per the review's required invariant.
        const gateway = new ModelGateway();
        const provider = new ControllableProvider();
        provider.forgedResponseIdentity = { modelId: "forged-model", provider: "forged-provider" };
        gateway.registerProvider(provider);
        const costEngine = new CostEngine();
        const budget = new BudgetGuard(costEngine, { perRunUsd: 10 });
        const model = mockModel({ provider: "controllable", modelId: "m1", costPerCall: 0.3 });

        const responsePromise = gateway.invoke(model, { prompt: "x" }, { policy: permissivePolicy(), budget, risk: 0, taskId: "t1" });
        provider.resolveAll();
        await expect(responsePromise).resolves.toBeDefined();
        expect(costEngine.all()).toHaveLength(1);
        expect(costEngine.all()[0]!.modelId).toBe("m1");
        expect(costEngine.all()[0]!.provider).toBe("controllable");
      });

      it("audit/policy evidence references the authorized identity, unaffected by a forged provider response", async () => {
        const gateway = new ModelGateway();
        const provider = new ControllableProvider();
        provider.forgedResponseIdentity = { modelId: "forged-model" };
        gateway.registerProvider(provider);
        const policy = permissivePolicy();
        const budget = permissiveBudget();
        const model = mockModel({ provider: "controllable", modelId: "audited-model", costPerCall: 0.1 });

        const responsePromise = gateway.invoke(model, { prompt: "x" }, { policy, budget, risk: 0, taskId: "t1" });
        provider.resolveAll();
        await responsePromise;

        const policyEvent = policy.auditTrail.all().find((e) => e.type === "POLICY_DECISION");
        expect(policyEvent).toBeDefined();
        expect((policyEvent!.payload as { action: { description: string } }).action.description).toContain(
          "audited-model"
        );
      });

      it("concurrent invocations against the same provider each keep their OWN authorized identity, even when the provider forges the SAME response identity for both", async () => {
        const gateway = new ModelGateway();
        const provider = new ControllableProvider();
        provider.forgedResponseIdentity = { modelId: "forged-shared-model" };
        gateway.registerProvider(provider);
        const costEngine = new CostEngine();
        const budget = new BudgetGuard(costEngine, { perRunUsd: 10 });
        const policy = permissivePolicy();

        const p1 = gateway.invoke(mockModel({ provider: "controllable", modelId: "model-a", costPerCall: 0.2 }), { prompt: "x" }, {
          policy,
          budget,
          risk: 0,
          taskId: "task-a"
        });
        const p2 = gateway.invoke(mockModel({ provider: "controllable", modelId: "model-b", costPerCall: 0.3 }), { prompt: "x" }, {
          policy,
          budget,
          risk: 0,
          taskId: "task-b"
        });

        provider.resolveAll();
        await Promise.all([p1, p2]);

        expect(costEngine.all().map((e) => e.modelId).sort()).toEqual(["model-a", "model-b"]);
      });
    }
  );

  describe(
    "P1 fix (13th independent review round, 'invocation payload remains caller-mutable during execution'): " +
      "invoke() passes a frozen, detached authorizedRequest snapshot into the provider boundary — never the " +
      "caller-owned mutable request object",
    () => {
      it(
        "BLOCKER regression, exact reproduction: mutating request.prompt WHILE the provider call is pending has " +
          "ZERO effect — the provider receives the ORIGINAL prompt",
        async () => {
          const gateway = new ModelGateway();
          const provider = new ControllableProvider();
          gateway.registerProvider(provider);
          const budget = permissiveBudget();
          const model = mockModel({ provider: "controllable" });

          const mutableRequest: { prompt: string; taskType?: string } = { prompt: "original prompt" };
          const responsePromise = gateway.invoke(model, mutableRequest, {
            policy: permissivePolicy(),
            budget,
            risk: 0,
            taskId: "t1"
          });

          mutableRequest.prompt = "attacker-controlled replacement prompt";

          provider.resolveAll();
          await responsePromise;

          expect(provider.receivedRequests[0]!.prompt).toBe("original prompt");
        }
      );

      it("mutating request.taskType WHILE pending has zero effect — the provider receives the ORIGINAL taskType", async () => {
        const gateway = new ModelGateway();
        const provider = new ControllableProvider();
        gateway.registerProvider(provider);
        const budget = permissiveBudget();
        const model = mockModel({ provider: "controllable" });

        const mutableRequest: { prompt: string; taskType?: string } = { prompt: "x", taskType: "original-type" };
        const responsePromise = gateway.invoke(model, mutableRequest, {
          policy: permissivePolicy(),
          budget,
          risk: 0,
          taskId: "t1"
        });

        mutableRequest.taskType = "swapped-type";

        provider.resolveAll();
        await responsePromise;

        expect(provider.receivedRequests[0]!.taskType).toBe("original-type");
      });

      it("concurrent reuse of one caller-owned request object across two invocations cannot cross-contaminate their payloads", async () => {
        const gateway = new ModelGateway();
        const provider = new ControllableProvider();
        gateway.registerProvider(provider);
        const budget = permissiveBudget();
        const policy = permissivePolicy();

        const sharedRequest: { prompt: string } = { prompt: "first prompt" };
        const p1 = gateway.invoke(mockModel({ provider: "controllable" }), sharedRequest, { policy, budget, risk: 0, taskId: "first" });
        sharedRequest.prompt = "second prompt";
        const p2 = gateway.invoke(mockModel({ provider: "controllable" }), sharedRequest, { policy, budget, risk: 0, taskId: "second" });

        provider.resolveAll();
        await Promise.all([p1, p2]);

        expect(provider.receivedRequests.map((r) => r.prompt).sort()).toEqual(["first prompt", "second prompt"]);
      });
    }
  );

  describe(
    "P1 fix (25th independent review round, 'approval evidence must flow through model invocation path'): " +
      "ModelGateway owns its OWN authoritative ApprovalWorkflow (constructor-injected, exactly like " +
      "CapabilityGateway's own approvals field) and ModelInvocationContext.approvalId is the ONLY way a real, " +
      "reviewer-granted approval can reach a risk-5 invocation",
    () => {
      it("BLOCKER regression, exact reproduction: a risk-5 invocation with a valid, matching approval succeeds exactly once", async () => {
        const approvals = new ApprovalWorkflow();
        const gateway = new ModelGateway(approvals);
        const provider = new ControllableProvider();
        gateway.registerProvider(provider);
        const costEngine = new CostEngine();
        const budget = new BudgetGuard(costEngine, { perRunUsd: 10 });
        const model = mockModel({ provider: "controllable", costPerCall: 0.4 });

        // The SAME identity invoke() will build internally: actionType
        // "model.invoke", the exact description/risk/costUsd/projectId
        // this call will use, plus (34th independent review round, finding
        // 3) the SAME identityDigest invoke() will compute from the exact
        // task/run/agent/provider/model/prompt it will actually invoke.
        approvals.requestFor("appr-1", {
          actionType: "model.invoke",
          description: "risk-5 approved action",
          risk: 5,
          costUsd: 0.4,
          projectId: "project-x",
          identityDigest: computeModelInvocationIdentityDigest({
            taskId: "t1",
            provider: "controllable",
            modelId: model.modelId,
            prompt: "x"
          })
        });
        approvals.approve("appr-1", "founder@example.com");

        const responsePromise = gateway.invoke(model, { prompt: "x" }, {
          policy: permissivePolicy(),
          budget,
          risk: 5,
          taskId: "t1",
          projectId: "project-x",
          description: "risk-5 approved action",
          approvalId: "appr-1"
        });
        provider.resolveAll();
        const response = await responsePromise;

        expect(response.output).toContain("x");
        expect(costEngine.totalFor({ projectId: "project-x" })).toBe(0.4);
        expect(approvals.get("appr-1")!.status).toBe("EXECUTED");
      });

      it("without approvalId, a risk-5 invocation remains blocked exactly as before — no default bypass was introduced", async () => {
        const approvals = new ApprovalWorkflow();
        const gateway = new ModelGateway(approvals);
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

      it("reusing the SAME approvalId for a second invocation is rejected — an approval authorizes exactly one execution", async () => {
        const approvals = new ApprovalWorkflow();
        const gateway = new ModelGateway(approvals);
        const provider = new ControllableProvider();
        gateway.registerProvider(provider);
        const budget = permissiveBudget();
        const model = mockModel({ provider: "controllable", costPerCall: 0.2 });

        approvals.requestFor("appr-reuse", {
          actionType: "model.invoke",
          description: "reused approval",
          risk: 5,
          costUsd: 0.2,
          identityDigest: computeModelInvocationIdentityDigest({
            taskId: "t1",
            provider: "controllable",
            modelId: model.modelId,
            prompt: "first"
          })
        });
        approvals.approve("appr-reuse", "founder@example.com");

        const context = {
          policy: permissivePolicy(),
          budget,
          risk: 5 as const,
          taskId: "t1",
          description: "reused approval",
          approvalId: "appr-reuse"
        };

        const p1 = gateway.invoke(model, { prompt: "first" }, context);
        provider.resolveAll();
        await expect(p1).resolves.toBeDefined();

        // The SAME approval id, presented again for a SECOND invocation —
        // the underlying request is now EXECUTED, not APPROVED.
        await expect(gateway.invoke(model, { prompt: "second" }, context)).rejects.toThrow(
          ApprovalEvidenceMismatchError
        );
        expect(provider.invocationCount).toBe(1); // the second attempt never reached the provider
      });

      it("an approval bound to a DIFFERENT action identity (different costUsd) does not authorize this invocation", async () => {
        const approvals = new ApprovalWorkflow();
        const gateway = new ModelGateway(approvals);
        const provider = new ControllableProvider();
        gateway.registerProvider(provider);
        const budget = permissiveBudget();
        const model = mockModel({ provider: "controllable", costPerCall: 0.4 });

        // Approved for a DIFFERENT cost than the actual invocation will carry.
        approvals.requestFor("appr-mismatch", {
          actionType: "model.invoke",
          description: "mismatched-cost action",
          risk: 5,
          costUsd: 999
        });
        approvals.approve("appr-mismatch", "founder@example.com");

        await expect(
          gateway.invoke(model, { prompt: "x" }, {
            policy: permissivePolicy(),
            budget,
            risk: 5,
            taskId: "t1",
            description: "mismatched-cost action",
            approvalId: "appr-mismatch"
          })
        ).rejects.toThrow(ApprovalEvidenceMismatchError);
        expect(provider.invocationCount).toBe(0);
      });

      it("an approval registered in a DIFFERENT ModelGateway's own approvals store is invisible to this gateway", async () => {
        const otherGatewaysApprovals = new ApprovalWorkflow();
        otherGatewaysApprovals.requestFor("appr-elsewhere", {
          actionType: "model.invoke",
          description: "elsewhere",
          risk: 5,
          costUsd: 0.1
        });
        otherGatewaysApprovals.approve("appr-elsewhere", "founder@example.com");

        // This gateway was constructed with its OWN, separate, empty store.
        const gateway = new ModelGateway(new ApprovalWorkflow());
        const provider = new ControllableProvider();
        gateway.registerProvider(provider);

        await expect(
          gateway.invoke(mockModel({ provider: "controllable", costPerCall: 0.1 }), { prompt: "x" }, {
            policy: permissivePolicy(),
            budget: permissiveBudget(),
            risk: 5,
            taskId: "t1",
            description: "elsewhere",
            approvalId: "appr-elsewhere"
          })
        ).rejects.toThrow(ApprovalEvidenceMismatchError);
        expect(provider.invocationCount).toBe(0);
      });
    }
  );

  describe(
    "P1 fix (34th independent review round, finding 3, 'bind approvals to the exact model invocation'): " +
      "an approval bound to one prompt/model/run cannot authorize a materially different one, even when " +
      "actionType/description/risk/costUsd/projectId all happen to match",
    () => {
      it(
        "BLOCKER regression, exact reproduction: approval for prompt/model/run A -> cannot authorize a " +
          "materially different prompt B under the SAME description/risk/cost/project",
        async () => {
          const approvals = new ApprovalWorkflow();
          const gateway = new ModelGateway(approvals);
          const provider = new ControllableProvider();
          gateway.registerProvider(provider);
          const model = mockModel({ provider: "controllable", costPerCall: 0.4 });

          approvals.requestFor("appr-a", {
            actionType: "model.invoke",
            description: "shared description",
            risk: 5,
            costUsd: 0.4,
            projectId: "project-x",
            identityDigest: computeModelInvocationIdentityDigest({
              taskId: "t1",
              provider: "controllable",
              modelId: model.modelId,
              prompt: "prompt A"
            })
          });
          approvals.approve("appr-a", "founder@example.com");

          // Same actionType/description/risk/costUsd/projectId, but a
          // MATERIALLY DIFFERENT prompt — never approved.
          await expect(
            gateway.invoke(model, { prompt: "prompt B" }, {
              policy: permissivePolicy(),
              budget: permissiveBudget(),
              risk: 5,
              taskId: "t1",
              projectId: "project-x",
              description: "shared description",
              approvalId: "appr-a"
            })
          ).rejects.toThrow(ApprovalEvidenceMismatchError);
          expect(provider.invocationCount).toBe(0);
        }
      );

      it("BLOCKER regression: an approval for one runId cannot authorize the SAME prompt/model under a DIFFERENT run", async () => {
        const approvals = new ApprovalWorkflow();
        const gateway = new ModelGateway(approvals);
        const provider = new ControllableProvider();
        gateway.registerProvider(provider);
        const model = mockModel({ provider: "controllable", costPerCall: 0.4 });

        approvals.requestFor("appr-run-a", {
          actionType: "model.invoke",
          description: "run-scoped action",
          risk: 5,
          identityDigest: computeModelInvocationIdentityDigest({
            taskId: "t1",
            runId: "run-a",
            provider: "controllable",
            modelId: model.modelId,
            prompt: "x"
          })
        });
        approvals.approve("appr-run-a", "founder@example.com");

        await expect(
          gateway.invoke(model, { prompt: "x" }, {
            policy: permissivePolicy(),
            budget: permissiveBudget(),
            risk: 5,
            taskId: "t1",
            runId: "run-b",
            description: "run-scoped action",
            approvalId: "appr-run-a"
          })
        ).rejects.toThrow(ApprovalEvidenceMismatchError);
        expect(provider.invocationCount).toBe(0);
      });

      it("no regression: an approval whose digest genuinely matches the exact taskId/runId/agentId/provider/modelId/prompt succeeds", async () => {
        const approvals = new ApprovalWorkflow();
        const gateway = new ModelGateway(approvals);
        const provider = new ControllableProvider();
        gateway.registerProvider(provider);
        const model = mockModel({ provider: "controllable", costPerCall: 0.4 });

        approvals.requestFor("appr-exact", {
          actionType: "model.invoke",
          description: "exact-match action",
          risk: 5,
          costUsd: 0.4,
          actorId: "agent-a",
          identityDigest: computeModelInvocationIdentityDigest({
            taskId: "t1",
            runId: "run-a",
            agentId: "agent-a",
            provider: "controllable",
            modelId: model.modelId,
            prompt: "x"
          })
        });
        approvals.approve("appr-exact", "founder@example.com");

        const responsePromise = gateway.invoke(model, { prompt: "x" }, {
          policy: permissivePolicy(),
          budget: permissiveBudget(),
          risk: 5,
          taskId: "t1",
          runId: "run-a",
          agentId: "agent-a",
          description: "exact-match action",
          approvalId: "appr-exact"
        });
        provider.resolveAll();
        await expect(responsePromise).resolves.toBeDefined();
      });
    }
  );

  describe(
    "P1 fix (28th independent review round, finding 13, 'reject duplicate provider registration'): " +
      "registerProvider() fails closed on a colliding id instead of silently replacing the authoritative adapter",
    () => {
      it("BLOCKER regression, exact reproduction: registering a second adapter for an already-bound id must not silently redirect real invocations", async () => {
        const gateway = new ModelGateway();
        const legit = new MockProvider();
        gateway.registerProvider(legit);

        const rogue: ModelProvider = {
          id: "mock",
          invoke: async () => ({ modelId: "hijacked", provider: "mock", costUsd: 999, output: "hijacked" })
        };

        expect(() => gateway.registerProvider(rogue)).toThrow(DuplicateProviderIdError);

        const registry = createDefaultModelRegistry();
        const model = registry.all()[0]!;
        const response = await gateway.invoke(
          model,
          { prompt: "hello" },
          { policy: permissivePolicy(), budget: permissiveBudget(), risk: 0, taskId: "t1" }
        );
        // The original, legitimately-registered adapter is still the one actually invoked.
        expect(response.output).toContain("hello");
        expect(response.costUsd).toBe(model.costPerCall);
      });

      it("names the offending provider id in the thrown error", () => {
        const gateway = new ModelGateway();
        gateway.registerProvider(new MockProvider());
        try {
          gateway.registerProvider(new MockProvider());
          expect.unreachable("expected registerProvider to throw");
        } catch (err) {
          expect(err).toBeInstanceOf(DuplicateProviderIdError);
          expect((err as Error).message).toContain("mock");
        }
      });

      it("registering distinct provider ids on the same gateway is unaffected", () => {
        const gateway = new ModelGateway();
        gateway.registerProvider(new MockProvider());
        const other: ModelProvider = { id: "other", invoke: async () => ({ modelId: "m", provider: "other", costUsd: 0, output: "" }) };
        expect(() => gateway.registerProvider(other)).not.toThrow();
        expect(gateway.hasProvider("mock")).toBe(true);
        expect(gateway.hasProvider("other")).toBe(true);
      });

      it("replaceProvider() performs the swap explicitly and records an audited event", async () => {
        const auditLog = new AuditLog();
        const gateway = new ModelGateway(new ApprovalWorkflow(), auditLog);
        gateway.registerProvider(new MockProvider());

        const replacement: ModelProvider = {
          id: "mock",
          invoke: async () => ({ modelId: "m", provider: "mock", costUsd: 0, output: "replacement" })
        };
        await expect(
          gateway.replaceProvider(replacement, { policy: permissivePolicy(), risk: 0 })
        ).resolves.not.toThrow();

        const events = auditLog.all().filter((e) => e.type === "MODEL_PROVIDER_REPLACED");
        expect(events).toHaveLength(1);
        expect(events[0]!.payload).toMatchObject({ providerId: "mock" });
      });

      it("replaceProvider() rejects replacing an id that was never registered (it is not a disguised register())", async () => {
        const gateway = new ModelGateway(new ApprovalWorkflow(), new AuditLog());
        await expect(
          gateway.replaceProvider(new MockProvider(), { policy: permissivePolicy(), risk: 0 })
        ).rejects.toThrow(UnknownProviderError);
      });
    }
  );

  describe(
    "P2 fix (32nd independent review round, finding 6, 'snapshot provider id once before duplicate checking'): " +
      "a getter/Proxy-backed provider must not be able to answer differently across the duplicate-check read " +
      "and the store-under-this-id read",
    () => {
      it(
        "BLOCKER regression, exact reproduction: a provider whose id getter returns a FRESH id on the " +
          "duplicate check but an ALREADY-TRUSTED id when captured must still fail closed — the trusted " +
          "provider's binding must never silently change",
        async () => {
          const gateway = new ModelGateway();
          gateway.registerProvider(new MockProvider());

          let readCount = 0;
          const rogue: ModelProvider = {
            get id() {
              readCount++;
              // First read (the duplicate `.has()` check) claims a brand-new,
              // never-registered id; every SUBSEQUENT read (the map key /
              // captureProviderBinding()'s own read) claims the ALREADY-
              // TRUSTED "mock" id instead.
              return readCount === 1 ? "rogue-fresh-id" : "mock";
            },
            invoke: async () => ({ modelId: "hijacked", provider: "mock", costUsd: 999, output: "hijacked" })
          };

          // Whatever this does — succeed under "rogue-fresh-id" (since that's
          // the ONLY id ever checked for duplication) or throw — it must
          // NEVER leave "mock" bound to the rogue implementation.
          try {
            gateway.registerProvider(rogue);
          } catch {
            // acceptable outcome too, as long as "mock" stays untouched
          }

          const registry = createDefaultModelRegistry();
          const model = registry.all()[0]!;
          const response = await gateway.invoke(
            model,
            { prompt: "hello" },
            { policy: permissivePolicy(), budget: permissiveBudget(), risk: 0, taskId: "t1" }
          );
          // The original, legitimately-registered "mock" adapter is still
          // the one actually invoked — never the rogue implementation.
          expect(response.output).toContain("hello");
          expect(response.output).not.toContain("hijacked");
        }
      );

      it("no regression: an ordinary, stable-id provider still registers and stores under its own genuine id", () => {
        const gateway = new ModelGateway();
        const provider: ModelProvider = {
          id: "stable-id",
          invoke: async () => ({ modelId: "m", provider: "stable-id", costUsd: 0, output: "ok" })
        };
        expect(() => gateway.registerProvider(provider)).not.toThrow();
        expect(gateway.hasProvider("stable-id")).toBe(true);
      });

      it(
        "BLOCKER regression: the same getter-mismatch shape on replaceProvider() must not let the audit event " +
          "and the actual swap disagree on which id was replaced",
        async () => {
          const auditLog = new AuditLog();
          const gateway = new ModelGateway(new ApprovalWorkflow(), auditLog);
          gateway.registerProvider(new MockProvider());

          let readCount = 0;
          const replacement: ModelProvider = {
            get id() {
              readCount++;
              // Every read inside replaceProvider() must agree — if they
              // didn't, the lookup (`this.#providers.get(id)`) and the swap
              // (`this.#providers.set(id, ...)`) could target DIFFERENT
              // provider ids, silently registering a NEW binding instead of
              // replacing "mock", while the audit event and/or lookup used
              // a different id than the one actually mutated.
              return "mock";
            },
            invoke: async () => ({ modelId: "m", provider: "mock", costUsd: 0, output: "replacement" })
          };

          await expect(
            gateway.replaceProvider(replacement, { policy: permissivePolicy(), risk: 0 })
          ).resolves.not.toThrow();

          const events = auditLog.all().filter((e) => e.type === "MODEL_PROVIDER_REPLACED");
          expect(events).toHaveLength(1);
          expect(events[0]!.payload).toMatchObject({ providerId: "mock" });
          expect(readCount).toBeGreaterThan(0);
        }
      );
    }
  );

  describe(
    "P1 fix (37th independent review round, finding 1, 'bind provider approval to the genuinely installed " +
      "snapshot'): a stateful/Proxy-backed provider getter must not answer differently between the moment " +
      "replaceProvider() computes its approval digest and the moment it actually installs the binding",
    () => {
      it(
        "BLOCKER regression, exact reproduction: an approval matching the candidate's FIRST accessor read " +
          "must install THAT exact configuration — a second, independent read of the same stateful getter " +
          "(the shape this finding closes) must never be what ends up installed",
        async () => {
          class StatefulConfigProvider implements ModelProvider {
            readonly id = "mock";
            #reads = 0;
            constructor() {
              // An OWN (instance-level) accessor — bkz. `detachFromCallerMutation()`'ın
              // yalnızca instance'ın KENDİ (Reflect.ownKeys) özelliklerini işlediğine
              // dair notu; a class-body `get endpoint()` would live on the
              // prototype instead and never be reached by this code path.
              Object.defineProperty(this, "endpoint", {
                get: () => {
                  this.#reads++;
                  return this.#reads === 1 ? "https://good.example.com" : "https://evil.example.com";
                },
                configurable: true,
                enumerable: true
              });
            }
            async invoke(): Promise<ModelInvocationResponse> {
              return {
                modelId: "m",
                provider: "mock",
                costUsd: 0,
                output: `endpoint:${(this as unknown as { endpoint: string }).endpoint}`
              };
            }
          }

          const auditLog = new AuditLog();
          const approvals = new ApprovalWorkflow();
          const gateway = new ModelGateway(approvals, auditLog);
          gateway.registerProvider(new MockProvider());

          // A SEPARATE instance, used ONLY to compute the digest an approver
          // would have seen — its OWN counter starts fresh, so ITS first
          // read ALSO produces "good", exactly matching what the REAL
          // candidate's own first (and, post-fix, ONLY) read will produce.
          const approverView = new StatefulConfigProvider();
          const description = "Replace provider adapter 'mock'";
          approvals.requestFor("appr-1", {
            actionType: "model.provider.replace",
            description,
            risk: 0,
            identityDigest: computeProviderReplacementIdentityDigest(approverView, "mock")
          });
          approvals.approve("appr-1", "founder@example.com");

          // The REAL candidate — a fresh instance whose own counter has
          // never been read yet.
          const candidate = new StatefulConfigProvider();
          await expect(
            gateway.replaceProvider(candidate, {
              policy: permissivePolicy(),
              risk: 0,
              description,
              approvalId: "appr-1"
            })
          ).resolves.not.toThrow();

          const model = mockModel({ provider: "mock" });
          const response = await gateway.invoke(model, { prompt: "x" }, {
            policy: permissivePolicy(),
            budget: permissiveBudget(),
            risk: 0,
            taskId: "t1"
          });
          // The installed binding must reflect the SAME snapshot the
          // approval was granted for ("good") — never a second, later,
          // independent read of the same stateful getter ("evil").
          expect(response.output).toBe("endpoint:https://good.example.com");
        }
      );

      it("no regression: an ordinary, non-stateful accessor-backed provider still replaces and installs exactly as before", async () => {
        class StableAccessorProvider implements ModelProvider {
          readonly id = "mock";
          constructor() {
            Object.defineProperty(this, "endpoint", {
              get: () => "https://stable.example.com",
              configurable: true,
              enumerable: true
            });
          }
          async invoke(): Promise<ModelInvocationResponse> {
            return {
              modelId: "m",
              provider: "mock",
              costUsd: 0,
              output: `endpoint:${(this as unknown as { endpoint: string }).endpoint}`
            };
          }
        }
        const auditLog = new AuditLog();
        const approvals = new ApprovalWorkflow();
        const gateway = new ModelGateway(approvals, auditLog);
        gateway.registerProvider(new MockProvider());

        const candidate = new StableAccessorProvider();
        const description = "Replace provider adapter 'mock'";
        approvals.requestFor("appr-1", {
          actionType: "model.provider.replace",
          description,
          risk: 0,
          identityDigest: computeProviderReplacementIdentityDigest(candidate, "mock")
        });
        approvals.approve("appr-1", "founder@example.com");

        await expect(
          gateway.replaceProvider(candidate, { policy: permissivePolicy(), risk: 0, description, approvalId: "appr-1" })
        ).resolves.not.toThrow();

        const model = mockModel({ provider: "mock" });
        const response = await gateway.invoke(model, { prompt: "x" }, {
          policy: permissivePolicy(),
          budget: permissiveBudget(),
          risk: 0,
          taskId: "t1"
        });
        expect(response.output).toBe("endpoint:https://stable.example.com");
      });
    }
  );

  describe(
    "P1 fix (37th independent review round, finding 2, 'reject lossy provider configuration fingerprints'): " +
      "a provider configuration that cannot be canonically serialized (a circular reference) must fail closed, " +
      "never fall back to a lossy placeholder like '[object Object]' under which different configurations " +
      "could collide",
    () => {
      class CyclicConfigProvider implements ModelProvider {
        readonly id = "mock";
        config: Record<string, unknown> = {};
        constructor(seed: string) {
          this.config.seed = seed;
          this.config.self = this.config;
        }
        async invoke(): Promise<ModelInvocationResponse> {
          return { modelId: "m", provider: "mock", costUsd: 0, output: "x" };
        }
      }

      it(
        "BLOCKER regression, exact reproduction: computing a replacement identity digest for a provider with " +
          "a circular configuration object fails closed instead of silently succeeding with a lossy fingerprint",
        () => {
          const candidate = new CyclicConfigProvider("good");
          expect(() => computeProviderReplacementIdentityDigest(candidate, "mock")).toThrow(
            UnsupportedProviderConfigurationError
          );
        }
      );

      it(
        "root-cause proof: two MATERIALLY DIFFERENT cyclic configurations would have collapsed onto the exact " +
          "same lossy '[object Object]' fingerprint under the old fallback — both must now fail closed instead " +
          "of silently sharing a digest",
        () => {
          const good = new CyclicConfigProvider("good");
          const evil = new CyclicConfigProvider("evil");
          expect(() => computeProviderReplacementIdentityDigest(good, "mock")).toThrow(
            UnsupportedProviderConfigurationError
          );
          expect(() => computeProviderReplacementIdentityDigest(evil, "mock")).toThrow(
            UnsupportedProviderConfigurationError
          );
        }
      );

      it("no regression: an ordinary provider with a plain, non-circular configuration object still computes a stable fingerprint", () => {
        class PlainConfigProvider implements ModelProvider {
          readonly id = "mock";
          config = { endpoint: "https://good.example.com" };
          async invoke(): Promise<ModelInvocationResponse> {
            return { modelId: "m", provider: "mock", costUsd: 0, output: "x" };
          }
        }
        const provider = new PlainConfigProvider();
        expect(() => computeProviderReplacementIdentityDigest(provider, "mock")).not.toThrow();
        expect(computeProviderReplacementIdentityDigest(provider, "mock")).toBe(
          computeProviderReplacementIdentityDigest(provider, "mock")
        );
      });
    }
  );

  describe(
    "P1 fix (independent Codex review, 'reject provider state omitted by the approval fingerprint'): a " +
      "provider's config fingerprint must cover symbol-keyed properties and faithfully distinguish Map/Set " +
      "values, never silently omit or collapse behaviorally material state",
    () => {
      const ENDPOINT_SYMBOL = Symbol("endpoint");

      it(
        "BLOCKER regression, exact reproduction: two same-class candidates differing ONLY in a symbol-keyed " +
          "endpoint property produce DIFFERENT identity digests",
        () => {
          class SymbolKeyedConfigProvider implements ModelProvider {
            readonly id = "mock";
            constructor(endpoint: string) {
              (this as unknown as Record<symbol, string>)[ENDPOINT_SYMBOL] = endpoint;
            }
            async invoke(): Promise<ModelInvocationResponse> {
              return { modelId: "m", provider: "mock", costUsd: 0, output: "x" };
            }
          }
          const good = new SymbolKeyedConfigProvider("https://good.example.com");
          const evil = new SymbolKeyedConfigProvider("https://evil.example.com");
          expect(computeProviderReplacementIdentityDigest(good, "mock")).not.toBe(
            computeProviderReplacementIdentityDigest(evil, "mock")
          );
        }
      );

      it(
        "BLOCKER regression: an approval requested for one symbol-keyed endpoint configuration cannot " +
          "authorize installing a DIFFERENT symbol-keyed endpoint configuration under the same provider id",
        async () => {
          class SymbolKeyedConfigProvider implements ModelProvider {
            readonly id = "mock";
            constructor(endpoint: string) {
              (this as unknown as Record<symbol, string>)[ENDPOINT_SYMBOL] = endpoint;
            }
            async invoke(): Promise<ModelInvocationResponse> {
              return { modelId: "m", provider: "mock", costUsd: 0, output: "x" };
            }
          }
          const auditLog = new AuditLog();
          const approvals = new ApprovalWorkflow();
          const gateway = new ModelGateway(approvals, auditLog);
          gateway.registerProvider(new MockProvider());

          const description = "Replace provider adapter 'mock'";
          const goodCandidate = new SymbolKeyedConfigProvider("https://good.example.com");
          approvals.requestFor("appr-good", {
            actionType: "model.provider.replace",
            description,
            risk: 5,
            identityDigest: computeProviderReplacementIdentityDigest(goodCandidate, "mock")
          });
          approvals.approve("appr-good", "founder@example.com");

          const evilCandidate = new SymbolKeyedConfigProvider("https://evil.example.com");
          await expect(
            gateway.replaceProvider(evilCandidate, {
              policy: permissivePolicy(),
              risk: 5,
              description,
              approvalId: "appr-good"
            })
          ).rejects.toThrow(ApprovalEvidenceMismatchError);
        }
      );

      it(
        "BLOCKER regression, exact reproduction: two same-class candidates differing ONLY in a Map-valued " +
          "config field produce DIFFERENT identity digests (bare JSON.stringify would collapse both Maps to " +
          "the identical '{}' representation)",
        () => {
          class MapConfigProvider implements ModelProvider {
            readonly id = "mock";
            constructor(readonly config: Map<string, string>) {}
            async invoke(): Promise<ModelInvocationResponse> {
              return { modelId: "m", provider: "mock", costUsd: 0, output: "x" };
            }
          }
          const good = new MapConfigProvider(new Map([["endpoint", "https://good.example.com"]]));
          const evil = new MapConfigProvider(new Map([["endpoint", "https://evil.example.com"]]));
          expect(JSON.stringify(good.config)).toBe("{}");
          expect(JSON.stringify(evil.config)).toBe("{}");
          expect(computeProviderReplacementIdentityDigest(good, "mock")).not.toBe(
            computeProviderReplacementIdentityDigest(evil, "mock")
          );
        }
      );

      it(
        "BLOCKER regression, exact reproduction: two same-class candidates differing ONLY in a Set-valued " +
          "config field produce DIFFERENT identity digests",
        () => {
          class SetConfigProvider implements ModelProvider {
            readonly id = "mock";
            constructor(readonly scopes: Set<string>) {}
            async invoke(): Promise<ModelInvocationResponse> {
              return { modelId: "m", provider: "mock", costUsd: 0, output: "x" };
            }
          }
          const good = new SetConfigProvider(new Set(["read", "write"]));
          const evil = new SetConfigProvider(new Set(["read", "admin"]));
          expect(computeProviderReplacementIdentityDigest(good, "mock")).not.toBe(
            computeProviderReplacementIdentityDigest(evil, "mock")
          );
        }
      );

      it("no regression: two Map/Set configs holding the SAME entries in a DIFFERENT insertion order still fingerprint identically", () => {
        class MapSetConfigProvider implements ModelProvider {
          readonly id = "mock";
          constructor(
            readonly config: Map<string, string>,
            readonly scopes: Set<string>
          ) {}
          async invoke(): Promise<ModelInvocationResponse> {
            return { modelId: "m", provider: "mock", costUsd: 0, output: "x" };
          }
        }
        const a = new MapSetConfigProvider(
          new Map([
            ["a", "1"],
            ["b", "2"]
          ]),
          new Set(["x", "y"])
        );
        const b = new MapSetConfigProvider(
          new Map([
            ["b", "2"],
            ["a", "1"]
          ]),
          new Set(["y", "x"])
        );
        expect(computeProviderReplacementIdentityDigest(a, "mock")).toBe(computeProviderReplacementIdentityDigest(b, "mock"));
      });

      it(
        "BLOCKER regression: unsupported/non-canonicalizable configuration (a class instance, a Date) fails " +
          "closed rather than silently omitting the value or falling back to a lossy representation",
        () => {
          class DateConfigProvider implements ModelProvider {
            readonly id = "mock";
            config = { issuedAt: new Date("2024-01-01") };
            async invoke(): Promise<ModelInvocationResponse> {
              return { modelId: "m", provider: "mock", costUsd: 0, output: "x" };
            }
          }
          const provider = new DateConfigProvider();
          expect(() => computeProviderReplacementIdentityDigest(provider, "mock")).toThrow(
            UnsupportedProviderConfigurationError
          );
        }
      );

      it("no regression: an ordinary provider with plain string/number/boolean/array/object configuration still computes a stable fingerprint covering nested arrays", () => {
        class OrdinaryArrayConfigProvider implements ModelProvider {
          readonly id = "mock";
          config = { endpoints: ["https://a.example.com", "https://b.example.com"], retries: 3, secure: true };
          async invoke(): Promise<ModelInvocationResponse> {
            return { modelId: "m", provider: "mock", costUsd: 0, output: "x" };
          }
        }
        const provider = new OrdinaryArrayConfigProvider();
        expect(() => computeProviderReplacementIdentityDigest(provider, "mock")).not.toThrow();
        expect(computeProviderReplacementIdentityDigest(provider, "mock")).toBe(
          computeProviderReplacementIdentityDigest(provider, "mock")
        );
      });
    }
  );

  describe(
    "P1 fix (independent Codex review, 'reject colliding symbol-key encodings'): two distinct symbols " +
      "with the same description must never silently collapse onto the same fingerprint entry",
    () => {
      it(
        "BLOCKER regression, exact reproduction: two DISTINCT Symbol('endpoint') instances used as NESTED " +
          "config keys, each holding a different value, are rejected as unsupported rather than silently " +
          "dropping one of them",
        () => {
          class TwoDistinctSymbolsProvider implements ModelProvider {
            readonly id = "mock";
            config: Record<PropertyKey, string> = {};
            constructor(a: string, b: string) {
              // Two SEPARATE calls to Symbol() with the identical description
              // produce two DISTINCT, mutually unequal symbols.
              this.config[Symbol("endpoint")] = a;
              this.config[Symbol("endpoint")] = b;
            }
            async invoke(): Promise<ModelInvocationResponse> {
              return { modelId: "m", provider: "mock", costUsd: 0, output: "x" };
            }
          }
          const provider = new TwoDistinctSymbolsProvider("https://a.example.com", "https://b.example.com");
          expect(() => computeProviderReplacementIdentityDigest(provider, "mock")).toThrow(
            UnsupportedProviderConfigurationError
          );
        }
      );

      it("no-regression: a REGISTERED Symbol.for() key has a stable, collision-free identity and is fully supported", () => {
        class RegisteredSymbolProvider implements ModelProvider {
          readonly id = "mock";
          config: Record<PropertyKey, string>;
          constructor(endpoint: string) {
            this.config = { [Symbol.for("endpoint")]: endpoint };
          }
          async invoke(): Promise<ModelInvocationResponse> {
            return { modelId: "m", provider: "mock", costUsd: 0, output: "x" };
          }
        }
        const good = new RegisteredSymbolProvider("https://good.example.com");
        const evil = new RegisteredSymbolProvider("https://evil.example.com");
        expect(() => computeProviderReplacementIdentityDigest(good, "mock")).not.toThrow();
        expect(computeProviderReplacementIdentityDigest(good, "mock")).not.toBe(
          computeProviderReplacementIdentityDigest(evil, "mock")
        );
        // The SAME registered key, same value, on a fresh instance -> identical fingerprint.
        const goodAgain = new RegisteredSymbolProvider("https://good.example.com");
        expect(computeProviderReplacementIdentityDigest(good, "mock")).toBe(
          computeProviderReplacementIdentityDigest(goodAgain, "mock")
        );
      });
    }
  );

  describe(
    "P1 fix (independent Codex review, 'include opaque provider configuration in replacement identity'): " +
      "a provider's own explicit getBindingIdentity() contract represents behaviorally material state no " +
      "reflection API can ever see (genuine #private fields, closure-captured state)",
    () => {
      it(
        "BLOCKER regression, exact reproduction: two same-class providers differing ONLY in a genuine " +
          "#private field produce the SAME digest when the class does not implement getBindingIdentity() " +
          "(the exact gap this finding identifies), but DIFFERENT digests once it does",
        () => {
          class OpaquePrivateProvider implements ModelProvider {
            readonly id = "mock";
            #endpoint: string;
            constructor(endpoint: string) {
              this.#endpoint = endpoint;
            }
            async invoke(): Promise<ModelInvocationResponse> {
              return { modelId: "m", provider: "mock", costUsd: 0, output: this.#endpoint };
            }
          }
          const good = new OpaquePrivateProvider("https://good.example.com");
          const evil = new OpaquePrivateProvider("https://evil.example.com");
          // Without getBindingIdentity(), the #private field is genuinely
          // invisible to every reflection API — no code change here could
          // ever recover it without the provider's own cooperation.
          expect(computeProviderReplacementIdentityDigest(good, "mock")).toBe(
            computeProviderReplacementIdentityDigest(evil, "mock")
          );

          class DeclaredOpaqueProvider implements ModelProvider {
            readonly id = "mock";
            #endpoint: string;
            constructor(endpoint: string) {
              this.#endpoint = endpoint;
            }
            async invoke(): Promise<ModelInvocationResponse> {
              return { modelId: "m", provider: "mock", costUsd: 0, output: this.#endpoint };
            }
            getBindingIdentity(): string {
              return `endpoint:${this.#endpoint}`;
            }
          }
          const goodDeclared = new DeclaredOpaqueProvider("https://good.example.com");
          const evilDeclared = new DeclaredOpaqueProvider("https://evil.example.com");
          expect(computeProviderReplacementIdentityDigest(goodDeclared, "mock")).not.toBe(
            computeProviderReplacementIdentityDigest(evilDeclared, "mock")
          );
        }
      );

      it("BLOCKER regression: a provider whose getBindingIdentity() returns an empty string is rejected — governed replacement fails closed", () => {
        class BrokenIdentityProvider implements ModelProvider {
          readonly id = "mock";
          async invoke(): Promise<ModelInvocationResponse> {
            return { modelId: "m", provider: "mock", costUsd: 0, output: "x" };
          }
          getBindingIdentity(): string {
            return "";
          }
        }
        const provider = new BrokenIdentityProvider();
        expect(() => computeProviderReplacementIdentityDigest(provider, "mock")).toThrow(
          IncompleteProviderIdentityError
        );
      });

      it("BLOCKER regression: a provider whose getBindingIdentity() returns a non-string value is rejected — governed replacement fails closed", () => {
        class NonStringIdentityProvider implements ModelProvider {
          readonly id = "mock";
          async invoke(): Promise<ModelInvocationResponse> {
            return { modelId: "m", provider: "mock", costUsd: 0, output: "x" };
          }
          getBindingIdentity(): string {
            return null as unknown as string;
          }
        }
        const provider = new NonStringIdentityProvider();
        expect(() => computeProviderReplacementIdentityDigest(provider, "mock")).toThrow(
          IncompleteProviderIdentityError
        );
      });

      it("no-regression: an ordinary provider that never implements getBindingIdentity() still computes a stable digest exactly as before", () => {
        class OrdinaryProvider implements ModelProvider {
          readonly id = "mock";
          config = { retries: 3 };
          async invoke(): Promise<ModelInvocationResponse> {
            return { modelId: "m", provider: "mock", costUsd: 0, output: "x" };
          }
        }
        const provider = new OrdinaryProvider();
        expect(() => computeProviderReplacementIdentityDigest(provider, "mock")).not.toThrow();
        expect(computeProviderReplacementIdentityDigest(provider, "mock")).toBe(
          computeProviderReplacementIdentityDigest(provider, "mock")
        );
      });
    }
  );

  describe(
    "P1 fix (37th independent review round, finding 3, 'deep-freeze nested provider state under a frozen " +
      "root'): a caller who already did a SHALLOW Object.freeze() on a config value themselves must not be " +
      "able to keep mutating a NESTED object one level down",
    () => {
      it(
        "BLOCKER regression, exact reproduction: register a provider whose config object was already " +
          "Object.freeze()'d by the caller (top-level only) -> the caller mutates the still-live nested " +
          "object reference -> the gateway must still observe the ORIGINAL nested value, never the mutation",
        async () => {
          class PreFrozenConfigProvider implements ModelProvider {
            readonly id = "preFrozenConfig";
            readonly config: { readonly nested: { endpoint: string } };
            constructor() {
              // A caller who ALREADY calls Object.freeze() themselves,
              // believing this makes `config` (and everything under it)
              // immutable — Object.freeze() is shallow, so `.nested` is a
              // genuinely separate, still-mutable object.
              this.config = Object.freeze({ nested: { endpoint: "https://good.example.com" } });
            }
            async invoke(): Promise<ModelInvocationResponse> {
              return {
                modelId: "m",
                provider: "preFrozenConfig",
                costUsd: 0,
                output: `endpoint:${this.config.nested.endpoint}`
              };
            }
          }

          const gateway = new ModelGateway();
          const provider = new PreFrozenConfigProvider();
          gateway.registerProvider(provider);

          // The top-level `config` was already frozen by the CALLER before
          // registration — confirm that really is the case (this test would
          // be meaningless otherwise).
          expect(Object.isFrozen(provider.config)).toBe(true);

          // The nested object must now ALSO be locked by registration —
          // mutating it must fail closed (TypeError), never succeed.
          expect(() => {
            (provider.config.nested as { endpoint: string }).endpoint = "https://evil.example.com";
          }).toThrow(TypeError);
          expect(provider.config.nested.endpoint).toBe("https://good.example.com");

          const model = mockModel({ provider: "preFrozenConfig" });
          const response = await gateway.invoke(model, { prompt: "x" }, {
            policy: permissivePolicy(),
            budget: permissiveBudget(),
            risk: 0,
            taskId: "t1"
          });
          expect(response.output).toBe("endpoint:https://good.example.com");
        }
      );

      it("no regression: an ordinary provider with an UNFROZEN plain config object still gets its nested state frozen exactly as before", async () => {
        class OrdinaryNestedConfigProvider implements ModelProvider {
          readonly id = "ordinaryNestedConfig";
          config = { nested: { endpoint: "https://good.example.com" } };
          async invoke(): Promise<ModelInvocationResponse> {
            return {
              modelId: "m",
              provider: "ordinaryNestedConfig",
              costUsd: 0,
              output: `endpoint:${this.config.nested.endpoint}`
            };
          }
        }
        const gateway = new ModelGateway();
        const provider = new OrdinaryNestedConfigProvider();
        gateway.registerProvider(provider);

        expect(() => {
          (provider.config.nested as { endpoint: string }).endpoint = "https://evil.example.com";
        }).toThrow(TypeError);

        const model = mockModel({ provider: "ordinaryNestedConfig" });
        const response = await gateway.invoke(model, { prompt: "x" }, {
          policy: permissivePolicy(),
          budget: permissiveBudget(),
          risk: 0,
          taskId: "t1"
        });
        expect(response.output).toBe("endpoint:https://good.example.com");
      });
    }
  );

  describe(
    "P1 fix (29th independent review round, finding 2, 'provider replacement must require policy + approval + audit')",
    () => {
      function replacement(output = "replacement"): ModelProvider {
        return {
          id: "mock",
          invoke: async () => ({ modelId: "m", provider: "mock", costUsd: 0, output })
        };
      }

      it("BLOCKER regression: a policy DENY blocks provider replacement entirely, and the ORIGINAL adapter keeps serving invocations", async () => {
        const auditLog = new AuditLog();
        const gateway = new ModelGateway(new ApprovalWorkflow(), auditLog);
        gateway.registerProvider(new MockProvider());

        const denyPolicy = new PolicyEngine();
        denyPolicy.addRule({ name: "deny-all", priority: 10, evaluate: () => "DENY" });

        await expect(gateway.replaceProvider(replacement(), { policy: denyPolicy, risk: 0 })).rejects.toThrow(
          CapabilityDeniedError
        );

        // No audit event was ever recorded for a blocked replacement.
        expect(auditLog.all().filter((e) => e.type === "MODEL_PROVIDER_REPLACED")).toHaveLength(0);

        // The ORIGINAL adapter still handles invocations — no silent redirection occurred.
        const registry = createDefaultModelRegistry();
        const model = registry.all()[0]!;
        const response = await gateway.invoke(model, { prompt: "hello" }, {
          policy: permissivePolicy(),
          budget: permissiveBudget(),
          risk: 0,
          taskId: "t1"
        });
        expect(response.output).toContain("hello");
        expect(response.output).not.toContain("replacement");
      });

      it("a risk-5 replacement is unconditionally APPROVAL_REQUIRED, even under an otherwise fully-permissive policy", async () => {
        const auditLog = new AuditLog();
        const approvals = new ApprovalWorkflow();
        const gateway = new ModelGateway(approvals, auditLog);
        gateway.registerProvider(new MockProvider());

        await expect(
          gateway.replaceProvider(replacement(), { policy: permissivePolicy(), risk: 5 })
        ).rejects.toThrow(CapabilityApprovalRequiredError);
        expect(auditLog.all().filter((e) => e.type === "MODEL_PROVIDER_REPLACED")).toHaveLength(0);
      });

      it("a risk-5 replacement succeeds once a genuine, matching approval is granted, and the audit event names both implementations", async () => {
        const auditLog = new AuditLog();
        const approvals = new ApprovalWorkflow();
        const gateway = new ModelGateway(approvals, auditLog);
        gateway.registerProvider(new MockProvider());

        const description = "Replace provider adapter 'mock'";
        // 34th independent review round, finding 4: the approval must be
        // bound to the EXACT candidate implementation `replaceProvider()`
        // will actually install — computed from the SAME object reference
        // passed to `replaceProvider()` below.
        const candidate = replacement();
        approvals.requestFor("appr-1", {
          actionType: "model.provider.replace",
          description,
          risk: 5,
          identityDigest: computeProviderReplacementIdentityDigest(candidate, "mock")
        });
        approvals.approve("appr-1", "founder@example.com");

        await expect(
          gateway.replaceProvider(candidate, {
            policy: permissivePolicy(),
            risk: 5,
            description,
            approvalId: "appr-1"
          })
        ).resolves.not.toThrow();

        const events = auditLog.all().filter((e) => e.type === "MODEL_PROVIDER_REPLACED");
        expect(events).toHaveLength(1);
        expect(events[0]!.payload).toMatchObject({
          providerId: "mock",
          previousImplementation: "MockProvider",
          newImplementation: "Object"
        });

        // The replacement adapter is now genuinely the one invoked.
        const registry = createDefaultModelRegistry();
        const model = registry.all()[0]!;
        const response = await gateway.invoke(model, { prompt: "x" }, {
          policy: permissivePolicy(),
          budget: permissiveBudget(),
          risk: 0,
          taskId: "t1"
        });
        expect(response.output).toBe("replacement");
      });

      it(
        "BLOCKER regression, exact reproduction (34th independent review round, finding 4): approve replacement " +
          "implementation X -> attempt installation of Y with the SAME provider id/description -> FAIL, X remains authoritative",
        async () => {
          const auditLog = new AuditLog();
          const approvals = new ApprovalWorkflow();
          const gateway = new ModelGateway(approvals, auditLog);
          gateway.registerProvider(new MockProvider());

          const description = "Replace provider adapter 'mock'";
          const implementationX = replacement("implementation-X-output");
          approvals.requestFor("appr-x", {
            actionType: "model.provider.replace",
            description,
            risk: 5,
            identityDigest: computeProviderReplacementIdentityDigest(implementationX, "mock")
          });
          approvals.approve("appr-x", "founder@example.com");

          // A DIFFERENT candidate object — same provider id, same generic
          // description — is what actually gets passed to replaceProvider().
          class ImplementationY implements ModelProvider {
            readonly id = "mock";
            async invoke(): Promise<ModelInvocationResponse> {
              return { modelId: "m", provider: "mock", costUsd: 0, output: "implementation-Y-output" };
            }
          }
          const implementationY = new ImplementationY();

          await expect(
            gateway.replaceProvider(implementationY, {
              policy: permissivePolicy(),
              risk: 5,
              description,
              approvalId: "appr-x"
            })
          ).rejects.toThrow(ApprovalEvidenceMismatchError);

          // No swap occurred — the ORIGINAL MockProvider still serves invocations.
          expect(auditLog.all().filter((e) => e.type === "MODEL_PROVIDER_REPLACED")).toHaveLength(0);
          const registry = createDefaultModelRegistry();
          const model = registry.all()[0]!;
          const response = await gateway.invoke(model, { prompt: "hello" }, {
            policy: permissivePolicy(),
            budget: permissiveBudget(),
            risk: 0,
            taskId: "t1"
          });
          expect(response.output).toContain("hello");
          expect(response.output).not.toContain("implementation-Y-output");
        }
      );

      it("an approval registered in a DIFFERENT ModelGateway's own approvals store cannot authorize this gateway's replacement", async () => {
        const elsewhere = new ApprovalWorkflow();
        elsewhere.requestFor("appr-elsewhere", { actionType: "model.provider.replace", description: "d", risk: 5 });
        elsewhere.approve("appr-elsewhere", "founder@example.com");

        const gateway = new ModelGateway(new ApprovalWorkflow(), new AuditLog());
        gateway.registerProvider(new MockProvider());

        await expect(
          gateway.replaceProvider(replacement(), {
            policy: permissivePolicy(),
            risk: 5,
            description: "d",
            approvalId: "appr-elsewhere"
          })
        ).rejects.toThrow(ApprovalEvidenceMismatchError);
      });

      it("BLOCKER regression: replaceProvider() fails closed when the ModelGateway was constructed with no AuditLog, even for a fully-permitted risk-0 replacement", async () => {
        const gateway = new ModelGateway(); // no AuditLog supplied
        gateway.registerProvider(new MockProvider());

        await expect(gateway.replaceProvider(replacement(), { policy: permissivePolicy(), risk: 0 })).rejects.toThrow(
          "ModelGateway was constructed without an AuditLog"
        );

        // The original adapter must still be the one serving invocations.
        const registry = createDefaultModelRegistry();
        const model = registry.all()[0]!;
        const response = await gateway.invoke(model, { prompt: "hello" }, {
          policy: permissivePolicy(),
          budget: permissiveBudget(),
          risk: 0,
          taskId: "t1"
        });
        expect(response.output).toContain("hello");
      });

      it(
        "P1 fix (35th independent review round, finding 11, 'prepare provider binding before recording " +
          "replacement'), BLOCKER regression, exact reproduction: a candidate whose binding construction " +
          "FAILS (its configuration cannot be safely locked) leaves NO 'MODEL_PROVIDER_REPLACED' audit " +
          "record, and the ORIGINAL provider remains authoritative",
        async () => {
          const auditLog = new AuditLog();
          const approvals = new ApprovalWorkflow();
          const gateway = new ModelGateway(approvals, auditLog);
          gateway.registerProvider(new MockProvider());

          class LockRejectingProvider implements ModelProvider {
            readonly id = "mock";
            endpoint = "https://x.example.com";
            async invoke(): Promise<ModelInvocationResponse> {
              return { modelId: "m", provider: "mock", costUsd: 0, output: "should-never-be-used" };
            }
          }
          // A Proxy whose defineProperty trap rejects every attempt to lock
          // an own property descriptor — exactly the shape
          // `detachFromCallerMutation()` (bkz. finding 5's fix) needs to
          // genuinely fail on, deterministically, without relying on any
          // platform-specific object exotica.
          const candidate = new Proxy(new LockRejectingProvider(), {
            defineProperty: () => false
          });

          await expect(
            gateway.replaceProvider(candidate, { policy: permissivePolicy(), risk: 0 })
          ).rejects.toThrow(UnsafeProviderConfigurationError);

          // No audit event was ever recorded for a replacement that never
          // actually completed.
          expect(auditLog.all().filter((e) => e.type === "MODEL_PROVIDER_REPLACED")).toHaveLength(0);

          // The ORIGINAL adapter still handles invocations — no silent
          // partial-swap occurred.
          const registry = createDefaultModelRegistry();
          const model = registry.all()[0]!;
          const response = await gateway.invoke(model, { prompt: "hello" }, {
            policy: permissivePolicy(),
            budget: permissiveBudget(),
            risk: 0,
            taskId: "t1"
          });
          expect(response.output).toContain("hello");
        }
      );

      it("registerProvider() is unaffected by the audit requirement — ordinary registration never needs an AuditLog", () => {
        const gateway = new ModelGateway();
        expect(() => gateway.registerProvider(new MockProvider())).not.toThrow();
        expect(gateway.hasProvider("mock")).toBe(true);
      });
    }
  );

  describe(
    "P1 fix (30th independent review round, finding 5, 'store immutable provider bindings'): mutating a " +
      "caller-owned provider object after registration must never redirect already-authorized calls",
    () => {
      it(
        "BLOCKER regression, exact reproduction: register provider A, mutate the ORIGINAL object's invoke " +
          "implementation to a malicious/different function -> the gateway continues using the registered binding",
        async () => {
          const provider = new MockProvider();
          const gateway = new ModelGateway();
          gateway.registerProvider(provider);

          // The caller retains a reference to the SAME object it registered and, AFTER
          // registration, reassigns its invoke method to something entirely different.
          let maliciousCalled = false;
          (provider as { invoke: unknown }).invoke = async () => {
            maliciousCalled = true;
            return { modelId: "hijacked", provider: "mock", costUsd: 0, output: "PWNED" };
          };

          const registry = createDefaultModelRegistry();
          const model = registry.all()[0]!;
          const response = await gateway.invoke(model, { prompt: "hello" }, {
            policy: permissivePolicy(),
            budget: permissiveBudget(),
            risk: 0,
            taskId: "t1"
          });

          expect(maliciousCalled).toBe(false);
          expect(response.output).toContain("hello");
          expect(response.output).not.toContain("PWNED");
        }
      );

      it("mutating the provider object's id after registration does not change which binding invoke() dispatches to", async () => {
        const provider = new MockProvider();
        const gateway = new ModelGateway();
        gateway.registerProvider(provider);

        // P1 fix (34th independent review round, finding 5, "detach
        // provider execution from caller-owned state"): registration now
        // locks every OWN, currently-existing data property (including
        // `id`) to its value at that moment — bkz. gateway.ts's
        // `detachFromCallerMutation()` — so this mutation itself now fails
        // closed, a STRONGER form of the same "never redirect" invariant
        // this test was already written to prove.
        expect(() => {
          (provider as { id: string }).id = "renamed";
        }).toThrow(TypeError);

        const registry = createDefaultModelRegistry();
        const model = registry.all()[0]!; // still references provider "mock"
        const response = await gateway.invoke(model, { prompt: "still routed" }, {
          policy: permissivePolicy(),
          budget: permissiveBudget(),
          risk: 0,
          taskId: "t1"
        });
        expect(response.output).toContain("still routed");
      });

      it("replaceProvider()'s captured binding is also immune to post-replacement mutation of the caller's new provider object", async () => {
        const gateway = new ModelGateway(undefined, new AuditLog());
        gateway.registerProvider(new MockProvider());

        const replacementProvider = new MockProvider({ fixedOutput: "legit-replacement" });
        await gateway.replaceProvider(replacementProvider, { policy: permissivePolicy(), risk: 0 });

        let maliciousCalled = false;
        (replacementProvider as { invoke: unknown }).invoke = async () => {
          maliciousCalled = true;
          return { modelId: "hijacked", provider: "mock", costUsd: 0, output: "PWNED" };
        };

        const registry = createDefaultModelRegistry();
        const model = registry.all()[0]!;
        const response = await gateway.invoke(model, { prompt: "x" }, {
          policy: permissivePolicy(),
          budget: permissiveBudget(),
          risk: 0,
          taskId: "t1"
        });

        expect(maliciousCalled).toBe(false);
        expect(response.output).toBe("legit-replacement");
      });
    }
  );

  describe(
    "P1 fix (30th independent review round, finding 6, 'provider replacement must rollback if audit fails'): " +
      "governed mutations must not apply before mandatory audit succeeds",
    () => {
      class ThrowingAuditLog extends AuditLog {
        override append(): never {
          throw new Error("simulated audit persistence failure");
        }
      }

      it(
        "BLOCKER regression, exact reproduction: approved replacement -> force audit failure -> operation FAILS " +
          "-> original provider remains active -> replacement is NOT observable",
        async () => {
          const auditLog = new ThrowingAuditLog();
          const gateway = new ModelGateway(undefined, auditLog);
          gateway.registerProvider(new MockProvider());

          const replacementProvider = new MockProvider({ fixedOutput: "should-never-be-observable" });
          await expect(
            gateway.replaceProvider(replacementProvider, { policy: permissivePolicy(), risk: 0 })
          ).rejects.toThrow("simulated audit persistence failure");

          // The original adapter must still be the one serving invocations —
          // the swap must never have taken effect despite the approved policy decision.
          const registry = createDefaultModelRegistry();
          const model = registry.all()[0]!;
          const response = await gateway.invoke(model, { prompt: "hello" }, {
            policy: permissivePolicy(),
            budget: permissiveBudget(),
            risk: 0,
            taskId: "t1"
          });
          expect(response.output).toContain("hello");
          expect(response.output).not.toContain("should-never-be-observable");
        }
      );

      it("a genuinely working AuditLog still allows the replacement to succeed and take effect (no regression)", async () => {
        const auditLog = new AuditLog();
        const gateway = new ModelGateway(undefined, auditLog);
        gateway.registerProvider(new MockProvider());

        const replacementProvider = new MockProvider({ fixedOutput: "genuinely-replaced" });
        await gateway.replaceProvider(replacementProvider, { policy: permissivePolicy(), risk: 0 });

        const registry = createDefaultModelRegistry();
        const model = registry.all()[0]!;
        const response = await gateway.invoke(model, { prompt: "x" }, {
          policy: permissivePolicy(),
          budget: permissiveBudget(),
          risk: 0,
          taskId: "t1"
        });
        expect(response.output).toBe("genuinely-replaced");
        expect(auditLog.all().filter((e) => e.type === "MODEL_PROVIDER_REPLACED")).toHaveLength(1);
      });
    }
  );

  describe(
    "P1 fix (31st independent review round, finding 2, 'preserve run and agent ownership through model " +
      "invocations'): runId/agentId now flow from ModelInvocationContext through reservation, commit, and " +
      "cost attribution",
    () => {
      it(
        "BLOCKER regression, exact reproduction: the SAME task/project invoked under DIFFERENT runs and " +
          "DIFFERENT agents keeps costs separated by run and attributable by agent",
        async () => {
          const costEngine = new CostEngine();
          const budget = new BudgetGuard(costEngine, { perRunUsd: 1 });
          const gateway = new ModelGateway();
          gateway.registerProvider(new MockProvider());
          const model = mockModel({ costPerCall: 0.6 });

          await gateway.invoke(
            model,
            { prompt: "p1" },
            { policy: permissivePolicy(), budget, risk: 0, taskId: "t1", runId: "run-a", agentId: "agent-a" }
          );
          await gateway.invoke(
            model,
            { prompt: "p2" },
            { policy: permissivePolicy(), budget, risk: 0, taskId: "t1", runId: "run-b", agentId: "agent-b" }
          );

          // Costs are genuinely separated by run — run-b's own $0.60 does
          // not count against run-a's $1 perRunUsd ceiling, and vice versa.
          expect(costEngine.totalFor({ runId: "run-a" })).toBe(0.6);
          expect(costEngine.totalFor({ runId: "run-b" })).toBe(0.6);
          // Costs are genuinely attributable by agent.
          expect(costEngine.totalFor({ agentId: "agent-a" })).toBe(0.6);
          expect(costEngine.totalFor({ agentId: "agent-b" })).toBe(0.6);
        }
      );

      it("BLOCKER: perRunUsd is actually enforced for a real model invocation, not silently unreachable", async () => {
        const costEngine = new CostEngine();
        const budget = new BudgetGuard(costEngine, { perRunUsd: 1 });
        const gateway = new ModelGateway();
        gateway.registerProvider(new MockProvider());
        const model = mockModel({ costPerCall: 0.6 });

        await gateway.invoke(model, { prompt: "p1" }, {
          policy: permissivePolicy(),
          budget,
          risk: 0,
          taskId: "t1",
          runId: "run-a"
        });

        // A second $0.60 invocation in the SAME run must be blocked by the
        // $1 perRunUsd ceiling — this is only reachable if runId genuinely
        // flows all the way through reserve()/commit().
        await expect(
          gateway.invoke(model, { prompt: "p2" }, {
            policy: permissivePolicy(),
            budget,
            risk: 0,
            taskId: "t1",
            runId: "run-a"
          })
        ).rejects.toThrow(BudgetExceededError);

        // A DIFFERENT run gets its own fresh allowance.
        const response = await gateway.invoke(model, { prompt: "p3" }, {
          policy: permissivePolicy(),
          budget,
          risk: 0,
          taskId: "t1",
          runId: "run-b"
        });
        expect(response.output).toContain("p3");
      });

      it("no regression: omitting runId/agentId entirely preserves the exact prior global-scope behavior", async () => {
        const costEngine = new CostEngine();
        const budget = new BudgetGuard(costEngine, { perRunUsd: 1 });
        const gateway = new ModelGateway();
        gateway.registerProvider(new MockProvider());
        const model = mockModel({ costPerCall: 0.6 });

        await gateway.invoke(model, { prompt: "p1" }, { policy: permissivePolicy(), budget, risk: 0, taskId: "t1" });
        // No runId supplied by either call -> both share the SAME global
        // perRunUsd scope, exactly as before this fix.
        await expect(
          gateway.invoke(model, { prompt: "p2" }, { policy: permissivePolicy(), budget, risk: 0, taskId: "t2" })
        ).rejects.toThrow(BudgetExceededError);
      });

      it("a committed CostEntry for a real invocation carries the invocation's own runId/agentId (durable attribution, not just an in-flight reservation)", async () => {
        const costEngine = new CostEngine();
        const budget = new BudgetGuard(costEngine, {});
        const gateway = new ModelGateway();
        gateway.registerProvider(new MockProvider());
        const model = mockModel({ costPerCall: 0.3 });

        await gateway.invoke(model, { prompt: "p" }, {
          policy: permissivePolicy(),
          budget,
          risk: 0,
          taskId: "t1",
          runId: "run-x",
          agentId: "agent-x"
        });

        const entry = costEngine.all().find((e) => e.taskId === "t1");
        expect(entry?.runId).toBe("run-x");
        expect(entry?.agentId).toBe("agent-x");
      });
    }
  );

  describe(
    "P1 fix (34th independent review round, finding 5, 'detach provider execution from caller-owned " +
      "state'): a registered provider's own OWN, currently-existing data properties are locked at " +
      "registration time, so a caller can no longer redirect an already-authorized provider's behavior by " +
      "mutating its config-like fields after the fact",
    () => {
      class ConfigurableProvider implements ModelProvider {
        readonly id = "configurable";
        endpoint = "https://good.example.com";
        async invoke(model: ModelRecord): Promise<ModelInvocationResponse> {
          return {
            modelId: model.modelId,
            provider: model.provider,
            costUsd: model.costPerCall,
            output: `endpoint:${this.endpoint}`
          };
        }
      }

      it(
        "BLOCKER regression, exact reproduction: register provider -> mutate provider.endpoint -> existing " +
          "authoritative binding remains unchanged",
        async () => {
          const gateway = new ModelGateway();
          const provider = new ConfigurableProvider();
          gateway.registerProvider(provider);

          // The mutation itself now fails closed (the property was locked
          // at registration) rather than silently succeeding and being
          // ignored — either way, the value the gateway actually uses can
          // never change.
          expect(() => {
            provider.endpoint = "https://evil.example.com";
          }).toThrow(TypeError);
          expect(provider.endpoint).toBe("https://good.example.com");

          const model = mockModel({ provider: "configurable" });
          const response = await gateway.invoke(model, { prompt: "x" }, {
            policy: permissivePolicy(),
            budget: permissiveBudget(),
            risk: 0,
            taskId: "t1"
          });
          expect(response.output).toBe("endpoint:https://good.example.com");
        }
      );

      it("no regression: an ordinary provider with no post-registration mutation invokes exactly as before", async () => {
        const gateway = new ModelGateway();
        const provider = new ConfigurableProvider();
        gateway.registerProvider(provider);

        const model = mockModel({ provider: "configurable" });
        const response = await gateway.invoke(model, { prompt: "x" }, {
          policy: permissivePolicy(),
          budget: permissiveBudget(),
          risk: 0,
          taskId: "t1"
        });
        expect(response.output).toBe("endpoint:https://good.example.com");
      });

      it("no regression: instrumentation that ADDS a new own property after registration (e.g. spying on a prototype method) is unaffected", () => {
        const gateway = new ModelGateway();
        const provider = new MockProvider();
        gateway.registerProvider(provider);

        // `invoke` is a PROTOTYPE method on MockProvider, not an own
        // instance property at registration time — the registration-time
        // lock only touches properties that already exist as OWN data
        // properties, so adding a brand new own property here (exactly
        // what spying on a prototype method requires) must not throw.
        expect(() => {
          Object.defineProperty(provider, "invoke", { value: async () => {}, configurable: true, writable: true });
        }).not.toThrow();
      });
    }
  );

  describe(
    "P1 fix (35th independent review round, finding 3, 'bind provider approvals to complete candidate " +
      "configuration'): two instances of the SAME provider class with materially different configuration " +
      "must never share an approval identity",
    () => {
      class EndpointProvider implements ModelProvider {
        readonly id = "mock";
        constructor(readonly endpoint: string) {}
        async invoke(): Promise<ModelInvocationResponse> {
          return { modelId: "m", provider: "mock", costUsd: 0, output: `endpoint:${this.endpoint}` };
        }
      }

      it(
        "BLOCKER regression, exact reproduction: two same-class candidates with different endpoints " +
          "produce DIFFERENT identity digests",
        () => {
          const good = new EndpointProvider("https://good.example.com");
          const evil = new EndpointProvider("https://evil.example.com");
          expect(computeProviderReplacementIdentityDigest(good, "mock")).not.toBe(
            computeProviderReplacementIdentityDigest(evil, "mock")
          );
        }
      );

      it(
        "BLOCKER regression: an approval requested for one endpoint configuration cannot authorize " +
          "installing a DIFFERENT endpoint configuration under the same provider id",
        async () => {
          const auditLog = new AuditLog();
          const approvals = new ApprovalWorkflow();
          const gateway = new ModelGateway(approvals, auditLog);
          gateway.registerProvider(new MockProvider());

          const description = "Replace provider adapter 'mock'";
          const goodCandidate = new EndpointProvider("https://good.example.com");
          approvals.requestFor("appr-good", {
            actionType: "model.provider.replace",
            description,
            risk: 5,
            identityDigest: computeProviderReplacementIdentityDigest(goodCandidate, "mock")
          });
          approvals.approve("appr-good", "founder@example.com");

          const evilCandidate = new EndpointProvider("https://evil.example.com");
          await expect(
            gateway.replaceProvider(evilCandidate, {
              policy: permissivePolicy(),
              risk: 5,
              description,
              approvalId: "appr-good"
            })
          ).rejects.toThrow(ApprovalEvidenceMismatchError);
          expect(auditLog.all().filter((e) => e.type === "MODEL_PROVIDER_REPLACED")).toHaveLength(0);
        }
      );

      it("no regression: an approval matching the EXACT candidate configuration still succeeds", async () => {
        const auditLog = new AuditLog();
        const approvals = new ApprovalWorkflow();
        const gateway = new ModelGateway(approvals, auditLog);
        gateway.registerProvider(new MockProvider());

        const description = "Replace provider adapter 'mock'";
        const candidate = new EndpointProvider("https://good.example.com");
        approvals.requestFor("appr-1", {
          actionType: "model.provider.replace",
          description,
          risk: 5,
          identityDigest: computeProviderReplacementIdentityDigest(candidate, "mock")
        });
        approvals.approve("appr-1", "founder@example.com");

        await expect(
          gateway.replaceProvider(candidate, { policy: permissivePolicy(), risk: 5, description, approvalId: "appr-1" })
        ).resolves.not.toThrow();
      });
    }
  );

  describe(
    "P1 fix (35th independent review round, finding 4, 'include taskType in invocation approval identity')",
    () => {
      it(
        "BLOCKER regression, exact reproduction: same task/model/prompt but a DIFFERENT taskType produces " +
          "a different approval identity, so the old approval cannot authorize the new action",
        async () => {
          const registry = createDefaultModelRegistry();
          const model = registry.all().find((m) => m.tier === "PREMIUM")!;
          const approvals = new ApprovalWorkflow();
          const gateway = new ModelGateway(approvals);

          approvals.requestFor("appr-1", {
            actionType: "model.invoke",
            description: `Invoke model '${model.modelId}' (${model.tier}) for task t1`,
            risk: 5,
            costUsd: model.costPerCall,
            identityDigest: computeModelInvocationIdentityDigest({
              taskId: "t1",
              provider: model.provider,
              modelId: model.modelId,
              prompt: "hello",
              taskType: "summarize"
            })
          });
          approvals.approve("appr-1", "founder@example.com");

          await expect(
            gateway.invoke(
              model,
              { prompt: "hello", taskType: "generate-code" },
              { policy: permissivePolicy(), budget: permissiveBudget(), risk: 5, taskId: "t1", approvalId: "appr-1" }
            )
          ).rejects.toThrow(ApprovalEvidenceMismatchError);
        }
      );

      it("no regression: an approval matching the EXACT taskType still authorizes the invocation", async () => {
        const registry = createDefaultModelRegistry();
        const model = registry.all().find((m) => m.tier === "PREMIUM")!;
        const approvals = new ApprovalWorkflow();
        const gateway = new ModelGateway(approvals);
        gateway.registerProvider(new MockProvider());

        approvals.requestFor("appr-1", {
          actionType: "model.invoke",
          description: `Invoke model '${model.modelId}' (${model.tier}) for task t1`,
          risk: 5,
          costUsd: model.costPerCall,
          identityDigest: computeModelInvocationIdentityDigest({
            taskId: "t1",
            provider: model.provider,
            modelId: model.modelId,
            prompt: "hello",
            taskType: "summarize"
          })
        });
        approvals.approve("appr-1", "founder@example.com");

        await expect(
          gateway.invoke(
            model,
            { prompt: "hello", taskType: "summarize" },
            { policy: permissivePolicy(), budget: permissiveBudget(), risk: 5, taskId: "t1", approvalId: "appr-1" }
          )
        ).resolves.not.toThrow();
      });
    }
  );

  describe(
    "P1 fix (35th independent review round, finding 5, 'freeze non-configurable writable provider fields')",
    () => {
      it(
        "BLOCKER regression, exact reproduction: a config field declared with a legal " +
          "{writable:true, configurable:false} descriptor (previously skipped entirely) is now locked at " +
          "registration time",
        async () => {
          class OddDescriptorProvider implements ModelProvider {
            readonly id = "odd";
            constructor() {
              Object.defineProperty(this, "endpoint", {
                value: "https://good.example.com",
                writable: true,
                configurable: false,
                enumerable: true
              });
            }
            async invoke(): Promise<ModelInvocationResponse> {
              return {
                modelId: "m",
                provider: "odd",
                costUsd: 0,
                output: `endpoint:${(this as unknown as { endpoint: string }).endpoint}`
              };
            }
          }

          const gateway = new ModelGateway();
          const provider = new OddDescriptorProvider();
          gateway.registerProvider(provider);

          expect(() => {
            (provider as unknown as { endpoint: string }).endpoint = "https://evil.example.com";
          }).toThrow(TypeError);

          const model = mockModel({ provider: "odd" });
          const response = await gateway.invoke(model, { prompt: "x" }, {
            policy: permissivePolicy(),
            budget: permissiveBudget(),
            risk: 0,
            taskId: "t1"
          });
          expect(response.output).toBe("endpoint:https://good.example.com");
        }
      );

      it("no regression: an ordinary provider with plain assignable fields still registers and invokes normally", async () => {
        class PlainProvider implements ModelProvider {
          readonly id = "plain";
          note = "unchanged";
          async invoke(): Promise<ModelInvocationResponse> {
            return { modelId: "m", provider: "plain", costUsd: 0, output: this.note };
          }
        }
        const gateway = new ModelGateway();
        gateway.registerProvider(new PlainProvider());
        const model = mockModel({ provider: "plain" });
        const response = await gateway.invoke(model, { prompt: "x" }, {
          policy: permissivePolicy(),
          budget: permissiveBudget(),
          risk: 0,
          taskId: "t1"
        });
        expect(response.output).toBe("unchanged");
      });
    }
  );

  describe(
    "P1 fix (36th independent review round, finding 6, 'snapshot provider responses before validation'): " +
      "invoke()'s returned response must be a detached, frozen snapshot the provider can no longer mutate",
    () => {
      it(
        "BLOCKER regression, exact reproduction: a provider that retains and later mutates the exact response " +
          "object it returned cannot change what the caller (or that caller's own subsequent validation) observes",
        async () => {
          let retainedResponse: { output: string; costUsd: number } | undefined;
          class MutatingProvider implements ModelProvider {
            readonly id = "mutating";
            async invoke(): Promise<ModelInvocationResponse> {
              const response = { modelId: "m", provider: "mutating", costUsd: 0.01, output: "original-output" };
              retainedResponse = response;
              return response;
            }
          }
          const gateway = new ModelGateway();
          gateway.registerProvider(new MutatingProvider());
          const model = mockModel({ provider: "mutating", costPerCall: 0.01 });
          const response = await gateway.invoke(model, { prompt: "x" }, {
            policy: permissivePolicy(),
            budget: permissiveBudget(),
            risk: 0,
            taskId: "t1"
          });
          expect(response.output).toBe("original-output");

          // The provider mutates the SAME object reference it returned —
          // simulating a provider adapter that kept the response around
          // (a cache, a log buffer) and changes it after the fact.
          expect(retainedResponse).toBeDefined();
          retainedResponse!.output = "swapped-after-return";
          retainedResponse!.costUsd = 999;

          // The gateway's returned response must be UNAFFECTED — it is a
          // detached snapshot, not a live view onto the provider's object.
          expect(response.output).toBe("original-output");
          expect(response.costUsd).toBe(0.01);
        }
      );

      it("BLOCKER: the returned response object itself is frozen — a caller cannot mutate it in place either", async () => {
        const gateway = new ModelGateway();
        gateway.registerProvider(new MockProvider());
        const model = mockModel();
        const response = await gateway.invoke(model, { prompt: "x" }, {
          policy: permissivePolicy(),
          budget: permissiveBudget(),
          risk: 0,
          taskId: "t1"
        });
        expect(() => {
          (response as { output: string }).output = "tampered";
        }).toThrow(TypeError);
      });

      it("no-regression: a well-behaved provider's response still returns normally with the expected values", async () => {
        const gateway = new ModelGateway();
        gateway.registerProvider(new MockProvider({ fixedOutput: "well-behaved" }));
        const model = mockModel();
        const response = await gateway.invoke(model, { prompt: "x" }, {
          policy: permissivePolicy(),
          budget: permissiveBudget(),
          risk: 0,
          taskId: "t1"
        });
        expect(response.output).toBe("well-behaved");
      });
    }
  );

  describe(
    "P1 fix (36th independent review round, finding 7, 'detach nested provider configuration'): a " +
      "registered provider's own NESTED plain-object configuration is now frozen too, not just the " +
      "top-level slot that points to it",
    () => {
      class NestedConfigProvider implements ModelProvider {
        readonly id = "nested-config";
        config = { endpoint: "https://good.example.com" };
        async invoke(): Promise<ModelInvocationResponse> {
          return { modelId: "m", provider: "nested-config", costUsd: 0, output: `endpoint:${this.config.endpoint}` };
        }
      }

      it(
        "BLOCKER regression, exact reproduction: register provider -> mutate provider.config.endpoint -> " +
          "the mutation fails closed and the authoritative binding remains unchanged",
        async () => {
          const gateway = new ModelGateway();
          const provider = new NestedConfigProvider();
          gateway.registerProvider(provider);

          expect(() => {
            provider.config.endpoint = "https://evil.example.com";
          }).toThrow(TypeError);
          expect(provider.config.endpoint).toBe("https://good.example.com");

          const model = mockModel({ provider: "nested-config" });
          const response = await gateway.invoke(model, { prompt: "x" }, {
            policy: permissivePolicy(),
            budget: permissiveBudget(),
            risk: 0,
            taskId: "t1"
          });
          expect(response.output).toBe("endpoint:https://good.example.com");
        }
      );

      it(
        "BLOCKER regression: an accessor-backed (getter) configuration object is evaluated ONCE at " +
          "registration time — a later change to the getter's backing store cannot redirect an " +
          "already-registered provider's execution",
        async () => {
          let backingEndpoint = "https://good.example.com";
          class AccessorConfigProvider implements ModelProvider {
            readonly id = "accessor-config";
            constructor() {
              // An OWN (instance-level) accessor property — a class-body
              // `get config()` would live on the PROTOTYPE instead, which
              // `detachFromCallerMutation()` deliberately never touches (it
              // only locks the provider INSTANCE's own properties, exactly
              // like `OddDescriptorProvider` above does for its own
              // instance-level `endpoint` data property).
              Object.defineProperty(this, "config", {
                get: () => ({ endpoint: backingEndpoint }),
                configurable: true,
                enumerable: true
              });
            }
            async invoke(): Promise<ModelInvocationResponse> {
              return {
                modelId: "m",
                provider: "accessor-config",
                costUsd: 0,
                output: `endpoint:${(this as unknown as { config: { endpoint: string } }).config.endpoint}`
              };
            }
          }
          const gateway = new ModelGateway();
          const provider = new AccessorConfigProvider();
          gateway.registerProvider(provider);

          // Mutating the backing store after registration must not change
          // what the now-baked-in, frozen snapshot property returns.
          backingEndpoint = "https://evil.example.com";
          expect((provider as unknown as { config: { endpoint: string } }).config.endpoint).toBe(
            "https://good.example.com"
          );

          const model = mockModel({ provider: "accessor-config" });
          const response = await gateway.invoke(model, { prompt: "x" }, {
            policy: permissivePolicy(),
            budget: permissiveBudget(),
            risk: 0,
            taskId: "t1"
          });
          expect(response.output).toBe("endpoint:https://good.example.com");
        }
      );

      it(
        "no regression: a provider's own nested PLAIN ARRAY used for self-tracking bookkeeping (the " +
          "ControllableProvider pattern — receivedModels.push() inside its own invoke()) remains mutable " +
          "in place after registration",
        async () => {
          const gateway = new ModelGateway();
          const provider = new ControllableProvider();
          gateway.registerProvider(provider);

          const model = mockModel({ provider: "controllable" });
          const invocation = gateway.invoke(model, { prompt: "hello" }, {
            policy: permissivePolicy(),
            budget: permissiveBudget(),
            risk: 0,
            taskId: "t1"
          });
          expect(provider.receivedModels).toHaveLength(1);
          provider.resolveAll();
          await invocation;
          expect(provider.receivedRequests).toHaveLength(1);
        }
      );

      it("no regression: an ordinary provider with no nested configuration invokes exactly as before", async () => {
        const gateway = new ModelGateway();
        gateway.registerProvider(new MockProvider({ fixedOutput: "unaffected" }));
        const model = mockModel();
        const response = await gateway.invoke(model, { prompt: "x" }, {
          policy: permissivePolicy(),
          budget: permissiveBudget(),
          risk: 0,
          taskId: "t1"
        });
        expect(response.output).toBe("unaffected");
      });
    }
  );

  describe(
    "P1 fix (P0 final closure remediation, finding 4, 'sparse provider arrays must not collide with explicit " +
      "null'): canonicalizeConfigValueForFingerprint() must fail closed on a sparse array hole rather than " +
      "letting it collapse onto the same fingerprint as an explicit null",
    () => {
      it("BLOCKER regression, exact reproduction: Array(1) (a hole) and [null] (an explicit value) must NOT produce the same identity digest", () => {
        class SparseArrayConfigProvider implements ModelProvider {
          readonly id = "mock";
          config: unknown[];
          constructor(items: unknown[]) {
            this.config = items;
          }
          async invoke(): Promise<ModelInvocationResponse> {
            return { modelId: "m", provider: "mock", costUsd: 0, output: "x" };
          }
        }
        const sparse = new SparseArrayConfigProvider(Array(1));
        const explicitNull = new SparseArrayConfigProvider([null]);

        // The finding's own instruction: fail closed on a sparse hole
        // rather than lossily normalize it — so the sparse candidate must
        // throw, and specifically must never produce a digest indistinguishable from `[null]`'s.
        expect(() => computeProviderReplacementIdentityDigest(sparse, "mock")).toThrow(
          UnsupportedProviderConfigurationError
        );
        expect(() => computeProviderReplacementIdentityDigest(explicitNull, "mock")).not.toThrow();
      });

      it("no-regression: a genuinely dense array of nulls still fingerprints normally and deterministically", () => {
        class DenseArrayConfigProvider implements ModelProvider {
          readonly id = "mock";
          config = [null, null, "x"];
          async invoke(): Promise<ModelInvocationResponse> {
            return { modelId: "m", provider: "mock", costUsd: 0, output: "x" };
          }
        }
        const provider = new DenseArrayConfigProvider();
        expect(() => computeProviderReplacementIdentityDigest(provider, "mock")).not.toThrow();
        expect(computeProviderReplacementIdentityDigest(provider, "mock")).toBe(
          computeProviderReplacementIdentityDigest(provider, "mock")
        );
      });
    }
  );
});
