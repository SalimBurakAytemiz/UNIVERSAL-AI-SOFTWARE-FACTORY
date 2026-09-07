// Baseline section 46 (Founder Decision Ledger): Kurucunun verdiği önemli
// kararları kalıcı olarak izler. Amaç, "zaten onaylanmış bir kararı tekrar
// tekrar sormamak" ve bir karar değiştiğinde geçmişi SİLMEK yerine
// SUPERSEDED olarak işaretleyip yeni kararla ilişkilendirmektir — böylece
// "neden değişti?" sorusu her zaman cevaplanabilir kalır (bölüm 255,
// Decision Explainability).

import type { StateStore } from "../state/file-store.js";
import { freezeRecord } from "../util/immutable.js";

export type FounderDecisionStatus = "ACTIVE" | "SUPERSEDED";

interface MutableFounderDecision {
  decisionId: string;
  project: string;
  decision: string;
  source: string;
  status: FounderDecisionStatus;
  createdAt: string;
  supersededBy?: string;
}

/** Dışa döndürülen her karar bunun donmuş, ayrık bir kopyasıdır. */
export type FounderDecision = Readonly<MutableFounderDecision>;

/**
 * P1 targeted-audit fix (23rd independent review round, same root class as
 * assumption-register.ts's "validate persisted assumptions before
 * restoring authoritative state"): `loadFrom()` (below) used to insert
 * every persisted record directly into `this.decisions` with NO
 * validation — a corrupt or hand-edited record claiming
 * `status: "SUPERSEDED"` with no `supersededBy` (a combination
 * `supersede()` itself could never produce, since it always sets both
 * fields together) would be restored into authoritative state, silently
 * corrupting "which decision is currently active?" bookkeeping. See
 * `describeInvalidPersistedDecision()` below.
 */
export class CorruptPersistedDecisionError extends Error {
  constructor(index: number, reason: string) {
    super(
      `Persisted decision record at index ${index} is corrupt or violates a domain invariant ` +
        `(${reason}) and cannot be restored into authoritative state. Persisted state must satisfy the ` +
        `same invariants as state created through the live record()/supersede() API — see baseline ` +
        `section 46. Refusing to load rather than silently repairing or dropping the record.`
    );
    this.name = "CorruptPersistedDecisionError";
  }
}

const VALID_DECISION_STATUSES: readonly FounderDecisionStatus[] = ["ACTIVE", "SUPERSEDED"];

function isNonEmptyDecisionString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Mirrors assumption-register.ts's `describeInvalidPersistedAssumption()` — see its fix note for the full rationale. */
function describeInvalidPersistedDecision(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "not a plain object";
  }
  const candidate = value as Record<string, unknown>;
  if (!isNonEmptyDecisionString(candidate.decisionId)) return "missing or invalid 'decisionId'";
  if (typeof candidate.project !== "string") return "missing or invalid 'project'";
  if (typeof candidate.decision !== "string") return "missing or invalid 'decision'";
  if (typeof candidate.source !== "string") return "missing or invalid 'source'";
  if (!VALID_DECISION_STATUSES.includes(candidate.status as FounderDecisionStatus)) return "invalid 'status'";
  if (!isNonEmptyDecisionString(candidate.createdAt)) return "missing or invalid 'createdAt'";
  if (candidate.supersededBy !== undefined && typeof candidate.supersededBy !== "string") {
    return "invalid 'supersededBy' (must be a string when present)";
  }
  // Domain invariant, identical to what supersede() always produces
  // together: a SUPERSEDED record must name its replacement.
  if (candidate.status === "SUPERSEDED" && !isNonEmptyDecisionString(candidate.supersededBy)) {
    return "SUPERSEDED record is missing 'supersededBy' — supersede() never produces one without the other";
  }
  return undefined;
}

/**
 * P2 fix (24th independent review round, "validate persisted supersession
 * graph"): `describeInvalidPersistedDecision()` above validates each
 * record IN ISOLATION — it cannot see whether a `supersededBy` target
 * actually exists, belongs to the same project, or whether the graph of
 * `supersededBy` edges as a WHOLE forms valid, acyclic chains (`A -> B ->
 * C`), since none of that is knowable from a single record. A persisted
 * decision could reference `supersededBy: "missing-id"` (a target that
 * was never itself persisted), a target belonging to a DIFFERENT project
 * (`supersede()` always copies `old.project` into the replacement, so a
 * cross-project reference could never have been produced live), or even
 * form a cycle (`A -> B -> A`) — `supersede()`'s own ACTIVE-only guard
 * (bkz. `DecisionAlreadySupersededError`) makes a cycle impossible to
 * create through the live API, but a hand-edited/corrupted persisted file
 * has no such guard. Restoring any of these into authoritative state would
 * silently corrupt "which decision is currently active, and why?" —
 * exactly what baseline section 255 (Decision Explainability) requires to
 * always be answerable. Run AFTER every individual record passes
 * `describeInvalidPersistedDecision()` and BEFORE any record is inserted
 * into the authoritative map (fail closed on the WHOLE batch, same
 * philosophy as the per-record check above).
 */
function describeInvalidPersistedDecisionGraph(
  records: readonly MutableFounderDecision[]
): { index: number; reason: string } | undefined {
  const byId = new Map<string, MutableFounderDecision>();
  records.forEach((r) => byId.set(r.decisionId, r));

  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.supersededBy === undefined) continue;
    if (record.supersededBy === record.decisionId) {
      return { index: i, reason: `supersededBy cannot reference itself ('${record.decisionId}')` };
    }
    const target = byId.get(record.supersededBy);
    if (!target) {
      return { index: i, reason: `supersededBy '${record.supersededBy}' does not reference any persisted decision` };
    }
    if (target.project !== record.project) {
      return {
        index: i,
        reason: `supersededBy '${record.supersededBy}' belongs to project '${target.project}', not '${record.project}'`
      };
    }
  }

  // Cycle detection over the supersededBy edges (A -> B means A was
  // superseded by B). Standard three-color DFS: WHITE = unvisited, GRAY =
  // on the current path, BLACK = fully resolved with no cycle found.
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(records.map((r) => [r.decisionId, WHITE]));

  function visit(id: string, path: readonly string[]): { index: number; reason: string } | undefined {
    color.set(id, GRAY);
    const next = byId.get(id)!.supersededBy;
    if (next !== undefined) {
      if (color.get(next) === GRAY) {
        const cycleIndex = records.findIndex((r) => r.decisionId === id);
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
    if (color.get(record.decisionId) === WHITE) {
      const result = visit(record.decisionId, []);
      if (result) return result;
    }
  }

  return undefined;
}

export class DuplicateDecisionError extends Error {
  constructor(decisionId: string) {
    super(`Decision id '${decisionId}' already exists. Use supersede() to record a change, never overwrite history.`);
    this.name = "DuplicateDecisionError";
  }
}

export class DecisionNotFoundError extends Error {
  constructor(decisionId: string) {
    super(`No decision found with id '${decisionId}'`);
    this.name = "DecisionNotFoundError";
  }
}

export class DecisionAlreadySupersededError extends Error {
  constructor(decisionId: string, currentStatus: FounderDecisionStatus, supersededBy: string | undefined) {
    super(
      `Cannot supersede decision '${decisionId}': its current status is ${currentStatus}` +
        (supersededBy ? ` (already superseded by '${supersededBy}')` : "") +
        `. A decision may only be superseded once, from ACTIVE. Evolve the CURRENT active ` +
        `replacement instead (A -> B -> C), never re-replace A directly (A -> B and A -> C).`
    );
    this.name = "DecisionAlreadySupersededError";
  }
}

export class FounderDecisionLedger {
  /**
   * P1 fix (25th independent review round targeted audit, same root class
   * as `audit/audit-log.ts`'s "audit records must be runtime-private and
   * append-only"): this Map used to be declared with TypeScript's `private`
   * keyword — compile-time only. Compiled JS leaves it an ordinary,
   * enumerable instance property, reachable via `(ledger as any).decisions`
   * or plain bracket access (`ledger["decisions"]`) with no type-system
   * escape hatch needed at all. A consumer holding a `FounderDecisionLedger`
   * reference could reach in and mutate a decision's `status` directly
   * (e.g. flipping ACTIVE straight to SUPERSEDED, or vice versa) — or
   * insert/delete a Map entry outright — completely bypassing
   * `supersede()`'s "never delete, only SUPERSEDED-and-chain" invariant and
   * its ACTIVE-only guard (baseline section 46's decision history must
   * always remain fully explainable). Fixed the same way `audit-log.ts`'s
   * `#records`/`policy-engine/approval.ts`'s `#requests`/`models/gateway.ts`'s
   * `#providers` already are: a genuine ECMAScript private class field
   * (`#decisions`), enforced by the JS runtime itself — `as any`, bracket
   * access, `Object.getOwnPropertyNames()`, and `Reflect.ownKeys()` all
   * fail to reach it, and any code outside this class body attempting
   * `x.#decisions` is a `SyntaxError` at PARSE time, not merely rejected at
   * runtime.
   */
  #decisions = new Map<string, MutableFounderDecision>();

  /**
   * P1 cross-cutting fix: eskiden bu (ve get()/allFor()) İÇ nesnenin
   * kendisini döndürüyordu — `ledger.get(id).status = "SUPERSEDED"` gibi bir
   * çağıran, `supersede()`'i hiç çağırmadan "asla silme, sadece SUPERSEDED
   * yap" değişmezini atlatabilirdi. Artık her okuma, donmuş bir kopya
   * döndürür; durum geçişleri YALNIZCA supersede() üzerinden, iç yetkili
   * nesne üzerinde gerçekleşir.
   */
  record(decisionId: string, project: string, decision: string, source: string): FounderDecision {
    if (this.#decisions.has(decisionId)) {
      throw new DuplicateDecisionError(decisionId);
    }
    const record: MutableFounderDecision = {
      decisionId,
      project,
      decision,
      source,
      status: "ACTIVE",
      createdAt: new Date().toISOString()
    };
    this.#decisions.set(decisionId, record);
    return freezeRecord(record);
  }

  get(decisionId: string): FounderDecision | undefined {
    const record = this.#decisions.get(decisionId);
    return record ? freezeRecord(record) : undefined;
  }

  /**
   * Eski kararı SUPERSEDED yapar (asla silmez) ve yeni kararı kaydeder.
   * Bu, "changed decisions trigger impact analysis" gereksinimi için geçmiş
   * karar zincirinin her zaman izlenebilir kalmasını sağlar.
   *
   * P1 fix (5th independent review round, "repeated supersession corrupts
   * decision history"): eskiden bu, `oldDecisionId`'nin GEÇERLİ durumunu
   * hiç kontrol etmiyordu — `A -> B` çağrısından sonra tekrar `A -> C`
   * çağrılırsa, `record()` YENİ bir C kaydı (status: ACTIVE) oluşturuyor
   * ve `old.supersededBy`'yi B'den C'ye SESSİZCE ÜZERİNE YAZIYORDU; B
   * kaydı ise hâlâ ACTIVE kalıyordu (hiç dokunulmamıştı) — sonuçta hem B
   * hem C "A'nın aktif yerine geçeni" iddiasında bulunan, ikisi de ACTIVE
   * durumda iki kayıt oluşuyordu. Bu, "hangi karar şu an yürürlükte?"
   * sorusunun asla iki farklı cevabı olamayacağı değişmezini bozar. Artık:
   * `oldDecisionId`'nin durumu ACTIVE DEĞİLSE (zaten SUPERSEDED ise),
   * HİÇBİR mutasyon yapılmadan (yeni kayıt oluşturulmadan ÖNCE)
   * DecisionAlreadySupersededError ile fail-closed olunur. Bir kararın
   * evrimi yalnızca `A -> B -> C` şeklinde (B'yi supersede ederek) mümkündür
   * — `A -> B` ve `A -> C` (dallanma) şeklinde DEĞİL; bu şema, dallanmayı
   * açıkça TANIMLAMADIĞI sürece asla sessizce buna izin vermez.
   */
  supersede(oldDecisionId: string, newDecisionId: string, decision: string, source: string): FounderDecision {
    const old = this.#decisions.get(oldDecisionId);
    if (!old) throw new DecisionNotFoundError(oldDecisionId);
    if (old.status !== "ACTIVE") {
      throw new DecisionAlreadySupersededError(oldDecisionId, old.status, old.supersededBy);
    }

    const replacement = this.record(newDecisionId, old.project, decision, source);
    old.status = "SUPERSEDED";
    old.supersededBy = newDecisionId;
    return replacement;
  }

  allFor(project: string): readonly FounderDecision[] {
    return [...this.#decisions.values()].filter((d) => d.project === project).map((d) => freezeRecord(d));
  }

  /** Halihazırda ACTIVE bir karar var mı? — aynı soruyu tekrar tekrar sormamak için (bölüm 46). */
  hasActiveDecision(decisionId: string): boolean {
    return this.#decisions.get(decisionId)?.status === "ACTIVE";
  }

  /**
   * Sadece bellekte tutmak yerine bir StateStore'a yazar (bölüm 275, 277)
   * — süreç yeniden başlasa bile karar geçmişi kaybolmaz.
   */
  saveTo(store: StateStore, path: string): void {
    store.write(path, [...this.#decisions.values()]);
  }

  /**
   * Daha önce saveTo() ile kaydedilmiş bir karar defterini geri yükler.
   *
   * P1 targeted-audit fix (23rd independent review round, same root class
   * as assumption-register.ts's persisted-state validation fix): her kayıt
   * eklemeden ÖNCE `describeInvalidPersistedDecision()` ile doğrulanır ve
   * `decisionId`'ler tekrarlanamaz; HERHANGİ bir kayıt geçersizse TÜM
   * yükleme reddedilir (fail closed) — bkz. `CorruptPersistedDecisionError`'ın
   * üstündeki not ve assumption-register.ts'teki aynı desenin gerekçesi.
   */
  static loadFrom(store: StateStore, path: string): FounderDecisionLedger {
    const ledger = new FounderDecisionLedger();
    const records = store.read<unknown[]>(path) ?? [];
    const seenIds = new Set<string>();
    // P1 fix (24th independent review round, same root class as
    // assumption-register.ts's "restored assumptions must be detached"):
    // each validated candidate is copied (`{ ...candidate }`), never the
    // exact object `store.read()` returned — a caller/store that later
    // mutates the original object can no longer reach authoritative state.
    const validated: MutableFounderDecision[] = [];
    records.forEach((record, index) => {
      const failure = describeInvalidPersistedDecision(record);
      if (failure) {
        throw new CorruptPersistedDecisionError(index, failure);
      }
      const candidate = record as MutableFounderDecision;
      if (seenIds.has(candidate.decisionId)) {
        throw new CorruptPersistedDecisionError(index, `duplicate decisionId '${candidate.decisionId}'`);
      }
      seenIds.add(candidate.decisionId);
      validated.push({ ...candidate });
    });

    // P2 fix (24th independent review round, "validate persisted
    // supersession graph"): run only AFTER every record has individually
    // passed validation, and BEFORE any of them enters `ledger.decisions`
    // — see `describeInvalidPersistedDecisionGraph()`'s note above.
    const graphFailure = describeInvalidPersistedDecisionGraph(validated);
    if (graphFailure) {
      throw new CorruptPersistedDecisionError(graphFailure.index, graphFailure.reason);
    }

    for (const record of validated) {
      ledger.#decisions.set(record.decisionId, record);
    }
    return ledger;
  }
}
