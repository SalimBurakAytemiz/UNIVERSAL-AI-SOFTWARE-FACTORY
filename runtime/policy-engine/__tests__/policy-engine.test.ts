import { describe, expect, it } from "vitest";
import { PolicyEngine, lowRiskAllowRule, type PolicyRule } from "../policy-engine.js";
import { ApprovalRequiredError, ApprovalWorkflow } from "../approval.js";

/** Test helper: a rule that always DENYs, at a caller-chosen priority. */
function denyRule(name: string, priority: number): PolicyRule {
  return { name, priority, evaluate: () => "DENY" };
}

/** Test helper: a rule that always returns APPROVAL_REQUIRED. */
function approvalRequiredRule(name: string, priority: number): PolicyRule {
  return { name, priority, evaluate: () => "APPROVAL_REQUIRED" };
}

describe("PolicyEngine", () => {
  it("defaults to DENY when no rule matches", () => {
    const engine = new PolicyEngine();
    const result = engine.evaluate({ actionType: "unknown", risk: 3, description: "unclassified action" });
    expect(result.decision).toBe("DENY");
    expect(result.matchedRule).toBe("default-deny");
  });

  it("allows low-risk actions when an explicit low-risk rule is registered", () => {
    const engine = new PolicyEngine();
    engine.addRule(lowRiskAllowRule(2));
    const result = engine.evaluate({ actionType: "read-file", risk: 1, description: "read a local file" });
    expect(result.decision).toBe("ALLOW");
  });

  it("never auto-allows a risk-5 action, even if a low-risk rule is registered", () => {
    const engine = new PolicyEngine();
    engine.addRule(lowRiskAllowRule(5)); // deliberately overly permissive rule
    const result = engine.evaluate({ actionType: "production-deploy", risk: 5, description: "deploy to production" });
    expect(result.decision).toBe("APPROVAL_REQUIRED");
    expect(result.matchedRule).toBe("risk-5-requires-approval");
  });

  it("records every decision in the audit trail", () => {
    const engine = new PolicyEngine();
    engine.evaluate({ actionType: "a", risk: 5, description: "x" });
    engine.evaluate({ actionType: "b", risk: 0, description: "y" });
    expect(engine.auditTrail.all()).toHaveLength(2);
    expect(engine.auditTrail.verifyIntegrity()).toBe(true);
  });

  describe("DENY always wins (BLOCKER regression: risk-5 must never convert a forbidden action into an approvable one)", () => {
    it("an explicit DENY rule on a risk-5 action remains DENY, not APPROVAL_REQUIRED", () => {
      const engine = new PolicyEngine();
      engine.addRule(denyRule("forbid-production-deploy", 1));
      const result = engine.evaluate({ actionType: "production-deploy", risk: 5, description: "deploy" });
      expect(result.decision).toBe("DENY");
      expect(result.matchedRule).toBe("forbid-production-deploy");
    });

    it("a HIGH-PRIORITY DENY rule on a risk-5 action remains DENY", () => {
      const engine = new PolicyEngine();
      // Even a very high priority must not let the built-in risk-5 upgrade sneak in ahead of it.
      engine.addRule(denyRule("security-forbid", Number.MAX_SAFE_INTEGER));
      const result = engine.evaluate({ actionType: "production-deploy", risk: 5, description: "deploy" });
      expect(result.decision).toBe("DENY");
      expect(result.matchedRule).toBe("security-forbid");
    });

    it("DENY wins even when a lower-priority ALLOW rule also matches the same risk-5 action", () => {
      const engine = new PolicyEngine();
      engine.addRule(lowRiskAllowRule(5)); // priority 1, would ALLOW risk<=5
      engine.addRule(denyRule("explicit-forbid", 10)); // higher priority -> evaluated first
      const result = engine.evaluate({ actionType: "production-deploy", risk: 5, description: "deploy" });
      expect(result.decision).toBe("DENY");
    });

    it("an otherwise-ALLOWED risk-5 action requires Founder approval (the intended, non-weakening upgrade)", () => {
      const engine = new PolicyEngine();
      engine.addRule(lowRiskAllowRule(5));
      const result = engine.evaluate({ actionType: "production-deploy", risk: 5, description: "deploy" });
      expect(result.decision).toBe("APPROVAL_REQUIRED");
    });

    it("an unaddressed risk-5 action (default-deny fallback) still surfaces as APPROVAL_REQUIRED, not silently denied forever", () => {
      const engine = new PolicyEngine(); // no rules at all
      const result = engine.evaluate({ actionType: "production-deploy", risk: 5, description: "deploy" });
      expect(result.decision).toBe("APPROVAL_REQUIRED");
    });

    it("risk-5 can never weaken an existing APPROVAL_REQUIRED decision (stays APPROVAL_REQUIRED, not ALLOW)", () => {
      const engine = new PolicyEngine();
      engine.addRule(approvalRequiredRule("needs-review", 5));
      const result = engine.evaluate({ actionType: "sensitive-op", risk: 5, description: "x" });
      expect(result.decision).toBe("APPROVAL_REQUIRED");
      expect(result.matchedRule).toBe("needs-review");
    });

    it("a DENY rule for a non-risk-5 action is completely unaffected by the risk-5 upgrade logic", () => {
      const engine = new PolicyEngine();
      engine.addRule(denyRule("forbid-x", 1));
      const result = engine.evaluate({ actionType: "x", risk: 2, description: "x" });
      expect(result.decision).toBe("DENY");
    });
  });
});

describe("ApprovalWorkflow (Human Approval invariant, baseline section 120/146)", () => {
  it("blocks execution of a risk-5 action that was never approved", () => {
    const workflow = new ApprovalWorkflow();
    workflow.request("deploy-1", "Deploy to production", 5);
    expect(() => workflow.execute("deploy-1")).toThrow(ApprovalRequiredError);
  });

  it("blocks execution of an action that was explicitly rejected", () => {
    const workflow = new ApprovalWorkflow();
    workflow.request("deploy-2", "Deploy to production", 5);
    workflow.reject("deploy-2", "founder@example.com");
    expect(() => workflow.execute("deploy-2")).toThrow(ApprovalRequiredError);
  });

  it("allows execution only after an explicit APPROVE by a human", () => {
    const workflow = new ApprovalWorkflow();
    workflow.request("deploy-3", "Deploy to production", 5);
    workflow.approve("deploy-3", "founder@example.com");
    const executed = workflow.execute("deploy-3");
    expect(executed.status).toBe("EXECUTED");
  });

  it("cannot execute the same approval twice (state machine forward-only)", () => {
    const workflow = new ApprovalWorkflow();
    workflow.request("deploy-4", "Deploy to production", 5);
    workflow.approve("deploy-4", "founder@example.com");
    workflow.execute("deploy-4");
    expect(() => workflow.execute("deploy-4")).toThrow(ApprovalRequiredError);
  });
});
