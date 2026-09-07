// Baseline section 86 (Project Isolation): "Cross-project: DEFAULT DENY."
// Bu depo, birden çok projeyi aynı süreçte barındırabilir; bir projenin
// kodu/ajanı, başka bir projenin verisine YANLIŞLIKLA bile erişememelidir.

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
  private readonly data = new Map<string, Map<string, T>>();

  /**
   * `trustedProjectId`, bu depoyu kuran/yönlendiren GÜVENİLİR koddan
   * gelmelidir (ör. zaten kendi proje kimliğini yetkilendirmiş bir
   * orkestratör) — döndürülen `ProjectIsolationView`'in KENDİ metodları
   * hiçbir proje kimliği parametresi almadığından, bu view'i elinde tutan
   * bir çağıran BAŞKA bir projeye asla geçemez; bunu deneyebileceği bir
   * argüman bile yoktur.
   */
  viewFor(trustedProjectId: string): ProjectIsolationView<T> {
    const data = this.data;
    return {
      set(key: string, value: T): void {
        const bucket = data.get(trustedProjectId) ?? new Map<string, T>();
        bucket.set(key, value);
        data.set(trustedProjectId, bucket);
      },
      get(key: string): T | undefined {
        return data.get(trustedProjectId)?.get(key);
      },
      keys(): readonly string[] {
        return [...(data.get(trustedProjectId)?.keys() ?? [])];
      }
    };
  }
}
