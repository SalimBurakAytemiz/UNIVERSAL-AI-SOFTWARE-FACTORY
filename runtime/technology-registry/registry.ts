// Baseline section 53-54 (Technology Registry): dil/çatı/motor/veritabanı
// gibi teknolojilerin yaşam döngüsünü izler. FORBIDDEN veya DEPRECATED
// olarak işaretlenen bir teknoloji, hiçbir öneri motoru tarafından
// otomatik olarak seçilemez — bu kural burada, veriye bakan tek bir
// fonksiyonda uygulanır (recommendable()).

import { freezeRecord } from "../util/immutable.js";
import { isNonBlankIdentity } from "../util/identity.js";
import type { AuditLog } from "../audit/audit-log.js";

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
export class DuplicateTechnologyIdError extends Error {
  constructor(id: string) {
    super(
      `Technology id '${id}' already exists. register() never overwrites an existing record — ` +
        `use transitionLifecycle() to change an existing technology's lifecycle.`
    );
    this.name = "DuplicateTechnologyIdError";
  }
}

export class TechnologyNotFoundError extends Error {
  constructor(id: string) {
    super(`No technology registered with id '${id}'.`);
    this.name = "TechnologyNotFoundError";
  }
}

/**
 * P1 fix (24th independent review round, "technology registry must reject
 * uncontrolled overwrites"): `DEPRECATED`/`FORBIDDEN` are governance
 * states (bölüm 53-54) — once a technology carries one of them, this
 * registry never lets a transition walk it back OUT to a recommendable
 * lifecycle. Reversing a genuine ban is significant enough that it must
 * never happen as a routine lifecycle transition (or, worse, as a silent
 * `register()` overwrite — see `DuplicateTechnologyIdError` above); it
 * requires registering a genuinely new, distinct technology id instead.
 */
export class InvalidTechnologyLifecycleTransitionError extends Error {
  constructor(id: string, from: TechnologyLifecycle, to: TechnologyLifecycle) {
    super(
      `Cannot transition technology '${id}' from '${from}' to '${to}': '${from}' is a governance-restricted ` +
        `lifecycle (DEPRECATED/FORBIDDEN) and can never be silently reversed back to a recommendable lifecycle ` +
        `(baseline section 53-54). Register a new, distinct technology id if a genuinely different offering ` +
        `should be recommended instead.`
    );
    this.name = "InvalidTechnologyLifecycleTransitionError";
  }
}

export class MissingTechnologyTransitionReasonError extends Error {
  constructor(id: string) {
    super(
      `transitionLifecycle('${id}') requires a non-empty 'reason' explaining WHY the lifecycle is changing — ` +
        `this is the audit evidence for a governance-affecting decision (baseline section 303, "no claim ` +
        `without evidence").`
    );
    this.name = "MissingTechnologyTransitionReasonError";
  }
}

export class TechnologyRegistry {
  private readonly technologies = new Map<string, TechnologyRecord>();

  constructor(private readonly auditLog?: AuditLog) {}

  /**
   * Yeni bir teknoloji kaydeder — YALNIZCA yeni bir id için. Aynı id ile
   * ikinci bir register() çağrısı, hedef lifecycle ne olursa olsun
   * (FORBIDDEN bir teknolojiyi PREFERRED bir kayıtla SESSİZCE değiştirmek
   * dahil) reddedilir; mevcut bir kaydın lifecycle'ını değiştirmenin TEK
   * yolu transitionLifecycle()'dır.
   */
  register(technology: TechnologyRecord): void {
    if (this.technologies.has(technology.id)) {
      throw new DuplicateTechnologyIdError(technology.id);
    }
    this.technologies.set(technology.id, freezeRecord({ ...technology }));
  }

  /**
   * Var olan bir teknolojinin lifecycle'ını değiştirmenin TEK yolu —
   * register()'ı TEKRAR çağırmak DEĞİL. FORBIDDEN/DEPRECATED'ten
   * recommendable bir lifecycle'a geri dönüş REDDEDİLİR (bkz.
   * `InvalidTechnologyLifecycleTransitionError`'ın üstündeki not); her
   * geçiş, varsa AuditLog'a kaydedilir.
   */
  transitionLifecycle(id: string, to: TechnologyLifecycle, reason: string): TechnologyRecord {
    const current = this.technologies.get(id);
    if (!current) {
      throw new TechnologyNotFoundError(id);
    }
    if (!isNonBlankIdentity(reason)) {
      throw new MissingTechnologyTransitionReasonError(id);
    }
    if (NON_RECOMMENDABLE_LIFECYCLES.includes(current.lifecycle) && !NON_RECOMMENDABLE_LIFECYCLES.includes(to)) {
      throw new InvalidTechnologyLifecycleTransitionError(id, current.lifecycle, to);
    }

    const updated = freezeRecord({ ...current, lifecycle: to });
    this.technologies.set(id, updated);
    this.auditLog?.append({
      type: "TECHNOLOGY_LIFECYCLE_TRANSITIONED",
      actor: "technology-registry",
      payload: { id, from: current.lifecycle, to, reason },
      timestamp: new Date().toISOString()
    });
    return updated;
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
