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
  /**
   * P2 fix (31st independent review round, finding 6, "implement the
   * SUPERSEDED assumption transition"): set ONLY by `supersede()` (bkz.
   * aşağısı) to the id of the assumption that replaces this one — the
   * authoritative replacement relationship a SUPERSEDED record must
   * durably carry, mirroring `decision-ledger.ts`'s own `supersededBy`
   * field for the exact same reason (baseline section 255, Decision/
   * Assumption Explainability: "why did this change?" must always be
   * answerable, not just "that this changed").
   */
  supersededBy?: string;
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
 * P2 fix (31st independent review round, finding 6, "implement the
 * SUPERSEDED assumption transition"): thrown by `supersede()` itself (a
 * second attempt to supersede an already-SUPERSEDED assumption) and by
 * `accept()`/`reject()`/`validate()` (bkz. aşağıdaki fix notu) — once an
 * assumption has been superseded it is TERMINAL, exactly like
 * `decision-ledger.ts`'s own `DecisionAlreadySupersededError` makes ACTIVE
 * decisions terminal-once-superseded: evolve the CURRENT active
 * replacement instead of re-deciding the fate of a retired assumption.
 */
export class AssumptionAlreadySupersededError extends Error {
  constructor(id: string, supersededBy: string | undefined) {
    super(
      `Assumption '${id}' has already been SUPERSEDED` +
        (supersededBy ? ` (by '${supersededBy}')` : "") +
        `. A superseded assumption is terminal — it can no longer be accepted, rejected, validated, or ` +
        `superseded again. Operate on its current active replacement instead.`
    );
    this.name = "AssumptionAlreadySupersededError";
  }
}

/**
 * P2 fix (31st independent review round, finding 6): thrown by
 * `supersede()` for every invariant OTHER than "already superseded"
 * (above) and "replacement does not exist" (which reuses the existing
 * `AssumptionNotFoundError` — bkz. `supersede()`'in üstündeki fix notu) —
 * self-supersession, superseding-with-a-dead-end (a replacement that is
 * itself already SUPERSEDED), and cycles, none of which the live
 * propose()/accept()/reject()/validate() API could ever otherwise produce.
 */
export class InvalidAssumptionSupersessionError extends Error {
  constructor(id: string, supersededBy: string, reason: string) {
    super(`Cannot supersede assumption '${id}' with '${supersededBy}': ${reason}.`);
    this.name = "InvalidAssumptionSupersessionError";
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
  if (candidate.supersededBy !== undefined && !isNonEmptyString(candidate.supersededBy)) {
    return "invalid 'supersededBy' (must be a non-empty string when present)";
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
  // P2 fix (31st independent review round, finding 6, "implement the
  // SUPERSEDED assumption transition"): mirrors decision-ledger.ts's
  // reciprocal SUPERSEDED/supersededBy check — supersede() (bkz. aşağısı)
  // never produces one of these fields without the other, so a persisted
  // record claiming either combination alone could never have come from
  // the live API.
  if (candidate.status === "SUPERSEDED" && !isNonEmptyString(candidate.supersededBy)) {
    return "SUPERSEDED record is missing 'supersededBy' — supersede() never produces one without the other";
  }
  if (candidate.status !== "SUPERSEDED" && candidate.supersededBy !== undefined) {
    return "a non-SUPERSEDED record must not carry 'supersededBy' — supersede() only ever sets it together with status: SUPERSEDED";
  }
  return undefined;
}

/**
 * P2 fix (31st independent review round, finding 6, "implement the
 * SUPERSEDED assumption transition"): `describeInvalidPersistedAssumption()`
 * above validates each record IN ISOLATION — it cannot see whether a
 * `supersededBy` target actually exists among the OTHER persisted records,
 * whether it forms a cycle, or whether the same successor is claimed by
 * more than one predecessor. Mirrors `decision-ledger.ts`'s own
 * `describeInvalidPersistedDecisionGraph()` (round 24/28) for the
 * identical reason: a hand-edited/corrupted persisted file has no live
 * API guard against these, so this is the ONLY place they can be caught
 * before reaching authoritative state. Run AFTER every individual record
 * passes `describeInvalidPersistedAssumption()` and BEFORE any record
 * enters the register — fail-closed on the WHOLE batch, same philosophy
 * as every other check in this file.
 */
function describeInvalidPersistedAssumptionGraph(
  records: readonly MutableAssumption[]
): { index: number; reason: string } | undefined {
  const byId = new Map<string, MutableAssumption>();
  records.forEach((r) => byId.set(r.id, r));

  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.supersededBy === undefined) continue;
    if (record.supersededBy === record.id) {
      return { index: i, reason: `supersededBy cannot reference itself ('${record.id}')` };
    }
    if (!byId.has(record.supersededBy)) {
      return { index: i, reason: `supersededBy '${record.supersededBy}' does not reference any persisted assumption` };
    }
  }

  const incomingCount = new Map<string, number>();
  for (const record of records) {
    if (record.supersededBy === undefined) continue;
    incomingCount.set(record.supersededBy, (incomingCount.get(record.supersededBy) ?? 0) + 1);
  }
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.supersededBy === undefined) continue;
    if ((incomingCount.get(record.supersededBy) ?? 0) > 1) {
      return {
        index: i,
        reason:
          `supersededBy '${record.supersededBy}' is claimed as the replacement by more than one predecessor — ` +
          `merged supersession chains are not a valid lifecycle (supersede() never assigns the same successor twice)`
      };
    }
  }

  // Cycle detection over the supersededBy edges, identical three-color DFS
  // to decision-ledger.ts's own graph validator.
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(records.map((r) => [r.id, WHITE]));

  function visit(id: string, path: readonly string[]): { index: number; reason: string } | undefined {
    color.set(id, GRAY);
    const next = byId.get(id)!.supersededBy;
    if (next !== undefined) {
      if (color.get(next) === GRAY) {
        const cycleIndex = records.findIndex((r) => r.id === id);
        return { index: cycleIndex, reason: `supersession chain forms a cycle: ${[...path, id, next].join(" -> ")}` };
      }
      if (color.get(next) === WHITE) {
        const result = visit(next, [...path, id]);
        if (result) return result;
      }
    }
    color.set(id, BLACK);
    return undefined;
  }

  for (const record of records) {
    if (color.get(record.id) === WHITE) {
      const result = visit(record.id, []);
      if (result) return result;
    }
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
    // P2 fix (31st independent review round, finding 6, "implement the
    // SUPERSEDED assumption transition"): a SUPERSEDED assumption is
    // terminal (bkz. `AssumptionAlreadySupersededError`'ın üstündeki fix
    // notu) — without this guard, introducing `supersede()` below would
    // let a caller supersede an assumption and then still accept() the
    // very record that was just declared retired, silently reviving it.
    if (assumption.status === "SUPERSEDED") {
      throw new AssumptionAlreadySupersededError(id, assumption.supersededBy);
    }
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
    if (assumption.status === "SUPERSEDED") {
      throw new AssumptionAlreadySupersededError(id, assumption.supersededBy);
    }
    assumption.status = "REJECTED";
    return freezeRecord(assumption);
  }

  validate(id: string): Assumption {
    const assumption = this.#mustGet(id);
    if (assumption.status === "SUPERSEDED") {
      throw new AssumptionAlreadySupersededError(id, assumption.supersededBy);
    }
    assumption.status = "VALIDATED";
    assumption.confirmedAt = new Date().toISOString();
    return freezeRecord(assumption);
  }

  /**
   * P2 fix (31st independent review round, finding 6, "implement the
   * SUPERSEDED assumption transition"): `AssumptionStatus` declared
   * `"SUPERSEDED"` from the start, but no public method could ever
   * legitimately produce it — the ONLY way to reach that state was for a
   * caller to bypass this class's invariants entirely (which the
   * genuine `#`-private `#assumptions` field, bkz. bu sınıfın üstündeki
   * 25th round fix notu, already makes impossible from outside). This is
   * the explicit, invariant-enforcing transition: `id` is marked
   * SUPERSEDED and durably records WHICH assumption replaces it —
   * mirroring `decision-ledger.ts`'s own `supersede()` for the identical
   * "why did this change, and to what?" explainability requirement
   * (baseline section 255/47), adapted to this register's own shape
   * (assumptions have no separate `project`/scope field to preserve the
   * way decisions do — this register is not partitioned that way, so
   * there is no additional ownership dimension to carry over).
   */
  supersede(id: string, supersededBy: string): Assumption {
    const assumption = this.#mustGet(id);
    if (assumption.status === "SUPERSEDED") {
      throw new AssumptionAlreadySupersededError(id, assumption.supersededBy);
    }
    if (id === supersededBy) {
      throw new InvalidAssumptionSupersessionError(id, supersededBy, "an assumption cannot supersede itself");
    }
    // "Replacement assumption must exist" — reuses the same
    // AssumptionNotFoundError() every other lookup in this class already
    // throws, rather than inventing a second, redundant error type.
    const replacement = this.#mustGet(supersededBy);
    if (replacement.status === "SUPERSEDED") {
      throw new InvalidAssumptionSupersessionError(
        id,
        supersededBy,
        `'${supersededBy}' is itself SUPERSEDED and cannot serve as an active replacement`
      );
    }
    if (this.#supersessionChainReaches(supersededBy, id)) {
      throw new InvalidAssumptionSupersessionError(id, supersededBy, "this would create a supersession cycle");
    }
    assumption.status = "SUPERSEDED";
    assumption.supersededBy = supersededBy;
    return freezeRecord(assumption);
  }

  /**
   * Follows `supersededBy` edges starting at `startId`; returns true if
   * `targetId` is ever reached — used by `supersede()` to refuse creating
   * a cycle. `visited` guards against looping forever on a chain that
   * (impossibly, given this method is the only way to create an edge) is
   * already corrupt.
   */
  #supersessionChainReaches(startId: string, targetId: string): boolean {
    let current: string | undefined = startId;
    const visited = new Set<string>();
    while (current !== undefined) {
      if (current === targetId) return true;
      if (visited.has(current)) return false;
      visited.add(current);
      current = this.#assumptions.get(current)?.supersededBy;
    }
    return false;
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
    // P1 fix (24th independent review round, "restored assumptions must
    // be detached"): each validated candidate is copied (`{ ...record }`),
    // never the exact object `store.read()` returned — a caller/store that
    // later mutates the original object can no longer reach authoritative
    // state.
    const validated: MutableAssumption[] = [];
    records.forEach((record, index) => {
      const failure = describeInvalidPersistedAssumption(record);
      if (failure) {
        throw new CorruptPersistedAssumptionError(index, failure);
      }
      const candidate = record as MutableAssumption;
      if (seenIds.has(candidate.id)) {
        throw new CorruptPersistedAssumptionError(index, `duplicate id '${candidate.id}'`);
      }
      seenIds.add(candidate.id);
      validated.push({ ...candidate });
    });

    // P2 fix (31st independent review round, finding 6, "implement the
    // SUPERSEDED assumption transition"): run only AFTER every record has
    // individually passed validation, and BEFORE any of them enters
    // `register.#assumptions` — see `describeInvalidPersistedAssumptionGraph()`'s
    // note above.
    const graphFailure = describeInvalidPersistedAssumptionGraph(validated);
    if (graphFailure) {
      throw new CorruptPersistedAssumptionError(graphFailure.index, graphFailure.reason);
    }

    for (const record of validated) {
      register.#assumptions.set(record.id, record);
    }
    return register;
  }
}
