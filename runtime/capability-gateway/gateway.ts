// Baseline section 147 (Constitution): risk taşıyan hiçbir eylem, politika
// motorunun önüne geçemez ("capability gateway'in policy engine'i atlayan
// bir yolu olmamalı"). Bu modül o tek geçiş noktasını uygular: `authorize`
// çağrılmadan bir eylemin gerçek fonksiyonu (execute) hiçbir zaman
// çalıştırılmaz.

import type { PolicyAction, PolicyEngine } from "../policy-engine/policy-engine.js";
import { ApprovalWorkflow, type ApprovalRequest } from "../policy-engine/approval.js";

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
 * P1 fix (25th independent review round, "approval workflow must be
 * authoritative"): a caller used to be able to pass its OWN
 * `ApprovalWorkflow` INSTANCE to `authorize()` (`{ workflow, approvalId }`)
 * — meaning ANY code calling `authorize()`, anywhere, could fabricate a
 * throwaway `ApprovalWorkflow`, request+approve a fake entry in it (with
 * no real reviewer, no real Founder, nothing), and hand THAT workflow back
 * to `authorize()` as "evidence." The gateway had no way to tell a
 * genuine, organization-wide approval store from a private, caller-forged
 * one — it just trusted whatever object arrived. Fixed: `CapabilityGateway`
 * now OWNS its approval store — injected ONCE, at CONSTRUCTION time, by
 * whoever assembles the gateway (a trusted wiring decision, exactly like
 * `policy` itself), never re-suppliable per call. `authorize()`'s
 * per-call API now accepts only an `approvalId: string` reference — never
 * a workflow object — and looks it up EXCLUSIVELY in `this.approvals`,
 * the ONE authoritative store this gateway was built with. A caller
 * cannot make `authorize()` consult a workflow it did not itself decide
 * to trust at construction.
 */
export interface ApprovalReference {
  readonly approvalId: string;
}

/**
 * Thrown when approval evidence was supplied but does not actually
 * authorize the exact action being gated — a missing/unknown approval id,
 * a request that is not (yet, or no longer) `APPROVED`, or an `APPROVED`
 * request whose recorded identity does not fully match this action
 * (replay across a materially different action).
 */
export class ApprovalEvidenceMismatchError extends Error {
  constructor(action: PolicyAction, approvalId: string, request: ApprovalRequest | undefined) {
    super(
      `Approval '${approvalId}' does not authorize action '${action.actionType}' (${action.description}, ` +
        `risk ${action.risk}). ` +
        (request === undefined
          ? "No approval request exists with that id."
          : `The approval's recorded identity (actionType='${String(request.actionType)}', ` +
            `description='${request.actionDescription}', risk=${request.risk}, ` +
            `costUsd=${String(request.costUsd)}, projectId=${String(request.projectId)}, ` +
            `actorId=${String(request.actorId)}) does not fully match this action, or the approval is not ` +
            `APPROVED (status: ${request.status}).`) +
        ` An approval can only authorize the EXACT action it was requested for (baseline section 145/147) — ` +
        `use ApprovalWorkflow.requestFor() to record the complete action identity an approval must be bound to.`
    );
    this.name = "ApprovalEvidenceMismatchError";
  }
}

/**
 * P1 fix (25th independent review round, "approval must be bound to
 * complete action identity"): matching used to compare only
 * `actionDescription`/`risk` — two materially different actions that
 * happen to share a similar description/risk (e.g. "production-deploy"
 * and "secret-mutation" both at risk 5, if worded similarly) could NOT be
 * told apart by that alone. Every field a `PolicyAction` (and a request
 * created via `requestFor()`) can carry is now compared: `actionType`,
 * `description`, `risk`, `costUsd`, `projectId`, `actorId`. A request
 * created via the legacy `request()` method never records `actionType`/
 * `costUsd`/`projectId`/`actorId` (they are `undefined`) — such a request
 * can only ever match an `action` that ALSO has every one of those fields
 * `undefined`, which is never the case for a real, fully-specified
 * `PolicyAction` with a genuine `actionType`. This is intentional: an
 * approval that never recorded its complete identity cannot be trusted to
 * authorize anything through this gateway — `requestFor()` is the only
 * supported way to create gateway-usable approval evidence.
 */
function isBoundToExactAction(request: ApprovalRequest, action: PolicyAction): boolean {
  return (
    request.status === "APPROVED" &&
    request.actionType === action.actionType &&
    request.actionDescription === action.description &&
    request.risk === action.risk &&
    request.costUsd === action.costUsd &&
    request.projectId === action.projectId &&
    request.actorId === action.actorId
  );
}

export class CapabilityGateway {
  constructor(
    private readonly policy: PolicyEngine,
    private readonly approvals: ApprovalWorkflow = new ApprovalWorkflow()
  ) {}

  /**
   * Bir eylemi çalıştırmadan ÖNCE politika motorundan geçirir. ALLOW
   * dışında hiçbir sonuç, `execute` fonksiyonunu tetiklemez — bu, riskli
   * bir eylemin "yanlışlıkla" veya bir hata sonucu politika kontrolünü
   * atlayarak çalışmasını yapısal olarak imkânsız kılar. Bir
   * `APPROVAL_REQUIRED` kararı, yalnızca `approval.approvalId` bu
   * gateway'in KENDİ yetkili `ApprovalWorkflow`'unda (bkz. üstteki fix
   * notu) TAM OLARAK bu eylemi kapsayan, GERÇEKTEN `APPROVED` bir kayda
   * işaret ediyorsa yürütmeye izin verir; açık bir DENY, hiçbir onay
   * kanıtıyla ASLA geçersiz kılınamaz.
   *
   * P1 fix (25th independent review round, "approval evidence must be
   * consumed before execution"): a matching APPROVED request used to
   * remain APPROVED (and therefore reusable) after `authorize()` let
   * execution proceed — a caller could present the SAME `approvalId` to
   * authorize the SAME action twice (or two concurrent callers could both
   * present it at once), and both would pass the identical check. Fixed:
   * once a matching, `APPROVED` request is found, this method immediately
   * calls `this.approvals.execute(approval.approvalId)` — the SAME
   * synchronous, atomic APPROVED -> EXECUTED transition
   * `ApprovalWorkflow.execute()` already provides (bkz. approval.ts) —
   * BEFORE the risky `execute` callback ever runs, and entirely within
   * this method's own synchronous prefix (no `await` between the match
   * check and the consumption). JS's single-threaded, run-to-completion
   * semantics mean two concurrent `authorize()` calls presenting the same
   * `approvalId` cannot interleave between "check" and "consume": whichever
   * runs its synchronous prefix first (whichever wins the race is
   * unspecified, but exactly one of them does) leaves the request
   * EXECUTED, so the OTHER call's own `this.approvals.get(...)` /
   * `isBoundToExactAction()` check (which re-reads the CURRENT status)
   * sees `EXECUTED`, not `APPROVED`, fails the match, and throws
   * `ApprovalEvidenceMismatchError` instead of ALSO proceeding.
   */
  async authorize<T>(action: PolicyAction, execute: () => Promise<T> | T, approval?: ApprovalReference): Promise<T> {
    const result = this.policy.evaluate(action);

    if (result.decision === "DENY") {
      throw new CapabilityDeniedError(action);
    }
    if (result.decision === "APPROVAL_REQUIRED") {
      if (!approval) {
        throw new CapabilityApprovalRequiredError(action);
      }
      const request = this.approvals.get(approval.approvalId);
      if (!request || !isBoundToExactAction(request, action)) {
        throw new ApprovalEvidenceMismatchError(action, approval.approvalId, request);
      }
      // Atomically consume the approval — APPROVED -> EXECUTED — before
      // the risky callback runs. See the fix note above: this happens in
      // the SAME synchronous prefix as the match check above, so a
      // concurrent replay attempt can never also pass.
      this.approvals.execute(approval.approvalId);
      return execute();
    }

    return execute();
  }
}
