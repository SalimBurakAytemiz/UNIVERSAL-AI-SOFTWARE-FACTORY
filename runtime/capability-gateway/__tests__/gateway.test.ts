import { describe, expect, it, vi } from "vitest";
import { PolicyEngine, lowRiskAllowRule } from "../../policy-engine/policy-engine.js";
import { CapabilityApprovalRequiredError, CapabilityDeniedError, CapabilityGateway } from "../gateway.js";

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
});
