// Baseline section 53-54 (Technology Registry): dil/çatı/motor/veritabanı
// gibi teknolojilerin yaşam döngüsünü izler. FORBIDDEN veya DEPRECATED
// olarak işaretlenen bir teknoloji, hiçbir öneri motoru tarafından
// otomatik olarak seçilemez — bu kural burada, veriye bakan tek bir
// fonksiyonda uygulanır (recommendable()).

import { freezeRecord } from "../util/immutable.js";

export type TechnologyLifecycle =
  | "EXPERIMENTAL"
  | "APPROVED"
  | "PREFERRED"
  | "SUPPORTED"
  | "DEPRECATED"
  | "FORBIDDEN";

export type TechnologyCategory =
  | "language"
  | "framework"
  | "engine"
  | "database"
  | "platform"
  | "cloud"
  | "testing"
  | "security"
  | "distribution";

export interface TechnologyRecord {
  readonly id: string;
  readonly category: TechnologyCategory;
  readonly lifecycle: TechnologyLifecycle;
  readonly notes?: string;
}

const NON_RECOMMENDABLE_LIFECYCLES: readonly TechnologyLifecycle[] = ["DEPRECATED", "FORBIDDEN"];

/**
 * P1 fix (4th independent review round, targeted follow-up ownership
 * audit): register() eskiden çağıranın nesne referansını saklıyor, all()
 * ise iç Map değerlerini doğrudan döndürüyordu — bir çağıran, register()'a
 * verdiği (veya all()'dan aldığı) bir kaydı sonradan `lifecycle: "FORBIDDEN"
 * -> "APPROVED"` şeklinde mutasyona uğratarak recommendable()'ın "FORBIDDEN/
 * DEPRECATED asla önerilmez" kuralını (bölüm 53-54) atlatabilirdi. Artık
 * register() bağımsız bir kopya saklar; all() donmuş, ayrık kopyalar
 * döndürür.
 */
export class TechnologyRegistry {
  private readonly technologies = new Map<string, TechnologyRecord>();

  register(technology: TechnologyRecord): void {
    this.technologies.set(technology.id, freezeRecord({ ...technology }));
  }

  all(): readonly TechnologyRecord[] {
    return [...this.technologies.values()].map((t) => freezeRecord(t));
  }

  findByCategory(category: TechnologyCategory): TechnologyRecord[] {
    return this.all().filter((t) => t.category === category);
  }

  /** FORBIDDEN/DEPRECATED teknolojiler asla önerilebilir listeye girmez. */
  recommendable(category?: TechnologyCategory): TechnologyRecord[] {
    return this.all().filter(
      (t) => !NON_RECOMMENDABLE_LIFECYCLES.includes(t.lifecycle) && (category === undefined || t.category === category)
    );
  }
}
