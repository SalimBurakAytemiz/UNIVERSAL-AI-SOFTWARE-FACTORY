// Baseline section 145 (Approval Evidence Package) + 146 (Human Approval).
// Bu modül, APPROVAL_REQUIRED kararı alan bir eylemin, geçerli bir insan
// (Kurucu) onayı olmadan asla EXECUTED durumuna erişemeyeceğini garanti eden
// durum makinesidir (bölüm 120'deki resmi değişmez: "Risk-5 bir işlem
// EXECUTED durumuna asla geçerli bir Kurucu onayı olmadan ulaşamaz").
//
// P1 fix (2nd independent review round): request()/get() eskiden İÇ
// (mutable) nesnenin KENDİSİNİ döndürüyordu. Bu, `const r = workflow.get(id);
// r.status = "APPROVED";` gibi bir çağıranın, hiçbir approve() çağrısı
// olmadan durumu doğrudan değiştirebilmesi anlamına geliyordu — "genuine
// Founder approval" değişmezini tamamen atlatan bir yol. Artık dışa dönen
// HER kayıt, iç Map'teki gerçek nesneden ayrık (detached), donmuş
// (Object.freeze) bir anlık görüntüdür (bkz. runtime/util/immutable.ts);
// durum geçişleri YALNIZCA approve()/reject()/execute() üzerinden, iç
// yetkili (authoritative) nesne üzerinde gerçekleşir.

import { AuditLog } from "../audit/audit-log.js";
import { freezeRecord } from "../util/immutable.js";
import { isNonBlankIdentity } from "../util/identity.js";
import type { PolicyAction } from "./policy-engine.js";

/**
 * P2 fix (23rd independent review round, "implement REQUEST_CHANGES
 * approval decision"): the authoritative P0 requirement explicitly lists
 * THREE reviewer decisions — APPROVE, REJECT, REQUEST_CHANGES — but this
 * state machine used to have only PENDING/APPROVED/REJECTED/EXECUTED. A
 * reviewer who wants "this isn't right yet, here's what needs to change"
 * (a genuinely distinct outcome from an outright REJECT — it implies
 * revision and resubmission are expected, not final refusal) had no way
 * to represent that decision: either misclassifying it as REJECTED
 * (losing the "revise and resubmit" semantics and any recorded reason for
 * WHAT must change) or leaving the request PENDING forever (never
 * recording that a reviewer actually looked at it and found it wanting).
 * `REQUEST_CHANGES` is now a first-class status, structurally distinct
 * from REJECTED at both the type and audit-event level — see
 * `requestChanges()` below.
 */
/**
 * P1 fix (27th independent review round, finding 5, "finalize approval
 * only after successful execution"): `EXECUTING` and `EXECUTION_FAILED`
 * are new, added for the split beginExecution()/completeExecution()/
 * failExecution() lifecycle below — see its fix note for the full
 * rationale. `EXECUTING` is a genuine intermediate, non-terminal state (a
 * request in flight); `EXECUTION_FAILED` is terminal for this approval id,
 * the same way `EXECUTED`/`REJECTED`/`REQUEST_CHANGES` already are.
 */
export type ApprovalStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "REQUEST_CHANGES"
  | "EXECUTING"
  | "EXECUTED"
  | "EXECUTION_FAILED";

interface MutableApprovalRequest {
  id: string;
  actionDescription: string;
  risk: number;
  status: ApprovalStatus;
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  evidenceRef?: string;
  /** Only ever set by requestChanges() — the reviewer's evidence for WHAT must change, distinct from a REJECT's finality. */
  changeRequestReason?: string;
  /** Only ever set by failExecution() — why the actual work failed after a genuine APPROVED claim was made. */
  failureReason?: string;
  /**
   * P1 fix (25th independent review round, "approval must be bound to
   * complete action identity"): only ever set by `requestFor()` (below) —
   * the full identity of the exact `PolicyAction` this approval covers,
   * beyond the legacy `actionDescription`/`risk` pair. Undefined for a
   * request created via the legacy `request()` method, which means such a
   * request can never satisfy `CapabilityGateway`'s full-identity binding
   * check (bkz. capability-gateway/gateway.ts) — a request that never
   * recorded its complete identity cannot later be trusted to match one.
   */
  actionType?: string;
  costUsd?: number;
  projectId?: string;
  /** The identity of whoever/whatever the approved action is being performed on behalf of, when applicable. */
  actorId?: string;
  /**
   * P1 fix (34th independent review round, findings 3 & 4): recorded
   * verbatim from `action.identityDigest` — bkz. `PolicyAction.identityDigest`'in
   * fix notu (policy-engine.ts) — so `CapabilityGateway`'s exact-match
   * check can bind this approval to whatever extra identity dimensions
   * (task/run/agent/provider/model/prompt for a model invocation, or the
   * candidate implementation for a provider replacement) the requesting
   * call site folded into that digest.
   */
  identityDigest?: string;
}

/** Dışa döndürülen her kayıt bunun donmuş, ayrık bir kopyasıdır — asla iç nesnenin kendisi değil. */
export type ApprovalRequest = Readonly<MutableApprovalRequest>;

export class ApprovalRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalRequiredError";
  }
}

export class InvalidApprovalDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidApprovalDecisionError";
  }
}

/**
 * P2 fix (7th independent review round, "duplicate approval IDs replace
 * authoritative history"): request() eskiden `this.requests.set(id, req)`
 * çağrısını KOŞULSUZ yapıyordu — aynı `id` ile tekrar request() çağrılması,
 * mevcut kaydın durumu ne olursa olsun (PENDING/APPROVED/REJECTED/EXECUTED
 * fark etmeksizin) onu SESSİZCE taze bir PENDING kayıtla DEĞİŞTİRİYORDU.
 * Bir onay ID'si, bölüm 145 "Approval Evidence Package" gereği KALICI,
 * benzersiz bir yetkili tanımlayıcıdır: gerçek onaylayan kimliği, karar
 * zaman damgası, kanıt referansı ve (varsa) EXECUTED durumu asla yeniden
 * yazılamaz/sıfırlanamaz. `decision-ledger.ts`'teki `DuplicateDecisionError`
 * ile AYNI desen: mutasyondan ÖNCE, mevcut kaydın durumuna bakmaksızın
 * reddedilir (fail closed).
 */
export class DuplicateApprovalIdError extends Error {
  constructor(id: string) {
    super(
      `Approval id '${id}' already exists. Approval ids are permanent, unique authoritative ` +
        `identifiers and can never be reused or silently overwritten, regardless of the existing ` +
        `record's current status — request a new, distinct id for a new approval.`
    );
    this.name = "DuplicateApprovalIdError";
  }
}

/**
 * P1 fix (24th independent review round, "approval state must be
 * runtime-private"): the request/decision map used to be declared with
 * TypeScript's `private` keyword — which is a COMPILE-TIME-ONLY marker.
 * It compiles to an entirely ordinary, enumerable JavaScript instance
 * property; nothing about it is actually hidden at runtime. A consumer
 * holding a reference to an `ApprovalWorkflow` instance could reach in via
 * `(workflow as any).requests` (or plain bracket access, `workflow
 * ["requests"]`, which needs no type-system escape hatch at all) and
 * mutate an approval record's `status` DIRECTLY — e.g. flipping a PENDING
 * request straight to "APPROVED" — completely bypassing `approve()`'s
 * reviewer-identity check and its audit-log entry. The `freezeRecord()`-
 * based detachment already used everywhere this class RETURNS a record
 * only protects outgoing copies; it does nothing to protect the
 * authoritative Map itself from being reached through the instance
 * directly. Fixed the same way `runtime/models/gateway.ts`'s
 * `#providers`/`#rawInvoke` already are: a genuine ECMAScript private
 * class field (`#requests`, not `private requests`). This is enforced by
 * the JS runtime itself, not a TypeScript/developer convention — `as
 * any`, bracket access, `Object.getOwnPropertyNames()`, and
 * `Reflect.ownKeys()` all fail to reach it (a private field is not even
 * listed as an own property key by any reflection API), and any code
 * outside this class body attempting to write `x.#requests` is a
 * `SyntaxError` at PARSE time, not merely a runtime rejection.
 */
export class ApprovalWorkflow {
  #requests = new Map<string, MutableApprovalRequest>();

  /**
   * P1 fix (28th independent review round, root-class B sweep, "TypeScript
   * private used for authoritative mutable state" — same class as finding
   * 1 above, in this same file): this was still a TS-compile-time-only
   * `private readonly` constructor-parameter property. Replacing it via
   * `(workflow as any).auditLog = { append: () => {} }` would silently
   * suppress every future `APPROVAL_*` audit event with no trace. Converted
   * to a genuine ECMAScript `#auditLog` private field.
   */
  #auditLog?: AuditLog;

  constructor(auditLog?: AuditLog) {
    this.#auditLog = auditLog;
  }

  request(id: string, actionDescription: string, risk: number): ApprovalRequest {
    if (this.#requests.has(id)) {
      throw new DuplicateApprovalIdError(id);
    }
    const req: MutableApprovalRequest = {
      id,
      actionDescription,
      risk,
      status: "PENDING",
      requestedAt: new Date().toISOString()
    };
    this.#requests.set(id, req);
    this.audit("APPROVAL_REQUESTED", req);
    return freezeRecord(req);
  }

  /**
   * P1 fix (25th independent review round, "approval must be bound to
   * complete action identity"): the RECOMMENDED way to request an approval
   * that will be presented to `CapabilityGateway.authorize()` — records
   * the COMPLETE identity of the exact `PolicyAction` being approved
   * (`actionType`, `description`, `risk`, `costUsd`), plus an optional
   * `actorId` (whoever/whatever the action is performed on behalf of),
   * not just the legacy `actionDescription`/`risk` pair `request()`
   * stores. Two actions that happen to share a description/risk (e.g. two
   * differently-scoped deployments) but differ in `actionType` or
   * `costUsd` are NEVER the same action, and an approval for one must
   * never be usable to authorize the other — see
   * `CapabilityGateway.authorize()`'s binding check, which requires ALL
   * of these fields to match before treating an approval as covering a
   * given action.
   */
  requestFor(id: string, action: PolicyAction, options?: { readonly actorId?: string }): ApprovalRequest {
    if (this.#requests.has(id)) {
      throw new DuplicateApprovalIdError(id);
    }
    const req: MutableApprovalRequest = {
      id,
      actionDescription: action.description,
      risk: action.risk,
      actionType: action.actionType,
      costUsd: action.costUsd,
      projectId: action.projectId,
      actorId: options?.actorId ?? action.actorId,
      identityDigest: action.identityDigest,
      status: "PENDING",
      requestedAt: new Date().toISOString()
    };
    this.#requests.set(id, req);
    this.audit("APPROVAL_REQUESTED", req);
    return freezeRecord(req);
  }

  /**
   * Onay kaydı — hem onaylayan kimliği (approver identity) hem de isteğe
   * bağlı bir kanıt/denetim referansı (evidenceRef) taşır (bölüm 145,
   * "Approval Evidence Package"). Boş bir onaylayan kimliği asla kabul
   * edilmez: bu, "kim onayladı?" sorusunun her zaman cevaplanabilir
   * kalmasını sağlayan minimum kanıt gereğidir.
   */
  approve(id: string, decidedBy: string, evidenceRef?: string): ApprovalRequest {
    assertValidApprover(decidedBy);
    const req = this.#mustGet(id);
    if (req.status !== "PENDING") {
      throw new Error(`Cannot approve request ${id}: status is ${req.status}, not PENDING`);
    }
    req.status = "APPROVED";
    req.decidedAt = new Date().toISOString();
    req.decidedBy = decidedBy;
    req.evidenceRef = evidenceRef;
    this.audit("APPROVAL_APPROVED", req);
    return freezeRecord(req);
  }

  reject(id: string, decidedBy: string, evidenceRef?: string): ApprovalRequest {
    assertValidApprover(decidedBy);
    const req = this.#mustGet(id);
    if (req.status !== "PENDING") {
      throw new Error(`Cannot reject request ${id}: status is ${req.status}, not PENDING`);
    }
    req.status = "REJECTED";
    req.decidedAt = new Date().toISOString();
    req.decidedBy = decidedBy;
    req.evidenceRef = evidenceRef;
    this.audit("APPROVAL_REJECTED", req);
    return freezeRecord(req);
  }

  /**
   * P2 fix (23rd independent review round, "implement REQUEST_CHANGES
   * approval decision"): a distinct, first-class reviewer outcome from
   * approve()/reject() — "not yet approved, and here is specifically what
   * must change before it can be." Requires BOTH a genuine (non-blank)
   * reviewer identity (bkz. `assertValidApprover`, AYNI paylaşılan
   * `isNonBlankIdentity` doğrulayıcısı) AND a genuine (non-blank) `reason`
   * describing what needs to change — REQUEST_CHANGES without a reason
   * would be indistinguishable from an unexplained REJECT, defeating the
   * entire point of this being a DIFFERENT decision from REJECT. Only
   * legal from PENDING (the SAME transition guard as approve()/reject()
   * — bkz. üstteki metodlar), and is TERMINAL for this request id, tıpkı
   * REJECTED gibi: bu id tekrar approve()/reject()/requestChanges()
   * ÜZERİNDEN ilerletilemez (hepsi `status !== "PENDING"` kontrolüyle
   * ZATEN engellenir, hiçbir özel durum eklenmesine gerek kalmadan) —
   * revize edilmiş eylem için YENİ, ayrı bir id ile request() çağrılması
   * gerekir (mevcut DuplicateApprovalIdError/kalıcı-kimlik felsefesiyle
   * TUTARLI). execute()'un KENDİSİ hiçbir değişiklik gerektirmez: zaten
   * yalnızca `status === "APPROVED"` olduğunda izin verir, bu yüzden
   * REQUEST_CHANGES durumundaki bir kayıt zaten yapısal olarak asla
   * EXECUTED'e ulaşamaz.
   */
  requestChanges(id: string, decidedBy: string, reason: string, evidenceRef?: string): ApprovalRequest {
    assertValidApprover(decidedBy);
    if (!isNonBlankIdentity(reason)) {
      throw new InvalidApprovalDecisionError(
        "REQUEST_CHANGES requires a non-empty reason describing what must change before this action " +
          "can be approved — baseline section 145, Approval Evidence Package. Without a reason, " +
          "REQUEST_CHANGES would be indistinguishable from an unexplained REJECT."
      );
    }
    const req = this.#mustGet(id);
    if (req.status !== "PENDING") {
      throw new Error(`Cannot request changes on request ${id}: status is ${req.status}, not PENDING`);
    }
    req.status = "REQUEST_CHANGES";
    req.decidedAt = new Date().toISOString();
    req.decidedBy = decidedBy;
    req.changeRequestReason = reason;
    req.evidenceRef = evidenceRef;
    this.audit("APPROVAL_CHANGES_REQUESTED", req);
    return freezeRecord(req);
  }

  /**
   * P1 fix (27th independent review round, finding 5, "finalize approval
   * only after successful execution"): the previous single `execute()`
   * method transitioned APPROVED -> EXECUTED UNCONDITIONALLY, and
   * `CapabilityGateway.authorize()` (bkz. capability-gateway/gateway.ts)
   * called it BEFORE running the actual risky callback — so if that
   * callback threw (the provider call failed, the deployment errored,
   * whatever the approved action actually was), the approval record
   * already, PERMANENTLY claimed `EXECUTED` even though the real work
   * never succeeded. That evidence is now simply FALSE — "no claim
   * without evidence" (bölüm 303) cuts both ways: a record must not claim
   * success that never happened, any more than it may omit a real one.
   * Fixed with a three-step lifecycle, split across three methods:
   *
   * 1. `beginExecution(id)` — APPROVED -> EXECUTING. This is the SAME
   *    atomic, single-synchronous-tick CLAIM the old `execute()` provided
   *    (still the one moment that blocks a concurrent replay: a second
   *    caller presenting the same `approvalId` while the first is
   *    in-flight sees status `EXECUTING`, not `APPROVED`, so
   *    `CapabilityGateway`'s `isBoundToExactAction()` match fails and it
   *    throws `ApprovalEvidenceMismatchError` instead of ALSO proceeding —
   *    identical replay protection, just no longer conflated with "the
   *    work already succeeded").
   * 2. `completeExecution(id)` — EXECUTING -> EXECUTED. Called ONLY after
   *    the real work genuinely completes successfully.
   * 3. `failExecution(id, reason?)` — EXECUTING -> EXECUTION_FAILED
   *    (terminal for this id, an explicit, honest failure record, never
   *    reusable to try again under the SAME id). Called from the caller's
   *    catch block.
   *
   * Valid retry semantics: `EXECUTION_FAILED` is terminal, exactly the
   * same way `EXECUTED`/`REJECTED`/`REQUEST_CHANGES` already are in this
   * state machine — consistent with this codebase's established
   * philosophy that approval/decision/technology-lifecycle ids are
   * permanent and never resurrected once they reach a terminal state
   * (`DuplicateApprovalIdError`, decision-ledger's no-un-superseding,
   * technology-registry's no-un-forbidding). A genuine retry after a
   * failure means requesting a brand-new approval (`requestFor()` with a
   * fresh id) and obtaining a fresh reviewer decision — never resuming a
   * half-failed one under its original id, which would reopen exactly the
   * kind of ambiguous "is this still valid?" state this fix exists to
   * close.
   */
  beginExecution(id: string): ApprovalRequest {
    const req = this.#mustGet(id);
    if (req.status !== "APPROVED") {
      throw new ApprovalRequiredError(
        `Action ${id} cannot begin execution: status is ${req.status}, requires APPROVED`
      );
    }
    req.status = "EXECUTING";
    this.audit("APPROVAL_EXECUTION_STARTED", req);
    return freezeRecord(req);
  }

  /** EXECUTING -> EXECUTED. Call ONLY after the real work this approval authorized has genuinely succeeded. */
  completeExecution(id: string): ApprovalRequest {
    const req = this.#mustGet(id);
    if (req.status !== "EXECUTING") {
      throw new ApprovalRequiredError(
        `Action ${id} cannot complete execution: status is ${req.status}, requires EXECUTING`
      );
    }
    req.status = "EXECUTED";
    this.audit("APPROVAL_EXECUTED", req);
    return freezeRecord(req);
  }

  /** EXECUTING -> EXECUTION_FAILED (terminal for this id — bkz. üstteki fix notu, "valid retry semantics"). */
  failExecution(id: string, reason?: string): ApprovalRequest {
    const req = this.#mustGet(id);
    if (req.status !== "EXECUTING") {
      throw new ApprovalRequiredError(
        `Action ${id} cannot fail execution: status is ${req.status}, requires EXECUTING`
      );
    }
    req.status = "EXECUTION_FAILED";
    req.failureReason = reason;
    this.audit("APPROVAL_EXECUTION_FAILED", req);
    return freezeRecord(req);
  }

  /**
   * Convenience wrapper preserving the ORIGINAL one-shot `execute()`
   * contract (APPROVED -> EXECUTED, throwing `ApprovalRequiredError` for
   * any other status) for callers that perform no risky, failure-prone
   * work of their own between claiming and finishing — e.g. tests
   * asserting the underlying state-machine gating itself. Any REAL,
   * failure-prone execution (the actual production path,
   * `CapabilityGateway.authorize()`) MUST use `beginExecution()` /
   * `completeExecution()` / `failExecution()` directly, wrapped around the
   * real work, so a thrown error is captured as `EXECUTION_FAILED` rather
   * than being reported as this convenience method's own uncaught
   * exception while secretly having already claimed `EXECUTED`.
   */
  execute(id: string): ApprovalRequest {
    this.beginExecution(id);
    return this.completeExecution(id);
  }

  get(id: string): ApprovalRequest | undefined {
    const req = this.#requests.get(id);
    return req ? freezeRecord(req) : undefined;
  }

  list(): readonly ApprovalRequest[] {
    return [...this.#requests.values()].map((r) => freezeRecord(r));
  }

  /**
   * P1 fix (28th independent review round, finding 1, "hide mutable
   * approval lookup helpers at runtime"): this used to be declared with
   * TypeScript's compile-time-only `private` keyword — an ordinary,
   * enumerable instance method in the emitted JS. It returns the ACTUAL
   * mutable record stored in `#requests` (deliberately, for internal use —
   * `approve()`/`reject()`/`requestChanges()`/`beginExecution()`/
   * `completeExecution()`/`failExecution()` all mutate that exact object
   * to perform their state transition), never a frozen copy. Because
   * `private` is not real runtime privacy, `(workflow as
   * any).mustGet(id).status = "APPROVED"` from ANY caller holding a
   * `ApprovalWorkflow` reference could reach this method directly and
   * mutate a PENDING request straight to APPROVED (or any other status)
   * with NO reviewer-identity check and NO audit-log entry — completely
   * bypassing every public method's guarantees. Converted to a genuine
   * ECMAScript private method (`#mustGet`) — `as any`, bracket access, and
   * every reflection API fail to reach it, and code outside this class
   * body attempting `x.#mustGet(...)` is a `SyntaxError` at PARSE time.
   */
  #mustGet(id: string): MutableApprovalRequest {
    const req = this.#requests.get(id);
    if (!req) throw new Error(`No approval request found for id ${id}`);
    return req;
  }

  private audit(type: string, req: MutableApprovalRequest): void {
    this.#auditLog?.append({
      type,
      actor: req.decidedBy ?? "approval-workflow",
      payload: {
        id: req.id,
        actionDescription: req.actionDescription,
        risk: req.risk,
        actionType: req.actionType,
        costUsd: req.costUsd,
        projectId: req.projectId,
        actorId: req.actorId,
        identityDigest: req.identityDigest,
        status: req.status,
        decidedBy: req.decidedBy,
        evidenceRef: req.evidenceRef,
        changeRequestReason: req.changeRequestReason,
        failureReason: req.failureReason
      },
      timestamp: new Date().toISOString()
    });
  }
}

function assertValidApprover(decidedBy: string): void {
  // P2 fix (23rd independent review round, "reject blank founder
  // confirmation identities"): now backed by the SAME shared
  // `isNonBlankIdentity()` validator used by assumption-register.ts's
  // accept() and its persisted-state restore path — a single source of
  // truth for "is this a genuine, non-blank identity", not two
  // independently-maintained trim checks.
  if (!isNonBlankIdentity(decidedBy)) {
    throw new InvalidApprovalDecisionError(
      "An approval/rejection requires a non-empty approver identity (decidedBy) — " +
        "baseline section 145, Approval Evidence Package."
    );
  }
}
