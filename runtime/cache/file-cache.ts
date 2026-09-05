// Baseline section 77 (Cache/Reuse Policy) + 275/277 (State Store / Durable
// State). `Cache` (cache.ts) yalnızca process-içi bir Map'tir: süreç yeniden
// başladığında tüm girdiler kaybolur. UASF-REQ-0036 "durable cache" der;
// bunu gerçek kılmak için FileCache, girdi haritasının tamamını her yazışta
// StateStore aracılığıyla diske yazar ve her okumada oradan yükler — böylece
// ayrı bir process/instance önceden hesaplanmış bir sonucu yeniden kullanabilir
// (Proof G'nin "restart sonrası da geçerli" kanıtı, bölüm 306).

import type { StateStore } from "../state/file-store.js";
import type { CacheEntry } from "./cache.js";

type PersistedEntries<T> = Record<string, CacheEntry<T>>;

export class FileCache<T = unknown> {
  constructor(
    private readonly stateStore: StateStore,
    private readonly path: string
  ) {}

  private loadAll(): PersistedEntries<T> {
    return this.stateStore.read<PersistedEntries<T>>(this.path) ?? {};
  }

  get(key: string): T | undefined {
    const all = this.loadAll();
    const entry = all[key];
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt < Date.now()) {
      // Süresi dolmuş girdi diskte de asla sessizce yeniden kullanılmaz.
      delete all[key];
      this.stateStore.write(this.path, all);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    const all = this.loadAll();
    all[key] = {
      value,
      computedAt: Date.now(),
      expiresAt: ttlMs !== undefined ? Date.now() + ttlMs : undefined
    };
    // Her set() çağrısında TÜM harita diske yazılır — kalıcılığın
    // yalnızca bu sürecin belleğine değil, dosyaya bağlı olması için
    // (bir sonraki process'in aynı in-memory nesneyi paylaşmasına gerek yok).
    this.stateStore.write(this.path, all);
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  size(): number {
    return Object.keys(this.loadAll()).length;
  }
}

export interface ComputeWithFileCacheResult<T> {
  readonly value: T;
  readonly cached: boolean;
}

/**
 * `computeWithCache`'in FileCache karşılığı: kalıcı önbellekte geçerli bir
 * girdi varsa yeniden hesaplamaz, yoksa hesaplar ve diske yazar.
 */
export async function computeWithFileCache<T>(
  cache: FileCache<T>,
  key: string,
  compute: () => Promise<T> | T,
  ttlMs?: number
): Promise<ComputeWithFileCacheResult<T>> {
  const existing = cache.get(key);
  if (existing !== undefined) {
    return { value: existing, cached: true };
  }
  const value = await compute();
  cache.set(key, value, ttlMs);
  return { value, cached: false };
}
