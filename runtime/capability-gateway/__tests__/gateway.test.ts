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

  describe("P1 fix (24th independent review round, 'approved requests must pass capability gateway')", () => {
    const action = { actionType: "production-deploy", risk: 5 as const, description: "deploy to prod" };

    it("executes once genuine approval evidence for the EXACT same action is presented", async () => {
      const policy = new PolicyEngine();
      const gateway = new CapabilityGateway(policy);
      const workflow = new ApprovalWorkflow();
      workflow.request("dep-1", action.description, action.risk);
      workflow.approve("dep-1", "founder@example.com");
      const execute = vi.fn(() => "deployed");

      const result = await gateway.authorize(action, execute, { workflow, approvalId: "dep-1" });

      expect(result).toBe("deployed");
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("still blocks execution when the referenced approval is only PENDING", async () => {
      const policy = new PolicyEngine();
      const gateway = new CapabilityGateway(policy);
      const workflow = new ApprovalWorkflow();
      workflow.request("dep-2", action.description, action.risk);
      const execute = vi.fn(() => "should never run");

      await expect(gateway.authorize(action, execute, { workflow, approvalId: "dep-2" })).rejects.toThrow(
        ApprovalEvidenceMismatchError
      );
      expect(execute).not.toHaveBeenCalled();
    });

    it("still blocks execution when the referenced approval was REJECTED", async () => {
      const policy = new PolicyEngine();
      const gateway = new CapabilityGateway(policy);
      const workflow = new ApprovalWorkflow();
      workflow.request("dep-3", action.description, action.risk);
      workflow.reject("dep-3", "founder@example.com");
      const execute = vi.fn(() => "should never run");

      await expect(gateway.authorize(action, execute, { workflow, approvalId: "dep-3" })).rejects.toThrow(
        ApprovalEvidenceMismatchError
      );
      expect(execute).not.toHaveBeenCalled();
    });

    it("still blocks execution when the referenced approval is REQUEST_CHANGES", async () => {
      const policy = new PolicyEngine();
      const gateway = new CapabilityGateway(policy);
      const workflow = new ApprovalWorkflow();
      workflow.request("dep-4", action.description, action.risk);
      workflow.requestChanges("dep-4", "founder@example.com", "needs a rollback plan");
      const execute = vi.fn(() => "should never run");

      await expect(gateway.authorize(action, execute, { workflow, approvalId: "dep-4" })).rejects.toThrow(
        ApprovalEvidenceMismatchError
      );
      expect(execute).not.toHaveBeenCalled();
    });

    it("rejects approval replay: an APPROVED request for a DIFFERENT action cannot authorize this one", async () => {
      const policy = new PolicyEngine();
      const gateway = new CapabilityGateway(policy);
      const workflow = new ApprovalWorkflow();
      workflow.request("unrelated-deploy", "deploy a totally different, unrelated release", 5);
      workflow.approve("unrelated-deploy", "founder@example.com");
      const execute = vi.fn(() => "should never run");

      await expect(gateway.authorize(action, execute, { workflow, approvalId: "unrelated-deploy" })).rejects.toThrow(
        ApprovalEvidenceMismatchError
      );
      expect(execute).not.toHaveBeenCalled();
    });

    it("rejects an unknown approval id", async () => {
      const policy = new PolicyEngine();
      const gateway = new CapabilityGateway(policy);
      const workflow = new ApprovalWorkflow();
      const execute = vi.fn(() => "should never run");

      await expect(gateway.authorize(action, execute, { workflow, approvalId: "never-requested" })).rejects.toThrow(
        ApprovalEvidenceMismatchError
      );
      expect(execute).not.toHaveBeenCalled();
    });

    it("an explicit policy DENY is never overridden by approval evidence, however genuine", async () => {
      const policy = new PolicyEngine();
      policy.addRule({ name: "deny-everything", priority: 100, evaluate: () => "DENY" });
      const gateway = new CapabilityGateway(policy);
      const workflow = new ApprovalWorkflow();
      workflow.request("dep-5", action.description, action.risk);
      workflow.approve("dep-5", "founder@example.com");
      const execute = vi.fn(() => "should never run");

      await expect(gateway.authorize(action, execute, { workflow, approvalId: "dep-5" })).rejects.toThrow(
        CapabilityDeniedError
      );
      expect(execute).not.toHaveBeenCalled();
    });
  });
});
