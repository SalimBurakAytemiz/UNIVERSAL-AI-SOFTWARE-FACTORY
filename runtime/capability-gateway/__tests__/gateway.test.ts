import { describe, expect, it, vi } from "vitest";
import { PolicyEngine, lowRiskAllowRule } from "../../policy-engine/policy-engine.js";
import { ApprovalWorkflow } from "../../policy-engine/approval.js";
import {
  ApprovalEvidenceMismatchError,
  CapabilityApprovalRequiredError,
  CapabilityDeniedError,
  CapabilityGateway
} from "../gateway.js";

describe("CapabilityGateway", () => {
  it("executes the action only when the policy engine returns ALLOW", async () => {
    const policy = new PolicyEngine();
    policy.addRule(lowRiskAllowRule(2));
    const gateway = new CapabilityGateway(policy);
    const execute = vi.fn(() => "done");

    const result = await gateway.authorize({ actionType: "read-file", risk: 1, description: "read a file" }, execute);

    expect(result).toBe("done");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("never calls execute when the policy engine returns DENY (default deny)", async () => {
    const policy = new PolicyEngine();
    const gateway = new CapabilityGateway(policy);
    const execute = vi.fn(() => "should never run");

    await expect(
      gateway.authorize({ actionType: "unclassified", risk: 3, description: "unknown action" }, execute)
    ).rejects.toThrow(CapabilityDeniedError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("never calls execute for a risk-5 action pending human approval", async () => {
    const policy = new PolicyEngine();
    policy.addRule(lowRiskAllowRule(5)); // even an overly permissive rule cannot bypass risk-5 approval
    const gateway = new CapabilityGateway(policy);
    const execute = vi.fn(() => "should never run");

    await expect(
      gateway.authorize({ actionType: "production-deploy", risk: 5, description: "deploy to prod" }, execute)
    ).rejects.toThrow(CapabilityApprovalRequiredError);
    expect(execute).not.toHaveBeenCalled();
  });

  describe(
    "P1 fix (25th independent review round, findings 1-3, 'approval workflow must be authoritative' + " +
      "'approval must be bound to complete action identity' + 'approval evidence must be consumed before " +
      "execution'): the gateway now OWNS its approval store, matches on full action identity, and consumes " +
      "an approval exactly once",
    () => {
      const action = {
        actionType: "production-deploy",
        risk: 5 as const,
        description: "deploy to prod",
        costUsd: 0,
        projectId: "proj-x"
      };

      function approvedGateway(id: string) {
        const policy = new PolicyEngine();
        const approvals = new ApprovalWorkflow();
        approvals.requestFor(id, action);
        approvals.approve(id, "founder@example.com");
        const gateway = new CapabilityGateway(policy, approvals);
        return { gateway, approvals };
      }

      it("executes once genuine approval evidence for the EXACT same action is presented", async () => {
        const { gateway } = approvedGateway("dep-1");
        const execute = vi.fn(() => "deployed");

        const result = await gateway.authorize(action, execute, { approvalId: "dep-1" });

        expect(result).toBe("deployed");
        expect(execute).toHaveBeenCalledTimes(1);
      });

      it("still blocks execution when the referenced approval is only PENDING", async () => {
        const policy = new PolicyEngine();
        const approvals = new ApprovalWorkflow();
        approvals.requestFor("dep-2", action);
        const gateway = new CapabilityGateway(policy, approvals);
        const execute = vi.fn(() => "should never run");

        await expect(gateway.authorize(action, execute, { approvalId: "dep-2" })).rejects.toThrow(
          ApprovalEvidenceMismatchError
        );
        expect(execute).not.toHaveBeenCalled();
      });

      it("still blocks execution when the referenced approval was REJECTED", async () => {
        const policy = new PolicyEngine();
        const approvals = new ApprovalWorkflow();
        approvals.requestFor("dep-3", action);
        approvals.reject("dep-3", "founder@example.com");
        const gateway = new CapabilityGateway(policy, approvals);
        const execute = vi.fn(() => "should never run");

        await expect(gateway.authorize(action, execute, { approvalId: "dep-3" })).rejects.toThrow(
          ApprovalEvidenceMismatchError
        );
        expect(execute).not.toHaveBeenCalled();
      });

      it("still blocks execution when the referenced approval is REQUEST_CHANGES", async () => {
        const policy = new PolicyEngine();
        const approvals = new ApprovalWorkflow();
        approvals.requestFor("dep-4", action);
        approvals.requestChanges("dep-4", "founder@example.com", "needs a rollback plan");
        const gateway = new CapabilityGateway(policy, approvals);
        const execute = vi.fn(() => "should never run");

        await expect(gateway.authorize(action, execute, { approvalId: "dep-4" })).rejects.toThrow(
          ApprovalEvidenceMismatchError
        );
        expect(execute).not.toHaveBeenCalled();
      });

      it("rejects an unknown approval id", async () => {
        const policy = new PolicyEngine();
        const approvals = new ApprovalWorkflow();
        const gateway = new CapabilityGateway(policy, approvals);
        const execute = vi.fn(() => "should never run");

        await expect(gateway.authorize(action, execute, { approvalId: "never-requested" })).rejects.toThrow(
          ApprovalEvidenceMismatchError
        );
        expect(execute).not.toHaveBeenCalled();
      });

      it("an explicit policy DENY is never overridden by approval evidence, however genuine", async () => {
        const policy = new PolicyEngine();
        policy.addRule({ name: "deny-everything", priority: 100, evaluate: () => "DENY" });
        const approvals = new ApprovalWorkflow();
        approvals.requestFor("dep-5", action);
        approvals.approve("dep-5", "founder@example.com");
        const gateway = new CapabilityGateway(policy, approvals);
        const execute = vi.fn(() => "should never run");

        await expect(gateway.authorize(action, execute, { approvalId: "dep-5" })).rejects.toThrow(
          CapabilityDeniedError
        );
        expect(execute).not.toHaveBeenCalled();
      });

      describe("finding 1: a caller-forged ApprovalWorkflow can never be consulted", () => {
        it(
          "REGRESSION, exact reproduction: an approval APPROVED in a fake, caller-created workflow does not " +
            "authorize execution through a gateway wired to a DIFFERENT, authoritative workflow",
          async () => {
            const policy = new PolicyEngine();
            const authoritativeApprovals = new ApprovalWorkflow();
            const gateway = new CapabilityGateway(policy, authoritativeApprovals);

            // A malicious/careless caller fabricates its OWN workflow and
            // marks an approval APPROVED in it — but the gateway was never
            // constructed with THIS workflow, so it is structurally
            // unreachable: there is no longer any per-call parameter that
            // could even accept it.
            const fakeApprovals = new ApprovalWorkflow();
            fakeApprovals.requestFor("dep-fake", action);
            fakeApprovals.approve("dep-fake", "attacker@example.com");

            const execute = vi.fn(() => "should never run");

            // The new authorize() signature has no way to pass a workflow
            // object at all — only an approvalId string. Even presenting
            // the SAME id the fake workflow used fails, since the
            // authoritative workflow never received a matching request.
            await expect(gateway.authorize(action, execute, { approvalId: "dep-fake" })).rejects.toThrow(
              ApprovalEvidenceMismatchError
            );
            expect(execute).not.toHaveBeenCalled();
          }
        );

        it("a gateway with no explicit approvals argument still owns its OWN authoritative (empty) workflow, not an ALLOW-everything shortcut", async () => {
          const policy = new PolicyEngine();
          const gateway = new CapabilityGateway(policy);
          const execute = vi.fn(() => "should never run");

          await expect(gateway.authorize(action, execute, { approvalId: "anything" })).rejects.toThrow(
            ApprovalEvidenceMismatchError
          );
          expect(execute).not.toHaveBeenCalled();
        });
      });

      describe("finding 2: approval must be bound to complete action identity", () => {
        it("an approval for production-deploy must not authorize a materially different secret-mutation action, even with a similar description/risk", async () => {
          const policy = new PolicyEngine();
          const approvals = new ApprovalWorkflow();
          const deployAction = { actionType: "production-deploy", risk: 5 as const, description: "sensitive change" };
          approvals.requestFor("dep-6", deployAction);
          approvals.approve("dep-6", "founder@example.com");
          const gateway = new CapabilityGateway(policy, approvals);
          const execute = vi.fn(() => "should never run");

          const secretMutationAction = { actionType: "secret-mutation", risk: 5 as const, description: "sensitive change" };

          await expect(gateway.authorize(secretMutationAction, execute, { approvalId: "dep-6" })).rejects.toThrow(
            ApprovalEvidenceMismatchError
          );
          expect(execute).not.toHaveBeenCalled();
        });

        it("an approval for one project cannot authorize the identical action for a different project", async () => {
          const policy = new PolicyEngine();
          const approvals = new ApprovalWorkflow();
          const actionForA = { actionType: "production-deploy", risk: 5 as const, description: "deploy", projectId: "proj-a" };
          approvals.requestFor("dep-7", actionForA);
          approvals.approve("dep-7", "founder@example.com");
          const gateway = new CapabilityGateway(policy, approvals);
          const execute = vi.fn(() => "should never run");

          const actionForB = { actionType: "production-deploy", risk: 5 as const, description: "deploy", projectId: "proj-b" };

          await expect(gateway.authorize(actionForB, execute, { approvalId: "dep-7" })).rejects.toThrow(
            ApprovalEvidenceMismatchError
          );
          expect(execute).not.toHaveBeenCalled();
        });

        it("an approval for a different costUsd cannot authorize a more expensive action of the same type/description/risk", async () => {
          const policy = new PolicyEngine();
          const approvals = new ApprovalWorkflow();
          const cheapAction = { actionType: "model.invoke", risk: 5 as const, description: "invoke", costUsd: 0.1 };
          approvals.requestFor("dep-8", cheapAction);
          approvals.approve("dep-8", "founder@example.com");
          const gateway = new CapabilityGateway(policy, approvals);
          const execute = vi.fn(() => "should never run");

          const expensiveAction = { actionType: "model.invoke", risk: 5 as const, description: "invoke", costUsd: 999 };

          await expect(gateway.authorize(expensiveAction, execute, { approvalId: "dep-8" })).rejects.toThrow(
            ApprovalEvidenceMismatchError
          );
          expect(execute).not.toHaveBeenCalled();
        });

        it("a legacy request() (no recorded actionType) can never satisfy the gateway's full-identity binding", async () => {
          const policy = new PolicyEngine();
          const approvals = new ApprovalWorkflow();
          approvals.request("dep-9", action.description, action.risk); // legacy API — no actionType/costUsd/projectId recorded
          approvals.approve("dep-9", "founder@example.com");
          const gateway = new CapabilityGateway(policy, approvals);
          const execute = vi.fn(() => "should never run");

          await expect(gateway.authorize(action, execute, { approvalId: "dep-9" })).rejects.toThrow(
            ApprovalEvidenceMismatchError
          );
          expect(execute).not.toHaveBeenCalled();
        });
      });

      describe("finding 3: approval evidence must be consumed exactly once before execution", () => {
        it("REGRESSION: the same approval id cannot be used to authorize execution a second time", async () => {
          const { gateway } = approvedGateway("dep-10");
          const execute = vi.fn(() => "deployed");

          const first = await gateway.authorize(action, execute, { approvalId: "dep-10" });
          expect(first).toBe("deployed");
          expect(execute).toHaveBeenCalledTimes(1);

          await expect(gateway.authorize(action, execute, { approvalId: "dep-10" })).rejects.toThrow(
            ApprovalEvidenceMismatchError
          );
          expect(execute).toHaveBeenCalledTimes(1); // still only once
        });

        it("REGRESSION: two concurrent executions using the same approval id result in at most one actually executing", async () => {
          const { gateway } = approvedGateway("dep-11");
          let concurrentCallers = 0;
          let maxConcurrent = 0;
          const execute = async () => {
            concurrentCallers += 1;
            maxConcurrent = Math.max(maxConcurrent, concurrentCallers);
            await new Promise((resolve) => setTimeout(resolve, 5));
            concurrentCallers -= 1;
            return "deployed";
          };

          const results = await Promise.allSettled([
            gateway.authorize(action, execute, { approvalId: "dep-11" }),
            gateway.authorize(action, execute, { approvalId: "dep-11" })
          ]);

          const fulfilled = results.filter((r) => r.status === "fulfilled");
          const rejected = results.filter((r) => r.status === "rejected");
          expect(fulfilled).toHaveLength(1);
          expect(rejected).toHaveLength(1);
          expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ApprovalEvidenceMismatchError);
          expect(maxConcurrent).toBe(1); // the second call never actually ran execute() concurrently with the first
        });

        it("the consumed approval's status is EXECUTED, not left as APPROVED, after a successful authorize()", async () => {
          const { gateway, approvals } = approvedGateway("dep-12");
          await gateway.authorize(action, () => "deployed", { approvalId: "dep-12" });

          expect(approvals.get("dep-12")!.status).toBe("EXECUTED");
        });
      });
    }
  );

  describe(
    "P1 fix (27th independent review round, finding 3, 'make gateway dependencies runtime-private'): the " +
      "internal policy/approvals fields now use genuine ECMAScript #private fields, not TypeScript's " +
      "compile-time-only `private`",
    () => {
      it("neither the policy nor the approvals dependency is reachable as an ordinary JS property", () => {
        const policy = new PolicyEngine();
        const approvals = new ApprovalWorkflow();
        const gateway = new CapabilityGateway(policy, approvals);

        expect((gateway as unknown as Record<string, unknown>).policy).toBeUndefined();
        expect((gateway as unknown as Record<string, unknown>).approvals).toBeUndefined();
      });

      it("no reflection API (Object.getOwnPropertyNames / Reflect.ownKeys) exposes the private dependencies", () => {
        const gateway = new CapabilityGateway(new PolicyEngine(), new ApprovalWorkflow());

        expect(Object.getOwnPropertyNames(gateway)).toEqual([]);
        expect(Reflect.ownKeys(gateway)).toEqual([]);
      });

      it(
        "REGRESSION: a plain JS consumer cannot swap in a forged, always-ALLOW policy engine via property " +
          "access, bypassing default-deny",
        () => {
          const policy = new PolicyEngine(); // no rules registered -> default-deny
          const gateway = new CapabilityGateway(policy);

          const forgedAlwaysAllow = new PolicyEngine();
          forgedAlwaysAllow.addRule({ name: "always-allow", priority: 1, evaluate: () => "ALLOW" });

          // This assignment merely creates a NEW, ordinary, inert own
          // property named "policy" on the instance — it does not touch
          // the genuine `#policy` private field at all (there is no
          // ordinary property of that name to overwrite in the first
          // place), so the class's own internal logic never sees it.
          (gateway as unknown as Record<string, unknown>).policy = forgedAlwaysAllow;
          const spread: Record<string, unknown> = { ...gateway };
          expect(spread.policy).toBe(forgedAlwaysAllow); // the inert stray property really was set...

          // ...yet the gateway still consults its ORIGINAL, default-deny policy engine.
          return expect(
            gateway.authorize({ actionType: "x", risk: 3, description: "d" }, () => "should never run")
          ).rejects.toThrow(CapabilityDeniedError);
        }
      );

      it(
        "REGRESSION: a plain JS consumer cannot swap in a forged, always-approved approvals workflow via " +
          "property access",
        () => {
          const policy = new PolicyEngine();
          const gateway = new CapabilityGateway(policy, new ApprovalWorkflow());

          const forgedApprovals = new ApprovalWorkflow();
          const forgedAction = { actionType: "production-deploy", risk: 5 as const, description: "deploy" };
          forgedApprovals.requestFor("forged-1", forgedAction);
          forgedApprovals.approve("forged-1", "attacker@example.com");

          (gateway as unknown as Record<string, unknown>).approvals = forgedApprovals;

          return expect(
            gateway.authorize(forgedAction, () => "should never run", { approvalId: "forged-1" })
          ).rejects.toThrow(ApprovalEvidenceMismatchError);
        }
      );
    }
  );

  describe(
    "P1 fix (27th independent review round, finding 4, 'bind approval to the policy-evaluated action'): every " +
      "reference inside authorize() uses the SAME authoritative action policy.evaluate() returned, never a " +
      "second read of the caller's own (possibly getter/Proxy-backed) action object",
    () => {
      it(
        "BLOCKER regression, exact reproduction: a risk getter answering differently on a second read cannot " +
          "desynchronize the APPROVAL_REQUIRED decision from the identity later checked against approval evidence",
        async () => {
          let reads = 0;
          const action = {
            actionType: "production-deploy",
            description: "deploy to prod",
            get risk() {
              reads += 1;
              // If authorize() ever re-read `risk` after policy.evaluate(),
              // this would return a DIFFERENT value than the one policy
              // actually decided APPROVAL_REQUIRED for.
              return reads === 1 ? 5 : 1;
            }
          };
          const policy = new PolicyEngine();
          const approvals = new ApprovalWorkflow();
          // Bind the approval to risk 5 — the value policy.evaluate() saw.
          approvals.requestFor("gtr-1", { actionType: "production-deploy", risk: 5, description: "deploy to prod" });
          approvals.approve("gtr-1", "founder@example.com");
          const gateway = new CapabilityGateway(policy, approvals);
          const execute = vi.fn(() => "deployed");

          const result = await gateway.authorize(
            action as unknown as { actionType: string; risk: 5; description: string },
            execute,
            { approvalId: "gtr-1" }
          );

          expect(reads).toBe(1); // the getter is consulted exactly once, by policy.evaluate() alone
          expect(result).toBe("deployed");
          expect(execute).toHaveBeenCalledTimes(1);
        }
      );

      it("thrown error objects (DENY / APPROVAL_REQUIRED / mismatch) carry the authoritative action's identity, not a possibly-different re-read", async () => {
        let reads = 0;
        const action = {
          actionType: "x",
          description: "d",
          get risk() {
            reads += 1;
            return 3; // stable value here — this test is about WHICH object is used, not a race
          }
        };
        const policy = new PolicyEngine(); // default-deny
        const gateway = new CapabilityGateway(policy);

        let thrown: unknown;
        try {
          await gateway.authorize(action as unknown as { actionType: string; risk: 3; description: string }, () => "never");
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(CapabilityDeniedError);
        expect(reads).toBe(1); // risk read exactly once (by policy.evaluate()), never again to build the error
      });
    }
  );

  describe(
    "P1 fix (27th independent review round, finding 5, 'finalize approval only after successful execution'): " +
      "the approval only reaches EXECUTED after the real work genuinely succeeds; a thrown callback is recorded " +
      "as an explicit failure, never a false success",
    () => {
      const action = {
        actionType: "production-deploy",
        risk: 5 as const,
        description: "deploy to prod",
        costUsd: 0,
        projectId: "proj-x"
      };

      function approvedGateway(id: string) {
        const policy = new PolicyEngine();
        const approvals = new ApprovalWorkflow();
        approvals.requestFor(id, action);
        approvals.approve(id, "founder@example.com");
        const gateway = new CapabilityGateway(policy, approvals);
        return { gateway, approvals };
      }

      it(
        "BLOCKER regression, exact reproduction: a callback that throws leaves the approval EXECUTION_FAILED, " +
          "never falsely EXECUTED",
        async () => {
          const { gateway, approvals } = approvedGateway("fail-1");
          const boom = new Error("provider call failed");
          const execute = vi.fn(() => {
            throw boom;
          });

          await expect(gateway.authorize(action, execute, { approvalId: "fail-1" })).rejects.toThrow(boom);

          const finalStatus = approvals.get("fail-1")!.status;
          expect(finalStatus).toBe("EXECUTION_FAILED");
          expect(finalStatus).not.toBe("EXECUTED");
        }
      );

      it("a callback that throws asynchronously (a rejected Promise) is handled the same way as a synchronous throw", async () => {
        const { gateway, approvals } = approvedGateway("fail-2");
        const boom = new Error("async provider call failed");
        const execute = vi.fn(async () => {
          throw boom;
        });

        await expect(gateway.authorize(action, execute, { approvalId: "fail-2" })).rejects.toThrow(boom);
        expect(approvals.get("fail-2")!.status).toBe("EXECUTION_FAILED");
      });

      it("the original error is re-thrown to the caller unchanged, never swallowed by the failure bookkeeping", async () => {
        const { gateway } = approvedGateway("fail-3");
        const boom = new Error("very specific failure reason");
        const execute = () => {
          throw boom;
        };

        await expect(gateway.authorize(action, execute, { approvalId: "fail-3" })).rejects.toBe(boom);
      });

      it("the approval's failure reason records the thrown error's message", async () => {
        const { gateway, approvals } = approvedGateway("fail-4");
        const execute = () => {
          throw new Error("disk full during deploy");
        };

        await expect(gateway.authorize(action, execute, { approvalId: "fail-4" })).rejects.toThrow();

        const record = approvals.get("fail-4") as unknown as { failureReason?: string };
        expect(record.failureReason).toBe("disk full during deploy");
      });

      it(
        "REGRESSION: after a failed attempt, the SAME approval id cannot be replayed to authorize a second, " +
          "successful attempt (EXECUTION_FAILED is terminal, not a retryable APPROVED-equivalent)",
        async () => {
          const { gateway, approvals } = approvedGateway("fail-5");
          const failingExecute = () => {
            throw new Error("boom");
          };
          await expect(gateway.authorize(action, failingExecute, { approvalId: "fail-5" })).rejects.toThrow();
          expect(approvals.get("fail-5")!.status).toBe("EXECUTION_FAILED");

          const succeedingExecute = vi.fn(() => "deployed");
          await expect(gateway.authorize(action, succeedingExecute, { approvalId: "fail-5" })).rejects.toThrow(
            ApprovalEvidenceMismatchError
          );
          expect(succeedingExecute).not.toHaveBeenCalled();
        }
      );

      it(
        "REGRESSION: two concurrent authorize() calls on the same approval — one destined to fail — never let " +
          "the failing one's bookkeeping corrupt the successful one's EXECUTED status",
        async () => {
          const { gateway, approvals } = approvedGateway("fail-6");
          const execute = vi.fn(() => "deployed");

          const results = await Promise.allSettled([
            gateway.authorize(action, execute, { approvalId: "fail-6" }),
            gateway.authorize(action, execute, { approvalId: "fail-6" })
          ]);

          const fulfilled = results.filter((r) => r.status === "fulfilled");
          const rejected = results.filter((r) => r.status === "rejected");
          expect(fulfilled).toHaveLength(1);
          expect(rejected).toHaveLength(1);
          expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ApprovalEvidenceMismatchError);
          // The one that genuinely ran ends EXECUTED, not EXECUTION_FAILED —
          // the SECOND caller's rejection happens at the MATCH step (before
          // beginExecution() is ever reached for it), never touching the
          // first caller's already-claimed EXECUTING/EXECUTED record.
          expect(approvals.get("fail-6")!.status).toBe("EXECUTED");
        }
      );
    }
  );

  describe(
    "P1 fix (28th independent review round, finding 9, 'snapshot approval id before consumption'): " +
      "approval.approvalId is read exactly once and that SAME id is used for lookup, action binding, " +
      "beginExecution, completeExecution/failExecution, and audit evidence",
    () => {
      const action = { actionType: "production-deploy", risk: 5 as const, description: "deploy to prod" };

      it(
        "BLOCKER regression, exact reproduction: an approvalId getter answering approval A's id for the match " +
          "check and a DIFFERENT approval B's id afterward must not let A authorize while B is silently consumed",
        async () => {
          const policy = new PolicyEngine(); // default-deny -> risk 5 -> APPROVAL_REQUIRED
          const approvals = new ApprovalWorkflow();
          approvals.requestFor("id-a", action);
          approvals.approve("id-a", "founder@example.com");
          // "id-b" is a COMPLETELY unrelated, also-APPROVED request that
          // this call never matched against `action` at all.
          approvals.requestFor("id-b", { actionType: "unrelated-action", risk: 5, description: "something else" });
          approvals.approve("id-b", "founder@example.com");

          const gateway = new CapabilityGateway(policy, approvals);
          const execute = vi.fn(() => "deployed");

          let reads = 0;
          const approvalRef = {
            get approvalId() {
              reads += 1;
              // If authorize() ever re-read this after the initial
              // lookup/match, it would return a DIFFERENT approval's id
              // for beginExecution()/completeExecution() than the one
              // actually matched and authorized the action.
              return reads === 1 ? "id-a" : "id-b";
            }
          };

          const result = await gateway.authorize(action, execute, approvalRef);

          expect(reads).toBe(1); // approvalId is consulted exactly once
          expect(result).toBe("deployed");
          // The approval that GENUINELY matched the action is the one
          // consumed — it reaches EXECUTED.
          expect(approvals.get("id-a")!.status).toBe("EXECUTED");
          // The unrelated approval is completely untouched — never
          // begun, never completed, never failed.
          expect(approvals.get("id-b")!.status).toBe("APPROVED");
        }
      );

      it("BLOCKER regression (failure path): the SAME captured id is used for failExecution() even if approvalId would answer differently by then", async () => {
        const policy = new PolicyEngine();
        const approvals = new ApprovalWorkflow();
        approvals.requestFor("id-a-fail", action);
        approvals.approve("id-a-fail", "founder@example.com");
        approvals.requestFor("id-b-fail", { actionType: "unrelated-action", risk: 5, description: "something else" });
        approvals.approve("id-b-fail", "founder@example.com");

        const gateway = new CapabilityGateway(policy, approvals);
        const boom = new Error("provider call failed");
        const execute = vi.fn(() => {
          throw boom;
        });

        let reads = 0;
        const approvalRef = {
          get approvalId() {
            reads += 1;
            return reads === 1 ? "id-a-fail" : "id-b-fail";
          }
        };

        await expect(gateway.authorize(action, execute, approvalRef)).rejects.toBe(boom);
        expect(reads).toBe(1);
        expect(approvals.get("id-a-fail")!.status).toBe("EXECUTION_FAILED");
        expect(approvals.get("id-b-fail")!.status).toBe("APPROVED"); // untouched
      });

      it("Proxy-wrapped ApprovalReference: approvalId is read at most once across the whole authorize() call", async () => {
        const policy = new PolicyEngine();
        const approvals = new ApprovalWorkflow();
        approvals.requestFor("id-proxy", action);
        approvals.approve("id-proxy", "founder@example.com");
        const gateway = new CapabilityGateway(policy, approvals);

        const reads: Record<string, number> = {};
        const target = { approvalId: "id-proxy" };
        const proxied = new Proxy(target, {
          get(t, prop, receiver) {
            reads[String(prop)] = (reads[String(prop)] ?? 0) + 1;
            return Reflect.get(t, prop, receiver);
          }
        });

        const result = await gateway.authorize(action, () => "deployed", proxied);
        expect(reads.approvalId).toBe(1);
        expect(result).toBe("deployed");
      });

      it("a mismatch error message still names the correct (single-read) approvalId, not a possibly-different later read", async () => {
        const policy = new PolicyEngine();
        const approvals = new ApprovalWorkflow(); // "id-unknown" never requested
        const gateway = new CapabilityGateway(policy, approvals);

        let reads = 0;
        const approvalRef = {
          get approvalId() {
            reads += 1;
            return reads === 1 ? "id-unknown" : "some-other-id";
          }
        };

        await expect(gateway.authorize(action, () => "never", approvalRef)).rejects.toThrow(/id-unknown/);
        expect(reads).toBe(1);
      });
    }
  );
});
