import { describe, expect, it } from "vitest";
import {
  ApprovalWorkflow,
  UnauthorizedApproverError,
  SelfApprovalNotPermittedError,
  RiskFiveAuthorityRequiredError
} from "../approval.js";
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
          const workflow = new ApprovalWorkflow(auditLog, ["founder@example.com"]);
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
          const workflow = new ApprovalWorkflow(auditLog, ["founder@example.com"]);
          workflow.requestFor("appr-1", { actionType: "risky", risk: 5, description: "y" });
          workflow.approve("appr-1", "founder@example.com");
          workflow.beginExecution("appr-1");

          expect(() => workflow.completeExecution("appr-1")).toThrow(/synthetic audit failure/);
          expect(workflow.get("appr-1")?.status).toBe("EXECUTING");
        }
      );

      it("no regression: approve() still transitions to APPROVED and records audit evidence when audit succeeds", () => {
        const auditLog = new AuditLog();
        const workflow = new ApprovalWorkflow(auditLog, ["founder@example.com"]);
        workflow.requestFor("appr-1", { actionType: "risky", risk: 5, description: "y" });

        const approved = workflow.approve("appr-1", "founder@example.com", "evidence-ref-1");
        expect(approved.status).toBe("APPROVED");
        expect(approved.decidedBy).toBe("founder@example.com");

        const events = auditLog.all().filter((r) => r.type === "APPROVAL_APPROVED");
        expect(events).toHaveLength(1);
        expect((events[0]!.payload as { status: string }).status).toBe("APPROVED");
      });

      it("no regression: the full request -> approve -> beginExecution -> completeExecution lifecycle is unaffected", () => {
        const workflow = new ApprovalWorkflow(new AuditLog(), ["founder@example.com"]);
        workflow.requestFor("appr-1", { actionType: "risky", risk: 5, description: "y" });
        workflow.approve("appr-1", "founder@example.com");
        workflow.beginExecution("appr-1");
        const executed = workflow.completeExecution("appr-1");
        expect(executed.status).toBe("EXECUTED");
      });
    }
  );

  describe(
    "P0 CLOSURE REMEDIATION, blocker 1, round 1 (UASF-REQ-0019, UASF-REQ-0020, default-deny, " +
      "'risk-5 Founder authority can be forged because caller-controlled decidedBy text is accepted')",
    () => {
      it(
        "fix verification: when constructed with an authorizedApprovers allowlist, approve() with a " +
          "decidedBy NOT in that list is rejected with UnauthorizedApproverError (fail-closed/default-deny)",
        () => {
          const workflow = new ApprovalWorkflow(new AuditLog(), ["founder@example.com"]);
          workflow.requestFor("appr-1", { actionType: "risky", risk: 5, description: "y" });
          expect(() => workflow.approve("appr-1", "attacker-forged-identity")).toThrow(UnauthorizedApproverError);
          expect(workflow.get("appr-1")?.status).toBe("PENDING");
        }
      );

      it(
        "fix verification: when constructed with an authorizedApprovers allowlist, approve() with a " +
          "decidedBy that IS a member (case/whitespace-insensitively) succeeds",
        () => {
          const workflow = new ApprovalWorkflow(new AuditLog(), ["founder@example.com"]);
          workflow.requestFor("appr-1", { actionType: "risky", risk: 5, description: "y" });
          const approved = workflow.approve("appr-1", "  Founder@Example.com  ");
          expect(approved.status).toBe("APPROVED");
        }
      );

      it(
        "fix verification: reject() and requestChanges() are also gated by the authorizedApprovers " +
          "allowlist when configured",
        () => {
          const workflow = new ApprovalWorkflow(new AuditLog(), ["founder@example.com"]);
          workflow.requestFor("appr-1", { actionType: "risky", risk: 5, description: "y" });
          workflow.requestFor("appr-2", { actionType: "risky", risk: 5, description: "y" });
          expect(() => workflow.reject("appr-1", "not-the-founder")).toThrow(UnauthorizedApproverError);
          expect(() => workflow.requestChanges("appr-2", "not-the-founder", "needs work")).toThrow(
            UnauthorizedApproverError
          );
        }
      );

      it(
        "fix verification: a requester can never approve its own request, even with a genuine allowlisted " +
          "identity (self-approval prevention, mirrors the phase-closure reviewer/requester-independence " +
          "pattern) — checked BEFORE the authorizedApprovers membership test",
        () => {
          const workflow = new ApprovalWorkflow(new AuditLog(), ["same-identity@example.com"]);
          workflow.requestFor(
            "appr-1",
            { actionType: "risky", risk: 5, description: "y" },
            { requestedBy: "same-identity@example.com" }
          );
          expect(() => workflow.approve("appr-1", "same-identity@example.com")).toThrow(
            SelfApprovalNotPermittedError
          );
          expect(workflow.get("appr-1")?.status).toBe("PENDING");
        }
      );

      it("no regression: a DIFFERENT decidedBy than requestedBy still approves normally when both are allowlisted", () => {
        const workflow = new ApprovalWorkflow(new AuditLog(), ["requester@example.com", "reviewer@example.com"]);
        workflow.requestFor(
          "appr-1",
          { actionType: "risky", risk: 5, description: "y" },
          { requestedBy: "requester@example.com" }
        );
        const approved = workflow.approve("appr-1", "reviewer@example.com");
        expect(approved.status).toBe("APPROVED");
      });

      it("no regression: requests created via requestFor() without a requestedBy are unaffected by self-approval checks", () => {
        const workflow = new ApprovalWorkflow(new AuditLog(), ["anyone@example.com"]);
        workflow.requestFor("appr-1", { actionType: "risky", risk: 5, description: "y" });
        const approved = workflow.approve("appr-1", "anyone@example.com");
        expect(approved.status).toBe("APPROVED");
      });

      it("no regression: the legacy request() method (never sets requestedBy) is unaffected by self-approval checks", () => {
        const workflow = new ApprovalWorkflow(new AuditLog(), ["anyone@example.com"]);
        workflow.request("appr-1", "some action", 5);
        const approved = workflow.approve("appr-1", "anyone@example.com");
        expect(approved.status).toBe("APPROVED");
      });
    }
  );

  /**
   * TR (P0 CLOSURE REMEDIATION fix notu, blocker 1 — ikinci tur, UASF-REQ-0019,
   * UASF-REQ-0020): bir önceki turun kendi testi ("without an authorizedApprovers
   * allowlist, ANY non-blank decidedBy string is still accepted") artık YANLIŞ
   * bir iddia kaydediyordu — bu, tam olarak bağımsız incelemenin bulduğu güvenlik
   * açığının KENDİSİYDİ. O test SİLİNDİ (asla "beklenen davranış" olarak
   * belgelenmemeli) ve yerine, risk-5 için yapılandırma eksikliğinin artık bir
   * RED nedeni olduğunu kanıtlayan bu blok eklendi — bkz. `RiskFiveAuthorityRequiredError`'ın
   * sınıf başı fix notu (approval.ts).
   */
  describe(
    "P0 CLOSURE REMEDIATION, blocker 1, round 2 (UASF-REQ-0019, UASF-REQ-0020, default-deny, " +
      "'Risk-5 authority validation is still opt-in')",
    () => {
      it(
        "BLOCKER regression, exact reproduction: missing authorized approver configuration on a risk-5 " +
          "request is DENIED, not silently bypassed — RiskFiveAuthorityRequiredError, not APPROVED",
        () => {
          const workflow = new ApprovalWorkflow(new AuditLog());
          workflow.requestFor("appr-1", { actionType: "risky", risk: 5, description: "y" });
          expect(() => workflow.approve("appr-1", "totally-unverified-self-declared-founder")).toThrow(
            RiskFiveAuthorityRequiredError
          );
          expect(workflow.get("appr-1")?.status).toBe("PENDING");
        }
      );

      it(
        "BLOCKER regression: an arbitrary, caller-controlled decidedBy string can never approve a risk-5 " +
          "request when no authorizedApprovers configuration exists — the identity string itself is " +
          "irrelevant, only the ABSENCE of authoritative configuration matters",
        () => {
          const workflow = new ApprovalWorkflow(new AuditLog());
          workflow.requestFor("appr-2", { actionType: "risky", risk: 5, description: "y" });
          expect(() => workflow.approve("appr-2", "attacker@example.com")).toThrow(RiskFiveAuthorityRequiredError);
          expect(() => workflow.reject("appr-2", "attacker@example.com")).toThrow(RiskFiveAuthorityRequiredError);
          expect(() => workflow.requestChanges("appr-2", "attacker@example.com", "x")).toThrow(
            RiskFiveAuthorityRequiredError
          );
          expect(workflow.get("appr-2")?.status).toBe("PENDING");
        }
      );

      it(
        "fix verification: a valid Founder approval (genuine authorizedApprovers configuration, decidedBy " +
          "IS the configured Founder identity) succeeds normally for a risk-5 request",
        () => {
          const workflow = new ApprovalWorkflow(new AuditLog(), ["founder@example.com"]);
          workflow.requestFor("appr-3", { actionType: "risky", risk: 5, description: "y" });
          const approved = workflow.approve("appr-3", "founder@example.com");
          expect(approved.status).toBe("APPROVED");
        }
      );

      it(
        "fix verification: an invalid/non-Founder approval (authorizedApprovers configured, but decidedBy " +
          "is NOT a member) is rejected with UnauthorizedApproverError, distinct from the missing-" +
          "configuration case above",
        () => {
          const workflow = new ApprovalWorkflow(new AuditLog(), ["founder@example.com"]);
          workflow.requestFor("appr-4", { actionType: "risky", risk: 5, description: "y" });
          expect(() => workflow.approve("appr-4", "attacker@example.com")).toThrow(UnauthorizedApproverError);
          expect(workflow.get("appr-4")?.status).toBe("PENDING");
        }
      );

      it("no regression: risk < 5 decisions remain unaffected when no authorizedApprovers configuration exists", () => {
        const workflow = new ApprovalWorkflow(new AuditLog());
        workflow.requestFor("appr-5", { actionType: "low-risk", risk: 4, description: "y" });
        const approved = workflow.approve("appr-5", "anyone@example.com");
        expect(approved.status).toBe("APPROVED");
      });
    }
  );
});
