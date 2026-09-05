// Baseline section 82 (Worker Fabric): işçi sınıflarını (linux-general,
// gpu, macos, ...) ve yeteneklerini kayıt altına alır. Kayıtlı olmak
// çalışıyor olmak anlamına gelmez (bölüm 9) — durumu IDLE olan işçiler
// zamanlayıcı tarafından seçilebilir.

import { freezeRecord } from "../util/immutable.js";
import { assertValidMonetaryAmount } from "../cost/cost-engine.js";

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

interface MutableWorkerRecord {
  id: string;
  workerClass: WorkerClass;
  capabilities: readonly string[];
  costPerMinuteUsd: number;
  status: WorkerStatus;
}

/** Dışa döndürülen her kayıt bunun donmuş, ayrık bir kopyasıdır. */
export type WorkerRecord = Readonly<MutableWorkerRecord>;

/**
 * P1 cross-cutting fix: `status`/`capabilities` eskiden all()/findCapable()
 * üzerinden İÇ nesnenin kendisi olarak sızıyordu — bir çağıran
 * `all()[0].status = "IDLE"` yaparak QUARANTINED bir işçiyi (bölüm 85,
 * worker security) tekrar aday listesine sokabilir, ya da
 * `.capabilities.push(...)` ile sahip olmadığı bir yeteneği "varmış gibi"
 * gösterip findCapable()'ı yanıltabilirdi. Artık register() çağıranın
 * geçtiği nesneyi değil bağımsız bir kopyasını saklar ve her okuma donmuş,
 * ayrık bir kopya döndürür.
 */
export class WorkerRegistry {
  private readonly workers: MutableWorkerRecord[] = [];

  register(worker: WorkerRecord): void {
    // P2 targeted-audit fix (7th independent review round, same class as
    // "invalid model prices corrupt cheapest-capable routing" — models/
    // registry.ts): `scheduler.ts` runs the IDENTICAL cheapest-of-candidates
    // reduce (`current.costPerMinuteUsd < cheapest.costPerMinuteUsd`) over
    // this registry's records. An unvalidated NaN/negative
    // `costPerMinuteUsd` corrupts that comparison exactly as an unvalidated
    // `costPerCall` corrupted model routing — the SAME centralized
    // validator is reused here, not a divergent rule.
    assertValidMonetaryAmount(worker.costPerMinuteUsd, `WorkerRegistry.register(id=${worker.id})`);
    this.workers.push({ ...worker, capabilities: [...worker.capabilities] });
  }

  all(): readonly WorkerRecord[] {
    return this.workers.map((w) => freezeRecord(w));
  }

  /**
   * QUARANTINED işçiler (bölüm 85, worker security) hiçbir zaman aday
   * listesine girmez.
   */
  findCapable(requiredCapabilities: readonly string[]): WorkerRecord[] {
    return this.workers
      .filter((w) => w.status !== "QUARANTINED" && requiredCapabilities.every((c) => w.capabilities.includes(c)))
      .map((w) => freezeRecord(w));
  }
}
