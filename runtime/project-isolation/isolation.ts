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

export class ProjectIsolationStore<T> {
  private readonly data = new Map<string, Map<string, T>>();

  /** Bir proje yalnızca kendi adına veri yazabilir. */
  set(projectId: string, key: string, value: T): void {
    const bucket = this.data.get(projectId) ?? new Map<string, T>();
    bucket.set(key, value);
    this.data.set(projectId, bucket);
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
