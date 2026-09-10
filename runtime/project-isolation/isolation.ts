// Baseline section 86 (Project Isolation): "Cross-project: DEFAULT DENY."
// Bu depo, birden çok projeyi aynı süreçte barındırabilir; bir projenin
// kodu/ajanı, başka bir projenin verisine YANLIŞLIKLA bile erişememelidir.

import { deepFreezeClone } from "../util/immutable.js";

/**
 * P1 fix (25th independent review round, "project isolation must use
 * trusted project identity"): the previous API —
 * `set(callerProjectId, targetProjectId, key, value)` /
 * `get(callerProjectId, targetProjectId, key)` / `keysFor(callerProjectId,
 * targetProjectId)` — "enforced" isolation by comparing TWO caller-supplied
 * strings and rejecting a mismatch. That is not a trust boundary at all:
 * NOTHING stops a caller from simply passing the SAME value for both
 * `callerProjectId` and `targetProjectId` — `store.set(targetProjectId,
 * targetProjectId, key, value)` sails through the `callerProjectId !==
 * targetProjectId` check trivially, regardless of which project the code
 * making that call actually belongs to. A runtime check comparing two
 * values the SAME caller controls can never establish who the caller
 * genuinely is; it only checks that the caller typed the same string
 * twice. Required invariant: project identity must come from a TRUSTED
 * context established OUTSIDE the caller-controlled arguments of the
 * read/write call itself (baseline section 86's "default deny" only means
 * something if the "who is asking" side of the check cannot be forged by
 * the very code being checked).
 *
 * Fixed with a capability/closure model, exactly mirroring the "trust
 * established once, at construction/wiring time, not per call" pattern
 * already used for `CapabilityGateway`'s `approvals` field (round 25,
 * finding 1) and `ModelGateway`'s `#approvals` field (round 25, finding
 * 6): `viewFor(trustedProjectId)` is called ONCE, by whoever assembles a
 * project's execution context (e.g. an orchestrator that has ALREADY
 * authorized which project it is bootstrapping/running — never by
 * arbitrary task code deep inside a request path), and returns a
 * `ProjectIsolationView<T>` closed over BOTH this store's own private
 * `data` map AND that one fixed `trustedProjectId`. The view's own
 * `set()`/`get()`/`keys()` methods take NO project-id parameter
 * whatsoever — there is no argument left through which a caller holding
 * one project's view could ever name a DIFFERENT project, let alone
 * supply the same value twice to slip past a comparison. Cross-project
 * access is not merely rejected at runtime here; it is inexpressible by
 * the view's own type signature. The old dual-string API and
 * `CrossProjectAccessDeniedError` are removed entirely — there is nothing
 * left for a caller to defeat by matching its own arguments to each
 * other.
 */
export interface ProjectIsolationView<T> {
  /** Yalnızca bu view'in bağlı olduğu projenin kendi verisine yazar. */
  set(key: string, value: T): void;
  /** Yalnızca bu view'in bağlı olduğu projenin kendi verisini okur. */
  get(key: string): T | undefined;
  /** Bu view'in bağlı olduğu projenin kendi anahtarlarının listesi. */
  keys(): readonly string[];
}

export class ProjectIsolationStore<T> {
  /**
   * P1 targeted-audit fix (26th independent review round, same root class
   * as finding 2, "cost ledger state must be runtime-private"): this
   * Map-of-Maps used to be declared with TypeScript's compile-time-only
   * `private` — in the emitted JS it is an ordinary, enumerable instance
   * property. This class's ENTIRE purpose (bölüm 86: "Cross-project:
   * DEFAULT DENY") is that a view returned by `viewFor()` can reach only
   * its own bound project's bucket; a caller with `(store as
   * any).data.get("other-project")` access would defeat that isolation
   * completely by reading or writing ANY project's bucket directly,
   * bypassing `viewFor()`'s capability model entirely. A genuine
   * ECMAScript private field (`#data`) closes this the same way every
   * other P0 authoritative store's field already does.
   */
  #data = new Map<string, Map<string, T>>();

  /**
   * `trustedProjectId`, bu depoyu kuran/yönlendiren GÜVENİLİR koddan
   * gelmelidir (ör. zaten kendi proje kimliğini yetkilendirmiş bir
   * orkestratör) — döndürülen `ProjectIsolationView`'in KENDİ metodları
   * hiçbir proje kimliği parametresi almadığından, bu view'i elinde tutan
   * bir çağıran BAŞKA bir projeye asla geçemez; bunu deneyebileceği bir
   * argüman bile yoktur.
   */
  viewFor(trustedProjectId: string): ProjectIsolationView<T> {
    const data = this.#data;
    return {
      // P2 fix (26th independent review round, finding 5, "detach values
      // across project isolation views"): `set()` used to store the
      // caller-supplied `value` REFERENCE directly — if the SAME mutable
      // object was stored under two different projects (or the caller
      // simply kept a reference and mutated it afterward), the store's
      // authoritative bucket for EVERY project holding that reference
      // changed too, silently breaching isolation without either project
      // ever explicitly writing to the other's bucket. `deepFreezeClone()`
      // (bkz. runtime/util/immutable.ts, the SAME primitive `audit-log.ts`
      // uses for its own "never mutable, from any angle" evidence) takes a
      // full `structuredClone()`-based deep copy — completely detached from
      // the caller's own object graph, sharing NO nested object/array
      // reference — and deep-freezes it before storing. Each project's
      // `set()` call, even for the identical input value, produces its OWN
      // independent copy; mutating the caller's original object (or a
      // value returned by `get()`) afterward can never reach — or be
      // reached by — another project's stored data.
      set(key: string, value: T): void {
        const bucket = data.get(trustedProjectId) ?? new Map<string, T>();
        bucket.set(key, deepFreezeClone(value));
        data.set(trustedProjectId, bucket);
      },
      // P2 fix (37th independent review round, finding 9, "mutable
      // collections escaping the trust boundary"): the comment this
      // replaced claimed the stored value "can never be mutated (attempting
      // to throws TypeError)" on the strength of `deepFreeze()` alone — true
      // for a plain object/array, but FALSE for a `Map`/`Set` (or any value
      // containing one at any depth): `Object.freeze()` only blocks adding/
      // removing/reassigning the object's OWN PROPERTIES, but `Map`/`Set`
      // store their entries in an internal slot, not as ordinary properties
      // — `.set()`/`.add()`/`.delete()` mutate that slot directly and are
      // completely unaffected by the object being frozen (bkz. `deepFreeze()`'ın
      // üstündeki fix notu, aynı sınıf). `get()` used to return the EXACT
      // SAME reference `set()` stored in this project's own bucket — a
      // caller holding a `Map`/`Set`-typed `T` could call `view.get(key).set(...)`/
      // `.add(...)` and silently mutate THIS project's own authoritative
      // bucket entry in place, corrupting every future `get()` for that key
      // with no error, no detection, and no distinguishable "this store is
      // supposed to be immutable" signal. Fixed by returning a FRESH
      // `deepFreezeClone()` of the retrieved value on every `get()` call —
      // completely detached from the stored bucket entry via its own
      // independent `structuredClone()` (which itself supports Map/Set,
      // preserving their entries) — so mutating whatever `get()` returns can
      // never reach back into this store's own authoritative state, exactly
      // mirroring the SAME detachment guarantee `set()` already provides on
      // the write side (bkz. yukarıdaki fix notu, 26. bağımsız inceleme
      // turu, bulgu 5).
      get(key: string): T | undefined {
        const value = data.get(trustedProjectId)?.get(key);
        return value === undefined ? undefined : deepFreezeClone(value);
      },
      keys(): readonly string[] {
        return [...(data.get(trustedProjectId)?.keys() ?? [])];
      }
    };
  }
}
