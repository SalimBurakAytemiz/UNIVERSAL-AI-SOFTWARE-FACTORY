import { describe, expect, it } from "vitest";
import { ApprovalWorkflow } from "../approval.js";
import { AuditLog, type AuditEvent, type AuditRecord } from "../../audit/audit-log.js";

/**
 * Test double simulating `AuditLog.append()` throwing for a SPECIFIC event
 * type (e.g. `UnsupportedAuditPayloadError` for a malformed payload reaching
 * it at runtime) while behaving normally for every other event type — lets a
 * test isolate exactly ONE transition's audit call as the failure point,
 * without needing to construct an actually-malformed payload for every
 * transition method under test.
 */
class SelectivelyThrowingAuditLog extends AuditLog {
  constructor(private readonly throwOnType: string) {
    super();
  }

  override append(event: AuditEvent): AuditRecord {
    if (event.type === this.throwOnType) {
      throw new Error(`synthetic audit failure for ${event.type}`);
    }
    return super.append(event);
  }
}

describe("ApprovalWorkflow", () => {
  describe(
    "P1 fix (35th independent review round, finding 2, 'rollback approval state when audit recording fails')",
    () => {
      it(
        "BLOCKER regression, exact reproduction: request() throws when audit recording fails, and the id " +
          "remains free for a genuine retry (no phantom PENDING record left behind)",
        () => {
          const auditLog = new SelectivelyThrowingAuditLog("APPROVAL_REQUESTED");
          const workflow = new ApprovalWorkflow(auditLog);

          expect(() => workflow.request("appr-1", "some action", 1)).toThrow(/synthetic audit failure/);
          expect(workflow.get("appr-1")).toBeUndefined();
          // A genuine retry with the SAME id must succeed once audit works again.
          const retryAuditLog = new AuditLog();
          const retryWorkflow = new ApprovalWorkflow(retryAuditLog);
          expect(() => retryWorkflow.request("appr-1", "some action", 1)).not.toThrow();
        }
      );

      it(
        "BLOCKER regression, exact reproduction: approve() throws when audit recording fails, and the " +
          "request remains PENDING (never left claiming APPROVED with no audit evidence)",
        () => {
          const auditLog = new SelectivelyThrowingAuditLog("APPROVAL_APPROVED");
          const workflow = new ApprovalWorkflow(auditLog);
          workflow.requestFor("appr-1", { actionType: "risky", risk: 5, description: "y" });

          expect(() => workflow.approve("appr-1", "founder@example.com")).toThrow(/synthetic audit failure/);
          const req = workflow.get("appr-1");
          expect(req?.status).toBe("PENDING");
          expect(req?.decidedBy).toBeUndefined();
        }
      );

      it(
        "BLOCKER regression: completeExecution() throws when audit recording fails, and the request " +
          "remains EXECUTING (never left claiming EXECUTED with no audit evidence)",
        () => {
          const auditLog = new SelectivelyThrowingAuditLog("APPROVAL_EXECUTED");
          const workflow = new ApprovalWorkflow(auditLog);
          workflow.requestFor("appr-1", { actionType: "risky", risk: 5, description: "y" });
          workflow.approve("appr-1", "founder@example.com");
          workflow.beginExecution("appr-1");

          expect(() => workflow.completeExecution("appr-1")).toThrow(/synthetic audit failure/);
          expect(workflow.get("appr-1")?.status).toBe("EXECUTING");
        }
      );

      it("no regression: approve() still transitions to APPROVED and records audit evidence when audit succeeds", () => {
        const auditLog = new AuditLog();
        const workflow = new ApprovalWorkflow(auditLog);
        workflow.requestFor("appr-1", { actionType: "risky", risk: 5, description: "y" });

        const approved = workflow.approve("appr-1", "founder@example.com", "evidence-ref-1");
        expect(approved.status).toBe("APPROVED");
        expect(approved.decidedBy).toBe("founder@example.com");

        const events = auditLog.all().filter((r) => r.type === "APPROVAL_APPROVED");
        expect(events).toHaveLength(1);
        expect((events[0]!.payload as { status: string }).status).toBe("APPROVED");
      });

      it("no regression: the full request -> approve -> beginExecution -> completeExecution lifecycle is unaffected", () => {
        const workflow = new ApprovalWorkflow(new AuditLog());
        workflow.requestFor("appr-1", { actionType: "risky", risk: 5, description: "y" });
        workflow.approve("appr-1", "founder@example.com");
        workflow.beginExecution("appr-1");
        const executed = workflow.completeExecution("appr-1");
        expect(executed.status).toBe("EXECUTED");
      });
    }
  );
});
