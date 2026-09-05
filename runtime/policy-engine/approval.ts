// Baseline section 145 (Approval Evidence Package) + 146 (Human Approval).
// Bu modül, APPROVAL_REQUIRED kararı alan bir eylemin, geçerli bir insan
// (Kurucu) onayı olmadan asla EXECUTED durumuna erişemeyeceğini garanti eden
// durum makinesidir (bölüm 120'deki resmi değişmez: "Risk-5 bir işlem
// EXECUTED durumuna asla geçerli bir Kurucu onayı olmadan ulaşamaz").

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXECUTED";

export interface ApprovalRequest {
  readonly id: string;
  readonly actionDescription: string;
  readonly risk: number;
  status: ApprovalStatus;
  readonly requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
}

export class ApprovalRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalRequiredError";
  }
}

export class ApprovalWorkflow {
  private readonly requests = new Map<string, ApprovalRequest>();

  request(id: string, actionDescription: string, risk: number): ApprovalRequest {
    const req: ApprovalRequest = {
      id,
      actionDescription,
      risk,
      status: "PENDING",
      requestedAt: new Date().toISOString()
    };
    this.requests.set(id, req);
    return req;
  }

  approve(id: string, decidedBy: string): ApprovalRequest {
    const req = this.mustGet(id);
    if (req.status !== "PENDING") {
      throw new Error(`Cannot approve request ${id}: status is ${req.status}, not PENDING`);
    }
    req.status = "APPROVED";
    req.decidedAt = new Date().toISOString();
    req.decidedBy = decidedBy;
    return req;
  }

  reject(id: string, decidedBy: string): ApprovalRequest {
    const req = this.mustGet(id);
    if (req.status !== "PENDING") {
      throw new Error(`Cannot reject request ${id}: status is ${req.status}, not PENDING`);
    }
    req.status = "REJECTED";
    req.decidedAt = new Date().toISOString();
    req.decidedBy = decidedBy;
    return req;
  }

  /**
   * Yürütmeye izin verir — yalnızca durum APPROVED ise. Aksi halde
   * ApprovalRequiredError fırlatır; hiçbir kod yolu bunu atlayamaz.
   */
  execute(id: string): ApprovalRequest {
    const req = this.mustGet(id);
    if (req.status !== "APPROVED") {
      throw new ApprovalRequiredError(
        `Action ${id} cannot execute: status is ${req.status}, requires APPROVED`
      );
    }
    req.status = "EXECUTED";
    return req;
  }

  get(id: string): ApprovalRequest | undefined {
    return this.requests.get(id);
  }

  private mustGet(id: string): ApprovalRequest {
    const req = this.requests.get(id);
    if (!req) throw new Error(`No approval request found for id ${id}`);
    return req;
  }
}
