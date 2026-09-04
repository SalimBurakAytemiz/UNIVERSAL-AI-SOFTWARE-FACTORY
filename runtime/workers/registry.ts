// Baseline section 82 (Worker Fabric): işçi sınıflarını (linux-general,
// gpu, macos, ...) ve yeteneklerini kayıt altına alır. Kayıtlı olmak
// çalışıyor olmak anlamına gelmez (bölüm 9) — durumu IDLE olan işçiler
// zamanlayıcı tarafından seçilebilir.

export type WorkerClass =
  | "linux-general"
  | "linux-container"
  | "windows-general"
  | "windows-game"
  | "macos"
  | "android"
  | "gpu"
  | "high-memory"
  | "edge";

export type WorkerStatus = "IDLE" | "BUSY" | "SUSPENDED" | "QUARANTINED";

export interface WorkerRecord {
  readonly id: string;
  readonly workerClass: WorkerClass;
  readonly capabilities: readonly string[];
  readonly costPerMinuteUsd: number;
  status: WorkerStatus;
}

export class WorkerRegistry {
  private readonly workers: WorkerRecord[] = [];

  register(worker: WorkerRecord): void {
    this.workers.push(worker);
  }

  all(): readonly WorkerRecord[] {
    return this.workers;
  }

  /**
   * QUARANTINED işçiler (bölüm 85, worker security) hiçbir zaman aday
   * listesine girmez.
   */
  findCapable(requiredCapabilities: readonly string[]): WorkerRecord[] {
    return this.workers.filter(
      (w) => w.status !== "QUARANTINED" && requiredCapabilities.every((c) => w.capabilities.includes(c))
    );
  }
}
