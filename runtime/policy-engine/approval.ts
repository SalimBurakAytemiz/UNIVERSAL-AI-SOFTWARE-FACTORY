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

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXECUTED";

interface MutableApprovalRequest {
  id: string;
  actionDescription: string;
  risk: number;
  status: ApprovalStatus;
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  evidenceRef?: string;
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

export class ApprovalWorkflow {
  private readonly requests = new Map<string, MutableApprovalRequest>();

  constructor(private readonly auditLog?: AuditLog) {}

  request(id: string, actionDescription: string, risk: number): ApprovalRequest {
    const req: MutableApprovalRequest = {
      id,
      actionDescription,
      risk,
      status: "PENDING",
      requestedAt: new Date().toISOString()
    };
    this.requests.set(id, req);
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
    const req = this.requests.get(id);
    return req ? freezeRecord(req) : undefined;
  }

  list(): readonly ApprovalRequest[] {
    return [...this.requests.values()].map((r) => freezeRecord(r));
  }

  private mustGet(id: string): MutableApprovalRequest {
    const req = this.requests.get(id);
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
        evidenceRef: req.evidenceRef
      },
      timestamp: new Date().toISOString()
    });
  }
}

function assertValidApprover(decidedBy: string): void {
  if (typeof decidedBy !== "string" || decidedBy.trim().length === 0) {
    throw new InvalidApprovalDecisionError(
      "An approval/rejection requires a non-empty approver identity (decidedBy) — " +
        "baseline section 145, Approval Evidence Package."
    );
  }
}
