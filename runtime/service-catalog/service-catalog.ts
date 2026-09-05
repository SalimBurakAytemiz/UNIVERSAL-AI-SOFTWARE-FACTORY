// Baseline section 97 (Integration Catalog) + 126 (Service Catalog / CMDB)
// + 127 (Service Ownership): servis ve entegrasyonların minimum ortak
// kaydı. "Her üretim servisinin bir sahibi olmalıdır" kuralı (bölüm 127)
// burada `findUnowned()` ile denetlenebilir bir sorguya dönüşür.

import { freezeRecord } from "../util/immutable.js";

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
  private readonly services = new Map<string, MutableServiceRecord>();

  register(record: ServiceRecord): void {
    if (this.services.has(record.id)) throw new DuplicateServiceError(record.id);
    this.services.set(record.id, { ...record });
  }

  get(id: string): ServiceRecord | undefined {
    const record = this.services.get(id);
    return record ? freezeRecord(record) : undefined;
  }

  all(): readonly ServiceRecord[] {
    return [...this.services.values()].map((s) => freezeRecord(s));
  }

  findByStatus(status: ServiceHealth): readonly ServiceRecord[] {
    return this.all().filter((s) => s.status === status);
  }

  /** Sahibi olmayan (owner alanı boş) kayıtları döndürür — bölüm 127 denetimi. */
  findUnowned(): readonly ServiceRecord[] {
    return this.all().filter((s) => !s.owner);
  }

  updateStatus(id: string, status: ServiceHealth): ServiceRecord {
    const record = this.services.get(id);
    if (!record) throw new ServiceNotFoundError(id);
    record.status = status;
    return freezeRecord(record);
  }
}
