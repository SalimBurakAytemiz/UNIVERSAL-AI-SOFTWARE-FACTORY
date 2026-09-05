// Baseline section 46 (Founder Decision Ledger): Kurucunun verdiği önemli
// kararları kalıcı olarak izler. Amaç, "zaten onaylanmış bir kararı tekrar
// tekrar sormamak" ve bir karar değiştiğinde geçmişi SİLMEK yerine
// SUPERSEDED olarak işaretleyip yeni kararla ilişkilendirmektir — böylece
// "neden değişti?" sorusu her zaman cevaplanabilir kalır (bölüm 255,
// Decision Explainability).

import type { StateStore } from "../state/file-store.js";

export type FounderDecisionStatus = "ACTIVE" | "SUPERSEDED";

export interface FounderDecision {
  readonly decisionId: string;
  readonly project: string;
  readonly decision: string;
  readonly source: string;
  status: FounderDecisionStatus;
  readonly createdAt: string;
  supersededBy?: string;
}

export class DuplicateDecisionError extends Error {
  constructor(decisionId: string) {
    super(`Decision id '${decisionId}' already exists. Use supersede() to record a change, never overwrite history.`);
    this.name = "DuplicateDecisionError";
  }
}

export class DecisionNotFoundError extends Error {
  constructor(decisionId: string) {
    super(`No decision found with id '${decisionId}'`);
    this.name = "DecisionNotFoundError";
  }
}

export class FounderDecisionLedger {
  private readonly decisions = new Map<string, FounderDecision>();

  record(decisionId: string, project: string, decision: string, source: string): FounderDecision {
    if (this.decisions.has(decisionId)) {
      throw new DuplicateDecisionError(decisionId);
    }
    const record: FounderDecision = {
      decisionId,
      project,
      decision,
      source,
      status: "ACTIVE",
      createdAt: new Date().toISOString()
    };
    this.decisions.set(decisionId, record);
    return record;
  }

  get(decisionId: string): FounderDecision | undefined {
    return this.decisions.get(decisionId);
  }

  /**
   * Eski kararı SUPERSEDED yapar (asla silmez) ve yeni kararı kaydeder.
   * Bu, "changed decisions trigger impact analysis" gereksinimi için geçmiş
   * karar zincirinin her zaman izlenebilir kalmasını sağlar.
   */
  supersede(oldDecisionId: string, newDecisionId: string, decision: string, source: string): FounderDecision {
    const old = this.decisions.get(oldDecisionId);
    if (!old) throw new DecisionNotFoundError(oldDecisionId);

    const replacement = this.record(newDecisionId, old.project, decision, source);
    old.status = "SUPERSEDED";
    old.supersededBy = newDecisionId;
    return replacement;
  }

  allFor(project: string): readonly FounderDecision[] {
    return [...this.decisions.values()].filter((d) => d.project === project);
  }

  /** Halihazırda ACTIVE bir karar var mı? — aynı soruyu tekrar tekrar sormamak için (bölüm 46). */
  hasActiveDecision(decisionId: string): boolean {
    return this.decisions.get(decisionId)?.status === "ACTIVE";
  }

  /**
   * Sadece bellekte tutmak yerine bir StateStore'a yazar (bölüm 275, 277)
   * — süreç yeniden başlasa bile karar geçmişi kaybolmaz.
   */
  saveTo(store: StateStore, path: string): void {
    store.write(path, [...this.decisions.values()]);
  }

  /** Daha önce saveTo() ile kaydedilmiş bir karar defterini geri yükler. */
  static loadFrom(store: StateStore, path: string): FounderDecisionLedger {
    const ledger = new FounderDecisionLedger();
    const records = store.read<FounderDecision[]>(path) ?? [];
    for (const record of records) {
      ledger.decisions.set(record.decisionId, record);
    }
    return ledger;
  }
}
