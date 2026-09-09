// Baseline section 147 (Constitution): risk taşıyan hiçbir eylem, politika
// motorunun önüne geçemez ("capability gateway'in policy engine'i atlayan
// bir yolu olmamalı"). Bu modül o tek geçiş noktasını uygular: `authorize`
// çağrılmadan bir eylemin gerçek fonksiyonu (execute) hiçbir zaman
// çalıştırılmaz.

import type { PolicyAction, PolicyEngine, PolicyEvaluationResult } from "../policy-engine/policy-engine.js";
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
            `actorId=${String(request.actorId)}, identityDigest=${String(request.identityDigest)}) does not ` +
            `fully match this action, or the approval is not APPROVED (status: ${request.status}).`) +
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
    request.actorId === action.actorId &&
    // P1 fix (34th independent review round, findings 3 & 4): bkz.
    // `PolicyAction.identityDigest`'in fix notu — compared for exact
    // equality exactly like every other identity field above. An action
    // that supplies no digest (`undefined`) can only match an approval
    // that ALSO recorded no digest, the same "an incomplete identity can
    // never be trusted to match" precedent this file's own 25th-round fix
    // already established for `actionType`/`costUsd`/`projectId`/`actorId`.
    request.identityDigest === action.identityDigest
  );
}

export class CapabilityGateway {
  /**
   * P1 fix (27th independent review round, finding 3, "make gateway
   * dependencies runtime-private"): `policy`/`approvals` used to be
   * declared with TypeScript's compile-time-only `private readonly`
   * constructor-parameter properties — in the emitted JS they are
   * ordinary, enumerable instance properties. This class's ENTIRE purpose
   * (bölüm 147: "capability gateway'in policy engine'i atlayan bir yolu
   * olmamalı") depends on `authorize()` always consulting the SAME,
   * originally-wired `PolicyEngine`/`ApprovalWorkflow` it was constructed
   * with — `(gateway as any).policy = fakeAlwaysAllowEngine` or
   * `(gateway as any).approvals = attackerControlledWorkflow` from any
   * caller holding a `CapabilityGateway` reference would silently swap out
   * the authoritative trust boundary established at construction time for
   * one the attacker fully controls, defeating default-deny and forged-
   * approval protection alike with no trace anywhere in `authorize()`
   * itself. Fixed: genuine ECMAScript private fields (`#policy`/
   * `#approvals`), assigned once in the constructor body — `as any`,
   * bracket access, and every reflection API fail to reach them, and any
   * code outside this class body attempting `gateway.#policy = x` is a
   * `SyntaxError` at PARSE time, not merely a runtime rejection.
   */
  #policy: PolicyEngine;
  #approvals: ApprovalWorkflow;

  constructor(policy: PolicyEngine, approvals: ApprovalWorkflow = new ApprovalWorkflow()) {
    this.#policy = policy;
    this.#approvals = approvals;
  }

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
  /**
   * P1 fix (32nd independent review round, finding 8, "persist the actual
   * policy outcome"): `authorize()` used to return ONLY `execute()`'s own
   * value — nothing about the ACTUAL, authoritative decision this method's
   * OWN `this.#policy.evaluate(action)` call just made was ever observable
   * by the caller. `project-lifecycle/orchestrator.ts`'s `bootstrapProject()`
   * (this method's own caller for `project.scaffold`) had to GUESS at what
   * decision must have occurred, and guessed wrong: it unconditionally
   * hardcoded `policyDecision: "ALLOW"` into its durable state record,
   * reasoning "if `authorize()` didn't throw, it must have been ALLOW" —
   * but a risk-5 action that reaches this point via a genuinely APPROVED
   * approval ALSO doesn't throw, despite `evaluate()` having returned
   * `APPROVAL_REQUIRED`, not `ALLOW`. That silently REWRITES a real
   * APPROVAL_REQUIRED-then-approved authorization history into a false
   * "no approval was ever needed" ALLOW record — exactly the falsified-
   * authorization-history defect this finding names. Fixed: an optional
   * `onDecision` callback, invoked with the SAME authoritative
   * `PolicyEvaluationResult` this method itself just computed, immediately
   * after `evaluate()` runs and BEFORE any DENY/APPROVAL_REQUIRED branching
   * — so a caller that cares (like `bootstrapProject()`) can capture the
   * TRUE decision and persist it honestly, while every pre-existing caller
   * that omits this parameter sees ZERO behavior change (a purely additive,
   * backward-compatible parameter, matching this codebase's established
   * pattern for extending an authorization surface without touching
   * existing call sites — e.g. `runId`/`agentId`'s own additions
   * elsewhere).
   */
  async authorize<T>(
    action: PolicyAction,
    execute: () => Promise<T> | T,
    approval?: ApprovalReference,
    onDecision?: (result: PolicyEvaluationResult) => void
  ): Promise<T> {
    const result = this.#policy.evaluate(action);
    onDecision?.(result);
    // P1 fix (27th independent review round, finding 4, "bind approval to
    // the policy-evaluated action"): every reference below uses
    // `authoritativeAction` (the EXACT frozen snapshot `this.#policy`
    // itself evaluated and decided about — `result.action`), never the
    // original `action` PARAMETER again. The old code kept re-reading the
    // caller-owned `action` parameter for the DENY/APPROVAL_REQUIRED error
    // messages AND, critically, for `isBoundToExactAction(request,
    // action)`'s identity match — a SEPARATE read of `action`'s properties
    // from the one `policy.evaluate()` performed internally to build ITS
    // OWN snapshot. If `action` is a getter/Proxy-backed object, nothing
    // guarantees that second read returns the SAME values the policy
    // engine actually reasoned about: it could answer with a materially
    // different identity for the approval-matching check than the one
    // that produced the APPROVAL_REQUIRED decision in the first place —
    // an approval bound to one action's identity could then be matched
    // against a DIFFERENT apparent identity for the same call. Using
    // `result.action` everywhere closes this: it is a plain, frozen,
    // already-copied object — reading it again can never re-invoke a
    // getter/Proxy trap, so it is guaranteed to be the exact same values
    // in every reference below.
    const authoritativeAction = result.action;

    if (result.decision === "DENY") {
      throw new CapabilityDeniedError(authoritativeAction);
    }
    if (result.decision === "APPROVAL_REQUIRED") {
      if (!approval) {
        throw new CapabilityApprovalRequiredError(authoritativeAction);
      }
      // P1 fix (28th independent review round, finding 9, "snapshot
      // approval id before consumption" — same root class as this file's
      // own round-27 finding 4, just for `approval.approvalId` instead of
      // `action`): `approval.approvalId` used to be read SEPARATELY at
      // EVERY use site below (the lookup, the mismatch-error message,
      // `beginExecution()`, and `completeExecution()`/`failExecution()`)
      // — up to four separate reads of a caller-owned `ApprovalReference`
      // object that, if getter/Proxy-backed, need not agree. A hostile or
      // merely buggy `approval` could answer approval A's id for the
      // lookup/match check and `beginExecution()` (genuinely claiming and
      // locking A), then answer a COMPLETELY DIFFERENT approval B's id for
      // `completeExecution()`/`failExecution()` — wrongly transitioning B
      // (which this call never actually matched, evaluated, or executed
      // anything for) while leaving A permanently stuck in EXECUTING,
      // never reaching a terminal state at all. Fixed: `approvalId` is
      // read into a local `const` exactly ONCE, as the very first thing
      // done with `approval` — every reference below (lookup, error
      // message, `beginExecution`, `completeExecution`/`failExecution`,
      // and the audit trail those methods themselves record) uses this
      // SAME captured string, never `approval.approvalId` again.
      const approvalId = approval.approvalId;
      const request = this.#approvals.get(approvalId);
      if (!request || !isBoundToExactAction(request, authoritativeAction)) {
        throw new ApprovalEvidenceMismatchError(authoritativeAction, approvalId, request);
      }
      // P1 fix (27th independent review round, finding 5, "finalize
      // approval only after successful execution"): `execute()` used to
      // be called AFTER an unconditional APPROVED -> EXECUTED transition
      // — if the risky callback below threw, the approval record already,
      // permanently claimed a successful execution that never happened.
      // Fixed: `beginExecution()` atomically claims APPROVED -> EXECUTING
      // FIRST (the SAME synchronous-prefix atomicity as before — see
      // `ApprovalWorkflow.beginExecution()`'s own fix note for why this
      // still blocks a concurrent replay just as completely), the
      // callback runs, and ONLY on genuine success does
      // `completeExecution()` transition EXECUTING -> EXECUTED; a thrown
      // error is captured via `failExecution()` (EXECUTING ->
      // EXECUTION_FAILED, an honest, terminal failure record) and
      // RE-THROWN, never swallowed.
      this.#approvals.beginExecution(approvalId);
      try {
        const value = await execute();
        this.#approvals.completeExecution(approvalId);
        return value;
      } catch (err) {
        this.#approvals.failExecution(approvalId, err instanceof Error ? err.message : String(err));
        throw err;
      }
    }

    return execute();
  }
}
