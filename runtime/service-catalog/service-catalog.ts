// Baseline section 97 (Integration Catalog) + 126 (Service Catalog / CMDB)
// + 127 (Service Ownership): servis ve entegrasyonların minimum ortak
// kaydı. "Her üretim servisinin bir sahibi olmalıdır" kuralı (bölüm 127)
// burada `findUnowned()` ile denetlenebilir bir sorguya dönüşür.

import { freezeRecord } from "../util/immutable.js";
import { isNonBlankIdentity } from "../util/identity.js";

export type ServiceKind = "service" | "integration";
export type ServiceHealth = "HEALTHY" | "DEGRADED" | "DOWN" | "UNKNOWN";

interface MutableServiceRecord {
  id: string;
  name: string;
  kind: ServiceKind;
  purpose: string;
  owner?: string;
  provider?: string;
  status: ServiceHealth;
}

/** Dışa döndürülen her kayıt bunun donmuş, ayrık bir kopyasıdır. */
export type ServiceRecord = Readonly<MutableServiceRecord>;

export class DuplicateServiceError extends Error {
  constructor(id: string) {
    super(`Service/integration id '${id}' is already registered`);
    this.name = "DuplicateServiceError";
  }
}

export class ServiceNotFoundError extends Error {
  constructor(id: string) {
    super(`No service/integration found with id '${id}'`);
    this.name = "ServiceNotFoundError";
  }
}

/**
 * P1 cross-cutting fix: `status` alanı eskiden mutable idi ve `all()`/
 * `get()`/`findByStatus()` iç Map'teki gerçek nesneyi döndürüyordu — bir
 * çağıran `catalog.all()[0].status = "DOWN"` ile updateStatus()'u hiç
 * çağırmadan durumu değiştirebilirdi. Artık: (1) register() çağıranın
 * geçtiği nesneyi DEĞİL, bağımsız bir İÇ kopyasını saklar (çağıranın
 * elinde tuttuğu orijinal referansı sonradan mutasyona uğratması da iç
 * durumu etkilemez), (2) her okuma API'si donmuş, ayrık bir kopya
 * döndürür.
 */
export class ServiceCatalog {
  /**
   * P1 targeted-audit fix (28th independent review round, root-class B
   * sweep, "TypeScript private used for authoritative mutable state" —
   * same class already fixed in models/registry.ts, workers/registry.ts,
   * technology-registry/registry.ts, artifact-registry.ts, and
   * assumption-register.ts): still declared with TypeScript's compile-time
   * -only `private` — `(catalog as any).services` reaches an ordinary,
   * enumerable instance property in the compiled JS, letting a caller
   * inject a fabricated record (bypassing `register()`'s duplicate-id
   * check) or flip a service's `status`/`owner` in place, bypassing
   * `updateStatus()` and baseline section 127's ownership-audit query
   * (`findUnowned()`). Fixed the same way every other P0 registry already
   * is.
   */
  #services = new Map<string, MutableServiceRecord>();

  /**
   * P1 fix (28th independent review round, root-class A sweep,
   * "validate-then-reread" — same class as finding 12's registry fixes):
   * `record.id` used to be read from the caller's own object at THREE
   * separate points — the `.has()` duplicate check, the `.set()` Map key,
   * and the `{ ...record }` spread's own property enumeration. A getter/
   * Proxy-backed `record` could answer a non-colliding id for the
   * duplicate check and a DIFFERENT (colliding) id afterward, corrupting
   * the store the same way finding 12 described. Fixed: `record` is
   * spread into `snapshot` FIRST, reading every property exactly once; the
   * duplicate check and the stored copy both derive from this SAME
   * snapshot.
   */
  register(record: ServiceRecord): void {
    const snapshot: ServiceRecord = { ...record };
    if (this.#services.has(snapshot.id)) throw new DuplicateServiceError(snapshot.id);
    this.#services.set(snapshot.id, { ...snapshot });
  }

  get(id: string): ServiceRecord | undefined {
    const record = this.#services.get(id);
    return record ? freezeRecord(record) : undefined;
  }

  all(): readonly ServiceRecord[] {
    return [...this.#services.values()].map((s) => freezeRecord(s));
  }

  findByStatus(status: ServiceHealth): readonly ServiceRecord[] {
    return this.all().filter((s) => s.status === status);
  }

  /**
   * Sahibi olmayan (owner alanı boş VEYA yalnızca boşluk karakterlerinden
   * oluşan) kayıtları döndürür — bölüm 127 denetimi.
   *
   * P2 fix (32nd independent review round, finding 9, "whitespace-only
   * service owners are unowned"): eskiden `!s.owner` kullanılıyordu — bir
   * JS string için `!` yalnızca BOŞ string (`""`) için `true` döner;
   * `owner: "   "` (yalnızca boşluk) GERÇEK bir DEĞER olarak TRUTHY'dir, bu
   * yüzden `!s.owner` bunu YANLIŞLIKLA "sahiplenilmiş" sayardı — anlamlı
   * hiçbir kimlik taşımayan bir servis, bölüm 127'nin "her üretim
   * servisinin GERÇEK bir sahibi olmalıdır" denetiminden görünmez şekilde
   * kaçardı. Fixed: bu dosyanın kendi kaydettiği bir alan icat etmek yerine,
   * `runtime/util/identity.ts`'nin ZATEN var olan, tek-kaynak
   * `isNonBlankIdentity()` doğrulayıcısı yeniden kullanılır (23rd
   * independent review round'un "reject blank founder confirmation
   * identities" fix'i — approval.ts/assumption-register.ts'in ZATEN
   * kullandığı AYNI "anlamlı kimlik" tanımı) — `owner` alanı SESSİZCE
   * trim'lenip GEÇERLİ bir sahiplik olarak normalize EDİLMEZ (bu, anlamsız
   * bir kimliği geçerliymiş gibi göstermek olurdu); yalnızca DENETİM
   * SORGUSU (`findUnowned()`), boşluk-yalnızca bir `owner`'ı DOĞRU şekilde
   * "eksik" olarak sınıflandırır.
   */
  findUnowned(): readonly ServiceRecord[] {
    return this.all().filter((s) => !isNonBlankIdentity(s.owner));
  }

  updateStatus(id: string, status: ServiceHealth): ServiceRecord {
    const record = this.#services.get(id);
    if (!record) throw new ServiceNotFoundError(id);
    record.status = status;
    return freezeRecord(record);
  }
}
