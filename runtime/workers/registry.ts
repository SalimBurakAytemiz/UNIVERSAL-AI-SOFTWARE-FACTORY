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
 * P2 fix (9th independent review round, "duplicate worker identities break
 * authoritative status"): register() eskiden bir `id` çakışmasını hiç
 * kontrol etmiyordu — aynı `id` ile İKİNCİ bir register() çağrısı, ilk
 * kaydı SİLMEDEN dizinin sonuna YENİ bir kayıt daha ekliyordu. Codex,
 * worker X'in önce IDLE, sonra AYNI id ile QUARANTINED olarak kaydedildiği
 * bir senaryo gösterdi: findCapable() yalnızca QUARANTINED kaydı filtreler,
 * ama BAYAT (stale) IDLE kaydı dizide KALIR ve ResourceAwareScheduler
 * bunu hâlâ seçebilir — "bir worker id TEK bir yetkili kimliği temsil
 * eder" ilkesini (bölüm 82/85) ihlal eder. Fixed: register() artık aynı
 * id ile ikinci bir kayda İZİN VERMEZ (fail closed); mevcut bir worker'ın
 * durumunu değiştirmek için AÇIK bir updateStatus() metodu kullanılmalıdır
 * — bu, YETKİLİ kaydı YERİNDE (in place) değiştirir, asla ikinci bir kayıt
 * OLUŞTURMAZ, dolayısıyla bayat bir ikinci kayıt hiçbir zaman var olamaz.
 */
export class DuplicateWorkerIdError extends Error {
  constructor(id: string) {
    super(
      `Worker id '${id}' already exists. A worker id is a permanent, unique authoritative ` +
        `identity — register() never creates a second record for an existing id; use ` +
        `updateStatus() to transition an existing worker's status.`
    );
    this.name = "DuplicateWorkerIdError";
  }
}

export class WorkerNotFoundError extends Error {
  constructor(id: string) {
    super(`No worker registered with id '${id}'.`);
    this.name = "WorkerNotFoundError";
  }
}

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
  /**
   * P1 fix (25th independent review round targeted audit, same root class
   * as `audit/audit-log.ts`'s "audit records must be runtime-private and
   * append-only"): this array used to be declared with TypeScript's
   * `private` keyword — compile-time only, so the compiled JS leaves it an
   * ordinary, enumerable instance property reachable via
   * `(registry as any).workers` or plain bracket access, with no
   * type-system escape hatch needed at all. A consumer holding a
   * `WorkerRegistry` reference could push a fabricated record directly
   * (bypassing `register()`'s duplicate-id and monetary-amount validation
   * entirely) or flip a QUARANTINED worker's `status` back to IDLE in
   * place (bypassing `updateStatus()` and baseline section 85's worker-
   * quarantine invariant). Fixed the same way `audit-log.ts`'s `#records`
   * already is: a genuine ECMAScript private class field (`#workers`),
   * enforced by the JS runtime itself — `as any`, bracket access,
   * `Object.getOwnPropertyNames()`, and `Reflect.ownKeys()` all fail to
   * reach it, and any code outside this class body attempting `x.#workers`
   * is a `SyntaxError` at PARSE time.
   */
  #workers: MutableWorkerRecord[] = [];

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
    // P2 fix (9th independent review round, "duplicate worker identities
    // break authoritative status"): reject an id collision BEFORE any
    // mutation — see DuplicateWorkerIdError above.
    if (this.#workers.some((w) => w.id === worker.id)) {
      throw new DuplicateWorkerIdError(worker.id);
    }
    this.#workers.push({ ...worker, capabilities: [...worker.capabilities] });
  }

  all(): readonly WorkerRecord[] {
    return this.#workers.map((w) => freezeRecord(w));
  }

  /**
   * QUARANTINED işçiler (bölüm 85, worker security) hiçbir zaman aday
   * listesine girmez.
   */
  findCapable(requiredCapabilities: readonly string[]): WorkerRecord[] {
    return this.#workers
      .filter((w) => w.status !== "QUARANTINED" && requiredCapabilities.every((c) => w.capabilities.includes(c)))
      .map((w) => freezeRecord(w));
  }

  /**
   * Var olan bir worker'ın durumunu değiştirmenin TEK yolu — register()'ı
   * TEKRAR çağırmak DEĞİL. YETKİLİ kaydı YERİNDE (in place) günceller,
   * asla ikinci bir kayıt oluşturmaz; bu yüzden bayat/çakışan bir kayıt
   * hiçbir zaman ortaya çıkamaz (bkz. DuplicateWorkerIdError yukarıda).
   */
  updateStatus(id: string, status: WorkerStatus): WorkerRecord {
    const worker = this.#workers.find((w) => w.id === id);
    if (!worker) {
      throw new WorkerNotFoundError(id);
    }
    worker.status = status;
    return freezeRecord(worker);
  }
}
