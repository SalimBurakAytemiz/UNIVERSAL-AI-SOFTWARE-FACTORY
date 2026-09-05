// Baseline section 46 (Founder Decision Ledger): Kurucunun verdiği önemli
// kararları kalıcı olarak izler. Amaç, "zaten onaylanmış bir kararı tekrar
// tekrar sormamak" ve bir karar değiştiğinde geçmişi SİLMEK yerine
// SUPERSEDED olarak işaretleyip yeni kararla ilişkilendirmektir — böylece
// "neden değişti?" sorusu her zaman cevaplanabilir kalır (bölüm 255,
// Decision Explainability).

import type { StateStore } from "../state/file-store.js";
import { freezeRecord } from "../util/immutable.js";

export type FounderDecisionStatus = "ACTIVE" | "SUPERSEDED";

interface MutableFounderDecision {
  decisionId: string;
  project: string;
  decision: string;
  source: string;
  status: FounderDecisionStatus;
  createdAt: string;
  supersededBy?: string;
}

/** Dışa döndürülen her karar bunun donmuş, ayrık bir kopyasıdır. */
export type FounderDecision = Readonly<MutableFounderDecision>;

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

export class DecisionAlreadySupersededError extends Error {
  constructor(decisionId: string, currentStatus: FounderDecisionStatus, supersededBy: string | undefined) {
    super(
      `Cannot supersede decision '${decisionId}': its current status is ${currentStatus}` +
        (supersededBy ? ` (already superseded by '${supersededBy}')` : "") +
        `. A decision may only be superseded once, from ACTIVE. Evolve the CURRENT active ` +
        `replacement instead (A -> B -> C), never re-replace A directly (A -> B and A -> C).`
    );
    this.name = "DecisionAlreadySupersededError";
  }
}

export class FounderDecisionLedger {
  private readonly decisions = new Map<string, MutableFounderDecision>();

  /**
   * P1 cross-cutting fix: eskiden bu (ve get()/allFor()) İÇ nesnenin
   * kendisini döndürüyordu — `ledger.get(id).status = "SUPERSEDED"` gibi bir
   * çağıran, `supersede()`'i hiç çağırmadan "asla silme, sadece SUPERSEDED
   * yap" değişmezini atlatabilirdi. Artık her okuma, donmuş bir kopya
   * döndürür; durum geçişleri YALNIZCA supersede() üzerinden, iç yetkili
   * nesne üzerinde gerçekleşir.
   */
  record(decisionId: string, project: string, decision: string, source: string): FounderDecision {
    if (this.decisions.has(decisionId)) {
      throw new DuplicateDecisionError(decisionId);
    }
    const record: MutableFounderDecision = {
      decisionId,
      project,
      decision,
      source,
      status: "ACTIVE",
      createdAt: new Date().toISOString()
    };
    this.decisions.set(decisionId, record);
    return freezeRecord(record);
  }

  get(decisionId: string): FounderDecision | undefined {
    const record = this.decisions.get(decisionId);
    return record ? freezeRecord(record) : undefined;
  }

  /**
   * Eski kararı SUPERSEDED yapar (asla silmez) ve yeni kararı kaydeder.
   * Bu, "changed decisions trigger impact analysis" gereksinimi için geçmiş
   * karar zincirinin her zaman izlenebilir kalmasını sağlar.
   *
   * P1 fix (5th independent review round, "repeated supersession corrupts
   * decision history"): eskiden bu, `oldDecisionId`'nin GEÇERLİ durumunu
   * hiç kontrol etmiyordu — `A -> B` çağrısından sonra tekrar `A -> C`
   * çağrılırsa, `record()` YENİ bir C kaydı (status: ACTIVE) oluşturuyor
   * ve `old.supersededBy`'yi B'den C'ye SESSİZCE ÜZERİNE YAZIYORDU; B
   * kaydı ise hâlâ ACTIVE kalıyordu (hiç dokunulmamıştı) — sonuçta hem B
   * hem C "A'nın aktif yerine geçeni" iddiasında bulunan, ikisi de ACTIVE
   * durumda iki kayıt oluşuyordu. Bu, "hangi karar şu an yürürlükte?"
   * sorusunun asla iki farklı cevabı olamayacağı değişmezini bozar. Artık:
   * `oldDecisionId`'nin durumu ACTIVE DEĞİLSE (zaten SUPERSEDED ise),
   * HİÇBİR mutasyon yapılmadan (yeni kayıt oluşturulmadan ÖNCE)
   * DecisionAlreadySupersededError ile fail-closed olunur. Bir kararın
   * evrimi yalnızca `A -> B -> C` şeklinde (B'yi supersede ederek) mümkündür
   * — `A -> B` ve `A -> C` (dallanma) şeklinde DEĞİL; bu şema, dallanmayı
   * açıkça TANIMLAMADIĞI sürece asla sessizce buna izin vermez.
   */
  supersede(oldDecisionId: string, newDecisionId: string, decision: string, source: string): FounderDecision {
    const old = this.decisions.get(oldDecisionId);
    if (!old) throw new DecisionNotFoundError(oldDecisionId);
    if (old.status !== "ACTIVE") {
      throw new DecisionAlreadySupersededError(oldDecisionId, old.status, old.supersededBy);
    }

    const replacement = this.record(newDecisionId, old.project, decision, source);
    old.status = "SUPERSEDED";
    old.supersededBy = newDecisionId;
    return replacement;
  }

  allFor(project: string): readonly FounderDecision[] {
    return [...this.decisions.values()].filter((d) => d.project === project).map((d) => freezeRecord(d));
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
    const records = store.read<MutableFounderDecision[]>(path) ?? [];
    for (const record of records) {
      ledger.decisions.set(record.decisionId, record);
    }
    return ledger;
  }
}
