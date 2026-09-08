// Baseline section 83 (Resource-Aware Scheduler): "SMALLEST SUFFICIENT
// WORKER" ilkesi. GPU/yüksek-bellek kaynaklar israf edilmez (bölüm 83) —
// zamanlayıcı, gerekli yetenekleri karşılayan, BOŞTA (IDLE) işçiler
// arasından dakika başına en ucuz olanı seçer. Bir GPU işçisi CPU
// yeteneklerini de sağlıyor olsa bile, daha ucuz bir CPU-only işçi
// yeterliyse GPU işçisi seçilmez (Proof H, bölüm 306).

import type { WorkerClass, WorkerRecord, WorkerRegistry } from "./../workers/registry.js";

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

/**
 * P1 fix (24th independent review round, "worker sufficiency must rank
 * before price"): the old selection rule was a single, flat "cheapest of
 * the capable/IDLE candidates" reduce — cost was the ONLY dimension ever
 * compared. That ranks correctly by ACCIDENT whenever the smaller worker
 * also happens to be the cheaper one (the case every prior test/proof
 * here used), but is not what baseline section 83 actually requires:
 * "SMALLEST SUFFICIENT WORKER... do not waste GPU/high-memory resources"
 * is a statement about RESOURCE CLASS, independent of price. A
 * mispriced/promotional GPU worker that happens to be CHEAPER per minute
 * than a sufficient CPU-only worker would, under the old rule, still be
 * selected for a CPU-only task — exactly the waste section 83 forbids.
 * This weight table encodes "how much excess resource capacity does this
 * worker class represent" (lower = leaner/smaller) so that resource-class
 * sufficiency is compared FIRST, before cost is ever consulted; cost only
 * breaks ties AMONG workers that are equally lean. `edge`/`linux-container`/
 * `android` are the leanest, general-purpose desktop/server classes are a
 * middle tier, and `windows-game`/`high-memory`/`gpu` are the
 * explicitly-called-out "do not waste" classes, ordered by how much
 * excess capacity they typically carry.
 */
const WORKER_CLASS_EXCESS_WEIGHT: Readonly<Record<WorkerClass, number>> = {
  edge: 0,
  "linux-container": 1,
  android: 1,
  "linux-general": 2,
  "windows-general": 2,
  macos: 2,
  "windows-game": 3,
  "high-memory": 4,
  gpu: 5
};

export class ResourceAwareScheduler {
  /**
   * P1 targeted-audit fix (28th independent review round, root-class B
   * sweep, "TypeScript private used for authoritative mutable state" —
   * same class as `models/router.ts`'s `#registry`): still declared with
   * TypeScript's compile-time-only `private` — `(scheduler as any).registry
   * = attackerControlledRegistry` from any caller holding a
   * `ResourceAwareScheduler` reference would silently substitute the
   * ENTIRE authoritative worker pool `selectWorker()` consults, bypassing
   * `WorkerRegistry`'s own duplicate-id/price-validation guarantees and the
   * "smallest sufficient worker" invariant (bölüm 83) itself. Fixed the
   * same way `models/router.ts`'s equivalent field already is.
   */
  #registry: WorkerRegistry;

  constructor(registry: WorkerRegistry) {
    this.#registry = registry;
  }

  /**
   * Sıralama (bölüm 83, "SMALLEST SUFFICIENT WORKER"), her adım BİR
   * ÖNCEKİNİ yalnızca eşitlik durumunda geçer:
   *   1. yetenek/kaynak yeterliliği (requiredCapabilities filtresi, aşağıda)
   *   2. fazla-kaynak minimizasyonu (WORKER_CLASS_EXCESS_WEIGHT karşılaştırması)
   *   3. müsaitlik (yalnızca IDLE, aşağıdaki filtre)
   *   4. maliyet (yalnızca 2. adımda eşitlik varsa devreye girer)
   * Bir GPU işçisi, gereken yetenekleri sağlasa VE daha ucuz olsa bile,
   * yeterli daha küçük bir işçi varken ASLA seçilmez — fiyat artık ikinci
   * sırada bile değil, yalnızca fazla-kaynak sınıfı EŞİT olduğunda bir
   * ayırt edici (tie-breaker).
   */
  selectWorker(requirement: TaskWorkerRequirement): WorkerRecord {
    const candidates = this.#registry
      .findCapable(requirement.requiredCapabilities)
      .filter((w) => w.status === "IDLE");

    if (candidates.length === 0) {
      throw new NoSufficientWorkerError(requirement);
    }

    return candidates.reduce((best, current) => (isSmallerOrCheaperSufficientWorker(current, best) ? current : best));
  }
}

function isSmallerOrCheaperSufficientWorker(current: WorkerRecord, best: WorkerRecord): boolean {
  const currentWeight = WORKER_CLASS_EXCESS_WEIGHT[current.workerClass];
  const bestWeight = WORKER_CLASS_EXCESS_WEIGHT[best.workerClass];
  if (currentWeight !== bestWeight) {
    return currentWeight < bestWeight;
  }
  return current.costPerMinuteUsd < best.costPerMinuteUsd;
}
