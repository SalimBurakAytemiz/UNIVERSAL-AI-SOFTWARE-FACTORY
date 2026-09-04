// Baseline section 242: audit history should be append-only and tamper-evident.
// Bu modül, Factory içindeki kritik kararları (politika, onay, maliyet) geriye
// dönük değiştirilemeyecek şekilde (append-only) kaydeder. Basit bir hash
// zinciri kullanılır: her kayıt bir önceki kaydın hash'ini içerir, böylece
// aradan bir kayıt silinip/değiştirilirse zincir bozulur ve tespit edilebilir.

import { createHash } from "node:crypto";

export interface AuditEvent {
  readonly type: string;
  readonly actor: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly timestamp: string;
}

export interface AuditRecord extends AuditEvent {
  readonly sequence: number;
  readonly previousHash: string;
  readonly hash: string;
}

function hashOf(record: Omit<AuditRecord, "hash">): string {
  const canonical = JSON.stringify(record);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Append-only, hash-chained audit log. In-memory for the P0 kernel;
 * a durable backend (baseline section 275, State Store) is future work.
 * Genesis previousHash is a fixed constant so tampering with record #0
 * is also detectable.
 */
export class AuditLog {
  private readonly records: AuditRecord[] = [];
  private static readonly GENESIS_HASH = "0".repeat(64);

  append(event: AuditEvent): AuditRecord {
    const previousHash = this.records.length > 0
      ? this.records[this.records.length - 1]!.hash
      : AuditLog.GENESIS_HASH;

    const base = {
      ...event,
      sequence: this.records.length,
      previousHash
    };
    const record: AuditRecord = { ...base, hash: hashOf(base) };
    this.records.push(record);
    return record;
  }

  all(): readonly AuditRecord[] {
    return this.records;
  }

  /**
   * Zincirin bozulup bozulmadığını doğrular (tamper detection, bölüm 242).
   * Her kaydın hash'i yeniden hesaplanır ve önceki kayda referansı kontrol edilir.
   */
  verifyIntegrity(): boolean {
    let expectedPrevious = AuditLog.GENESIS_HASH;
    for (const record of this.records) {
      if (record.previousHash !== expectedPrevious) return false;
      const { hash, ...rest } = record;
      if (hashOf(rest) !== hash) return false;
      expectedPrevious = hash;
    }
    return true;
  }
}
