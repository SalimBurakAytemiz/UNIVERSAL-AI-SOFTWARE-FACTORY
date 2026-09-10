// Baseline section 59: Model Gateway — sağlayıcı soyutlaması. Çekirdek
// testler asla ücretli bir API gerektirmemelidir; bu yüzden gateway,
// sağlayıcıları isimle kayıt altına alan basit bir arayüzdür ve
// MockProvider (providers/mock-provider.ts) varsayılan/test sağlayıcısıdır.
//
// P1 fix (10th independent review round, "public ModelGateway.invoke()
// bypasses enforcement"): Codex, `gateway.invoke(...)`'in HERKESE açık,
// PolicyEngine/BudgetGuard'dan TAMAMEN habersiz bir sağlayıcı çağrısı
// yaptığını gösterdi — router.ts'nin KENDİ `invokeAuthorized()` sarmalayıcısı
// düzeltilmiş olsa bile, bu, "hiçbir gerçek provider çağrısı yetkisiz
// gerçekleşemez" (bölüm 147) sistemik değişmezini GARANTİ ETMEZ, çünkü
// `gateway.invoke()`'e doğrudan erişimi olan HERHANGİ bir çağıran (aynı
// dosyadaki bir proof dahil) bu korumayı tamamen atlayabilir. "routeAndExecute
// kullan" gibi bir GELİŞTİRİCİ SÖZLEŞMESİYLE çözülemez — bu YAPISAL olarak
// engellenmelidir. Fix: PolicyEngine/BudgetGuard rezervasyon+mutabakat
// mantığının TAMAMI artık BU sınıfın KENDİ `invoke()` metodunun içinde
// yaşıyor (router.ts artık yalnızca ince bir sarmalayıcı) — HAM sağlayıcı
// çağrısı (`provider.invoke`) `#rawInvoke` özel metoduna taşındı ve bu
// sınıfın DIŞINDAN hiçbir şekilde erişilemez hale getirildi. `invoke()`
// artık bir `ModelInvocationContext` (policy + budget + risk + taskId)
// parametresini ZORUNLU kılar — TypeScript bunu atlayan bir çağrıyı
// DERLEME ZAMANINDA reddeder, ve parametre isteğe bağlı bir bayrak/bağlam
// DEĞİLDİR (bölüm 147 gereği bu tür bir "atlanabilir" tasarım kabul
// edilemez): gerçek yetkilendirme mantığının kendisi bu metodun GÖVDESİNDE
// çalışır, bu yüzden "yanlış bağlam geçmek" bile yetkilendirmeyi ATLATAMAZ.

import { createHash } from "node:crypto";
import type { ModelRecord } from "./registry.js";
import { CapabilityGateway } from "../capability-gateway/gateway.js";
import type { PolicyEngine, RiskLevel } from "../policy-engine/policy-engine.js";
import { ApprovalWorkflow } from "../policy-engine/approval.js";
import type { BudgetGuard } from "../budget/budget.js";
import { freezeRecord, deepFreeze } from "../util/immutable.js";
import type { AuditLog } from "../audit/audit-log.js";

/**
 * P1 fix (34th independent review round, findings 3 & 4, "approval
 * evidence not bound to immutable exact action identity"): a stable digest
 * over whatever authoritative, already-snapshotted values a call site folds
 * in — bkz. `PolicyAction.identityDigest`'in fix notu
 * (policy-engine.ts). Every argument here MUST already be a plain,
 * already-captured primitive (never re-read from a caller-owned object
 * after this call), so two invocations of this function produce the SAME
 * digest if and only if every one of those authoritative values genuinely
 * agrees.
 */
function identityDigestOf(parts: readonly (string | number | undefined)[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/**
 * Exported so a genuine approval-request workflow (whoever calls
 * `ApprovalWorkflow.requestFor()` BEFORE the real `invoke()` call this
 * approval must eventually authorize) can compute the EXACT SAME digest
 * `invoke()` itself will bind into `PolicyAction.identityDigest` below —
 * a single, shared source of truth rather than a hand-duplicated formula
 * that could silently drift from what `invoke()` actually checks.
 *
 * P1 fix (35th independent review round, finding 4, "include taskType in
 * invocation approval identity"): `taskType` (`ModelInvocationRequest`'s
 * OTHER field, alongside `prompt`) used to be entirely absent from this
 * digest — even though it materially influences model behavior/routing
 * (bkz. `ModelInvocationRequest.taskType`'ın kendi tanımı) exactly the same
 * way `prompt` already does. Two invocations sharing the same task/run/
 * agent/provider/model/prompt but requesting a DIFFERENT `taskType` (e.g.
 * "summarize" vs. "generate-code" against an identical prompt string) used
 * to produce the IDENTICAL digest, so an approval genuinely requested for
 * one `taskType` could silently authorize a materially different one. Now
 * an explicit, required parameter — bkz. aşağıdaki `invoke()`'in çağrısı,
 * `authorizedRequest.taskType`'ı geçirir.
 */
export function computeModelInvocationIdentityDigest(params: {
  readonly taskId: string;
  readonly runId?: string;
  readonly agentId?: string;
  readonly provider: string;
  readonly modelId: string;
  readonly prompt: string;
  readonly taskType?: string;
}): string {
  return identityDigestOf([
    params.taskId,
    params.runId,
    params.agentId,
    params.provider,
    params.modelId,
    params.prompt,
    params.taskType
  ]);
}

/**
 * P1 fix (35th independent review round, finding 3, "bind provider
 * approvals to complete candidate configuration"): `provider.invoke.toString()`
 * only captures the METHOD'S SOURCE TEXT — which is shared by every
 * instance of the same class (a class method lives once, on the shared
 * prototype; `toString()` returns the identical text regardless of which
 * instance calls it). Two DIFFERENT, independently-configured instances of
 * the same adapter class (e.g. one instance pointed at a legitimate
 * endpoint/account, another pointed at an attacker-controlled one, or two
 * genuinely distinct customer accounts) therefore produced the EXACT SAME
 * digest — an approval genuinely requested for candidate A's exact
 * configuration could then authorize installing candidate B, so long as B
 * happened to be built from the same class. Fixed: every OWN, string-keyed,
 * enumerable property the candidate `provider` object actually carries
 * (its config surface — the same fields `detachFromCallerMutation()` below
 * locks at registration time) is folded into the digest too, keyed by
 * property name for a canonical, order-independent fingerprint. Each
 * value is hashed INDIVIDUALLY (`sha256`, one-way) rather than embedded in
 * cleartext, so a config field that happens to hold a plaintext secret
 * (an API key/endpoint credential stored directly on the adapter) never
 * appears in the digest's input in a recoverable form — only a
 * non-reversible fingerprint of it does, which is exactly this finding's
 * own "no plaintext secrets" requirement while still making two
 * differently-configured instances produce provably different digests.
 */
/**
 * P1 fix (37th independent review round, finding 2, "reject lossy provider
 * configuration fingerprints"): a value whose canonicalization
 * (`JSON.stringify`) THROWS — a circular-referencing configuration object,
 * a `BigInt` field — used to fall back to `String(value)`. For a plain
 * object that fallback ALWAYS produces the literal string `"[object
 * Object]"`, REGARDLESS of the object's actual shape — two materially
 * DIFFERENT cyclic configurations (different endpoints, different nested
 * structure, anything) collapse to the exact SAME hashed fingerprint
 * component, exactly the "two different configurations must never silently
 * share a digest" property this whole function exists to guarantee. Fixed
 * with the safer of the two documented options: fail closed. A
 * configuration value that cannot be canonicalized is refused outright
 * (`UnsupportedProviderConfigurationError`) rather than silently
 * fingerprinted as a lossy placeholder — an approval can never be computed
 * for, nor a provider installed with, configuration this function cannot
 * faithfully represent.
 */
export class UnsupportedProviderConfigurationError extends Error {
  constructor(id: string, key: PropertyKey, cause: unknown) {
    super(
      `Provider '${id}' exposes a configuration property (${String(key)}) that could not be canonically ` +
        `fingerprinted: ${cause instanceof Error ? cause.message : String(cause)}. Refusing fail-closed ` +
        `(baseline section 147) rather than falling back to a lossy representation (e.g. "[object Object]") ` +
        `under which materially different configurations could collide onto the same approval digest.`
    );
    this.name = "UnsupportedProviderConfigurationError";
  }
}

/**
 * P1 fix (independent Codex review, "include opaque provider configuration
 * in replacement identity"): thrown ONLY when a provider's OWN, opted-in
 * `getBindingIdentity()` (bkz. `ModelProvider`'ın kendi fix notu) exists but
 * returns something that cannot possibly serve as a canonical execution
 * identity — a non-string, or an empty string. A provider that DECLARES it
 * has opaque material state (by implementing this method at all) but then
 * fails to actually supply a usable identity is worse than one that never
 * declared it in the first place: the caller/reviewer would otherwise
 * reasonably believe the opaque state IS being represented in the approval
 * digest when it silently is not. Fail closed rather than fold in `""`/
 * `undefined`/`"[object Object]"`-shaped garbage, which would satisfy
 * neither "represents the difference" nor "collision-free".
 */
export class IncompleteProviderIdentityError extends Error {
  constructor(id: string, reason: string) {
    super(
      `Provider '${id}' implements getBindingIdentity() but it ${reason}. A provider that opts into declaring ` +
        `opaque/private material configuration must supply a genuine, non-empty, canonical identity string for ` +
        `it — governed replacement is refused rather than silently fold in an unusable value (baseline section 147).`
    );
    this.name = "IncompleteProviderIdentityError";
  }
}

/**
 * P1 fix (independent Codex review, "reject provider state omitted by the
 * approval fingerprint"): a JSON-serializable canonical shape produced by
 * `canonicalizeConfigValueForFingerprint()` below — never fed directly to
 * `JSON.stringify()` in a way that could silently collapse a `Map`/`Set`'s
 * actual entries to `{}` the way bare `JSON.stringify()` does.
 */
type CanonicalFingerprintValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalFingerprintValue[]
  | { readonly [key: string]: CanonicalFingerprintValue };

/**
 * Deterministic ordering for a list of already-canonicalized values (Map
 * entries, Set items) whose ORIGINAL relative order must not matter — two
 * `Map`/`Set` instances holding the exact same entries/items in a
 * different insertion order must fingerprint identically. Sorting by each
 * item's own canonical JSON text is stable and total (bkz. `Array.prototype.sort`'ın
 * ES2019+ kararlılık garantisi).
 */
function sortByCanonicalJson<T>(items: readonly T[]): T[] {
  return items
    .map((item) => ({ item, json: JSON.stringify(item) }))
    .sort((a, b) => (a.json < b.json ? -1 : a.json > b.json ? 1 : 0))
    .map((entry) => entry.item);
}

/**
 * P1 fix (independent Codex review, "reject provider state omitted by the
 * approval fingerprint"): the finding identified TWO independent root
 * causes in the OLD `canonicalProviderConfigFingerprint()`: (a) it filtered
 * `Reflect.ownKeys(provider)` down to string keys only, silently dropping
 * every symbol-keyed own property before fingerprinting it at all — a
 * caller could stash behaviorally material state (an endpoint, an account
 * id) behind a symbol key and it would never enter the approval identity;
 * (b) it fed each value straight to bare `JSON.stringify()`, which
 * serializes ANY `Map`/`Set` to the literal empty object `{}` regardless
 * of the map/set's actual entries (neither type exposes its data as an own
 * enumerable property `JSON.stringify`'s default algorithm can see) — two
 * providers differing only in Map/Set-typed configuration would fingerprint
 * identically, letting an approval for candidate A silently authorize
 * installing candidate B.
 *
 * This function replaces the ad-hoc per-value `JSON.stringify()` call with
 * a real recursive canonicalizer that: (1) explicitly recognizes and
 * faithfully encodes `Map` (as an order-independent, sorted list of
 * canonicalized `[key, value]` pairs) and `Set` (as an order-independent,
 * sorted list of canonicalized items) instead of ever handing either to
 * `JSON.stringify()` directly; (2) recurses into arrays and plain objects,
 * covering BOTH string AND symbol own keys (bkz. `canonicalProviderConfigFingerprint()`'in
 * kendi çağrısı, artık `Reflect.ownKeys()`'i STRING FİLTRESİ OLMADAN
 * dolaşıyor); (3) fails closed — via the ALREADY-ESTABLISHED
 * `UnsupportedProviderConfigurationError` (never a new error type, per this
 * round's "reuse existing governance" instruction) — for anything this
 * canonicalizer cannot faithfully, losslessly represent: functions,
 * `bigint`s, symbol VALUES (as opposed to symbol KEYS, which are fully
 * supported), non-finite numbers (`NaN`/`Infinity`), circular references,
 * and any object whose prototype is neither `Object.prototype` nor `null`
 * (a `Date`, a `RegExp`, a class instance — none of which this repository's
 * own provider configuration shapes currently require, and any of which
 * COULD hide behaviorally material state this function has no faithful way
 * to canonicalize). `seen` is a plain (non-`Weak`) `Set` scoped to exactly
 * ONE top-level fingerprint computation — bkz. `deepFreeze()`'in kendi
 * `WeakSet` notu (util/immutable.ts): unlike that traversal, THIS one must
 * be free to re-visit the SAME shared sub-object reached from two
 * DIFFERENT top-level config properties (that is not a cycle), while still
 * detecting a genuine cycle WITHIN a single property's own descent — so the
 * `seen` set is entered/exited around each container via try/finally,
 * never left populated across sibling properties.
 */
function canonicalizeConfigValueForFingerprint(
  value: unknown,
  id: string,
  key: PropertyKey,
  seen: Set<unknown>
): CanonicalFingerprintValue {
  if (value === null) return null;
  const type = typeof value;
  if (type === "string" || type === "boolean") return value as string | boolean;
  if (type === "number") {
    if (!Number.isFinite(value as number)) {
      throw new UnsupportedProviderConfigurationError(
        id,
        key,
        new Error(`non-finite numeric configuration value (${String(value)}) cannot be canonically fingerprinted`)
      );
    }
    return value as number;
  }
  if (type === "undefined") return { __type: "undefined" };
  if (type === "function") {
    // A function VALUE (as opposed to a symbol KEY, which IS fully
    // supported above) is canonicalized by its own source text rather than
    // failed closed: this mirrors the ALREADY-ESTABLISHED precedent
    // `computeProviderReplacementIdentityDigest()` itself uses one level up
    // (`provider.invoke.toString()`, bkz. yukarıda) — two DIFFERENT function
    // bodies always produce different source text, so this is faithful and
    // non-lossy, never a collapsing fallback like `"[object Object]"`. This
    // also preserves an existing, previously-resolved P0 invariant: a
    // plain-object `ModelProvider` candidate (no class, `invoke` as an OWN
    // data property — bkz. `replaceProvider()`'ın kendi testleri, 29th
    // independent review round) has always had that `invoke` property
    // itself enter this same per-property fingerprint loop; failing closed
    // on it here would regress that already-passing governance path.
    return { __type: "Function", source: (value as (...args: unknown[]) => unknown).toString() };
  }
  if (type === "symbol" || type === "bigint") {
    throw new UnsupportedProviderConfigurationError(
      id,
      key,
      new Error(`unsupported configuration value type '${type}' cannot be canonically fingerprinted`)
    );
  }
  // type === "object" from here on.
  if (seen.has(value)) {
    throw new UnsupportedProviderConfigurationError(
      id,
      key,
      new Error("circular reference detected while canonicalizing configuration for fingerprinting")
    );
  }
  if (Array.isArray(value)) {
    seen.add(value);
    try {
      return value.map((item) => canonicalizeConfigValueForFingerprint(item, id, key, seen));
    } finally {
      seen.delete(value);
    }
  }
  if (value instanceof Map) {
    seen.add(value);
    try {
      const entries = Array.from(value.entries()).map(
        ([entryKey, entryValue]) =>
          [
            canonicalizeConfigValueForFingerprint(entryKey, id, key, seen),
            canonicalizeConfigValueForFingerprint(entryValue, id, key, seen)
          ] as const
      );
      return { __type: "Map", entries: sortByCanonicalJson(entries) as unknown as CanonicalFingerprintValue };
    } finally {
      seen.delete(value);
    }
  }
  if (value instanceof Set) {
    seen.add(value);
    try {
      const items = Array.from(value.values()).map((item) => canonicalizeConfigValueForFingerprint(item, id, key, seen));
      return { __type: "Set", items: sortByCanonicalJson(items) };
    } finally {
      seen.delete(value);
    }
  }
  const proto = Object.getPrototypeOf(value as object);
  if (proto !== Object.prototype && proto !== null) {
    throw new UnsupportedProviderConfigurationError(
      id,
      key,
      new Error(
        `unsupported configuration object type '${(value as object).constructor?.name ?? "unknown"}' cannot be ` +
          "canonically fingerprinted"
      )
    );
  }
  seen.add(value);
  try {
    const ownKeys = Reflect.ownKeys(value as object);
    const stringKeys: string[] = [];
    const symbolKeys: symbol[] = [];
    for (const ownKey of ownKeys) {
      if (typeof ownKey === "symbol") {
        symbolKeys.push(ownKey);
      } else {
        stringKeys.push(ownKey);
      }
    }
    stringKeys.sort();
    // P1 fix (independent Codex review, "reject colliding symbol-key
    // encodings"): a symbol-keyed property used to be labeled by
    // `String(symbol)` alone — which reflects ONLY a symbol's DESCRIPTION,
    // never its per-symbol identity. `Symbol("endpoint")` created twice
    // produces two DISTINCT, mutually-unequal symbols that BOTH stringify
    // to `"Symbol(endpoint)"` — so a config object keyed by both would
    // canonicalize to the SAME `sym:Symbol(endpoint)` label twice, and the
    // second `result[...] = ...` assignment below would SILENTLY OVERWRITE
    // the first, dropping an entire distinct property (and its value) from
    // the fingerprint with no error, no warning — two materially different
    // configurations could then hash identically. `Symbol.for(key)`
    // (registry symbols), by contrast, genuinely IS a collision-free,
    // globally-stable identity: two calls to `Symbol.for("x")` always
    // return the exact SAME symbol (per the ECMAScript global symbol
    // registry's own contract), so `Symbol.keyFor()` is a faithful,
    // deterministic label for it. A LOCAL (non-registered) symbol has NO
    // such stable identity available to this function — canonicalizing it
    // by description would silently reproduce the exact collision above,
    // and canonicalizing it by object identity would not be REPRODUCIBLE
    // (a fresh approval computation for the "same" logical config would
    // never match). Per this finding's own instruction ("do NOT attempt
    // magic introspection... for symbols that cannot be stably/canonically
    // identified -> FAIL CLOSED"), a local symbol key therefore fails
    // closed rather than risk ever silently dropping a distinct property.
    const symbolLabels = new Map<symbol, string>();
    for (const ownKey of symbolKeys) {
      const registryKey = Symbol.keyFor(ownKey);
      if (registryKey === undefined) {
        throw new UnsupportedProviderConfigurationError(
          id,
          key,
          new Error(
            `symbol-keyed configuration property '${String(ownKey)}' is not a registered Symbol.for() symbol — a ` +
              "local Symbol() has no collision-free, reproducible identity available for canonical fingerprinting " +
              "(two distinct local symbols can share the same description) and is rejected rather than risk " +
              "silently dropping a distinct property"
          )
        );
      }
      symbolLabels.set(ownKey, `sym:${registryKey}`);
    }
    symbolKeys.sort((a, b) => {
      const la = symbolLabels.get(a)!;
      const lb = symbolLabels.get(b)!;
      return la < lb ? -1 : la > lb ? 1 : 0;
    });
    const result: Record<string, CanonicalFingerprintValue> = {};
    for (const ownKey of stringKeys) {
      result[`str:${ownKey}`] = canonicalizeConfigValueForFingerprint(
        (value as Record<string, unknown>)[ownKey],
        id,
        key,
        seen
      );
    }
    for (const ownKey of symbolKeys) {
      result[symbolLabels.get(ownKey)!] = canonicalizeConfigValueForFingerprint(
        (value as Record<PropertyKey, unknown>)[ownKey],
        id,
        key,
        seen
      );
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

/**
 * P1 fix (37th independent review round, finding 1, "bind provider approval
 * to the genuinely installed snapshot"): bkz. `replaceProvider()`'ın kendi
 * fix notu for the full call-site rationale — `resolvedAccessors` is a
 * SINGLE, already-taken reading of every accessor (getter) property this
 * provider instance currently exposes (bkz. `resolveProviderAccessors()`),
 * computed exactly ONCE per `replaceProvider()` call and threaded into both
 * this function AND the later `detachFromCallerMutation()`/
 * `captureProviderBinding()` call. Previously this function read every
 * accessor DIRECTLY off the live `provider` object — a SEPARATE,
 * independent invocation of each getter from whatever `detachFromCallerMutation()`
 * would invoke again later when actually installing the binding. A
 * stateful or Proxy-backed getter (returning a different value on each
 * call) could therefore have its FIRST read folded into the approval
 * digest, while its SECOND, independent read (moments later, inside the
 * approved callback) is what actually gets locked into the installed
 * `ProviderBinding` — an approval genuinely granted for configuration A
 * silently installing configuration B. Data properties carry no such risk
 * (a data property's value is fixed at the moment of the descriptor read,
 * never re-evaluated), so only accessor properties need this
 * once-only-shared-reading treatment.
 */
function canonicalProviderConfigFingerprint(
  provider: ModelProvider,
  id: string,
  resolvedAccessors: ReadonlyMap<PropertyKey, unknown>
): string {
  // P1 fix (independent Codex review, "reject provider state omitted by the
  // approval fingerprint"): iterate EVERY own key `Reflect.ownKeys()`
  // reports — string AND symbol — never filter symbol keys out before
  // fingerprinting (bkz. üstteki fix notu). Sorting mixes both kinds via a
  // stable, unambiguous label (`str:`/`sym:` prefix) so the two namespaces
  // never collide with each other and ordering stays deterministic run to
  // run for the SAME object.
  const ownKeys = Reflect.ownKeys(provider);
  const labeled = ownKeys.map((key) => ({
    key,
    label: typeof key === "symbol" ? `sym:${String(key)}` : `str:${key}`
  }));
  labeled.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

  const entries = labeled.map(({ key, label }) => {
    const descriptor = Object.getOwnPropertyDescriptor(provider, key);
    const value = descriptor && "value" in descriptor ? descriptor.value : resolvedAccessors.get(key);
    // Canonicalize (never bare `JSON.stringify`, which silently collapses
    // `Map`/`Set` to `{}`) before hashing — bkz.
    // `canonicalizeConfigValueForFingerprint()`'in fix notu.
    const canonical = canonicalizeConfigValueForFingerprint(value, id, key, new Set());
    const serialized = JSON.stringify(canonical);
    return `${label}:${createHash("sha256").update(serialized).digest("hex")}`;
  });
  return entries.join("|");
}

/**
 * Reads every OWN accessor (getter) property `provider` currently exposes
 * exactly ONCE, returning a stable snapshot keyed by property name — bkz.
 * `canonicalProviderConfigFingerprint()`'in üstündeki fix notu for why this
 * single reading must be shared between digest computation and the later
 * installed binding, rather than each independently re-invoking the same
 * getter. A getter that throws refuses the ENTIRE operation fail-closed
 * (`UnsafeProviderConfigurationError`), exactly as `detachFromCallerMutation()`
 * already did for this same failure mode.
 */
function resolveProviderAccessors(provider: ModelProvider, id: string): ReadonlyMap<PropertyKey, unknown> {
  const resolved = new Map<PropertyKey, unknown>();
  for (const key of Reflect.ownKeys(provider)) {
    const descriptor = Object.getOwnPropertyDescriptor(provider, key);
    if (!descriptor || "value" in descriptor || !descriptor.get) continue;
    try {
      resolved.set(key, descriptor.get.call(provider));
    } catch (err) {
      throw new UnsafeProviderConfigurationError(id, key, err);
    }
  }
  return resolved;
}

/**
 * Same rationale as `computeModelInvocationIdentityDigest()` above, for the
 * `model.provider.replace` action `replaceProvider()` gates — takes the
 * CANDIDATE provider object itself (never a hand-typed implementation
 * name/source string) so a caller cannot accidentally compute a digest for
 * an implementation other than the one it actually holds. Now also folds in
 * `canonicalProviderConfigFingerprint()` (bkz. üstteki fix notu) so two
 * instances of the same class with materially different configuration are
 * never mistaken for the same approved candidate.
 */
export function computeProviderReplacementIdentityDigest(
  provider: ModelProvider,
  id: string,
  resolvedAccessors: ReadonlyMap<PropertyKey, unknown> = resolveProviderAccessors(provider, id)
): string {
  // P1 fix (independent Codex review, "include opaque provider
  // configuration in replacement identity"): `canonicalProviderConfigFingerprint()`
  // is faithful for everything `Reflect.ownKeys()` can see, but genuine
  // `#private` fields and closure-captured state are invisible to every
  // reflection API by design of the language — no amount of introspection
  // here can recover them. A provider that carries such opaque,
  // behaviorally material state opts into representing it by implementing
  // `getBindingIdentity()` (bkz. `ModelProvider`'ın kendi fix notu); when
  // present, its value is folded into the digest as an ADDITIONAL,
  // independent component — never a replacement for the existing
  // fingerprint, which remains the authoritative source for everything it
  // CAN see. A provider that omits the method is presumed to have no such
  // opaque state (the only workable default, since "does this provider
  // have invisible state" is exactly what cannot be detected from outside).
  const bindingIdentity = provider.getBindingIdentity?.();
  if (provider.getBindingIdentity && (typeof bindingIdentity !== "string" || bindingIdentity.length === 0)) {
    throw new IncompleteProviderIdentityError(
      id,
      typeof bindingIdentity !== "string" ? `returned a non-string value (${typeof bindingIdentity})` : "returned an empty string"
    );
  }
  return identityDigestOf([
    id,
    provider.constructor?.name ?? "unknown",
    provider.invoke.toString(),
    canonicalProviderConfigFingerprint(provider, id, resolvedAccessors),
    bindingIdentity !== undefined ? `binding:${bindingIdentity}` : "no-opaque-binding-identity-declared"
  ]);
}

export interface ModelInvocationRequest {
  readonly prompt: string;
  readonly taskType?: string;
}

export interface ModelInvocationResponse {
  readonly modelId: string;
  readonly provider: string;
  readonly costUsd: number;
  readonly output: string;
}

/**
 * P1 fix (33rd independent review round, finding 1 / root class F,
 * "billable provider failure reconciliation"): `invoke()` used to treat
 * EVERY provider throw identically — "no real cost occurred" — and
 * unconditionally release its budget reservation. That assumption is
 * false in general: a real provider adapter can fail AFTER the external
 * provider already accepted (and possibly billed) the request — a
 * network timeout waiting for an already-generated response, a dropped
 * connection after submission, a 5xx returned once work already started.
 * A `ModelProvider.invoke()` implementation that CAN determine what
 * actually happened communicates it by throwing (or, per Node's
 * `Error.cause` convention, wrapping) a `ProviderInvocationError` with an
 * explicit `billingStatus`:
 *  - `"NOT_BILLED"`: the caller has authoritative evidence no cost was
 *    ever incurred (e.g. a local validation error, a connection refused
 *    before any request left this process). `invoke()` releases the
 *    reservation exactly as before — this is the ONLY case that ever did.
 *  - `"BILLED"`, with `incurredCostUsd` known exactly: `invoke()` commits
 *    that EXACT amount, so the real spend is durably recorded rather than
 *    silently erased, while the original failure still propagates to the
 *    caller.
 *  - `"BILLED"` without a known exact amount, `"UNKNOWN"`, or (the fail-
 *    closed DEFAULT) any error that is not a `ProviderInvocationError` at
 *    all (a plain, unclassified `Error` — what `MockProvider`/most naive
 *    adapters throw): the reservation is preserved and marked
 *    reconciliation-required (bkz. `BudgetGuard.markProviderFailureUnresolved()`),
 *    never silently released. This last branch is the fix's actual
 *    behavior change: "no classification at all" used to mean "assume
 *    zero cost" (fail OPEN); it now means "assume cost MAY have been
 *    incurred" (fail CLOSED) — exactly baseline section 147's "no silent
 *    spending" applied to the failure path, not only the success path.
 */
export type ProviderFailureBillingStatus = "NOT_BILLED" | "BILLED" | "UNKNOWN";

export class ProviderInvocationError extends Error {
  readonly billingStatus: ProviderFailureBillingStatus;
  readonly incurredCostUsd?: number;

  constructor(
    message: string,
    billingStatus: ProviderFailureBillingStatus,
    options?: { readonly incurredCostUsd?: number; readonly cause?: unknown }
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ProviderInvocationError";
    this.billingStatus = billingStatus;
    this.incurredCostUsd = options?.incurredCostUsd;
  }
}

/**
 * Classifies an error caught from `ModelProvider.invoke()` into the
 * billing-status contract above. Anything that is not a genuine
 * `ProviderInvocationError` — including every plain `Error` this
 * repository's own `MockProvider`/`FailingProvider` test fixtures throw —
 * is conservatively `"UNKNOWN"`, never `"NOT_BILLED"`: the whole point of
 * this classification is that "no evidence" must never be read as
 * "evidence of zero cost".
 *
 * P1 fix (36th independent review round, finding 8, "treat unknown
 * providers as definitely unbilled"): `UnknownProviderError` (bkz.
 * `#rawInvoke()` below) is a distinct, NARROWER case than "no evidence" —
 * it is thrown by THIS module, entirely LOCALLY, before `provider.invoke()`
 * is ever reached (no registered provider exists to call at all), so no
 * external system could possibly have been contacted, let alone billed.
 * Treating it as `"UNKNOWN"` (the fail-closed default for genuine
 * ambiguity) used to route it into
 * `BudgetGuard.markProviderFailureUnresolved()` — stranding the
 * reservation in `RECONCILIATION_FAILED` for a failure that was never
 * ambiguous in the first place. This is the ONE case where "no
 * `ProviderInvocationError`" still has POSITIVE evidence of zero cost: the
 * failure's own type proves invocation never started.
 */
function classifyProviderFailure(err: unknown): { readonly billingStatus: ProviderFailureBillingStatus; readonly incurredCostUsd?: number } {
  if (err instanceof ProviderInvocationError) {
    return { billingStatus: err.billingStatus, incurredCostUsd: err.incurredCostUsd };
  }
  if (err instanceof UnknownProviderError) {
    return { billingStatus: "NOT_BILLED" };
  }
  return { billingStatus: "UNKNOWN" };
}

export interface ModelProvider {
  readonly id: string;
  invoke(model: ModelRecord, request: ModelInvocationRequest): Promise<ModelInvocationResponse>;
  /**
   * P1 fix (independent Codex review, "include opaque provider
   * configuration in replacement identity"): `canonicalProviderConfigFingerprint()`
   * (bkz. aşağısı) can only ever canonicalize what `Reflect.ownKeys()`
   * exposes — genuine ECMAScript `#private` fields, values captured in a
   * closure, and other opaque adapter-internal state are, BY DESIGN OF THE
   * LANGUAGE, invisible to every reflection API this or any other module
   * could use. Two provider instances of the SAME class differing ONLY in
   * such invisible state would silently fingerprint identically — an
   * approval genuinely granted for one materially different configuration
   * could then authorize installing another. Rather than attempt any form
   * of "magic introspection" of opaque state (impossible in general), a
   * provider that carries behaviorally material state outside its own
   * enumerable/non-enumerable own properties MUST implement this method,
   * returning a canonical, deterministic, non-secret string identifying
   * ALL such state (a stable fingerprint/hash is fine — sensitive values
   * must never appear in plaintext here, since this value is folded
   * directly into an audit-visible approval digest). A provider that omits
   * this method is presumed to have NO such opaque state — bkz.
   * `computeProviderReplacementIdentityDigest()`'in kendi fix notu for why
   * this presumption, not a blanket fail-closed for every provider, is the
   * correct default: `canonicalProviderConfigFingerprint()` already
   * faithfully captures every kind of state a plain, ordinary provider
   * object can have.
   */
  getBindingIdentity?(): string;
}

/**
 * P1 fix (30th independent review round, finding 5, "store immutable
 * provider bindings"): `registerProvider()`/`replaceProvider()` used to
 * store the caller's OWN `ModelProvider` OBJECT directly in `#providers` —
 * a live reference to whatever the caller passed in, not a copy. Since a
 * plain `ModelProvider` object is an ordinary, caller-owned, mutable JS
 * object, nothing stopped that SAME caller from later reassigning
 * `provider.invoke = maliciousFunction` — every FUTURE, already-authorized
 * `#rawInvoke()` call for that provider id would then silently execute the
 * attacker-controlled function instead, with zero re-registration, zero
 * new audit event, and zero opportunity for the policy/approval gate this
 * file's `replaceProvider()` exists to enforce. Fixed by capturing a
 * DETACHED, frozen binding at the moment of registration/replacement — the
 * provider id, the `invoke` method BOUND to the provider instance at that
 * exact moment (`Function.prototype.bind`, so the captured function keeps
 * working correctly even if it reads its own `this` state, but is
 * otherwise a completely independent reference the caller's own object can
 * never redirect), and the implementation's constructor name (captured
 * once, for `replaceProvider()`'s own audit trail — bkz. aşağıdaki
 * `implementationName`). `#providers` now stores ONLY this immutable
 * binding — never the caller's live object — so mutating (or even
 * reassigning properties on) the original `provider` object after
 * registration has no effect whatsoever on what a future `invoke()` call
 * actually executes.
 */
interface ProviderBinding {
  readonly id: string;
  readonly invoke: ModelProvider["invoke"];
  readonly implementationName: string;
}

/**
 * P1 fix (32nd independent review round, finding 6, "snapshot provider id
 * once before duplicate checking"): this used to read `provider.id` ITSELF
 * (rather than accepting it as a parameter) — meaning every CALLER
 * (`registerProvider()`/`replaceProvider()`) that ALSO needed the id for
 * its own duplicate-check/lookup read it a SECOND time, separately, before
 * ever calling this function. See those methods' own fix notes for the
 * exploit this enabled; `id` is now REQUIRED here specifically so the sole
 * source of truth for "which id does this binding get filed under" is
 * whatever the CALLER already captured once, never a fresh, independent
 * read of a caller-owned (potentially getter/Proxy-backed) `provider.id`.
 */
/**
 * P1 fix (34th independent review round, finding 5, "detach provider
 * execution from caller-owned state"): `provider.invoke.bind(provider)`
 * permanently fixes WHICH FUNCTION runs (a later `provider.invoke = evilFn`
 * reassignment cannot retroactively change what the already-bound wrapper
 * calls through to — bkz. round 30's fix note above), but it does NOT
 * protect any OTHER config-like state `invoke()`'s body might read off
 * `this` at CALL TIME (e.g. `this.endpoint`, `this.apiKey`) — since `this`
 * is bound to the caller's OWN, still-live, still-mutable `provider`
 * object, a caller free to keep mutating THAT object after registration
 * could silently redirect an already-authorized/approved provider's
 * observable behavior (its real target endpoint, credentials, etc.)
 * without any new registration, approval, or audit event ever occurring.
 * Fixed: every OWN, currently-existing, writable DATA property (found via
 * `Reflect.ownKeys`, which also catches Symbol-keyed properties -- getters/
 * setters are deliberately skipped, since `Object.defineProperty` with
 * `writable` is meaningless for an accessor descriptor) is locked to its
 * value AS OF THIS EXACT MOMENT (`writable: false, configurable: false`).
 * This is deliberately NOT `Object.freeze()`/`Object.seal()`: the object
 * stays EXTENSIBLE, so tooling that legitimately needs to ADD a brand new
 * own property after registration (e.g. `vi.spyOn(provider, "invoke")`,
 * which shadows a prototype method with a NEW instance-level property --
 * bkz. router.test.ts's own fix note on this exact pattern) keeps working
 * unaffected. Nested objects/arrays an existing property already pointed
 * to remain freely mutable IN PLACE (locking is shallow, exactly like
 * `freezeRecord` elsewhere in this codebase) -- a provider's own
 * self-tracking bookkeeping via such a nested container is unaffected,
 * only a caller's ability to REASSIGN one of the provider's own top-level
 * fields (its actual attack surface) is removed. Genuine ECMAScript
 * private (`#`) fields are invisible to `Reflect.ownKeys` and untouched by
 * `Object.defineProperty` entirely, so a real adapter storing credentials
 * in a private field keeps working exactly as before -- this fix targets
 * only the caller-visible, caller-mutable public surface the finding
 * actually describes.
 */
/**
 * P1 fix (35th independent review round, finding 5, "freeze
 * non-configurable writable provider fields"): the guard used to be
 * `descriptor.configurable` — skipping the lock ENTIRELY for a legal (if
 * unusual) descriptor shape, `{ writable: true, configurable: false }`
 * (e.g. a provider constructed via `Object.defineProperty(this, "endpoint",
 * { value: ..., writable: true, configurable: false })` instead of a plain
 * assignment). Such a field remained fully caller-mutable forever — exactly
 * the caller-owned-state leak this whole function exists to close — even
 * though the ECMAScript spec explicitly PERMITS toggling `writable` from
 * `true` to `false` on a non-configurable data property (the one narrowing
 * change a non-configurable property still allows; verified empirically:
 * `Object.defineProperty` with `configurable` left at its EXISTING `false`
 * value and only `writable` reduced to `false` succeeds, it does not
 * throw). Fixed: the guard is now `descriptor.writable || descriptor.configurable`
 * — i.e. "there is still SOMETHING about this data property this function
 * can tighten" — covering all three non-fully-locked shapes
 * (`writable:true,configurable:true`; `writable:true,configurable:false`;
 * `writable:false,configurable:true`, the last one closing a second, more
 * minor gap where an already-non-writable-but-still-configurable field
 * could still be redefined back to writable, or deleted, by anyone holding
 * the object). Only `writable:false,configurable:false` (already fully
 * locked) is skipped, since nothing further can or needs to change. If
 * locking a property nonetheless throws (an edge case this function cannot
 * anticipate for every possible provider shape), the provider binding is
 * refused fail-closed — `UnsafeProviderConfigurationError` — rather than
 * silently registering a provider with unprotected caller-mutable state.
 */
export class UnsafeProviderConfigurationError extends Error {
  constructor(id: string, key: PropertyKey, cause: unknown) {
    super(
      `Provider '${id}' exposes a configuration property (${String(key)}) that could not be safely ` +
        `detached from caller mutation: ${cause instanceof Error ? cause.message : String(cause)}. Registration ` +
        `is refused fail-closed (baseline section 147) rather than leaving that property caller-mutable.`
    );
    this.name = "UnsafeProviderConfigurationError";
  }
}

/**
 * A genuine plain data object (`{}`/`Object.create(null)`) — never an array,
 * and never a class instance. Arrays are deliberately excluded even though
 * they are structurally "plain": this codebase's own established provider
 * pattern (bkz. `ControllableProvider` in gateway.test.ts, documented right
 * above its `#counters` field since the 34th independent review round) uses
 * a plain OWN array property (`receivedModels`, `pending`) as the provider's
 * SELF-TRACKING BOOKKEEPING container, mutated in place (`.push()`,
 * `.splice()`) by the provider's own `invoke()` on every call — exactly the
 * "provider's own internal mutability, unrelated to caller-facing
 * configuration" this function's own docstring already carves out for class
 * instances. A configuration surface is something the CALLER hands the
 * provider at construction time and the provider only ever reads
 * (`provider.config.endpoint`, the finding's own example); freezing that is
 * this fix's actual target. Structurally, a plain array cannot be told apart
 * from the other kind by shape alone, so this fix scopes itself to plain
 * OBJECTS only — closing the exact gap the finding names without also
 * breaking the array-shaped bookkeeping pattern the codebase already relies
 * on and tests against.
 */
function isPlainConfigValue(value: unknown): value is Record<PropertyKey, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * P1 fix (36th independent review round, finding 7, "detach nested
 * provider configuration"): the fix note above this function already
 * documented the gap this closes as a KNOWN, ACCEPTED limitation —
 * "[locking] is shallow, exactly like `freezeRecord` elsewhere in this
 * codebase... nested objects/arrays an existing property already pointed
 * to remain freely mutable IN PLACE." Codex reproduced the concrete
 * consequence: `provider.config = { endpoint: "https://good" }` gets its
 * TOP-LEVEL `config` slot locked (a caller can no longer do
 * `provider.config = somethingElse`), but the OBJECT that slot points to
 * was never itself frozen — `provider.config.endpoint = "https://evil"`
 * still succeeded freely, silently redirecting an already-registered,
 * already-approved provider's real execution target with no new
 * registration, approval, or audit event. Fixed in two parts:
 *
 * (1) For a data property whose value is a genuine PLAIN object or array
 * (bkz. `isPlainConfigValue()` — deliberately NOT any class instance,
 * which may legitimately need continued internal mutability for reasons
 * unrelated to caller-facing configuration, e.g. an internal connection
 * pool), the nested value is now recursively frozen too (`deepFreeze()`,
 * the SAME already-proven recursive-freeze primitive `audit-log.ts` uses
 * for its own "never mutable again" records) — in place, not cloned away,
 * so the provider's OWN internal code can still read it, just never
 * write through it again.
 *
 * (2) An ACCESSOR property (a getter) used to be skipped ENTIRELY — "genuine
 * ECMAScript private field OR an accessor, `Object.defineProperty` with
 * `writable` is meaningless for it" — but a getter backed by a caller-
 * mutable closure variable or field could legitimately return a DIFFERENT
 * config object on every single read, meaning `invoke()`'s own read of
 * `this.config` at call time could observe a value that was never seen,
 * let alone approved, at registration time at all — this is exactly the
 * finding's own "accessor-backed configuration must be evaluated safely
 * into the authoritative snapshot" requirement. Fixed: the getter is
 * invoked ONCE, right now, and its return value is baked in as a frozen,
 * ordinary DATA property — replacing the accessor entirely — so every
 * future read of that property (including the provider's own `invoke()`)
 * observes this exact, registration-time snapshot, never a live
 * re-evaluation of whatever the getter's original backing store holds
 * later. A write-only accessor (a setter with no getter) has nothing to
 * snapshot and is left as-is — it cannot itself EXPOSE mutable state to a
 * reader, only accept writes, so it carries no read-time risk this fix
 * needs to close.
 *
 * P1 fix (37th independent review round, finding 1, "bind provider approval
 * to the genuinely installed snapshot"): this used to call
 * `descriptor.get.call(provider)` itself, right here — a SECOND, independent
 * invocation of the SAME getter `canonicalProviderConfigFingerprint()` (via
 * `replaceProvider()`'s own approval-digest computation) had ALREADY
 * invoked moments earlier. `resolvedAccessors` (bkz. `resolveProviderAccessors()`'ın
 * üstündeki fix notu) is that SAME, already-taken reading, threaded through
 * so the value actually locked into the installed binding is GUARANTEED
 * identical to whatever the approval digest was computed from — never a
 * fresh, potentially-different second read of a stateful/Proxy-backed
 * getter.
 */
function detachFromCallerMutation(
  provider: ModelProvider,
  id: string,
  resolvedAccessors: ReadonlyMap<PropertyKey, unknown>
): void {
  for (const key of Reflect.ownKeys(provider)) {
    const descriptor = Object.getOwnPropertyDescriptor(provider, key);
    if (!descriptor) continue;

    if (!("value" in descriptor)) {
      if (!descriptor.get) continue;
      const snapshot = resolvedAccessors.get(key);
      if (isPlainConfigValue(snapshot)) {
        deepFreeze(snapshot);
      }
      try {
        Object.defineProperty(provider, key, {
          value: snapshot,
          writable: false,
          configurable: false,
          enumerable: descriptor.enumerable
        });
      } catch (err) {
        throw new UnsafeProviderConfigurationError(id, key, err);
      }
      continue;
    }

    if (descriptor.writable || descriptor.configurable) {
      try {
        Object.defineProperty(provider, key, { ...descriptor, writable: false, configurable: false });
      } catch (err) {
        throw new UnsafeProviderConfigurationError(id, key, err);
      }
    }

    // P1 fix (37th independent review round, finding 3, "deep-freeze
    // nested provider state under a frozen root"): this used to also
    // guard on `!Object.isFrozen(descriptor.value)`, skipping `deepFreeze()`
    // ENTIRELY whenever the caller had already done a SHALLOW
    // `Object.freeze()` on this config value themselves. `Object.freeze()`
    // is shallow — a frozen top-level `config` object can still have a
    // fully mutable `.nested` object one level down — so this guard treated
    // "the top level happens to already be frozen" as proof "everything
    // reachable from it is already frozen," letting a nested field remain
    // silently mutable forever. `deepFreeze()` itself (bkz. `runtime/util/immutable.ts`'in
    // fix notu) is now cycle-safe via its OWN internal `WeakSet`-based
    // visited tracking, so calling it unconditionally here — even on an
    // already (shallow-)frozen value — is always safe and correctly
    // recurses into any still-mutable descendants.
    if (isPlainConfigValue(descriptor.value)) {
      deepFreeze(descriptor.value);
    }
  }
}

function captureProviderBinding(
  provider: ModelProvider,
  id: string,
  resolvedAccessors: ReadonlyMap<PropertyKey, unknown> = resolveProviderAccessors(provider, id)
): ProviderBinding {
  detachFromCallerMutation(provider, id, resolvedAccessors);
  return Object.freeze({
    id,
    invoke: provider.invoke.bind(provider),
    implementationName: provider.constructor?.name ?? "unknown"
  });
}

/**
 * `ModelGateway.invoke()`'in atlanamaz şekilde ZORUNLU kıldığı yetkilendirme
 * bağlamı. `policy`/`budget` isteğe bağlı DEĞİLDİR — bölüm 147'nin gereği
 * budur: gerçek bir provider çağrısına giden HİÇBİR yol, bu ikisi olmadan
 * DERLENEMEZ bile.
 *
 * P1 fix (11th independent review round, "supplied capability gateway can
 * bypass authoritative policy"): bu arayüz eskiden isteğe bağlı bir
 * `capabilityGateway?: CapabilityGateway` alanı içeriyordu ("zaten bir
 * örneğe sahip çağıranlar onu yeniden kullanabilir" amacıyla, saf bir
 * nesne-yeniden-kullanım optimizasyonu). Codex, bunun GERÇEK bir politika
 * atlatma vektörü olduğunu gösterdi: `authorize()` çağrısı
 * `context.capabilityGateway ?? new CapabilityGateway(context.policy)`
 * şeklindeydi — yani BİR çağıran, YETKİLİ (authoritative,
 * default-DENY olabilecek) bir `policy` sağlarken, AYNI ANDA bunu
 * TAMAMEN görmezden gelen, ALLOW-her-şeyi bir politikayla kurulmuş bir
 * `capabilityGateway` da sağlayabilirdi — `authorize()` ikincisini
 * kullanır, `context.policy` hiçbir zaman `evaluate()` çağırmaz, ve HİÇBİR
 * audit kaydı üretilmez. `CapabilityGateway` (runtime/capability-gateway/
 * gateway.ts) durumsuz, iki satırlık bir sarmalayıcıdır (`policy`
 * referansını tutmaktan başka hiçbir şey yapmaz) — yeniden kullanmanın
 * TEK faydası önemsiz bir nesne ayırma maliyetinden kaçınmaktı, bu da
 * "yetkili politikanın asla atlatılamaması" gereksiniminin yanında hiçbir
 * ağırlığı olmayan bir optimizasyondu. Fix: bu alan TAMAMEN KALDIRILDI —
 * artık `capabilityGateway` diye bir şey enjekte ETMENİN YOLU YOK; TEK
 * yetkilendirme yolu, `invoke()`'in KENDİSİNİN, HER ÇAĞRIDA, doğrudan
 * `context.policy`'den TAZE bir `CapabilityGateway` inşa etmesidir (bkz.
 * aşağıdaki `invoke()`). Bu, "bir boolean bayrak eklemek" veya "çağıranın
 * doğru gateway'i kullanmasını belgelemek" DEĞİLDİR — atlatma vektörünün
 * kendisi (enjekte edilebilir alternatif bir CapabilityGateway) tipten
 * SİLİNDİ.
 */
/**
 * P1 fix (25th independent review round, "approval evidence must flow
 * through model invocation path"): `ModelInvocationContext` used to have
 * NO way to carry approval evidence at all — a risk-5 model invocation
 * always evaluates to `APPROVAL_REQUIRED` (bkz. policy-engine.ts), but
 * `invoke()` below called `capabilityGateway.authorize()` with NO third
 * `approval` argument, so EVERY risk-5 model call was unconditionally
 * blocked (`CapabilityApprovalRequiredError`), with no code path by which
 * a genuine, reviewer-granted approval could ever reach it — even worse,
 * `invoke()` used to construct a BRAND NEW `CapabilityGateway(context.policy)`
 * on every call, which (per the pre-fix default) came with its own
 * throwaway, always-empty `ApprovalWorkflow` — so even a caller willing to
 * hand-roll a workaround had no store to register a real approval into in
 * the first place. `approvalId` is now an optional per-call reference
 * (never a workflow object — bkz. `capability-gateway/gateway.ts`'in
 * `ApprovalReference`'ın üstündeki fix notu, the SAME anti-forgery
 * reasoning applies here) into `ModelGateway`'s OWN authoritative
 * `#approvals` store (bkz. aşağıdaki `ModelGateway`), constructor-injected
 * ONCE by whoever assembles the gateway — never per-call, never from this
 * context.
 */
export interface ModelInvocationContext {
  readonly policy: PolicyEngine;
  readonly budget: BudgetGuard;
  readonly risk: RiskLevel;
  readonly taskId: string;
  readonly projectId?: string;
  /**
   * P1 fix (31st independent review round, finding 2, "preserve run and
   * agent ownership through model invocations"): `ModelInvocationContext`
   * used to carry `taskId`/`projectId` but no `runId`/`agentId` at all —
   * even though `runtime/cost/cost-engine.ts`'s `CostScope`/
   * `ReservationOwnership` (round 14's `agentId`, round 29's `runId`) have
   * long supported both, and `runtime/budget/budget.ts`'s `perRunUsd`
   * ceiling (round 29) is specifically scoped BY `runId`. Since neither
   * field could ever reach `invoke()` below, `budget.reserve()`/`.commit()`
   * never received them for a REAL model invocation — the ONLY path that
   * actually spends money — so `perRunUsd` silently degraded to its
   * "no runId supplied" global-scope fallback for every single model call
   * this Factory ever makes, and no committed `CostEntry` for a real
   * invocation ever carried an `agentId`, making per-agent cost
   * attribution (`costEngine.totalFor({ agentId })`) permanently empty in
   * practice despite the ledger itself supporting it. Both are optional,
   * additive fields (matching every prior ownership-dimension addition in
   * this codebase) — a caller that never supplies them sees the exact
   * prior behavior, unchanged.
   */
  readonly runId?: string;
  readonly agentId?: string;
  readonly description?: string;
  readonly approvalId?: string;
}

export class UnknownProviderError extends Error {
  constructor(provider: string) {
    super(`No provider registered for '${provider}'. Register it via ModelGateway.registerProvider().`);
    this.name = "UnknownProviderError";
  }
}

/**
 * P1 fix (28th independent review round, finding 13, "reject duplicate
 * provider registration"): `registerProvider()` used to call
 * `this.#providers.set(provider.id, provider)` unconditionally — a SECOND
 * `registerProvider()` call for the same `id` silently REPLACED the
 * authoritative adapter every subsequent `invoke()` dispatches real
 * provider calls through (bkz. `#rawInvoke`'s `this.#providers.get(model.provider)`).
 * Since a provider is the ONLY thing standing between an authorized,
 * budget-reserved invocation and an ACTUAL external side effect/spend, a
 * caller (or a compromised/buggy startup path) able to swap the adapter
 * bound to a live id after the fact could silently redirect every future
 * "trusted" model call for that provider id to a completely different
 * implementation, with zero audit trail of the swap ever happening —
 * exactly the "no silent architectural deletion" class this repo's
 * constitutional rules (bölüm 147) forbid. Fixed: registering an already-
 * bound id now fails closed; a caller that genuinely needs to replace an
 * adapter must do so through the separately named, explicitly audited
 * `replaceProvider()` below.
 */
export class DuplicateProviderIdError extends Error {
  constructor(id: string) {
    super(
      `Provider id '${id}' is already registered. registerProvider() never silently replaces an existing ` +
        `adapter — use ModelGateway.replaceProvider() for an explicit, audited replacement.`
    );
    this.name = "DuplicateProviderIdError";
  }
}

/**
 * P1 fix (29th independent review round, finding 2, "provider replacement
 * must require policy + approval + audit"): `replaceProvider()`'s only
 * requirement used to be that the AuditLog happened to be present — an
 * OPTIONAL constructor parameter — and even then, recording was purely
 * best-effort (`this.#auditLog?.append(...)`, silently a no-op when
 * omitted). Since replacing a trusted provider adapter is EXACTLY the kind
 * of "no silent architectural deletion" action baseline section 147/303
 * exists to gate, this operation is now REQUIRED to carry durable audit
 * evidence — a `ModelGateway` constructed without an `AuditLog` cannot call
 * `replaceProvider()` at all (it can still `registerProvider()`/`invoke()`
 * normally; only the explicit-replacement path demands it).
 */
export class ProviderReplacementAuditRequiredError extends Error {
  constructor(id: string) {
    super(
      `Cannot replace provider '${id}': this ModelGateway was constructed without an AuditLog. Provider ` +
        `replacement must generate durable audit evidence (baseline section 147/303) — construct the ` +
        `ModelGateway with an AuditLog to enable replaceProvider().`
    );
    this.name = "ProviderReplacementAuditRequiredError";
  }
}

/**
 * P1 fix (29th independent review round, finding 2): the authorization
 * context `replaceProvider()` now REQUIRES — mirrors `ModelInvocationContext`
 * (policy is mandatory, risk is caller-stated so the SAME risk-5-forces-
 * approval floor `PolicyEngine.evaluate()` already enforces for every other
 * risky action applies here too, and `approvalId` is a reference into this
 * gateway's OWN `#approvals` store, never a workflow object — bkz.
 * `ModelInvocationContext.approvalId`'in fix notu, the SAME anti-forgery
 * reasoning applies here).
 */
export interface ProviderReplacementContext {
  readonly policy: PolicyEngine;
  readonly risk: RiskLevel;
  readonly projectId?: string;
  readonly description?: string;
  readonly approvalId?: string;
}

export class ModelGateway {
  // Gerçek ECMAScript private alan (`#`), TypeScript'in `private`
  // anahtar kelimesinden BİLEREK farklı: `private` yalnızca DERLEME
  // ZAMANINDA (tsc) uyarır — derlenmiş JS çıktısında sıradan bir genel
  // (public) özelliktir ve `(gateway as any).rawInvoke(...)` gibi bir tip
  // atlatmasıyla ÇALIŞMA ZAMANINDA hâlâ çağrılabilir. `#` ile tanımlanan
  // alanlar/metodlar ise JS ÇALIŞMA ZAMANININ KENDİSİ tarafından bu sınıf
  // gövdesinin DIŞINDAN erişilemez kılınır — `as any`, `Object.getOwnPropertyNames`,
  // Reflect, hiçbiri bunu atlatamaz (bir `SyntaxError`/`TypeError`
  // üretir). Bölüm 147'nin "yapısal olarak engellenmeli, geliştirici
  // sözleşmesiyle değil" gereksinimini KARŞILAYAN budur.
  readonly #providers = new Map<string, ProviderBinding>();

  /**
   * P1 fix (25th independent review round, "approval evidence must flow
   * through model invocation path"): the authoritative approval store for
   * every invocation this gateway ever authorizes — injected ONCE, at
   * CONSTRUCTION time, exactly like `CapabilityGateway`'s own `approvals`
   * field (bkz. capability-gateway/gateway.ts'in `CapabilityGateway`
   * constructor'ının üstündeki fix notu — the SAME "trust established
   * once, at construction, by whoever assembles the system" model).
   * `invoke()` below passes `this.#approvals` (never anything read from
   * the per-call `context`) into the freshly-constructed
   * `CapabilityGateway` it builds on EVERY call — a caller wanting a
   * risk-5 invocation to actually succeed must first `requestFor()`/
   * `approve()` a matching entry in THIS SAME store (the one reference
   * they were handed when this `ModelGateway` was constructed), then pass
   * only its id via `ModelInvocationContext.approvalId`.
   */
  readonly #approvals: ApprovalWorkflow;

  /**
   * P1 fix (28th independent review round, finding 13): optional, injected
   * ONCE at construction — the same "trust established once, by whoever
   * assembles the system" model as `#approvals` above. Used only to record
   * the explicit, audited `replaceProvider()` swap below; ordinary
   * `registerProvider()` never touches it.
   */
  readonly #auditLog?: AuditLog;

  constructor(approvals: ApprovalWorkflow = new ApprovalWorkflow(), auditLog?: AuditLog) {
    this.#approvals = approvals;
    this.#auditLog = auditLog;
  }

  /**
   * P1 fix (28th independent review round, finding 13, "reject duplicate
   * provider registration"): fails closed on a colliding id instead of
   * silently replacing the authoritative adapter — bkz. `DuplicateProviderIdError`
   * fix notu yukarıda.
   */
  /**
   * P1 fix (32nd independent review round, finding 6, "snapshot provider id
   * once before duplicate checking"): `provider.id` used to be reread
   * independently for the `#providers.has()` duplicate check, the
   * `DuplicateProviderIdError` message, the `#providers.set()` map key, AND
   * (inside `captureProviderBinding()`) the stored binding's own `id`
   * field — FOUR separate reads of a caller-owned property. Codex
   * reproduced: a getter/Proxy-backed `provider` (`get id() { ... }`) could
   * return a genuinely-unused id on its FIRST read (passing the
   * `has()`/duplicate check cleanly) and then return an ALREADY-TRUSTED,
   * live id (e.g. `"openai"`) on a LATER read — the map would then be
   * `.set()` under the trusted id, silently overwriting/aliasing the
   * genuine provider a caller had every reason to believe was still
   * authoritative, with the duplicate check having verified NOTHING about
   * the id actually used to store it. Fixed: `id` is read EXACTLY ONCE,
   * into a genuine local `const`, before the duplicate check even runs —
   * the check, the error message, the map key, and the captured binding
   * (via `captureProviderBinding(provider, id)`'s now-required parameter)
   * all derive from this SAME snapshot, so no later read of
   * `provider.id` can ever diverge from the id this method just verified
   * was not already registered. The explicit, governed `replaceProvider()`
   * path remains the only way to swap an existing id's binding (bkz. o
   * metodun kendi, aynı sınıftan fix notu).
   */
  registerProvider(provider: ModelProvider): void {
    const id = provider.id;
    if (this.#providers.has(id)) {
      throw new DuplicateProviderIdError(id);
    }
    this.#providers.set(id, captureProviderBinding(provider, id));
  }

  /**
   * `registerProvider()`'ın aksine, var olan bir adaptörü KASITLI ve
   * DENETLENEBİLİR şekilde değiştirmenin TEK yolu budur — bkz.
   * `DuplicateProviderIdError`'ın fix notu. Bilinmeyen bir id'yi
   * değiştirmeye çalışmak da reddedilir (bu bir "replace" değil, gizlenmiş
   * bir "register" olurdu); `registerProvider()` kullanılmalıdır.
   *
   * P1 fix (29th independent review round, finding 2, "provider replacement
   * must require policy + approval + audit"): this used to be an
   * unconditional, unauthenticated public mutation — ANY caller holding a
   * `ModelGateway` reference could silently redirect every future "trusted"
   * call for a live provider id to a completely different implementation,
   * with audit evidence recorded only best-effort (or not at all, if no
   * `AuditLog` happened to be supplied at construction). Since the adapter
   * bound to a provider id is the ONLY thing standing between an authorized,
   * budget-reserved `invoke()` and an ACTUAL external side effect, swapping
   * it is exactly the kind of action baseline section 147's default-deny
   * policy gate exists for. Fixed: replacement now goes through the SAME
   * `CapabilityGateway.authorize()` every risky Factory action passes
   * through (bkz. `invoke()`'in kendi çağrısı) — a genuine `PolicyEngine`
   * DENY blocks the swap entirely, a risk-5 replacement is unconditionally
   * `APPROVAL_REQUIRED` (the SAME built-in floor every other risky action
   * enforces) unless a genuine, pre-registered approval (`context.approvalId`,
   * resolved against THIS gateway's own `#approvals` store — never a
   * caller-supplied workflow object) is presented, and the swap is
   * UNCONDITIONALLY required to generate durable audit evidence — a
   * `ModelGateway` with no `AuditLog` cannot call this method at all (bkz.
   * `ProviderReplacementAuditRequiredError`'ın fix notu). The recorded event
   * captures BOTH the previous and replacement adapter's own implementation
   * identity (its constructor name — the only distinguishing identity a
   * `ModelProvider` exposes beyond the id, which is intentionally UNCHANGED
   * by a replace), so a legitimate reviewer can see that a REAL swap
   * happened, not merely a same-instance no-op.
   */
  async replaceProvider(provider: ModelProvider, context: ProviderReplacementContext): Promise<void> {
    // P1 fix (32nd independent review round, finding 6, "snapshot provider
    // id once before duplicate checking" — same root class as
    // `registerProvider()`'s own fix above, applied here too since this
    // method ALSO reads `provider.id` repeatedly): `id` is now read exactly
    // once, and every subsequent use below (the existing-provider lookup,
    // the "unknown provider" error, the description default, the audit
    // payload, and the final `#providers.set()`/`captureProviderBinding()`
    // call) derives from this SAME snapshot — a getter/Proxy-backed
    // `provider` cannot answer differently at the lookup step than it does
    // at the swap step.
    const id = provider.id;
    const existingProvider = this.#providers.get(id);
    if (!existingProvider) {
      throw new UnknownProviderError(id);
    }
    if (!this.#auditLog) {
      throw new ProviderReplacementAuditRequiredError(id);
    }
    const auditLog = this.#auditLog;
    const capabilityGateway = new CapabilityGateway(context.policy, this.#approvals);
    const approvalReference = context.approvalId !== undefined ? { approvalId: context.approvalId } : undefined;
    // P1 fix (34th independent review round, finding 4, "bind provider-
    // replacement approval to the implementation"): snapshotted HERE, in
    // this method's own synchronous prefix — BEFORE `authorize()` (and
    // therefore before any approval-matching or execution) ever runs — so
    // the digest genuinely captures the CANDIDATE `provider` this call was
    // actually invoked with, not a later, possibly-different read. Binding
    // both the implementation's constructor name AND its actual `invoke`
    // source text (`Function.prototype.toString()`) means two DIFFERENT
    // implementations sharing the same provider id/class name (or vice
    // versa) still produce different digests — an approval genuinely
    // requested for one candidate's exact digest cannot authorize
    // installing a materially different implementation under the same id.
    //
    // P1 fix (37th independent review round, finding 1, "bind provider
    // approval to the genuinely installed snapshot"): `resolvedAccessors` is
    // read HERE, exactly once, and threaded into BOTH this digest
    // computation AND the later `captureProviderBinding()` call inside the
    // approved callback below — bkz. `resolveProviderAccessors()`'ın
    // üstündeki fix notu. Previously each call independently re-invoked
    // every accessor property off the live `provider` object, so a
    // stateful/Proxy-backed getter could answer differently at digest time
    // than it did at install time, letting an approval genuinely granted
    // for configuration A silently install configuration B.
    const resolvedAccessors = resolveProviderAccessors(provider, id);
    const candidateDigest = computeProviderReplacementIdentityDigest(provider, id, resolvedAccessors);

    await capabilityGateway.authorize(
      {
        actionType: "model.provider.replace",
        risk: context.risk,
        description: context.description ?? `Replace provider adapter '${id}'`,
        projectId: context.projectId,
        identityDigest: candidateDigest
      },
      () => {
        // P1 fix (30th independent review round, finding 6, "provider
        // replacement must rollback if audit fails"): this used to swap
        // `this.#providers` FIRST, then call `auditLog.append(...)` — if
        // the append call itself threw (a corrupted/durable-storage-backed
        // `AuditLog` implementation failing to write, for instance), the
        // provider binding was ALREADY replaced in memory, yet the promise
        // this method returns rejects, giving every caller the impression
        // the replacement never happened — a real, live architectural
        // mutation with NO corresponding audit evidence, exactly what
        // `ProviderReplacementAuditRequiredError` exists to make
        // structurally impossible.
        //
        // P1 fix (35th independent review round, finding 11, "prepare
        // provider binding before recording replacement"): the round-30
        // fix above still left ONE gap of the exact same shape, one step
        // earlier: `captureProviderBinding(provider, id)` was called
        // INLINE, as part of the `this.#providers.set(...)` expression,
        // AFTER `auditLog.append(...)` had already durably recorded
        // "MODEL_PROVIDER_REPLACED". Since the 35th round's own finding 5
        // fix made `captureProviderBinding()` (via `detachFromCallerMutation()`)
        // capable of THROWING — `UnsafeProviderConfigurationError`, for a
        // candidate whose configuration cannot be safely locked — a
        // candidate that fails to bind would leave the audit log
        // truthfully-looking but factually WRONG: a durable
        // "MODEL_PROVIDER_REPLACED" record for a swap that never actually
        // happened, with the ORIGINAL provider still authoritative in
        // `this.#providers`. Fixed by building the binding FIRST: the
        // candidate is validated and locked into an authoritative
        // `ProviderBinding` value BEFORE anything is recorded or applied.
        // Only once that succeeds does the durable audit event get
        // appended, and only then does the actual swap
        // (`this.#providers.set`) run — all three steps in the SAME
        // synchronous tick (no `await` between any of them), so nothing
        // else can observe an intermediate state. If `captureProviderBinding()`
        // throws, NEITHER the audit record NOR the swap ever happens — the
        // original provider binding remains fully authoritative, and the
        // thrown error propagates out of `replaceProvider()` truthfully
        // reflecting that nothing changed. If `auditLog.append()` itself
        // then throws, the swap still never runs, preserving the round-30
        // fix's own guarantee unchanged.
        //
        // P1 fix (37th independent review round, finding 1): `resolvedAccessors`
        // (the SAME single reading computed above, before `authorize()` ever
        // ran) is passed through here too — never a fresh re-invocation of
        // the candidate's own getters — so the installed binding is
        // guaranteed to reflect EXACTLY the configuration the approval
        // digest above was computed from.
        const binding = captureProviderBinding(provider, id, resolvedAccessors);
        auditLog.append({
          type: "MODEL_PROVIDER_REPLACED",
          actor: "ModelGateway",
          payload: {
            providerId: id,
            previousImplementation: existingProvider.implementationName,
            newImplementation: provider.constructor?.name ?? "unknown"
          },
          timestamp: new Date().toISOString()
        });
        this.#providers.set(id, binding);
      },
      approvalReference
    );
  }

  hasProvider(id: string): boolean {
    return this.#providers.has(id);
  }

  /**
   * TEK genel invocation API'si — bir gerçek sağlayıcıya ulaşan TEK yol
   * budur. Sıra HER ZAMAN: PolicyEngine (ALLOW zorunlu) -> BudgetGuard
   * rezervasyonu (tahmini maliyet, provider çağrılmadan ÖNCE atomik olarak
   * ayrılır) -> provider çağrısı -> mutabakat (`commit()` başarıda,
   * `release()` provider hata fırlatırsa). Bu ikisi arasına HİÇBİR
   * "kısayol" eklenemez çünkü hepsi AYNI fonksiyon gövdesinde yaşar.
   *
   * P1 fix (11th independent review round, "caller context mutation can
   * change cost ownership during invocation"): Codex reproduced: bir
   * çağıran $0.60'ı proje A için rezerve eder, provider çağrısı
   * BAŞLAR, çağıran `await` SÜRERKEN `context.projectId`'yi B'ye
   * MUTASYONA UĞRATIR, ve mutabakat (commit) daha sonra ORİJİNAL
   * `context` nesnesini TEKRAR OKUDUĞU için maliyet B'ye kaydedilir —
   * A'nın rezervasyonu A'nın hiçbir zaman gerçek bir harcamayla
   * eşleşmediği, ve tekrarlanan çağrılarla A'nın görev tavanının
   * TAMAMEN atlatılabileceği anlamına gelir. Kök neden: `context`
   * çağıranın hâlâ bir referansını tuttuğu, sıradan (donmamış) bir
   * nesnedir, ve eski kod `context.taskId`/`context.projectId`'yi HEM
   * rezervasyon anında HEM DE (bir `await`den SONRA) mutabakat anında
   * AYRI AYRI okuyordu — ikisi arasında farklı değerler görebilirdi.
   * Fix: TÜM yetkili "sahiplik" alanları (taskId, projectId, risk,
   * description, model kimliği) herhangi bir asenkron iş BAŞLAMADAN
   * ÖNCE, donmuş/ayrık bir `executionScope` anlık görüntüsüne
   * KOPYALANIR (`freezeRecord`); `policy`/`budget` REFERANSLARI da aynı
   * anda yerel `const`'lara yakalanır (bir JS referansı yakalandıktan
   * SONRA, `context.policy = ...` gibi bir mutasyon o yerel değişkeni
   * ETKİLEMEZ). Bundan sonra kodun HİÇBİR YERİNDE `context.xxx`
   * DOĞRUDAN tekrar okunmaz — rezervasyon, provider çağrısı VE mutabakat
   * SADECE bu anlık görüntüyü kullanır. Çağıranın `context`'i
   * (paylaşılan/tekrar kullanılan bir nesne olsa bile) invoke() bu
   * anlık görüntüyü aldıktan SONRA yaptığı hiçbir mutasyon, bu ÇALIŞAN
   * invocation'ı ASLA etkileyemez — eşzamanlı iki invoke() çağrısı AYNI
   * paylaşılan `context` nesnesini kullansa bile, her biri KENDİ
   * senkron ön ekinde (herhangi bir await'ten önce) kendi bağımsız anlık
   * görüntüsünü alır, bu yüzden birbirlerini kirletemezler.
   */
  /**
   * P1 fix (12th independent review round, "model identity snapshot is
   * not used during provider execution"): Codex reproduced the
   * `executionScope` snapshot above capturing `model.modelId`/
   * `model.provider`/`model.costPerCall` for ACCOUNTING purposes, but the
   * ORIGINAL, caller-owned `model` object was still what actually got
   * passed into `#rawInvoke(model, request)` — so a caller mutating the
   * `model` object's fields (id, provider, tier, costPerCall) WHILE the
   * provider call was pending could make the ACTUAL provider invocation
   * (and, if a real adapter reads `model` lazily, its costUsd) diverge
   * from the identity that was authorized/reserved/accounted for, even
   * though `executionScope`'s COPY of those same fields stayed correct.
   * A snapshot that isn't the thing actually used protects nothing. Fix:
   * `model` is copied into a frozen, detached `authorizedModel`
   * (`freezeRecord`) as the very FIRST thing `invoke()` does — before
   * `executionScope` is even built (which now reads from
   * `authorizedModel`, not `model`) and certainly before any async work
   * — and `authorizedModel` (never the original `model` parameter) is
   * what gets passed to `#rawInvoke()`. `capabilities` is an array field;
   * `freezeRecord` freezes a COPY of it too, so `model.capabilities.push(...)`
   * afterward cannot even reach the snapshot's array.
   *
   * P1 fix (13th independent review round, "provider/model identity can
   * still change accounting and audit evidence"): the 12th round's fix
   * above closed the gap for the ACTUAL PROVIDER CALL (`#rawInvoke` now
   * receives `authorizedModel`), but `commit()` (below) was STILL called
   * with `provider: response.provider, modelId: response.modelId` — i.e.
   * the IDENTITY FIELDS of the raw response the provider itself returned,
   * not the authorized identity that was reserved. Since `response` comes
   * from an external `ModelProvider.invoke()` implementation (untrusted
   * from this class's point of view — a misbehaving or compromised
   * provider adapter could return ANY `modelId`/`provider` string it
   * likes), accounting/audit/reconciliation could be silently redefined
   * by the PROVIDER'S OWN RETURN VALUE even with the model-mutation gap
   * closed. The required invariant is: AUTHORIZE one identity -> INVOKE
   * that identity -> ACCOUNT that SAME identity -> RECONCILE that SAME
   * identity -> AUDIT that SAME identity — no response object may
   * redefine it. Fixed: `commit()` is now called with
   * `provider: authorizedModel.provider, modelId: authorizedModel.modelId`
   * — the PRE-AUTHORIZED snapshot — never `response.provider`/
   * `response.modelId`. `response.costUsd` is still used for the actual
   * dollar AMOUNT (a provider legitimately reports what a call actually
   * cost; that is not an identity field), but a provider can no longer
   * redirect WHOSE ledger that amount lands on. `authorizedModel.provider`/
   * `.modelId` are also now passed to `budget.reserve()` (see below), so
   * `commit()`'s own ownership-mismatch check (runtime/budget/budget.ts)
   * independently re-verifies this at the reservation layer too —
   * defense in depth, not reliance on this call site alone getting it
   * right.
   */
  async invoke(
    model: ModelRecord,
    request: ModelInvocationRequest,
    context: ModelInvocationContext
  ): Promise<ModelInvocationResponse> {
    // Herhangi bir asenkron iş BAŞLAMADAN ÖNCE: yetkili, ayrık model
    // kimliği anlık görüntüsü — bkz. yukarıdaki fix notu. Bundan sonra
    // `model` parametresinin KENDİSİ bir daha ASLA okunmaz/geçirilmez;
    // sadece `authorizedModel` kullanılır.
    const authorizedModel: ModelRecord = freezeRecord({ ...model });

    // P1 fix (13th independent review round, "invocation payload remains
    // caller-mutable during execution"): Codex reproduced `request`
    // (prompt/taskType) being passed DIRECTLY into `#rawInvoke(model,
    // request)` with no snapshot of its own — a caller mutating
    // `request.prompt`/`.taskType` WHILE the provider call was pending
    // (the SAME microtask-ordering scenario proven for `model` above)
    // could make a replacement payload execute under the authorization/
    // budget already reserved for the ORIGINAL prompt. Fixed the same
    // way: `request` is copied into a frozen, detached `authorizedRequest`
    // in this same synchronous prefix, before any await, and
    // `authorizedRequest` (never the original `request` parameter) is
    // what gets passed to `#rawInvoke()`.
    const authorizedRequest: ModelInvocationRequest = freezeRecord({ ...request });

    // Herhangi bir asenkron iş (hatta CapabilityGateway.authorize()'ın
    // KENDİSİ) başlamadan ÖNCE: yetkili sahiplik anlık görüntüsü.
    const executionScope = freezeRecord({
      taskId: context.taskId,
      projectId: context.projectId,
      // P1 fix (31st independent review round, finding 2, "preserve run
      // and agent ownership through model invocations"): captured into
      // the SAME frozen snapshot, at the SAME synchronous-prefix point,
      // as every other authoritative ownership field — bkz.
      // `ModelInvocationContext.runId`/`.agentId`'in üstündeki fix notu.
      runId: context.runId,
      agentId: context.agentId,
      risk: context.risk,
      description:
        context.description ??
        `Invoke model '${authorizedModel.modelId}' (${authorizedModel.tier}) for task ${context.taskId}`,
      modelId: authorizedModel.modelId,
      provider: authorizedModel.provider,
      costPerCallUsd: authorizedModel.costPerCall
    });
    // `policy`/`budget` REFERANSLARI da hemen yakalanır — bkz. yukarıdaki
    // fix notu. `context.policy`/`context.budget`'a bundan sonra ASLA
    // tekrar erişilmez.
    const budget = context.budget;
    // P1 fix (11th independent review round, "supplied capability gateway
    // can bypass authoritative policy"): eskiden `context.capabilityGateway
    // ?? new CapabilityGateway(context.policy)` idi — bir çağıran YETKİLİ
    // (ör. default-DENY) bir `policy` sağlarken AYNI ZAMANDA bunu
    // TAMAMEN görmezden gelen, ALLOW-her-şeyi bir politikayla kurulmuş
    // ayrı bir `capabilityGateway` da sağlayabilir ve `authorize()`
    // ikincisini kullanırdı — `context.policy` HİÇBİR ZAMAN
    // `evaluate()` çağırmaz, sıfır audit kaydı üretilirdi. Enjekte
    // edilebilir bir `capabilityGateway` artık TİPTE BİLE YOK (bkz.
    // `ModelInvocationContext`) — TEK yetkilendirme yolu, HER ÇAĞRIDA
    // doğrudan `context.policy`'den TAZE inşa edilen BU
    // `CapabilityGateway`'dir.
    //
    // P1 fix (25th independent review round, "approval evidence must flow
    // through model invocation path"): `this.#approvals` (this gateway's
    // OWN authoritative store, injected once at construction — bkz.
    // yukarıdaki `#approvals`'ın fix notu) is now passed as the SECOND
    // constructor argument, so a genuine, pre-registered approval can
    // actually be found and validated for a risk-5 invocation — before
    // this fix, a brand new, always-empty `ApprovalWorkflow` was
    // implicitly constructed here on every call, making APPROVAL_REQUIRED
    // model invocations structurally unauthorizable.
    const capabilityGateway = new CapabilityGateway(context.policy, this.#approvals);
    // `approval` bağlantısı yalnızca bir `approvalId` REFERANSIDIR — bir
    // `ApprovalWorkflow` NESNESİ asla değil (bkz. `ApprovalReference`'ın
    // fix notu) — ve eylemin TAM kimliğine (actionType/description/risk/
    // costUsd/projectId) bağlanır, tıpkı `CapabilityGateway.authorize()`'ın
    // her çağıran için zaten uyguladığı gibi.
    const approvalReference = context.approvalId !== undefined ? { approvalId: context.approvalId } : undefined;

    return capabilityGateway.authorize(
      {
        actionType: "model.invoke",
        risk: executionScope.risk,
        description: executionScope.description,
        costUsd: executionScope.costPerCallUsd,
        projectId: executionScope.projectId,
        // P1 fix (34th independent review round, finding 3, "bind approvals
        // to the exact model invocation"): `actorId` used to be left
        // unset here entirely — meaning it was ALWAYS `undefined` on both
        // this action and (absent an explicit `options.actorId` at
        // `requestFor()` time) the approval request itself, so the
        // `actorId` comparison `isBoundToExactAction()` already performs
        // trivially matched `undefined === undefined` for every model
        // invocation regardless of WHICH agent actually invoked it. Now
        // populated from `executionScope.agentId` (the SAME pre-authorized
        // snapshot `budget.reserve()`/`commit()` below already use), so an
        // approval genuinely scoped to one agent cannot authorize a
        // materially different agent's invocation.
        actorId: executionScope.agentId,
        // Binds every OTHER dimension this finding names that `PolicyAction`
        // has no dedicated field for — task, run, provider, model, and the
        // actual prompt/request payload — into one exact-match digest (bkz.
        // `identityDigestOf()`'in fix notu yukarıda). Every value here is
        // already an authoritative, pre-authorized snapshot (`executionScope`/
        // `authorizedModel`/`authorizedRequest`), never re-read from the
        // caller's own, potentially-mutated `context`/`model`/`request`.
        identityDigest: computeModelInvocationIdentityDigest({
          taskId: executionScope.taskId,
          runId: executionScope.runId,
          agentId: executionScope.agentId,
          provider: authorizedModel.provider,
          modelId: authorizedModel.modelId,
          prompt: authorizedRequest.prompt,
          // P1 fix (35th independent review round, finding 4): bkz.
          // `computeModelInvocationIdentityDigest()`'in fix notu —
          // `authorizedRequest` (the pre-authorized snapshot, never the
          // original, still-caller-mutable `request` parameter) supplies
          // `taskType` the same way it already supplies `prompt`.
          taskType: authorizedRequest.taskType
        })
      },
      async () => {
        // Provider ÇAĞRILMADAN ÖNCE, tahmini maliyet (costPerCall) TÜM
        // ilgili tavanlara (mevcut açık rezervasyonlar dahil) karşı ATOMİK
        // olarak ayrılır — 10th independent review round fix, bkz.
        // runtime/budget/budget.ts'deki `reserve()` notu. Yetersiz bütçe,
        // hiçbir provider çağrısı yapılmadan reddeder (fail closed).
        // P1 fix (13th independent review round, "reservation ownership
        // checks omit agent identity" / "provider/model identity can
        // still change accounting"): `provider`/`modelId` are now part of
        // what's reserved too (from `authorizedModel`, the pre-authorized
        // snapshot) — `budget.ts`'s `commit()` independently validates
        // these against what is ACTUALLY committed, so even if this call
        // site's own commit() call below were ever changed incorrectly,
        // the reservation layer itself still fails closed.
        // P1 fix (31st independent review round, finding 2): `runId`/
        // `agentId` now flow into the reservation's own authoritative
        // scope, the SAME way `taskId`/`projectId`/`provider`/`modelId`
        // already do — without this, `perRunUsd` could never actually be
        // enforced for a real model invocation, and no committed entry
        // could ever be attributed to an agent.
        const reservation = budget.reserve(
          {
            taskId: executionScope.taskId,
            projectId: executionScope.projectId,
            runId: executionScope.runId,
            agentId: executionScope.agentId,
            provider: authorizedModel.provider,
            modelId: authorizedModel.modelId
          },
          executionScope.costPerCallUsd
        );

        let response: ModelInvocationResponse;
        try {
          const rawResponse = await this.#rawInvoke(authorizedModel, authorizedRequest);
          // P1 fix (36th independent review round, finding 6, "snapshot
          // provider responses before validation"): `#rawInvoke()` returns
          // `provider.invoke(...)`'s result VERBATIM — the exact same
          // object reference the provider adapter itself constructed and
          // may still hold onto (e.g. a provider that caches or logs its
          // own last response). Without detaching it here, EVERY later
          // consumer of `response` — this method's own `response.costUsd`
          // billing read below, the caller this promise resolves to, and
          // that caller's own downstream validation (e.g. `router.ts`'s
          // `routeAndExecute()` calls a caller-supplied
          // `validate(response)` predicate AFTER `invoke()` returns) — all
          // observe the SAME live, provider-owned object. A provider that
          // mutates `output`/`costUsd` on that object after returning it
          // (whether via a stray reference it kept, or a hostile/buggy
          // adapter) could let content pass a caller's validation and then
          // change before that same caller actually uses it — exactly the
          // "validate what you got, not what changed after" gap this
          // codebase's own established pattern (bkz. `authorizedModel`/
          // `authorizedRequest`/`executionScope` above, all `freezeRecord`d
          // the moment they are read, never re-read from a caller-owned
          // source afterward) already closes for every OTHER value this
          // method touches. Fixed the same way: a fresh, detached, frozen
          // copy is taken immediately, before this method's own billing
          // read and before the response is ever handed back to a caller —
          // every subsequent read anywhere (here, in the caller, in that
          // caller's own validation) sees this exact, immutable snapshot.
          response = freezeRecord({ ...rawResponse });
        } catch (err) {
          // P1 fix (33rd independent review round, finding 1 / root class
          // F, "billable provider failure reconciliation"): the OLD,
          // documented mutabakat kuralı ("provider hata fırlatırsa hiçbir
          // gerçek maliyet oluşmadığı varsayılır") is exactly the "provider
          // threw == cost is zero" assumption this round's finding
          // forbids — bkz. `ProviderInvocationError`'ın üstündeki fix
          // notu for the full three-way classification this replaces it
          // with. `executionScope`/`authorizedModel` (the SAME
          // pre-authorized snapshots `budget.reserve()` above and the
          // success-path `budget.commit()` below already use — never
          // `context` again) supply the identity for every branch here,
          // consistent with this method's own 13th/31st round fix notes.
          const failure = classifyProviderFailure(err);
          if (failure.billingStatus === "NOT_BILLED") {
            budget.release(reservation.id, reservation.scope);
          } else if (failure.billingStatus === "BILLED" && failure.incurredCostUsd !== undefined) {
            budget.commit(reservation.id, {
              taskId: executionScope.taskId,
              projectId: executionScope.projectId,
              runId: executionScope.runId,
              agentId: executionScope.agentId,
              provider: authorizedModel.provider,
              modelId: authorizedModel.modelId,
              amountUsd: failure.incurredCostUsd
            });
          } else {
            // "BILLED" with no known exact amount, "UNKNOWN", or (the
            // fail-closed default) an unclassified plain Error — never
            // silently erase possible real spend.
            budget.markProviderFailureUnresolved(reservation.id, reservation.scope);
          }
          throw err;
        }

        // Gerçek maliyet, validate() çağrılmadan ÖNCE ve KOŞULSUZ olarak
        // kaydedilir — bir çıktının sonradan geçersiz sayılması, zaten
        // gerçekleşmiş harcamanın kayıtlardan düşmesine ASLA yol açmaz.
        // taskId/projectId, `context`'ten DEĞİL, `executionScope`
        // anlık görüntüsünden okunur (bkz. yukarıdaki fix notu) — bu
        // await'ten SONRA çağıranın `context`'i mutasyona uğramış olsa
        // bile, mutabakat HER ZAMAN rezervasyonun sahibiyle AYNI kapsamı
        // kullanır. P1 fix (13th independent review round, "provider/model
        // identity can still change accounting and audit evidence"):
        // `provider`/`modelId` are now taken from `authorizedModel` (the
        // PRE-AUTHORIZED identity snapshot), NOT from `response.provider`/
        // `response.modelId` — a provider adapter's own return value can
        // no longer redefine WHOSE ledger a cost lands on, even though its
        // reported `costUsd` (a legitimate actual-amount value, not an
        // identity field) is still used for the dollar amount recorded.
        // P1 fix (31st independent review round, finding 2): `runId`/
        // `agentId` are read from `executionScope` (the pre-authorized
        // snapshot), never from `context` again — the SAME "authorize one
        // identity, account that SAME identity" invariant this method's
        // own fix notes above already establish for `taskId`/`projectId`/
        // `provider`/`modelId`, extended to the two new ownership
        // dimensions. `budget.commit()`'s own ownership-mismatch check
        // (cost-engine.ts's `ownershipMismatches()`) independently
        // re-verifies `runId`/`agentId` against what was actually reserved
        // — defense in depth, not reliance on this call site alone.
        budget.commit(reservation.id, {
          taskId: executionScope.taskId,
          projectId: executionScope.projectId,
          runId: executionScope.runId,
          agentId: executionScope.agentId,
          provider: authorizedModel.provider,
          modelId: authorizedModel.modelId,
          amountUsd: response.costUsd
        });

        return response;
      },
      approvalReference
    );
  }

  /**
   * HAM sağlayıcı çağrısı. Gerçek bir ECMAScript private metodu (`#`) —
   * bu sınıfın DIŞINDAN (bir proof, bir test, başka bir modül) HİÇBİR
   * ŞEKİLDE, hatta bir tip atlatmasıyla bile erişilemez (bkz. `#providers`
   * üstündeki not). PolicyEngine/BudgetGuard'ı atlayan tek yol, bu metoda
   * doğrudan erişim olurdu — artık bu erişim JS çalışma zamanının kendisi
   * tarafından engellenir, bir geliştirici sözleşmesi/kongvansiyonu
   * değil.
   */
  async #rawInvoke(model: ModelRecord, request: ModelInvocationRequest): Promise<ModelInvocationResponse> {
    const provider = this.#providers.get(model.provider);
    if (!provider) throw new UnknownProviderError(model.provider);
    return provider.invoke(model, request);
  }
}
