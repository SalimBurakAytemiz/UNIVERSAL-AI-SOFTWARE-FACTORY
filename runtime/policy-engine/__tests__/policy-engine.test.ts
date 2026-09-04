import { describe, expect, it } from "vitest";
import { PolicyEngine, lowRiskAllowRule } from "../policy-engine.js";
import { ApprovalRequiredError, ApprovalWorkflow } from "../approval.js";

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
