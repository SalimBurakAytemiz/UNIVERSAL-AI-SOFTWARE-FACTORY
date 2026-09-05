// Baseline section 69 (Cost Engine): her görev/ajan/model/sağlayıcı
// çağrısının maliyeti izlenir. "Sessiz harcama yok" ilkesi (bölüm 147)
// burada başlar — bir tutar bu motora kaydedilmeden harcanmış sayılmaz.

export interface CostEntry {
  readonly taskId: string;
  readonly agentId?: string;
  readonly projectId?: string;
  readonly provider: string;
  readonly modelId: string;
  readonly amountUsd: number;
  readonly timestamp: string;
}

export interface CostScope {
  readonly taskId?: string;
  readonly agentId?: string;
  readonly projectId?: string;
}

export class CostEngine {
  private readonly entries: CostEntry[] = [];

  /**
   * `now` enjekte edilebilir bir saat fonksiyonudur — varsayılan olarak
   * gerçek zamanı kullanır, ancak testler (özellikle günlük/aylık bütçe
   * sıfırlanma senaryoları) belirli bir ana "sabitlenmiş" kayıtlar
   * üretebilmek için bunu değiştirebilir (bkz. runtime/budget/budget.ts).
   */
  constructor(private readonly now: () => Date = () => new Date()) {}

  record(entry: Omit<CostEntry, "timestamp">): CostEntry {
    const full: CostEntry = { ...entry, timestamp: this.now().toISOString() };
    this.entries.push(full);
    return full;
  }

  all(): readonly CostEntry[] {
    return this.entries;
  }

  /** Belirli bir kapsam (görev/ajan/proje) için toplam maliyeti hesaplar. */
  totalFor(scope: CostScope): number {
    return this.entries.filter((e) => matchesScope(e, scope)).reduce((sum, e) => sum + e.amountUsd, 0);
  }

  total(): number {
    return this.entries.reduce((sum, e) => sum + e.amountUsd, 0);
  }

  /**
   * Belirli bir kapsam VE zaman penceresi (sinceIso'dan itibaren) için
   * toplam maliyeti hesaplar. Günlük/aylık bütçe tavanlarının (bölüm 70-72)
   * gerçekten "dönemsel" olabilmesi için gereken temel sorgu budur — ISO
   * 8601 zaman damgaları sözlüksel (string) karşılaştırmayla doğru sırada
   * olduğundan basit bir string karşılaştırması yeterlidir.
   */
  totalInWindow(scope: CostScope, sinceIso: string): number {
    return this.entries
      .filter((e) => matchesScope(e, scope) && e.timestamp >= sinceIso)
      .reduce((sum, e) => sum + e.amountUsd, 0);
  }
}

function matchesScope(entry: CostEntry, scope: CostScope): boolean {
  return (
    (scope.taskId === undefined || entry.taskId === scope.taskId) &&
    (scope.agentId === undefined || entry.agentId === scope.agentId) &&
    (scope.projectId === undefined || entry.projectId === scope.projectId)
  );
}
