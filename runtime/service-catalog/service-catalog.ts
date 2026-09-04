// Baseline section 97 (Integration Catalog) + 126 (Service Catalog / CMDB)
// + 127 (Service Ownership): servis ve entegrasyonların minimum ortak
// kaydı. "Her üretim servisinin bir sahibi olmalıdır" kuralı (bölüm 127)
// burada `findUnowned()` ile denetlenebilir bir sorguya dönüşür.

export type ServiceKind = "service" | "integration";
export type ServiceHealth = "HEALTHY" | "DEGRADED" | "DOWN" | "UNKNOWN";

export interface ServiceRecord {
  readonly id: string;
  readonly name: string;
  readonly kind: ServiceKind;
  readonly purpose: string;
  readonly owner?: string;
  readonly provider?: string;
  status: ServiceHealth;
}

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

export class ServiceCatalog {
  private readonly services = new Map<string, ServiceRecord>();

  register(record: ServiceRecord): void {
    if (this.services.has(record.id)) throw new DuplicateServiceError(record.id);
    this.services.set(record.id, record);
  }

  get(id: string): ServiceRecord | undefined {
    return this.services.get(id);
  }

  all(): readonly ServiceRecord[] {
    return [...this.services.values()];
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
    return record;
  }
}
