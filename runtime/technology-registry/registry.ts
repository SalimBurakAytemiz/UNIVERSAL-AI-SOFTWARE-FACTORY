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
  /**
   * P1 targeted-audit fix (26th independent review round, same root class
   * as finding 2, "cost ledger state must be runtime-private"): this Map
   * used to be declared with TypeScript's compile-time-only `private` —
   * the compiled JS leaves it an ordinary, enumerable instance property
   * reachable via `(registry as any).technologies` or plain bracket
   * access. Since `transitionLifecycle()`'s ENTIRE purpose (bölüm 53-54) is
   * refusing to walk a DEPRECATED/FORBIDDEN technology back out to a
   * recommendable lifecycle, a consumer with such access could bypass that
   * governance rule completely — `(registry as any).technologies.set(id, {
   * ...forbiddenRecord, lifecycle: "PREFERRED" })` un-bans a technology
   * with no `InvalidTechnologyLifecycleTransitionError`, no `reason`, and
   * no audit trail. A genuine ECMAScript private field (`#technologies`)
   * closes this the same way `audit-log.ts`'s `#records` and
   * `cost-engine.ts`'s `#entries`/`#reservations` already do: `as any`,
   * bracket access, and every reflection API fail to reach it.
   */
  #technologies = new Map<string, TechnologyRecord>();

  /**
   * P1 fix (28th independent review round, root-class B sweep, "TypeScript
   * private used for authoritative mutable state" — same class as this
   * round's finding 6 [cost-engine.ts's clock] and finding 1's audit-log
   * follow-up [approval.ts]): this was still a TS-compile-time-only
   * `private readonly` constructor-parameter property. Replacing it via
   * `(registry as any).auditLog = { append: () => {} }` would silently
   * suppress every future audit event this registry records. Converted to
   * a genuine ECMAScript `#auditLog` private field.
   */
  #auditLog?: AuditLog;

  constructor(auditLog?: AuditLog) {
    this.#auditLog = auditLog;
  }

  /**
   * Yeni bir teknoloji kaydeder — YALNIZCA yeni bir id için. Aynı id ile
   * ikinci bir register() çağrısı, hedef lifecycle ne olursa olsun
   * (FORBIDDEN bir teknolojiyi PREFERRED bir kayıtla SESSİZCE değiştirmek
   * dahil) reddedilir; mevcut bir kaydın lifecycle'ını değiştirmenin TEK
   * yolu transitionLifecycle()'dır.
   *
   * P1 fix (28th independent review round, finding 12, "snapshot registry
   * records before validation/storage" — same root class as models/
   * registry.ts's register()): `technology.id` used to be read from the
   * caller's own object at THREE separate points — the `.has()` duplicate
   * check, the `{ ...technology }` spread, and the `.set(technology.id,
   * ...)` Map key. A getter/Proxy-backed `technology` could answer a
   * non-colliding id for the duplicate check and a DIFFERENT one for the
   * actual storage. Fixed: `technology` is spread into `snapshot` FIRST,
   * reading every property exactly once; the duplicate check and the Map
   * key both derive from this SAME snapshot.
   */
  register(technology: TechnologyRecord): void {
    const snapshot: TechnologyRecord = { ...technology };
    if (this.#technologies.has(snapshot.id)) {
      throw new DuplicateTechnologyIdError(snapshot.id);
    }
    this.#technologies.set(snapshot.id, freezeRecord(snapshot));
  }

  /**
   * Var olan bir teknolojinin lifecycle'ını değiştirmenin TEK yolu —
   * register()'ı TEKRAR çağırmak DEĞİL. FORBIDDEN/DEPRECATED'ten
   * recommendable bir lifecycle'a geri dönüş REDDEDİLİR (bkz.
   * `InvalidTechnologyLifecycleTransitionError`'ın üstündeki not); her
   * geçiş, varsa AuditLog'a kaydedilir.
   */
  transitionLifecycle(id: string, to: TechnologyLifecycle, reason: string): TechnologyRecord {
    const current = this.#technologies.get(id);
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
    // P1 fix (30th independent review round targeted audit, same root
    // class as finding 6, "provider replacement must rollback if audit
    // fails"): this used to call `this.#technologies.set(id, updated)`
    // FIRST and append to the audit log only afterward — if an audit log
    // WAS configured and its `append()` threw (a broken/misconfigured
    // sink), the lifecycle transition had already taken effect with no
    // corresponding audit trail, and the thrown error gave the caller no
    // indication the mutation nonetheless succeeded. Fixed: when an audit
    // log is configured, the append happens FIRST — if it throws, this
    // method never reaches `this.#technologies.set()`, so the map is
    // never observably updated and a caller who catches the audit error
    // sees the state genuinely unchanged. (No audit log configured is a
    // different, deliberately-accepted case — see the constructor's own
    // fix note — and the transition still applies normally, since no
    // audit trail was ever promised in that mode.)
    this.#auditLog?.append({
      type: "TECHNOLOGY_LIFECYCLE_TRANSITIONED",
      actor: "technology-registry",
      payload: { id, from: current.lifecycle, to, reason },
      timestamp: new Date().toISOString()
    });
    this.#technologies.set(id, updated);
    return updated;
  }

  all(): readonly TechnologyRecord[] {
    return [...this.#technologies.values()].map((t) => freezeRecord(t));
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
