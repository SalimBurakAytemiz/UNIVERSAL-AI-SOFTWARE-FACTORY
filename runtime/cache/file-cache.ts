// Baseline section 77 (Cache/Reuse Policy) + 275/277 (State Store / Durable
// State). `Cache` (cache.ts) yalnızca process-içi bir Map'tir: süreç yeniden
// başladığında tüm girdiler kaybolur. UASF-REQ-0036 "durable cache" der;
// bunu gerçek kılmak için FileCache, girdi haritasının tamamını her yazışta
// StateStore aracılığıyla diske yazar ve her okumada oradan yükler — böylece
// ayrı bir process/instance önceden hesaplanmış bir sonucu yeniden kullanabilir
// (Proof G'nin "restart sonrası da geçerli" kanıtı, bölüm 306).

import type { StateStore } from "../state/file-store.js";
import type { CacheEntry } from "./cache.js";

/**
 * P2 fix (6th independent review round, "durable cache loses __proto__
 * keys"): eskiden bu, kalıcı hale (disk) `Record<string, CacheEntry<T>>`
 * — yani düz bir JavaScript nesnesi — olarak yazılıyor ve `all[key] = ...`
 * / `all[key]` şeklinde ERİŞİLİYORDU. Cache API'si RASTGELE string
 * anahtarları kabul ettiğinden, `key = "__proto__"` verildiğinde bu asla
 * sıradan bir "own property" OLUŞTURMAZ — `Object.prototype.__proto__`
 * bir accessor (getter/setter) olduğundan, `all["__proto__"] = entry`
 * yazması nesnenin PROTOTİPİNİ değiştirmeye ÇALIŞIR (prototype pollution
 * riski) ve kaydı asla gerçek bir "own" alan olarak SAKLAMAZ — bu yüzden
 * `get("__proto__")` her zaman `undefined` dönerdi ve kalıcı gösterim
 * sessizce `{}` olarak kalırdı. Artık kalıcı gösterim bir DİZİ
 * (`[key, entry]` çiftlerinden oluşan) ve bellek-içi yapı bir `Map`'tir —
 * ikisi de anahtar adının HİÇBİR ÖZEL anlamı olmadığı, salt veri
 * yapılarıdır; `"__proto__"`, `"constructor"`, `"prototype"` dahil HER
 * string, sıradan bir anahtar olarak davranır (Map.set/get, nesne
 * özelliği erişimi/ataması KULLANMAZ, dolayısıyla prototip zincirine asla
 * dokunmaz).
 */
type PersistedEntry<T> = readonly [key: string, entry: CacheEntry<T>];
type PersistedEntries<T> = readonly PersistedEntry<T>[];

export class FileCache<T = unknown> {
  constructor(
    private readonly stateStore: StateStore,
    private readonly path: string
  ) {}

  private loadAll(): Map<string, CacheEntry<T>> {
    const persisted = this.stateStore.read<PersistedEntries<T>>(this.path) ?? [];
    return new Map(persisted);
  }

  private saveAll(all: Map<string, CacheEntry<T>>): void {
    // Her set() çağrısında TÜM harita diske yazılır — kalıcılığın
    // yalnızca bu sürecin belleğine değil, dosyaya bağlı olması için
    // (bir sonraki process'in aynı in-memory nesneyi paylaşmasına gerek yok).
    this.stateStore.write(this.path, [...all.entries()]);
  }

  get(key: string): T | undefined {
    const all = this.loadAll();
    const entry = all.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt < Date.now()) {
      // Süresi dolmuş girdi diskte de asla sessizce yeniden kullanılmaz.
      all.delete(key);
      this.saveAll(all);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    const all = this.loadAll();
    all.set(key, {
      value,
      computedAt: Date.now(),
      expiresAt: ttlMs !== undefined ? Date.now() + ttlMs : undefined
    });
    this.saveAll(all);
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  size(): number {
    return this.loadAll().size;
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
