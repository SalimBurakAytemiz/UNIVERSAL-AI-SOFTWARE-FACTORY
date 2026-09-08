// Baseline section 47 (Assumption Register): geliştirme sırasında yapılan
// varsayımları izler. Kritik kural: "High-impact assumptions require
// Founder confirmation" — bu modül bunu, kodda atlanamayacak bir kural
// olarak uygular (yüksek etkili bir varsayım, açık bir `confirmedBy`
// olmadan ACCEPTED durumuna geçemez).

import type { StateStore } from "../state/file-store.js";
import { freezeRecord } from "../util/immutable.js";
import { isNonBlankIdentity } from "../util/identity.js";

export type AssumptionImpact = "LOW" | "MEDIUM" | "HIGH";
export type AssumptionStatus = "PROPOSED" | "ACCEPTED" | "REJECTED" | "VALIDATED" | "SUPERSEDED";

interface MutableAssumption {
  id: string;
  description: string;
  reason: string;
  impact: AssumptionImpact;
  source: string;
  status: AssumptionStatus;
  createdAt: string;
  confirmedAt?: string;
  confirmedBy?: string;
}

/** Dışa döndürülen her varsayım bunun donmuş, ayrık bir kopyasıdır. */
export type Assumption = Readonly<MutableAssumption>;

export class AssumptionNotFoundError extends Error {
  constructor(id: string) {
    super(`No assumption found with id '${id}'`);
    this.name = "AssumptionNotFoundError";
  }
}

export class FounderConfirmationRequiredError extends Error {
  constructor(id: string) {
    super(
      `Assumption '${id}' has HIGH impact and cannot move to ACCEPTED without an explicit ` +
        `Founder confirmation (confirmedBy). See baseline section 47.`
    );
    this.name = "FounderConfirmationRequiredError";
  }
}

/**
 * P2 fix (7th independent review round targeted audit, same class as
 * "duplicate approval IDs replace authoritative history" — approval.ts):
 * propose() eskiden `this.assumptions.set(input.id, assumption)` çağrısını
 * KOŞULSUZ yapıyordu. Bir çağıran, HALİHAZIRDA Kurucu tarafından onaylanmış
 * (ACCEPTED, `confirmedBy` dolu) HIGH-impact bir varsayım için AYNI id ile
 * tekrar propose() çağırarak, onu sessizce taze bir PROPOSED kayıtla
 * DEĞİŞTİREBİLİR ve ardından `confirmedBy` OLMADAN kabul edilebilir bir
 * duruma sokabilirdi — bölüm 47'nin "High-impact assumptions require
 * Founder confirmation" değişmezini tamamen ATLATAN bir yol. Artık aynı id
 * ile ikinci bir propose() çağrısı, mevcut kaydın durumu ne olursa olsun,
 * mutasyondan ÖNCE reddedilir (fail closed) — approval.ts'teki
 * DuplicateApprovalIdError ile AYNI desen.
 */
/**
 * P1 fix (23rd independent review round, "validate persisted assumptions
 * before restoring authoritative state"): Codex reproduced that
 * `loadFrom()` (below) inserted every persisted record DIRECTLY into
 * `this.assumptions` with NO validation whatsoever — a corrupt or
 * hand-edited persisted record such as `{ impact: "HIGH", status:
 * "ACCEPTED", confirmedBy: missing }` was restored straight into
 * authoritative runtime state, completely bypassing the SAME
 * Founder-confirmation invariant that `accept()` enforces for every
 * record created through the live API. Persisted state that never went
 * through `propose()`/`accept()`/`reject()`/`validate()` must still
 * satisfy the exact same domain invariants those methods enforce — a
 * restart must never be a laundering path for state that could never
 * have been created live. See `describeInvalidPersistedAssumption()`
 * below (used by `loadFrom()`) for the actual check.
 */
export class CorruptPersistedAssumptionError extends Error {
  constructor(index: number, reason: string) {
    super(
      `Persisted assumption record at index ${index} is corrupt or violates a domain invariant ` +
        `(${reason}) and cannot be restored into authoritative state. Persisted state must satisfy the ` +
        `same invariants as state created through the live propose()/accept()/reject()/validate() API — ` +
        `see baseline section 47. Refusing to load rather than silently repairing or dropping the record.`
    );
    this.name = "CorruptPersistedAssumptionError";
  }
}

const VALID_ASSUMPTION_IMPACTS: readonly AssumptionImpact[] = ["LOW", "MEDIUM", "HIGH"];
const VALID_ASSUMPTION_STATUSES: readonly AssumptionStatus[] = [
  "PROPOSED",
  "ACCEPTED",
  "REJECTED",
  "VALIDATED",
  "SUPERSEDED"
];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Returns `undefined` if `value` is a structurally valid, domain-invariant-
 * respecting persisted assumption record; otherwise a short, human-readable
 * reason it was rejected. A single function (rather than a boolean
 * type-guard) so `loadFrom()` can report exactly WHY a record was refused,
 * consistent with baseline section 303's "no claim without evidence" —
 * refusing silently, with no diagnosable reason, would itself be a kind of
 * unaccountable claim ("this record is bad, trust me").
 */
function describeInvalidPersistedAssumption(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "not a plain object";
  }
  const candidate = value as Record<string, unknown>;
  if (!isNonEmptyString(candidate.id)) return "missing or invalid 'id'";
  if (typeof candidate.description !== "string") return "missing or invalid 'description'";
  if (typeof candidate.reason !== "string") return "missing or invalid 'reason'";
  if (!VALID_ASSUMPTION_IMPACTS.includes(candidate.impact as AssumptionImpact)) return "invalid 'impact'";
  if (typeof candidate.source !== "string") return "missing or invalid 'source'";
  if (!VALID_ASSUMPTION_STATUSES.includes(candidate.status as AssumptionStatus)) return "invalid 'status'";
  if (!isNonEmptyString(candidate.createdAt)) return "missing or invalid 'createdAt'";
  if (candidate.confirmedAt !== undefined && typeof candidate.confirmedAt !== "string") {
    return "invalid 'confirmedAt' (must be a string when present)";
  }
  if (candidate.confirmedBy !== undefined && typeof candidate.confirmedBy !== "string") {
    return "invalid 'confirmedBy' (must be a string when present)";
  }
  // Domain invariant, identical to accept()'s own gate: a HIGH-impact
  // ACCEPTED record must carry a genuine (non-blank) Founder confirmation
  // identity — a persisted record can never claim a state the live API
  // itself could never have produced.
  if (
    candidate.impact === "HIGH" &&
    candidate.status === "ACCEPTED" &&
    !isNonBlankIdentity(candidate.confirmedBy)
  ) {
    return "HIGH-impact ACCEPTED record is missing a valid Founder confirmation identity (confirmedBy)";
  }
  return undefined;
}

export class DuplicateAssumptionIdError extends Error {
  constructor(id: string) {
    super(
      `Assumption id '${id}' already exists. Assumption ids are permanent, unique authoritative ` +
        `identifiers and can never be reused or silently overwritten, regardless of the existing ` +
        `record's current status — propose a new, distinct id for a new assumption.`
    );
    this.name = "DuplicateAssumptionIdError";
  }
}

export interface ProposeAssumptionInput {
  readonly id: string;
  readonly description: string;
  readonly reason: string;
  readonly impact: AssumptionImpact;
  readonly source: string;
}

/**
 * P1 cross-cutting fix: `status`/`confirmedBy` alanları eskiden mutable
 * idi ve get()/allWithStatus() iç nesnenin kendisini döndürüyordu — bir
 * çağıran, HIGH etkili bir varsayımı `confirmedBy` OLMADAN
 * `assumption.status = "ACCEPTED"` yaparak, accept()'in Founder onayı
 * kontrolünü tamamen atlayabilirdi. Artık her okuma donmuş, ayrık bir
 * kopya döndürür; durum geçişleri YALNIZCA accept()/reject()/validate()
 * üzerinden gerçekleşir.
 */
export class AssumptionRegister {
  /**
   * P1 fix (25th independent review round targeted audit, same root class
   * as `audit/audit-log.ts`'s "audit records must be runtime-private and
   * append-only"): this Map used to be declared with TypeScript's `private`
   * keyword — compile-time only, so the compiled JS leaves it an ordinary,
   * enumerable instance property reachable via `(register as any).assumptions`
   * or plain bracket access, with no type-system escape hatch needed at
   * all. A consumer holding an `AssumptionRegister` reference could reach
   * in and flip a HIGH-impact assumption straight to `status: "ACCEPTED"`
   * with no `confirmedBy` at all, completely bypassing `accept()`'s Founder-
   * confirmation gate (baseline section 47's "High-impact assumptions
   * require Founder confirmation" is meaningless if the record can be
   * mutated without ever calling `accept()`). Fixed the same way
   * `audit-log.ts`'s `#records`/`policy-engine/approval.ts`'s `#requests`
   * already are: a genuine ECMAScript private class field (`#assumptions`),
   * enforced by the JS runtime itself — `as any`, bracket access,
   * `Object.getOwnPropertyNames()`, and `Reflect.ownKeys()` all fail to
   * reach it, and any code outside this class body attempting
   * `x.#assumptions` is a `SyntaxError` at PARSE time.
   */
  #assumptions = new Map<string, MutableAssumption>();

  propose(input: ProposeAssumptionInput): Assumption {
    // P1 fix (28th independent review round, finding 12, "snapshot
    // registry records before validation/storage" — same root class as
    // models/registry.ts's register()): `input.id` used to be read from
    // the caller's own object at THREE separate points — the
    // `.has()` duplicate check, the `{ ...input }` spread that builds the
    // stored record, and the `.set(input.id, ...)` Map key. A
    // getter/Proxy-backed `input` could answer a non-colliding id for the
    // duplicate check, then a DIFFERENT id for the spread/Map-key reads —
    // storing a record whose own `.id` field disagrees with the Map key
    // it is actually stored under, or silently bypassing the duplicate
    // check entirely. Fixed: `input` is spread into `snapshot` FIRST,
    // reading every property exactly once; the duplicate check, the
    // stored record, and the Map key all derive from this SAME snapshot.
    const snapshot: ProposeAssumptionInput = { ...input };
    if (this.#assumptions.has(snapshot.id)) {
      throw new DuplicateAssumptionIdError(snapshot.id);
    }
    const assumption: MutableAssumption = { ...snapshot, status: "PROPOSED", createdAt: new Date().toISOString() };
    this.#assumptions.set(snapshot.id, assumption);
    return freezeRecord(assumption);
  }

  get(id: string): Assumption | undefined {
    const assumption = this.#assumptions.get(id);
    return assumption ? freezeRecord(assumption) : undefined;
  }

  /**
   * HIGH etkili bir varsayımı kabul etmek için `confirmedBy` (Kurucunun
   * kimliği) zorunludur; aksi halde reddedilir. LOW/MEDIUM etkili
   * varsayımlar bir mühendis tarafından da kabul edilebilir (bölüm 313,
   * "safe, reversible implementation details").
   *
   * P2 fix (23rd independent review round, "reject blank founder
   * confirmation identities"): eskiden yalnızca `!confirmedBy` (bir
   * TRUTHY/falsy kontrolü) kullanılıyordu — `confirmedBy = "   "`
   * (yalnızca boşluk karakterleri) TRUTHY bir string olduğundan, bu
   * kontrolü SESSİZCE geçerdi, HIGH etkili bir varsayımı ANLAMLI hiçbir
   * kimlik OLMADAN "ACCEPTED" durumuna sokardı. Artık approval.ts'nin
   * `assertValidApprover`'ı ile AYNI, paylaşılan `isNonBlankIdentity()`
   * doğrulayıcısı kullanılır (bkz. runtime/util/identity.ts) — kırpılmış
   * (trimmed) uzunluğu sıfır olan HERHANGİ bir string (boş, tek boşluk,
   * sekme, yeni satır, bunların kombinasyonu) reddedilir.
   */
  accept(id: string, confirmedBy?: string): Assumption {
    const assumption = this.#mustGet(id);
    if (assumption.impact === "HIGH" && !isNonBlankIdentity(confirmedBy)) {
      throw new FounderConfirmationRequiredError(id);
    }
    assumption.status = "ACCEPTED";
    assumption.confirmedAt = new Date().toISOString();
    assumption.confirmedBy = confirmedBy;
    return freezeRecord(assumption);
  }

  reject(id: string): Assumption {
    const assumption = this.#mustGet(id);
    assumption.status = "REJECTED";
    return freezeRecord(assumption);
  }

  validate(id: string): Assumption {
    const assumption = this.#mustGet(id);
    assumption.status = "VALIDATED";
    assumption.confirmedAt = new Date().toISOString();
    return freezeRecord(assumption);
  }

  allWithStatus(status: AssumptionStatus): readonly Assumption[] {
    return [...this.#assumptions.values()].filter((a) => a.status === status).map((a) => freezeRecord(a));
  }

  /**
   * P1 fix (29th independent review round, finding 3, "assumption
   * authoritative lookup must be runtime-private" — same root class as
   * `policy-engine/approval.ts`'s `#mustGet()`, round 28 finding 1): this
   * used to be declared with TypeScript's `private` keyword — compile-time
   * only, so the compiled JS leaves it an ordinary, callable instance
   * method reachable via `(register as any).mustGet(id)` or plain bracket
   * access, with no type-system escape hatch needed at all. Since this
   * method returns the ACTUAL mutable `MutableAssumption` object stored in
   * `#assumptions` (never a frozen copy — `accept()`/`reject()`/`validate()`
   * rely on that to make their own in-place status transitions), any caller
   * able to reach it could flip a HIGH-impact assumption straight to
   * `status: "ACCEPTED"` with no `confirmedBy` at all, completely bypassing
   * `accept()`'s Founder-confirmation gate the SAME way `#assumptions`
   * itself already had to be converted to a genuine private field for (bkz.
   * bu sınıfın üstündeki 25th round fix notu) — a private Map is worthless
   * if a private-in-name-only method still hands out direct mutable access
   * to what it stores. Fixed the same way `approval.ts`'s `#mustGet()`
   * already is: a genuine ECMAScript private method (`#`), enforced by the
   * JS runtime itself.
   */
  #mustGet(id: string): MutableAssumption {
    const assumption = this.#assumptions.get(id);
    if (!assumption) throw new AssumptionNotFoundError(id);
    return assumption;
  }

  /** Sadece bellekte tutmak yerine bir StateStore'a yazar (bölüm 275, 277). */
  saveTo(store: StateStore, path: string): void {
    store.write(path, [...this.#assumptions.values()]);
  }

  /**
   * Daha önce saveTo() ile kaydedilmiş bir varsayım kaydını geri yükler.
   *
   * P1 fix (23rd independent review round, "validate persisted assumptions
   * before restoring authoritative state"): eskiden her kayıt HİÇBİR
   * doğrulama olmadan doğrudan `this.assumptions`'a ekleniyordu — bkz.
   * `CorruptPersistedAssumptionError`'ın üstündeki not. Artık HER kayıt,
   * eklemeden ÖNCE `describeInvalidPersistedAssumption()` ile yapısal
   * olarak VE etki-alanı (domain) değişmezleri açısından doğrulanır, ve
   * içindeki `id`'ler TEKRARLANAMAZ (aynı persist edilmiş dosya içinde iki
   * kayıt aynı id'yi taşırsa, hangisinin "yetkili" olduğu belirsizdir —
   * bu da kendi başına bozuk bir durumdur). HERHANGİ bir kayıt geçersizse,
   * TÜM yükleme reddedilir (fail closed) — bazı kayıtları sessizce
   * atlayıp diğerlerini yüklemek, kendi başına bir SESSİZ VERİ KAYBI
   * biçimi olurdu (bölüm 303, "no claim without evidence"; hangi
   * kayıtların atlandığına dair hiçbir iz bırakmadan devam etmek kabul
   * edilemez).
   */
  static loadFrom(store: StateStore, path: string): AssumptionRegister {
    const register = new AssumptionRegister();
    const records = store.read<unknown[]>(path) ?? [];
    const seenIds = new Set<string>();
    records.forEach((record, index) => {
      const failure = describeInvalidPersistedAssumption(record);
      if (failure) {
        throw new CorruptPersistedAssumptionError(index, failure);
      }
      const validated = record as MutableAssumption;
      if (seenIds.has(validated.id)) {
        throw new CorruptPersistedAssumptionError(index, `duplicate id '${validated.id}'`);
      }
      seenIds.add(validated.id);
      // P1 fix (24th independent review round, "restored assumptions must
      // be detached"): this used to store `validated` — the EXACT object
      // `store.read()` returned — directly into `this.assumptions`. Every
      // field on `MutableAssumption` is a primitive (no nested objects/
      // arrays), so a shallow copy is sufficient to fully detach it: if the
      // caller/store still holds (or later returns again, e.g. a cache) a
      // reference to that same object and mutates it — `original.status =
      // "ACCEPTED"` — authoritative registry state changed with NO
      // `accept()`/`reject()`/`validate()` call and NO invariant check at
      // all, the exact same class of bypass `freezeRecord()`-on-read
      // already protects against for objects LEAVING this class. Now the
      // register owns its own independent copy from the moment of load.
      register.#assumptions.set(validated.id, { ...validated });
    });
    return register;
  }
}
