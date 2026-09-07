// Baseline section 86 (Project Isolation): "Cross-project: DEFAULT DENY."
// Bu depo, birden çok projeyi aynı süreçte barındırabilir; bir projenin
// kodu/ajanı, başka bir projenin verisine YANLIŞLIKLA bile erişememelidir.
// Bu basit anahtar-değer deposu, çağıranın proje kimliği ile hedef proje
// kimliği eşleşmediğinde erişimi reddeder — "varsayılan izin" değil
// "varsayılan red" ilkesini kod düzeyinde uygular.

export class CrossProjectAccessDeniedError extends Error {
  constructor(callerProjectId: string, targetProjectId: string) {
    super(
      `Project '${callerProjectId}' attempted to access project '${targetProjectId}''s data. ` +
        `Cross-project access is denied by default (baseline section 86).`
    );
    this.name = "CrossProjectAccessDeniedError";
  }
}

/**
 * P1 fix (24th independent review round, "project writes must require
 * caller identity"): `set()` used to accept only a SINGLE `projectId` —
 * the TARGET being written to — with no separate notion of WHO (which
 * project's own code/agent) was making the call. `get()`/`keysFor()`
 * already required BOTH a `callerProjectId` and a `targetProjectId` and
 * rejected a mismatch (bkz. `CrossProjectAccessDeniedError`), but `set()`
 * had no equivalent caller-vs-target check at all — any caller holding a
 * reference to this store could write into ANY project's bucket merely by
 * passing that project's id as the (unchecked) target, e.g. code running
 * "for" project A calling `store.set("project-B", ...)` and silently
 * mutating project B's data. Default deny (baseline section 86) must
 * apply to writes exactly as it already does to reads — a caller cannot
 * be trusted to self-report which project it is acting FOR unless that
 * claim is checked against the project it is actually trying to touch.
 */
export class ProjectIsolationStore<T> {
  private readonly data = new Map<string, Map<string, T>>();

  /**
   * Bir proje yalnızca kendi adına veri yazabilir — `callerProjectId` ile
   * `targetProjectId` eşleşmiyorsa CrossProjectAccessDeniedError fırlatılır,
   * `get()`/`keysFor()` ile AYNI kontrol, AYNI hata türü.
   */
  set(callerProjectId: string, targetProjectId: string, key: string, value: T): void {
    if (callerProjectId !== targetProjectId) {
      throw new CrossProjectAccessDeniedError(callerProjectId, targetProjectId);
    }
    const bucket = this.data.get(targetProjectId) ?? new Map<string, T>();
    bucket.set(key, value);
    this.data.set(targetProjectId, bucket);
  }

  /**
   * `callerProjectId` ile `targetProjectId` eşleşmiyorsa
   * CrossProjectAccessDeniedError fırlatılır — bu kontrolü atlayan bir
   * ikinci yol yoktur.
   */
  get(callerProjectId: string, targetProjectId: string, key: string): T | undefined {
    if (callerProjectId !== targetProjectId) {
      throw new CrossProjectAccessDeniedError(callerProjectId, targetProjectId);
    }
    return this.data.get(targetProjectId)?.get(key);
  }

  /** Bir projenin kendi anahtarlarının listesi (yine sadece kendi kapsamında). */
  keysFor(callerProjectId: string, targetProjectId: string): readonly string[] {
    if (callerProjectId !== targetProjectId) {
      throw new CrossProjectAccessDeniedError(callerProjectId, targetProjectId);
    }
    return [...(this.data.get(targetProjectId)?.keys() ?? [])];
  }
}
