// Baseline section 242: audit history should be append-only and tamper-evident.
// Bu modül, Factory içindeki kritik kararları (politika, onay, maliyet) geriye
// dönük değiştirilemeyecek şekilde (append-only) kaydeder. Basit bir hash
// zinciri kullanılır: her kayıt bir önceki kaydın hash'ini içerir, böylece
// aradan bir kayıt silinip/değiştirilirse zincir bozulur ve tespit edilebilir.

import { createHash } from "node:crypto";
import { deepFreezeClone } from "../util/immutable.js";

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
 * P1 fix (31st independent review round, finding 7, "reject or canonically
 * serialize non-JSON audit payloads"): `append()` used to accept ANY
 * `event.payload` value `structuredClone()` could clone — which includes
 * `Map`/`Set`/`Date`/`RegExp` instances, none of which `JSON.stringify()`
 * (used by `hashOf()` above, since `#records` is ultimately an in-memory
 * structure with no separate canonical-serialization step) represents
 * faithfully: `JSON.stringify(new Map([["k", "v"]]))` produces `"{}"` — an
 * empty object — silently discarding every entry. The record actually
 * STORED (via `structuredClone`, which DOES preserve a real `Map`
 * instance) and the record the HASH actually authenticates (computed over
 * `JSON.stringify()`'s `"{}"` view of that same field) would then disagree
 * about what the payload even contains — two audit events differing only
 * in what a `Map`/`Set` field holds could hash IDENTICALLY, defeating
 * baseline section 242's tamper-evidence guarantee for exactly the data a
 * reviewer would need to trust. Fixed with the simpler of the two
 * documented options (a fail-closed JSON-only contract, rather than a
 * bespoke canonical serializer covering every structured-clone-able type):
 * `assertJsonCompatibleValue()` below walks the ENTIRE event (after
 * `structuredClone()`, so a getter/Proxy-backed caller value cannot answer
 * differently across the check and the eventual hash/store) and rejects
 * anything that is not a plain, JSON-representable value — a plain object
 * (or array/string/number/boolean/null), recursively — BEFORE `hashOf()`
 * or `this.#records.push()` ever run, so a `Map`/`Set`/`Date`/function/
 * symbol/BigInt payload is refused outright rather than silently
 * mis-hashed or partially recorded.
 *
 * P2 fix (32nd independent review round, finding 7, "reject lossy audit
 * values before hashing"): this round's finding REVERSES this file's own
 * 31st-round decision to accept non-finite numbers (NaN/Infinity/-Infinity)
 * on the theory that they were "a different, already-accepted lossy case."
 * Codex correctly pointed out that reasoning does not actually hold up
 * under baseline section 242's tamper-evidence guarantee: NaN, Infinity,
 * -Infinity, AND a literal `null` all collapse to the exact SAME
 * `JSON.stringify()` output (`null`) — meaning the hash computed over any
 * one of them is IDENTICAL to the hash computed over any other. A reviewer
 * trusting this record's hash to authenticate "exactly what was logged"
 * cannot actually tell, from the hash alone, whether a genuinely rejected
 * NaN amount, an Infinity amount, or simply a legitimate `null` was ever
 * recorded — the same class of "hash authenticates a DIFFERENT payload
 * than what one might assume" defect the Map/Set fix above targets, just
 * one level more subtle (both a NUMBER and `null` are already "plain,
 * JSON-representable values" individually, so the 31st round's check never
 * flagged the collision). Fixed: `assertJsonCompatibleValue()` now rejects
 * any non-finite number outright too — see below. The call sites that used
 * to log a rejected NaN/Infinity amount directly as forensic evidence
 * (`runtime/budget/budget.ts`'s `BUDGET_INVALID_AMOUNT_REJECTED`/
 * `BUDGET_RESERVATION_COMMIT_FAILED` events) now log a `String()`
 * representation instead (`forensicAmountForAudit()`, bkz. budget.ts'in
 * kendi fix notu) — a plain string preserves EXACTLY which invalid value
 * was rejected (unlike the number itself, `"NaN"`/`"Infinity"`/
 * `"-Infinity"` never collapse into each other or into `null` under
 * `JSON.stringify()`), so the forensic evidence this codebase's own "no
 * silent spending" philosophy relies on is preserved without weakening
 * this contract.
 *
 * P1 fix (33rd independent review round, finding 4 / root class C, "reject
 * or canonicalize undefined audit values before hashing"): the 31st/32nd
 * round checks above (`value === null || value === undefined) return;`)
 * treated `undefined` as an already-safe, "already JSON-shaped" value —
 * but it is not: `JSON.stringify()` (which `hashOf()` runs over) silently
 * DROPS an object property whose value is `undefined` entirely
 * (`JSON.stringify({a: undefined})` → `"{}"`, no `"a"` key at all), while
 * `structuredClone()` (used above to detach `event` from the caller, and
 * again by `deepFreezeClone()` for every record `all()` returns) PRESERVES
 * that same key with its `undefined` value intact. That is exactly this
 * file's own "the record actually stored and the record the hash
 * authenticates disagree about what the payload contains" defect class
 * (see the Map/Set fix note above) — a caller reading `auditLog.all()`
 * would see a `payload` field literally present (as `undefined`), while
 * the hash was computed as though that field never existed, and a second,
 * genuinely field-less record would hash IDENTICALLY. Inside an ARRAY the
 * collision is worse: `JSON.stringify([undefined])` → `"[null]"`, so an
 * `undefined` array element is indistinguishable, once hashed, from a
 * legitimate `null` one — the same "two different meanings collapse to
 * one hash" defect the 32nd round already fixed for NaN/Infinity vs.
 * `null`. Fixed with the round's explicit "reject or explicitly
 * normalize" option, applied per-context rather than uniformly (a single
 * blanket rejection of every `undefined` was tried and rejected during
 * this investigation — legitimate, common call sites such as
 * `policy-engine.ts`'s `matchedRule` and `approval.ts`'s `decidedBy`/
 * `evidenceRef`/`changeRequestReason`/`failureReason` routinely pass
 * `undefined` for "this optional field does not apply to this event",
 * exactly JavaScript's own idiom for an absent object property — rejecting
 * that outright would have made ordinary, non-malicious audit calls fail
 * closed for no security benefit): `canonicalizeAuditValue()` below
 * NORMALIZES an `undefined` object-PROPERTY value by omitting the key
 * entirely, BEFORE storage — the exact same thing `JSON.stringify()` was
 * already silently doing at hash-time, now applied to the value that is
 * actually stored too, so `all()`'s output and the computed hash can never
 * disagree again. An `undefined` ARRAY element, which has no equivalent
 * "just omit it" option (every index must hold a real value) and would
 * otherwise collide with a legitimate `null`, is REJECTED outright via
 * `UnsupportedAuditPayloadError`, consistent with the NaN/Infinity
 * precedent.
 */
export class UnsupportedAuditPayloadError extends Error {
  constructor(path: string, reason: string) {
    super(
      `Refusing to append audit record: '${path}' is ${reason}, which is not a plain, JSON-representable ` +
        `value. JSON.stringify() (used to compute this record's tamper-evident hash) silently mis-serializes ` +
        `types like Map/Set (e.g. as "{}", discarding every entry) — accepting one here would let this ` +
        `record's hash authenticate a DIFFERENT payload than what was actually stored, defeating baseline ` +
        `section 242's tamper-evidence guarantee. Convert it to a plain object/array/string/number/boolean/ ` +
        `null before calling append().`
    );
    this.name = "UnsupportedAuditPayloadError";
  }
}

/**
 * Validates AND normalizes `value` into the exact shape that will be
 * stored (pushed into `#records`) and hashed — the two must be the SAME
 * object graph, not merely two independently-computed values that happen
 * to usually agree. See `UnsupportedAuditPayloadError`'s fix note above for
 * the full rationale, in particular for why `undefined` is handled
 * differently depending on whether it appears as an object property (
 * normalized: the key is omitted) or an array element (rejected: no safe
 * normalization exists that would not collide with a legitimate `null`).
 */
function canonicalizeAuditValue(value: unknown, path: string): unknown {
  if (value === null) return null;
  if (value === undefined) {
    // Reached only for a value that is NOT an object property (the object
    // branch below filters `undefined` properties out before recursing
    // here) — i.e. an array element, or the whole event itself. Both cases
    // are ambiguous once JSON-serialized; fail closed rather than guess.
    throw new UnsupportedAuditPayloadError(
      path,
      "undefined in a position with no safe 'omit' equivalent (an array element, or the event itself) — " +
        "JSON.stringify() would silently turn this into null, indistinguishable from a genuine null"
    );
  }
  const type = typeof value;
  if (type === "number" && !Number.isFinite(value)) {
    throw new UnsupportedAuditPayloadError(path, `a non-finite number (${String(value)})`);
  }
  if (type === "string" || type === "boolean" || type === "number") return value;
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalizeAuditValue(item, `${path}[${index}]`));
  }
  if (type === "object") {
    // Only a genuine plain object (Object.prototype, or a null-prototype
    // dictionary) is accepted — a Map/Set/Date/RegExp/class instance all
    // have a DIFFERENT prototype, which is exactly how this check tells
    // "ordinary JSON-shaped data" apart from a type JSON.stringify() would
    // silently misrepresent.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new UnsupportedAuditPayloadError(
        path,
        `an instance of '${Object.prototype.toString.call(value)}' rather than a plain object`
      );
    }
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (nested === undefined) continue;
      result[key] = canonicalizeAuditValue(nested, `${path}.${key}`);
    }
    return result;
  }
  // function / symbol / bigint.
  throw new UnsupportedAuditPayloadError(path, `of unsupported type '${type}'`);
}

/**
 * Append-only, hash-chained audit log. In-memory for the P0 kernel;
 * a durable backend (baseline section 275, State Store) is future work.
 * Genesis previousHash is a fixed constant so tampering with record #0
 * is also detectable.
 */
/**
 * P1 fix (25th independent review round, "audit records must be
 * runtime-private and append-only"): `records` used to be declared with
 * TypeScript's `private` keyword — compile-time-only, compiling to an
 * ordinary, enumerable JavaScript instance property. A consumer holding a
 * reference to an `AuditLog` instance could reach in via
 * `(auditLog as any).records` (or plain bracket access, no type-system
 * escape hatch needed at all) and `.push()`/`.splice()`/reassign the array
 * DIRECTLY — inserting a fabricated record with no hash-chain computation,
 * or deleting/reordering existing ones — all WITHOUT going through
 * `append()` at all. `verifyIntegrity()` re-derives each record's hash
 * from its own fields and checks `previousHash` linkage, so a record
 * spliced OUT from the middle (with every OTHER record's `previousHash`/
 * `hash` fields left untouched) breaks the chain and IS caught — but a
 * record REPLACED wholesale by one with a freshly, correctly recomputed
 * hash chain (the attacker doing the SAME `hashOf()` computation
 * `append()` uses) would NOT be caught, since integrity verification only
 * checks internal CONSISTENCY of whatever is currently in the array, not
 * that every record's journey there was through `append()`. Fixed the
 * same way `runtime/policy-engine/approval.ts`'s `#requests` and
 * `runtime/models/gateway.ts`'s `#providers` already are: a genuine
 * ECMAScript private class field (`#records`, not `private records`).
 * This is enforced by the JS runtime itself — `as any`, bracket access,
 * `Object.getOwnPropertyNames()`, and `Reflect.ownKeys()` all fail to
 * reach it, and any code outside this class body attempting to write
 * `x.#records` is a `SyntaxError` at PARSE time. Combined with `all()`'s
 * pre-existing `deepFreezeClone()` detachment (outgoing copies were
 * already safe — this fix closes the OTHER direction: reaching the
 * authoritative array directly through the instance), there is now no
 * remaining path to add, remove, or reorder an audit record except
 * `append()`'s own hash-chained, append-only sequence.
 */
export class AuditLog {
  #records: AuditRecord[] = [];
  private static readonly GENESIS_HASH = "0".repeat(64);

  /**
   * P1 fix (4th independent review round, "audit payload mutability leak"):
   * eskiden `event` (ve özellikle `event.payload`, rastgele derinlikte iç
   * içe nesne/dizi içerebilir) SIĞ bir kopyayla (`{...event}`) saklanıyordu
   * — bu yalnızca ÜST DÜZEYİ ayırır; `event.payload` iç Map'e giden
   * kayıtla AYNI nesne referansıydı. Bir çağıran, append()'e verdiği
   * ORİJİNAL payload nesnesini SONRADAN mutasyona uğratırsa (ör.
   * `myPayload.detail.amount = 9999`), bu doğrudan yetkili (authoritative)
   * audit geçmişini de bozardı — hash zaten hesaplanmış olduğundan
   * verifyIntegrity() bunu yakalardı ama kayıt İÇERİĞİ zaten sessizce
   * değişmiş olurdu. Artık `event` önce TAM bir derin kopyayla
   * (`structuredClone`) çağıranın nesne grafiğinden koparılır; ondan
   * SONRA hash hesaplanır ve iç diziye eklenir — orijinal girdi nesnesi
   * üzerindeki hiçbir sonraki mutasyon, artık depolanmış olan kaydı
   * ETKİLEYEMEZ.
   */
  append(event: AuditEvent): AuditRecord {
    const detachedEvent = structuredClone(event);
    // P1 fix (31st/33rd independent review rounds, "reject or canonically
    // serialize non-JSON audit payloads" / root class C): runs on the
    // ALREADY-detached clone (never the caller's original `event`), before
    // any hash is computed or anything is pushed onto `#records` — and,
    // since the 33rd round, its RETURN VALUE (not `detachedEvent`) is what
    // gets stored and hashed, so an `undefined` object property is omitted
    // from BOTH, never just from the hash (bkz. `canonicalizeAuditValue()`'s
    // own fix note above).
    const canonicalEvent = canonicalizeAuditValue(detachedEvent, "event") as AuditEvent;
    const previousHash = this.#records.length > 0
      ? this.#records[this.#records.length - 1]!.hash
      : AuditLog.GENESIS_HASH;

    const base = {
      ...canonicalEvent,
      sequence: this.#records.length,
      previousHash
    };
    const record: AuditRecord = { ...base, hash: hashOf(base) };
    this.#records.push(record);
    return deepFreezeClone(record);
  }

  /**
   * P1 cross-cutting fix (round 3): eskiden bu, İÇ `records` dizisinin
   * KENDİSİNİ döndürüyordu — `auditLog.all().push(sahteKayit)` veya
   * `.splice(...)` ile bir çağıran, hash zincirinden hiç geçmeden kayıt
   * ekleyebilir veya (özellikle SON kaydı) hash zincirini bozmadan
   * silebilirdi; bu, `verifyIntegrity()`'nin asla yakalayamayacağı bir
   * "sessiz silme" yoluydu.
   *
   * P1 fix (round 4): sığ `freezeRecord` yerine artık `deepFreezeClone`
   * kullanılır — döndürülen kaydın `payload` alanı DAHİL, tüm nesne
   * grafiği hem iç durumdan ayrık (derin kopya) hem de tamamen donmuştur.
   * Böylece `auditLog.all()[0].payload.detay.altAlan = "x"` gibi iç içe
   * bir mutasyon girişimi de artık iç durumu ETKİLEMEZ (ve zaten donmuş
   * olduğundan TypeError fırlatır).
   */
  all(): readonly AuditRecord[] {
    return this.#records.map((r) => deepFreezeClone(r));
  }

  /**
   * Zincirin bozulup bozulmadığını doğrular (tamper detection, bölüm 242).
   * Her kaydın hash'i yeniden hesaplanır ve önceki kayda referansı kontrol edilir.
   */
  verifyIntegrity(): boolean {
    let expectedPrevious = AuditLog.GENESIS_HASH;
    for (const record of this.#records) {
      if (record.previousHash !== expectedPrevious) return false;
      const { hash, ...rest } = record;
      if (hashOf(rest) !== hash) return false;
      expectedPrevious = hash;
    }
    return true;
  }
}
