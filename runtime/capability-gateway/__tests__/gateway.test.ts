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
});
