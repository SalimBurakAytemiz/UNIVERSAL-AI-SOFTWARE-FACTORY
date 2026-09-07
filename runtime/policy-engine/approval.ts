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
export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "REQUEST_CHANGES" | "EXECUTED";

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

  constructor(private readonly auditLog?: AuditLog) {}

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
   * Onay kaydı — hem onaylayan kimliği (approver identity) hem de isteğe
   * bağlı bir kanıt/denetim referansı (evidenceRef) taşır (bölüm 145,
   * "Approval Evidence Package"). Boş bir onaylayan kimliği asla kabul
   * edilmez: bu, "kim onayladı?" sorusunun her zaman cevaplanabilir
   * kalmasını sağlayan minimum kanıt gereğidir.
   */
  approve(id: string, decidedBy: string, evidenceRef?: string): ApprovalRequest {
    assertValidApprover(decidedBy);
    const req = this.mustGet(id);
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
    const req = this.mustGet(id);
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
    const req = this.mustGet(id);
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
   * Yürütmeye izin verir — yalnızca İÇ yetkili kaydın durumu APPROVED ise.
   * Çağıranın elinde tuttuğu (ve artık asla mutasyona uğratılamayan) bir
   * kopya değil, HER ZAMAN bu sınıfın kendi Map'indeki gerçek durum
   * kontrol edilir; aksi halde ApprovalRequiredError fırlatır. Hiçbir kod
   * yolu bunu atlayamaz.
   */
  execute(id: string): ApprovalRequest {
    const req = this.mustGet(id);
    if (req.status !== "APPROVED") {
      throw new ApprovalRequiredError(
        `Action ${id} cannot execute: status is ${req.status}, requires APPROVED`
      );
    }
    req.status = "EXECUTED";
    this.audit("APPROVAL_EXECUTED", req);
    return freezeRecord(req);
  }

  get(id: string): ApprovalRequest | undefined {
    const req = this.#requests.get(id);
    return req ? freezeRecord(req) : undefined;
  }

  list(): readonly ApprovalRequest[] {
    return [...this.#requests.values()].map((r) => freezeRecord(r));
  }

  private mustGet(id: string): MutableApprovalRequest {
    const req = this.#requests.get(id);
    if (!req) throw new Error(`No approval request found for id ${id}`);
    return req;
  }

  private audit(type: string, req: MutableApprovalRequest): void {
    this.auditLog?.append({
      type,
      actor: req.decidedBy ?? "approval-workflow",
      payload: {
        id: req.id,
        actionDescription: req.actionDescription,
        risk: req.risk,
        status: req.status,
        decidedBy: req.decidedBy,
        evidenceRef: req.evidenceRef,
        changeRequestReason: req.changeRequestReason
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
