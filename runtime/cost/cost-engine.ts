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

  record(entry: Omit<CostEntry, "timestamp">): CostEntry {
    const full: CostEntry = { ...entry, timestamp: new Date().toISOString() };
    this.entries.push(full);
    return full;
  }

  all(): readonly CostEntry[] {
    return this.entries;
  }

  /** Belirli bir kapsam (görev/ajan/proje) için toplam maliyeti hesaplar. */
  totalFor(scope: CostScope): number {
    return this.entries
      .filter(
        (e) =>
          (scope.taskId === undefined || e.taskId === scope.taskId) &&
          (scope.agentId === undefined || e.agentId === scope.agentId) &&
          (scope.projectId === undefined || e.projectId === scope.projectId)
      )
      .reduce((sum, e) => sum + e.amountUsd, 0);
  }

  total(): number {
    return this.entries.reduce((sum, e) => sum + e.amountUsd, 0);
  }
}
