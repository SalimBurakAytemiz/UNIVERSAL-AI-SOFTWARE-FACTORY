// Baseline section 60/61: Model Registry. Kayıtlar veridir, kod değil —
// bir sağlayıcının kalıcı olarak ücretsiz/ucuz/premium olduğu asla
// kod içine gömülmez (bölüm 60). Yeni model eklemek kod değişikliği
// gerektirmemelidir.

import { freezeRecord } from "../util/immutable.js";
import { assertValidMonetaryAmount } from "../cost/cost-engine.js";

export type ModelTier =
  | "MOCK"
  | "LOCAL_FREE"
  | "VERY_LOW_COST"
  | "STANDARD"
  | "PREMIUM"
  | "CRITICAL_REVIEW";

/**
 * P1 fix (33rd independent review round, root class A, "freeze authoritative
 * tier ordering at runtime"): this array used to be typed `readonly
 * ModelTier[]` — a TypeScript-only annotation. TypeScript's `readonly`
 * modifier is checked ONLY at compile time; the emitted JS array is an
 * ordinary, mutable object. Any caller holding this export (every module
 * that imports `TIER_ORDER`, directly or via `tierRank()`) could bypass the
 * type system with `as any`/`as ModelTier[]` and call `.push()`/`.reverse()`/
 * `.sort()`/index-assign on it, silently corrupting the ONE authoritative
 * ordering `CheapestCapableModelRouter` (bkz. `router.ts`) relies on to
 * select "the cheapest capable model" (bölüm 60/61) — a reordered or
 * mutated `TIER_ORDER` could make routing silently prefer `PREMIUM`/
 * `CRITICAL_REVIEW` over `MOCK`/`LOCAL_FREE` for every future invocation,
 * with no error, no audit trail, and no test able to observe the change
 * without already knowing to look for it. Fixed: `Object.freeze()` makes
 * every element-mutation attempt on this EXACT array a silent no-op in
 * sloppy mode or a `TypeError` in strict mode (this codebase's ESM modules
 * are strict by default) — the runtime, not merely the type checker, now
 * enforces that this ordering can never change after module load.
 */
export const TIER_ORDER: readonly ModelTier[] = Object.freeze([
  "MOCK",
  "LOCAL_FREE",
  "VERY_LOW_COST",
  "STANDARD",
  "PREMIUM",
  "CRITICAL_REVIEW"
]);

export function tierRank(tier: ModelTier): number {
  return TIER_ORDER.indexOf(tier);
}

export type ModelStatus =
  | "DISCOVERED"
  | "EVALUATED"
  | "APPROVED"
  | "ACTIVE"
  | "MONITORED"
  | "DEPRECATED"
  | "RETIRED";

export interface ModelRecord {
  readonly provider: string;
  readonly modelId: string;
  readonly tier: ModelTier;
  readonly costPerCall: number;
  readonly capabilities: readonly string[];
  readonly status: ModelStatus;
}

const USABLE_STATUSES: readonly ModelStatus[] = ["APPROVED", "ACTIVE", "MONITORED"];

/**
 * P2 targeted-audit fix (9th independent review round, same class as
 * "duplicate worker identities break authoritative status" —
 * workers/registry.ts): register() eskiden bir `modelId` çakışmasını hiç
 * kontrol etmiyordu — aynı `modelId` ile ikinci bir register() çağrısı,
 * ilk kaydı SİLMEDEN dizinin sonuna YENİ bir kayıt daha ekliyordu.
 * findCapable() yalnızca `status`'a göre filtreler; bir model önce ACTIVE
 * kaydedilip sonra AYNI id ile DEPRECATED/RETIRED olarak "yeniden
 * kaydedilirse", BAYAT ACTIVE kayıt dizide kalır ve router hâlâ onu
 * seçebilir — "bir model id TEK bir yetkili kimliği temsil eder" ilkesini
 * (bölüm 60/61) ihlal eder. Fixed: register() artık aynı id ile ikinci
 * bir kayda İZİN VERMEZ; mevcut bir modelin durumunu değiştirmek için
 * AÇIK bir updateStatus() metodu kullanılmalıdır — bu, YETKİLİ kaydı
 * YERİNDE değiştirir, asla ikinci bir kayıt OLUŞTURMAZ.
 */
export class DuplicateModelIdError extends Error {
  constructor(modelId: string) {
    super(
      `Model id '${modelId}' already exists. A model id is a permanent, unique authoritative ` +
        `identity — register() never creates a second record for an existing id; use ` +
        `updateStatus() to transition an existing model's status.`
    );
    this.name = "DuplicateModelIdError";
  }
}

export class ModelNotFoundError extends Error {
  constructor(modelId: string) {
    super(`No model registered with id '${modelId}'.`);
    this.name = "ModelNotFoundError";
  }
}

/**
 * P1 fix (4th independent review round, targeted follow-up ownership
 * audit): register() eskiden ÇAĞIRANIN geçtiği nesnenin REFERANSINI
 * saklıyordu ve all()/findCapable() İÇ diziyi doğrudan döndürüyordu (en
 * kötü hali — hiçbir kopya, hiçbir dondurma). Bir çağıran, kaydettiği
 * (veya `all()`'dan döndürülen) bir model kaydını sonradan mutasyona
 * uğratarak `costPerCall`'ı düşürüp en-ucuz-yeterli-model yönlendirmesini
 * yanıltabilir, `status`'u DEPRECATED/RETIRED'dan APPROVED'a çevirip bu
 * modelin asla otomatik seçilmeme kuralını atlatabilir, veya
 * `capabilities`'e sahip olmadığı bir yetenek ekleyebilirdi (bölüm 60-64,
 * maliyet/yönlendirme bütünlüğü). Artık register() bağımsız bir kopya
 * saklar; all()/findCapable() donmuş, ayrık anlık görüntüler döndürür.
 */
export class ModelRegistry {
  /**
   * P1 fix (25th independent review round targeted audit, same root class
   * as `audit/audit-log.ts`'s "audit records must be runtime-private and
   * append-only"): this array used to be declared with TypeScript's
   * `private` keyword — compile-time only, so the compiled JS leaves it an
   * ordinary, enumerable instance property reachable via
   * `(registry as any).models` or plain bracket access, with no
   * type-system escape hatch needed at all. A consumer holding a
   * `ModelRegistry` reference could push a fabricated record directly
   * (bypassing `register()`'s duplicate-id and monetary-amount validation
   * entirely) or flip a DEPRECATED/RETIRED model's `status` back to ACTIVE
   * in place (bypassing `updateStatus()` and baseline section 60-64's
   * cost/routing-integrity invariants). Fixed the same way `audit-log.ts`'s
   * `#records` already is: a genuine ECMAScript private class field
   * (`#models`), enforced by the JS runtime itself — `as any`, bracket
   * access, `Object.getOwnPropertyNames()`, and `Reflect.ownKeys()` all
   * fail to reach it, and any code outside this class body attempting
   * `x.#models` is a `SyntaxError` at PARSE time.
   */
  #models: ModelRecord[] = [];

  register(model: ModelRecord): void {
    // P1 fix (28th independent review round, finding 12, "snapshot
    // registry records before validation/storage"): `model` used to be
    // read from the caller's own object at THREE separate points —
    // `model.costPerCall` (validation), `model.modelId` (duplicate check,
    // twice — the `.some()` predicate and the error constructor), and
    // finally every property again via `{ ...model }` (the copy actually
    // stored). A getter/Proxy-backed `model` could answer a valid
    // `costPerCall`/a non-colliding `modelId` for the first two reads,
    // then a COMPLETELY different (invalid, or duplicate-colliding) value
    // for the final stored copy — poisoning `this.#models` with a record
    // that was never actually validated or checked for duplicates. Fixed:
    // `model` is spread into `snapshot` FIRST — reading every property
    // exactly once — and validation, the duplicate check, and the stored
    // copy all derive from this SAME snapshot; `model` itself is never
    // read again.
    const snapshot: ModelRecord = { ...model };
    // P2 fix (7th independent review round, "invalid model prices corrupt
    // cheapest-capable routing"): önceden `costPerCall` HİÇ doğrulanmadan
    // kabul ediliyordu. `NaN`, "en ucuz" karşılaştırmalarında (`x < NaN`,
    // `NaN < x`) HER ZAMAN false döndüğü için önce kaydedilen (genellikle
    // premium) adayın hiç elenmemesine yol açar — sessizce yanlış modelin
    // seçilmesine (bölüm 60/61 ihlali). Merkezi doğrulayıcı
    // (`assertValidMonetaryAmount`, cost-engine.ts) BURADA da kullanılır —
    // ayrı/farklı bir kural icat edilmez — ve reddedilen bir kayıt asla
    // `this.#models` dizisine ULAŞMAZ (fail closed, mutasyondan önce kontrol).
    assertValidMonetaryAmount(snapshot.costPerCall, `ModelRegistry.register(modelId=${snapshot.modelId})`);
    // P2 targeted-audit fix (9th independent review round): reject an id
    // collision BEFORE any mutation — see DuplicateModelIdError above.
    if (this.#models.some((m) => m.modelId === snapshot.modelId)) {
      throw new DuplicateModelIdError(snapshot.modelId);
    }
    this.#models.push(freezeRecord(snapshot));
  }

  all(): readonly ModelRecord[] {
    return this.#models.map((m) => freezeRecord(m));
  }

  /**
   * Belirtilen tüm yetenekleri destekleyen ve kullanılabilir durumda olan
   * (APPROVED/ACTIVE/MONITORED) modelleri döndürür. DEPRECATED/RETIRED
   * modeller asla otomatik yönlendirmeye dahil edilmez.
   */
  findCapable(requiredCapabilities: readonly string[]): ModelRecord[] {
    return this.#models
      .filter((m) => USABLE_STATUSES.includes(m.status) && requiredCapabilities.every((cap) => m.capabilities.includes(cap)))
      .map((m) => freezeRecord(m));
  }

  /**
   * Var olan bir modelin durumunu değiştirmenin TEK yolu — register()'ı
   * TEKRAR çağırmak DEĞİL. YETKİLİ kaydı YERİNDE (aynı dizi konumunda)
   * değiştirir, asla ikinci bir kayıt oluşturmaz.
   */
  updateStatus(modelId: string, status: ModelStatus): ModelRecord {
    const index = this.#models.findIndex((m) => m.modelId === modelId);
    if (index === -1) {
      throw new ModelNotFoundError(modelId);
    }
    const updated = freezeRecord({ ...this.#models[index]!, status });
    this.#models[index] = updated;
    return freezeRecord(updated);
  }
}

/**
 * A small, representative default registry spanning MOCK through PREMIUM,
 * used by tests, proofs, and `factory routing explain`. Real deployments
 * are expected to load their own registry data rather than relying on this.
 */
export function createDefaultModelRegistry(): ModelRegistry {
  const registry = new ModelRegistry();

  registry.register({
    provider: "mock",
    modelId: "mock-classifier",
    tier: "MOCK",
    costPerCall: 0,
    capabilities: ["classification", "tagging", "formatting", "summarization"],
    status: "ACTIVE"
  });

  registry.register({
    provider: "mock",
    modelId: "mock-standard-coder",
    tier: "STANDARD",
    costPerCall: 0.01,
    capabilities: [
      "classification", "tagging", "formatting", "summarization",
      "implementation", "code-review", "debugging", "integrations", "test-generation"
    ],
    status: "ACTIVE"
  });

  registry.register({
    provider: "mock",
    modelId: "mock-premium-architect",
    tier: "PREMIUM",
    costPerCall: 0.20,
    capabilities: [
      "implementation", "code-review", "debugging", "integrations", "test-generation",
      "critical-architecture", "security-reasoning", "distributed-systems", "incident-analysis"
    ],
    status: "ACTIVE"
  });

  return registry;
}
