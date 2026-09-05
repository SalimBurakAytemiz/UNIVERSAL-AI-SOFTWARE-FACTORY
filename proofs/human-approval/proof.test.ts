// Proof: Human Approval (baseline section 6 in the required-proof-scenarios
// list, section 305 item 6; invariant stated formally in section 120: "A
// Risk-5 operation can never reach EXECUTED without valid Human Founder
// approval.")
import { describe, expect, it } from "vitest";
import { PolicyEngine } from "../../runtime/policy-engine/policy-engine.js";
import { ApprovalRequiredError, ApprovalWorkflow } from "../../runtime/policy-engine/approval.js";

describe("Proof: Human approval gates Risk-5 actions", () => {
  it("a production deployment (risk 5) is APPROVAL_REQUIRED from the policy engine and cannot execute until approved", () => {
    const policy = new PolicyEngine();
    const decision = policy.evaluate({
      actionType: "production-deploy",
      risk: 5,
      description: "Deploy release v1.2.0 to production"
    });
    expect(decision.decision).toBe("APPROVAL_REQUIRED");

    const approvals = new ApprovalWorkflow();
    approvals.request("release-v1.2.0", "Deploy release v1.2.0 to production", 5);

    // No human decision yet -> execution is impossible.
    expect(() => approvals.execute("release-v1.2.0")).toThrow(ApprovalRequiredError);

    // Only an explicit human APPROVE unblocks execution.
    approvals.approve("release-v1.2.0", "founder@example.com");
    const executed = approvals.execute("release-v1.2.0");
    expect(executed.status).toBe("EXECUTED");
    expect(executed.decidedBy).toBe("founder@example.com");
  });
});
