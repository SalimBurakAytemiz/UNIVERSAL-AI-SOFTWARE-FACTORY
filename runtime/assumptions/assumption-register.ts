// Baseline section 47 (Assumption Register): geliştirme sırasında yapılan
// varsayımları izler. Kritik kural: "High-impact assumptions require
// Founder confirmation" — bu modül bunu, kodda atlanamayacak bir kural
// olarak uygular (yüksek etkili bir varsayım, açık bir `confirmedBy`
// olmadan ACCEPTED durumuna geçemez).

import type { StateStore } from "../state/file-store.js";

export type AssumptionImpact = "LOW" | "MEDIUM" | "HIGH";
export type AssumptionStatus = "PROPOSED" | "ACCEPTED" | "REJECTED" | "VALIDATED" | "SUPERSEDED";

export interface Assumption {
  readonly id: string;
  readonly description: string;
  readonly reason: string;
  readonly impact: AssumptionImpact;
  readonly source: string;
  status: AssumptionStatus;
  readonly createdAt: string;
  confirmedAt?: string;
  confirmedBy?: string;
}

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

export interface ProposeAssumptionInput {
  readonly id: string;
  readonly description: string;
  readonly reason: string;
  readonly impact: AssumptionImpact;
  readonly source: string;
}

export class AssumptionRegister {
  private readonly assumptions = new Map<string, Assumption>();

  propose(input: ProposeAssumptionInput): Assumption {
    const assumption: Assumption = { ...input, status: "PROPOSED", createdAt: new Date().toISOString() };
    this.assumptions.set(input.id, assumption);
    return assumption;
  }

  get(id: string): Assumption | undefined {
    return this.assumptions.get(id);
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
    return assumption;
  }

  reject(id: string): Assumption {
    const assumption = this.mustGet(id);
    assumption.status = "REJECTED";
    return assumption;
  }

  validate(id: string): Assumption {
    const assumption = this.mustGet(id);
    assumption.status = "VALIDATED";
    assumption.confirmedAt = new Date().toISOString();
    return assumption;
  }

  allWithStatus(status: AssumptionStatus): readonly Assumption[] {
    return [...this.assumptions.values()].filter((a) => a.status === status);
  }

  private mustGet(id: string): Assumption {
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
    const records = store.read<Assumption[]>(path) ?? [];
    for (const record of records) {
      register.assumptions.set(record.id, record);
    }
    return register;
  }
}
