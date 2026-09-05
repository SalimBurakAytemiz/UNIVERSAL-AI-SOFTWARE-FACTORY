// Baseline section 47 (Assumption Register): geliştirme sırasında yapılan
// varsayımları izler. Kritik kural: "High-impact assumptions require
// Founder confirmation" — bu modül bunu, kodda atlanamayacak bir kural
// olarak uygular (yüksek etkili bir varsayım, açık bir `confirmedBy`
// olmadan ACCEPTED durumuna geçemez).

import type { StateStore } from "../state/file-store.js";
import { freezeRecord } from "../util/immutable.js";

export type AssumptionImpact = "LOW" | "MEDIUM" | "HIGH";
export type AssumptionStatus = "PROPOSED" | "ACCEPTED" | "REJECTED" | "VALIDATED" | "SUPERSEDED";

interface MutableAssumption {
  id: string;
  description: string;
  reason: string;
  impact: AssumptionImpact;
  source: string;
  status: AssumptionStatus;
  createdAt: string;
  confirmedAt?: string;
  confirmedBy?: string;
}

/** Dışa döndürülen her varsayım bunun donmuş, ayrık bir kopyasıdır. */
export type Assumption = Readonly<MutableAssumption>;

export class AssumptionNotFoundError extends Error {
  constructor(id: string) {
    super(`No assumption found with id '${id}'`);
    this.name = "AssumptionNotFoundError";
  }
}

export class FounderConfirmationRequiredError extends Error {
  constructor(id: string) {
    super(
      `Assumption '${id}' has HIGH impact and cannot move to ACCEPTED without an explicit ` +
        `Founder confirmation (confirmedBy). See baseline section 47.`
    );
    this.name = "FounderConfirmationRequiredError";
  }
}

/**
 * P2 fix (7th independent review round targeted audit, same class as
 * "duplicate approval IDs replace authoritative history" — approval.ts):
 * propose() eskiden `this.assumptions.set(input.id, assumption)` çağrısını
 * KOŞULSUZ yapıyordu. Bir çağıran, HALİHAZIRDA Kurucu tarafından onaylanmış
 * (ACCEPTED, `confirmedBy` dolu) HIGH-impact bir varsayım için AYNI id ile
 * tekrar propose() çağırarak, onu sessizce taze bir PROPOSED kayıtla
 * DEĞİŞTİREBİLİR ve ardından `confirmedBy` OLMADAN kabul edilebilir bir
 * duruma sokabilirdi — bölüm 47'nin "High-impact assumptions require
 * Founder confirmation" değişmezini tamamen ATLATAN bir yol. Artık aynı id
 * ile ikinci bir propose() çağrısı, mevcut kaydın durumu ne olursa olsun,
 * mutasyondan ÖNCE reddedilir (fail closed) — approval.ts'teki
 * DuplicateApprovalIdError ile AYNI desen.
 */
export class DuplicateAssumptionIdError extends Error {
  constructor(id: string) {
    super(
      `Assumption id '${id}' already exists. Assumption ids are permanent, unique authoritative ` +
        `identifiers and can never be reused or silently overwritten, regardless of the existing ` +
        `record's current status — propose a new, distinct id for a new assumption.`
    );
    this.name = "DuplicateAssumptionIdError";
  }
}

export interface ProposeAssumptionInput {
  readonly id: string;
  readonly description: string;
  readonly reason: string;
  readonly impact: AssumptionImpact;
  readonly source: string;
}

/**
 * P1 cross-cutting fix: `status`/`confirmedBy` alanları eskiden mutable
 * idi ve get()/allWithStatus() iç nesnenin kendisini döndürüyordu — bir
 * çağıran, HIGH etkili bir varsayımı `confirmedBy` OLMADAN
 * `assumption.status = "ACCEPTED"` yaparak, accept()'in Founder onayı
 * kontrolünü tamamen atlayabilirdi. Artık her okuma donmuş, ayrık bir
 * kopya döndürür; durum geçişleri YALNIZCA accept()/reject()/validate()
 * üzerinden gerçekleşir.
 */
export class AssumptionRegister {
  private readonly assumptions = new Map<string, MutableAssumption>();

  propose(input: ProposeAssumptionInput): Assumption {
    if (this.assumptions.has(input.id)) {
      throw new DuplicateAssumptionIdError(input.id);
    }
    const assumption: MutableAssumption = { ...input, status: "PROPOSED", createdAt: new Date().toISOString() };
    this.assumptions.set(input.id, assumption);
    return freezeRecord(assumption);
  }

  get(id: string): Assumption | undefined {
    const assumption = this.assumptions.get(id);
    return assumption ? freezeRecord(assumption) : undefined;
  }

  /**
   * HIGH etkili bir varsayımı kabul etmek için `confirmedBy` (Kurucunun
   * kimliği) zorunludur; aksi halde reddedilir. LOW/MEDIUM etkili
   * varsayımlar bir mühendis tarafından da kabul edilebilir (bölüm 313,
   * "safe, reversible implementation details").
   */
  accept(id: string, confirmedBy?: string): Assumption {
    const assumption = this.mustGet(id);
    if (assumption.impact === "HIGH" && !confirmedBy) {
      throw new FounderConfirmationRequiredError(id);
    }
    assumption.status = "ACCEPTED";
    assumption.confirmedAt = new Date().toISOString();
    assumption.confirmedBy = confirmedBy;
    return freezeRecord(assumption);
  }

  reject(id: string): Assumption {
    const assumption = this.mustGet(id);
    assumption.status = "REJECTED";
    return freezeRecord(assumption);
  }

  validate(id: string): Assumption {
    const assumption = this.mustGet(id);
    assumption.status = "VALIDATED";
    assumption.confirmedAt = new Date().toISOString();
    return freezeRecord(assumption);
  }

  allWithStatus(status: AssumptionStatus): readonly Assumption[] {
    return [...this.assumptions.values()].filter((a) => a.status === status).map((a) => freezeRecord(a));
  }

  private mustGet(id: string): MutableAssumption {
    const assumption = this.assumptions.get(id);
    if (!assumption) throw new AssumptionNotFoundError(id);
    return assumption;
  }

  /** Sadece bellekte tutmak yerine bir StateStore'a yazar (bölüm 275, 277). */
  saveTo(store: StateStore, path: string): void {
    store.write(path, [...this.assumptions.values()]);
  }

  /** Daha önce saveTo() ile kaydedilmiş bir varsayım kaydını geri yükler. */
  static loadFrom(store: StateStore, path: string): AssumptionRegister {
    const register = new AssumptionRegister();
    const records = store.read<MutableAssumption[]>(path) ?? [];
    for (const record of records) {
      register.assumptions.set(record.id, record);
    }
    return register;
  }
}
