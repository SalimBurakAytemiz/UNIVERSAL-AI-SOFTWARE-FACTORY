// Baseline section 83 (Resource-Aware Scheduler): "SMALLEST SUFFICIENT
// WORKER" ilkesi. GPU/yüksek-bellek kaynaklar israf edilmez (bölüm 83) —
// zamanlayıcı, gerekli yetenekleri karşılayan, BOŞTA (IDLE) işçiler
// arasından dakika başına en ucuz olanı seçer. Bir GPU işçisi CPU
// yeteneklerini de sağlıyor olsa bile, daha ucuz bir CPU-only işçi
// yeterliyse GPU işçisi seçilmez (Proof H, bölüm 306).

import type { WorkerRecord, WorkerRegistry } from "./../workers/registry.js";

export interface TaskWorkerRequirement {
  readonly taskId: string;
  readonly requiredCapabilities: readonly string[];
}

export class NoSufficientWorkerError extends Error {
  constructor(requirement: TaskWorkerRequirement) {
    super(
      `No IDLE worker satisfies capabilities [${requirement.requiredCapabilities.join(", ")}] ` +
        `for task ${requirement.taskId}`
    );
    this.name = "NoSufficientWorkerError";
  }
}

export class ResourceAwareScheduler {
  constructor(private readonly registry: WorkerRegistry) {}

  selectWorker(requirement: TaskWorkerRequirement): WorkerRecord {
    const candidates = this.registry
      .findCapable(requirement.requiredCapabilities)
      .filter((w) => w.status === "IDLE");

    if (candidates.length === 0) {
      throw new NoSufficientWorkerError(requirement);
    }

    return candidates.reduce((cheapest, current) =>
      current.costPerMinuteUsd < cheapest.costPerMinuteUsd ? current : cheapest
    );
  }
}
