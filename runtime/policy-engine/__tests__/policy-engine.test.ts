import { describe, expect, it } from "vitest";
import { PolicyEngine, lowRiskAllowRule, type PolicyRule } from "../policy-engine.js";
import { ApprovalRequiredError, ApprovalWorkflow, DuplicateApprovalIdError, InvalidApprovalDecisionError } from "../approval.js";
import { AuditLog } from "../../audit/audit-log.js";

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

  describe("P1 regression (7th independent review round, 'higher-priority ALLOW bypasses matching DENY'): DENY wins regardless of rule priority ordering", () => {
    it("a LOW-priority DENY beats a HIGH-priority ALLOW on a risk-1 action (previously the ALLOW short-circuited and the DENY was never evaluated)", () => {
      const engine = new PolicyEngine();
      engine.addRule({ name: "high-priority-allow", priority: 10, evaluate: () => "ALLOW" });
      engine.addRule(denyRule("low-priority-deny", 1));
      const result = engine.evaluate({ actionType: "risky-write", risk: 1, description: "x" });
      expect(result.decision).toBe("DENY");
      expect(result.matchedRule).toBe("low-priority-deny");
    });

    it("a LOW-priority DENY beats a HIGH-priority ALLOW on a risk-5 action and stays DENY, not APPROVAL_REQUIRED", () => {
      const engine = new PolicyEngine();
      engine.addRule({ name: "high-priority-allow", priority: 10, evaluate: () => "ALLOW" });
      engine.addRule(denyRule("low-priority-deny", 1));
      const result = engine.evaluate({ actionType: "risky-write", risk: 5, description: "x" });
      expect(result.decision).toBe("DENY");
      expect(result.matchedRule).toBe("low-priority-deny");
    });

    it("a LOW-priority DENY beats a HIGH-priority APPROVAL_REQUIRED rule", () => {
      const engine = new PolicyEngine();
      engine.addRule(approvalRequiredRule("high-priority-approval", 10));
      engine.addRule(denyRule("low-priority-deny", 1));
      const result = engine.evaluate({ actionType: "x", risk: 3, description: "x" });
      expect(result.decision).toBe("DENY");
      expect(result.matchedRule).toBe("low-priority-deny");
    });

    it("multiple non-matching high-priority ALLOW rules still surface the only DENY rule at the very bottom of priority order", () => {
      const engine = new PolicyEngine();
      engine.addRule({ name: "allow-a", priority: 100, evaluate: () => "ALLOW" });
      engine.addRule({ name: "allow-b", priority: 50, evaluate: () => "ALLOW" });
      engine.addRule({ name: "allow-c", priority: 20, evaluate: () => "ALLOW" });
      engine.addRule(denyRule("bottom-deny", 0));
      const result = engine.evaluate({ actionType: "x", risk: 2, description: "x" });
      expect(result.decision).toBe("DENY");
      expect(result.matchedRule).toBe("bottom-deny");
    });

    it("when TWO DENY rules match, the higher-priority DENY is reported as the matched rule (deterministic precedence preserved)", () => {
      const engine = new PolicyEngine();
      engine.addRule(denyRule("deny-low", 1));
      engine.addRule(denyRule("deny-high", 5));
      const result = engine.evaluate({ actionType: "x", risk: 2, description: "x" });
      expect(result.decision).toBe("DENY");
      expect(result.matchedRule).toBe("deny-high");
    });

    it("non-conflicting case (no DENY registered at all) still picks the highest-priority ALLOW, preserving prior deterministic precedence", () => {
      const engine = new PolicyEngine();
      engine.addRule({ name: "allow-low", priority: 1, evaluate: () => "ALLOW" });
      engine.addRule({ name: "allow-high", priority: 10, evaluate: () => "ALLOW" });
      const result = engine.evaluate({ actionType: "x", risk: 1, description: "x" });
      expect(result.decision).toBe("ALLOW");
      expect(result.matchedRule).toBe("allow-high");
    });

    it("a DENY rule that does not match the given action (returns null) never blocks an unrelated ALLOW", () => {
      const engine = new PolicyEngine();
      engine.addRule({
        name: "deny-only-deploy",
        priority: 5,
        evaluate: (action) => (action.actionType === "production-deploy" ? "DENY" : null)
      });
      engine.addRule({ name: "allow-read", priority: 1, evaluate: () => "ALLOW" });
      const result = engine.evaluate({ actionType: "read-file", risk: 1, description: "x" });
      expect(result.decision).toBe("ALLOW");
      expect(result.matchedRule).toBe("allow-read");
    });

    it("the audit log records the DENY decision (not the shadowed ALLOW) when both match the same action", () => {
      const engine = new PolicyEngine();
      engine.addRule({ name: "high-priority-allow", priority: 10, evaluate: () => "ALLOW" });
      engine.addRule(denyRule("low-priority-deny", 1));
      engine.evaluate({ actionType: "risky-write", risk: 1, description: "x" });

      const [record] = engine.auditTrail.all();
      const payload = record!.payload as { decision: string; matchedRule: string };
      expect(payload.decision).toBe("DENY");
      expect(payload.matchedRule).toBe("low-priority-deny");
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

  describe("P1 fix: approval state is not directly mutable via a leaked reference", () => {
    it("mutating the object returned by request() cannot approve the action", () => {
      const workflow = new ApprovalWorkflow();
      const returned = workflow.request("deploy-5", "Deploy to production", 5);

      expect(() => {
        (returned as { status: string }).status = "APPROVED";
      }).toThrow(TypeError); // frozen snapshot rejects the write

      expect(() => workflow.execute("deploy-5")).toThrow(ApprovalRequiredError);
    });

    it("mutating objects returned by get()/list() cannot change internal state", () => {
      const workflow = new ApprovalWorkflow();
      workflow.request("deploy-6", "Deploy to production", 5);

      const got = workflow.get("deploy-6")!;
      expect(() => {
        (got as { status: string }).status = "APPROVED";
      }).toThrow(TypeError);

      const [listed] = workflow.list();
      expect(() => {
        (listed as { status: string }).status = "APPROVED";
      }).toThrow(TypeError);

      expect(workflow.get("deploy-6")!.status).toBe("PENDING");
      expect(() => workflow.execute("deploy-6")).toThrow(ApprovalRequiredError);
    });

    it("a risk-5 action can never execute without an explicit approve() call", () => {
      const workflow = new ApprovalWorkflow();
      workflow.request("deploy-7", "Deploy to production", 5);
      expect(() => workflow.execute("deploy-7")).toThrow(ApprovalRequiredError);
    });

    it("an explicit REJECT still results in DENY-equivalent behavior: execution stays blocked", () => {
      const workflow = new ApprovalWorkflow();
      workflow.request("deploy-8", "Deploy to production", 5);
      workflow.reject("deploy-8", "founder@example.com");
      expect(workflow.get("deploy-8")!.status).toBe("REJECTED");
      expect(() => workflow.execute("deploy-8")).toThrow(ApprovalRequiredError);
    });

    it("approve()/reject() require a non-empty approver identity", () => {
      const workflow = new ApprovalWorkflow();
      workflow.request("deploy-9", "Deploy to production", 5);
      expect(() => workflow.approve("deploy-9", "")).toThrow(InvalidApprovalDecisionError);
      expect(() => workflow.approve("deploy-9", "   ")).toThrow(InvalidApprovalDecisionError);
      expect(() => workflow.reject("deploy-9", "")).toThrow(InvalidApprovalDecisionError);
      // still PENDING — an invalid approver attempt never mutated state
      expect(workflow.get("deploy-9")!.status).toBe("PENDING");
    });

    it("an already-EXECUTED approval cannot be reset back to PENDING/APPROVED via a leaked mutable reference", () => {
      const workflow = new ApprovalWorkflow();
      workflow.request("deploy-10", "Deploy to production", 5);
      workflow.approve("deploy-10", "founder@example.com");
      const executed = workflow.execute("deploy-10");

      expect(() => {
        (executed as { status: string }).status = "PENDING";
      }).toThrow(TypeError);

      expect(workflow.get("deploy-10")!.status).toBe("EXECUTED");
      // Forward-only: even a legitimate-looking second execute() still fails closed.
      expect(() => workflow.execute("deploy-10")).toThrow(ApprovalRequiredError);
    });

    it("a REJECTED approval cannot be changed externally back to APPROVED", () => {
      const workflow = new ApprovalWorkflow();
      workflow.request("deploy-11", "Deploy to production", 5);
      const rejected = workflow.reject("deploy-11", "founder@example.com");

      expect(() => {
        (rejected as { status: string }).status = "APPROVED";
      }).toThrow(TypeError);

      expect(workflow.get("deploy-11")!.status).toBe("REJECTED");
      expect(() => workflow.approve("deploy-11", "founder@example.com")).toThrow(); // not PENDING anymore
    });

    it("every state transition (request/approve/reject/execute) is recorded to the audit log", () => {
      const auditLog = new AuditLog();
      const workflow = new ApprovalWorkflow(auditLog);
      workflow.request("deploy-12", "Deploy to production", 5);
      workflow.approve("deploy-12", "founder@example.com", "evidence://ticket-42");
      workflow.execute("deploy-12");

      const types = auditLog.all().map((r) => r.type);
      expect(types).toEqual(["APPROVAL_REQUESTED", "APPROVAL_APPROVED", "APPROVAL_EXECUTED"]);
      expect(auditLog.verifyIntegrity()).toBe(true);
    });

    it("an invalid transition (approve twice, execute unapproved) fails closed and is never silently accepted", () => {
      const workflow = new ApprovalWorkflow();
      workflow.request("deploy-13", "Deploy to production", 5);
      workflow.approve("deploy-13", "founder@example.com");
      expect(() => workflow.approve("deploy-13", "someone-else@example.com")).toThrow();
      expect(workflow.get("deploy-13")!.decidedBy).toBe("founder@example.com");
    });
  });

  describe("P2 regression (7th independent review round, 'duplicate approval IDs replace authoritative history')", () => {
    it("rejects a second request() with the same id while the first is still PENDING", () => {
      const workflow = new ApprovalWorkflow();
      workflow.request("dup-1", "Deploy to production", 5);
      expect(() => workflow.request("dup-1", "A different action entirely", 5)).toThrow(DuplicateApprovalIdError);
      expect(workflow.get("dup-1")!.actionDescription).toBe("Deploy to production");
    });

    it("rejects a second request() with the same id after APPROVED, preserving the APPROVED record", () => {
      const workflow = new ApprovalWorkflow();
      workflow.request("dup-2", "Deploy to production", 5);
      workflow.approve("dup-2", "founder@example.com", "evidence://ticket-1");
      expect(() => workflow.request("dup-2", "A sneaky replacement request", 5)).toThrow(DuplicateApprovalIdError);
      const record = workflow.get("dup-2")!;
      expect(record.status).toBe("APPROVED");
      expect(record.decidedBy).toBe("founder@example.com");
      expect(record.evidenceRef).toBe("evidence://ticket-1");
    });

    it("rejects a second request() with the same id after REJECTED, preserving the REJECTED record", () => {
      const workflow = new ApprovalWorkflow();
      workflow.request("dup-3", "Deploy to production", 5);
      workflow.reject("dup-3", "founder@example.com");
      expect(() => workflow.request("dup-3", "A sneaky replacement request", 5)).toThrow(DuplicateApprovalIdError);
      expect(workflow.get("dup-3")!.status).toBe("REJECTED");
    });

    it("BLOCKER regression: request() cannot silently erase an EXECUTED record's approver identity, decision timestamp, and evidence reference", () => {
      const workflow = new ApprovalWorkflow();
      workflow.request("dup-4", "Deploy to production", 5);
      workflow.approve("dup-4", "founder@example.com", "evidence://ticket-42");
      const executed = workflow.execute("dup-4");

      expect(() => workflow.request("dup-4", "A replacement action", 5)).toThrow(DuplicateApprovalIdError);

      const stillAuthoritative = workflow.get("dup-4")!;
      expect(stillAuthoritative.status).toBe("EXECUTED");
      expect(stillAuthoritative.decidedBy).toBe("founder@example.com");
      expect(stillAuthoritative.evidenceRef).toBe("evidence://ticket-42");
      expect(stillAuthoritative.decidedAt).toBe(executed.decidedAt);
      expect(stillAuthoritative.actionDescription).toBe("Deploy to production");
    });

    it("a rejected duplicate request() never mutates the existing record's requestedAt timestamp", () => {
      const workflow = new ApprovalWorkflow();
      const original = workflow.request("dup-5", "Deploy to production", 5);
      expect(() => workflow.request("dup-5", "Different action", 3)).toThrow(DuplicateApprovalIdError);
      expect(workflow.get("dup-5")!.requestedAt).toBe(original.requestedAt);
      expect(workflow.get("dup-5")!.risk).toBe(5);
    });

    it("a rejected duplicate request() does not append a spurious APPROVAL_REQUESTED audit entry", () => {
      const auditLog = new AuditLog();
      const workflow = new ApprovalWorkflow(auditLog);
      workflow.request("dup-6", "Deploy to production", 5);
      expect(() => workflow.request("dup-6", "Different action", 5)).toThrow(DuplicateApprovalIdError);

      const requestedEvents = auditLog.all().filter((r) => r.type === "APPROVAL_REQUESTED");
      expect(requestedEvents).toHaveLength(1);
    });

    it("distinct ids remain completely independent — no cross-contamination from the duplicate-id guard", () => {
      const workflow = new ApprovalWorkflow();
      workflow.request("dup-7-a", "Action A", 5);
      workflow.request("dup-7-b", "Action B", 5);
      expect(workflow.get("dup-7-a")!.actionDescription).toBe("Action A");
      expect(workflow.get("dup-7-b")!.actionDescription).toBe("Action B");
    });

    it("after a duplicate is rejected, execute() still fails for a never-approved original request (no partial state corruption)", () => {
      const workflow = new ApprovalWorkflow();
      workflow.request("dup-8", "Deploy to production", 5);
      expect(() => workflow.request("dup-8", "Different action", 5)).toThrow(DuplicateApprovalIdError);
      expect(() => workflow.execute("dup-8")).toThrow(ApprovalRequiredError);
    });

    it("the DuplicateApprovalIdError message names the offending id", () => {
      const workflow = new ApprovalWorkflow();
      workflow.request("dup-9", "Deploy to production", 5);
      try {
        workflow.request("dup-9", "Different action", 5);
        throw new Error("expected request() to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(DuplicateApprovalIdError);
        expect((err as Error).message).toContain("dup-9");
      }
    });
  });
});
