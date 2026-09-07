// Baseline section 147 (Constitution): risk taşıyan hiçbir eylem, politika
// motorunun önüne geçemez ("capability gateway'in policy engine'i atlayan
// bir yolu olmamalı"). Bu modül o tek geçiş noktasını uygular: `authorize`
// çağrılmadan bir eylemin gerçek fonksiyonu (execute) hiçbir zaman
// çalıştırılmaz.

import type { PolicyAction, PolicyEngine } from "../policy-engine/policy-engine.js";
import type { ApprovalRequest, ApprovalWorkflow } from "../policy-engine/approval.js";

export class CapabilityDeniedError extends Error {
  constructor(action: PolicyAction) {
    super(`Action '${action.actionType}' was DENIED by policy: ${action.description}`);
    this.name = "CapabilityDeniedError";
  }
}

export class CapabilityApprovalRequiredError extends Error {
  constructor(action: PolicyAction) {
    super(
      `Action '${action.actionType}' requires human approval before it can execute: ${action.description}. ` +
        `Use runtime/policy-engine/approval.ts to request and record that approval first.`
    );
    this.name = "CapabilityApprovalRequiredError";
  }
}

/**
 * P1 fix (24th independent review round, "approved requests must pass
 * capability gateway"): before this fix, `authorize()` UNCONDITIONALLY
 * threw `CapabilityApprovalRequiredError` for an `APPROVAL_REQUIRED`
 * decision — it accepted no way to present the evidence of an approval
 * that had ALREADY happened, so an action a human Founder had genuinely
 * approved through `ApprovalWorkflow` still could never reach `execute()`
 * through the ONE authoritative capability gateway (bölüm 147). Passing
 * an `ApprovalEvidence` lets a caller present a specific, already-decided
 * `ApprovalRequest` — but `authorize()` still independently verifies it
 * (see `authorize()`'s body): the request must exist, be `APPROVED`
 * (never `PENDING`/`REJECTED`/`REQUEST_CHANGES`), AND its own recorded
 * `actionDescription`/`risk` must match the action being authorized RIGHT
 * NOW — an approval for one action can never be replayed to authorize a
 * DIFFERENT one. An explicit `DENY` is checked FIRST and is never
 * affected by approval evidence at all: no evidence can ever override a
 * policy DENY.
 */
export interface ApprovalEvidence {
  readonly workflow: ApprovalWorkflow;
  readonly approvalId: string;
}

/**
 * Thrown when approval evidence was supplied but does not actually
 * authorize the exact action being gated — a missing/unknown approval id,
 * a request that is not (yet, or no longer) `APPROVED`, or an `APPROVED`
 * request whose recorded action/risk does not match this one (replay
 * across unrelated actions).
 */
export class ApprovalEvidenceMismatchError extends Error {
  constructor(action: PolicyAction, approvalId: string, request: ApprovalRequest | undefined) {
    super(
      `Approval '${approvalId}' does not authorize action '${action.actionType}' (${action.description}, ` +
        `risk ${action.risk}). ` +
        (request === undefined
          ? "No approval request exists with that id."
          : `The approval is for a different action ('${request.actionDescription}', risk ${request.risk}) or ` +
            `is not APPROVED (status: ${request.status}).`) +
        ` An approval can only authorize the EXACT action it was requested for — approval replay for an ` +
        `unrelated action is never permitted (baseline section 145/147).`
    );
    this.name = "ApprovalEvidenceMismatchError";
  }
}

export class CapabilityGateway {
  constructor(private readonly policy: PolicyEngine) {}

  /**
   * Bir eylemi çalıştırmadan ÖNCE politika motorundan geçirir. ALLOW
   * dışında hiçbir sonuç, `execute` fonksiyonunu tetiklemez — bu, riskli
   * bir eylemin "yanlışlıkla" veya bir hata sonucu politika kontrolünü
   * atlayarak çalışmasını yapısal olarak imkânsız kılar. Bir
   * `APPROVAL_REQUIRED` kararı, yalnızca `approval` parametresi TAM OLARAK
   * bu eylemi kapsayan, GERÇEKTEN `APPROVED` bir kayda işaret ediyorsa
   * yürütmeye izin verir (bkz. `ApprovalEvidence`'ın üstündeki fix notu);
   * açık bir DENY, hiçbir onay kanıtıyla ASLA geçersiz kılınamaz.
   */
  async authorize<T>(action: PolicyAction, execute: () => Promise<T> | T, approval?: ApprovalEvidence): Promise<T> {
    const result = this.policy.evaluate(action);

    if (result.decision === "DENY") {
      throw new CapabilityDeniedError(action);
    }
    if (result.decision === "APPROVAL_REQUIRED") {
      if (!approval) {
        throw new CapabilityApprovalRequiredError(action);
      }
      const request = approval.workflow.get(approval.approvalId);
      const boundToThisExactAction =
        request !== undefined &&
        request.status === "APPROVED" &&
        request.actionDescription === action.description &&
        request.risk === action.risk;
      if (!boundToThisExactAction) {
        throw new ApprovalEvidenceMismatchError(action, approval.approvalId, request);
      }
      return execute();
    }

    return execute();
  }
}
