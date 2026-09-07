// Baseline section 123 (Artifact System): kod, doküman, build çıktısı,
// test kanıtı, ekran görüntüsü gibi üretilen çıktıları sınıflandırır ve
// kaydeder. Bu, "no claim without evidence" ilkesinin (bölüm 303) somut
// bir dayanağıdır — bir kanıt (proof/test sonucu) iddiaya bağlanacaksa,
// önce bir Artifact kaydı olarak var olmalıdır.

import { freezeRecord } from "../util/immutable.js";

export type ArtifactClass =
  | "code"
  | "docs"
  | "binaries"
  | "builds"
  | "tests"
  | "screenshots"
  | "video"
  | "logs"
  | "datasets"
  | "models"
  | "textures"
  | "3d"
  | "audio"
  | "game-packages";

export interface ArtifactRecord {
  readonly id: string;
  readonly artifactClass: ArtifactClass;
  readonly path: string;
  readonly projectId: string;
  readonly createdAt: string;
  readonly checksum?: string;
}

export class DuplicateArtifactError extends Error {
  constructor(id: string) {
    super(`Artifact id '${id}' is already registered`);
    this.name = "DuplicateArtifactError";
  }
}

export interface RegisterArtifactInput {
  readonly id: string;
  readonly artifactClass: ArtifactClass;
  readonly path: string;
  readonly projectId: string;
  readonly checksum?: string;
}

/**
 * P1 fix (4th independent review round, targeted follow-up ownership
 * audit): get()/allFor()/findByClass() previously returned the internal
 * ArtifactRecord objects directly — mutating a returned record's `path`
 * or `checksum` after the fact would silently swap what evidence a proof
 * reference actually points to, without a new register() event, directly
 * undermining "no claim without evidence" (bölüm 303: the record backing
 * a claim must be exactly what was registered). Every read now returns a
 * frozen, detached snapshot.
 */
export class ArtifactRegistry {
  /**
   * P1 targeted-audit fix (26th independent review round, same root class
   * as finding 2, "cost ledger state must be runtime-private"): a
   * compile-time-only `private` Map leaves an ordinary, enumerable
   * instance property in the emitted JS — `(registry as any).artifacts.set(
   * id, forgedRecord)` could inject a fabricated evidence record that
   * never went through `register()`'s duplicate-id check, or silently swap
   * an EXISTING record's `path`/`checksum`, directly defeating "no claim
   * without evidence" (bölüm 303: the record backing a claim must be
   * exactly what was registered — see this class's own fix note above).
   * A genuine ECMAScript private field (`#artifacts`) closes this the same
   * way `audit-log.ts`'s `#records` already does.
   */
  #artifacts = new Map<string, ArtifactRecord>();

  /** Aynı id ile iki kez kayıt, sessizce üzerine yazmak yerine reddedilir. */
  register(input: RegisterArtifactInput): ArtifactRecord {
    if (this.#artifacts.has(input.id)) {
      throw new DuplicateArtifactError(input.id);
    }
    const record: ArtifactRecord = { ...input, createdAt: new Date().toISOString() };
    this.#artifacts.set(input.id, record);
    return freezeRecord(record);
  }

  get(id: string): ArtifactRecord | undefined {
    const record = this.#artifacts.get(id);
    return record ? freezeRecord(record) : undefined;
  }

  allFor(projectId: string): readonly ArtifactRecord[] {
    return [...this.#artifacts.values()].filter((a) => a.projectId === projectId).map((a) => freezeRecord(a));
  }

  findByClass(artifactClass: ArtifactClass): readonly ArtifactRecord[] {
    return [...this.#artifacts.values()].filter((a) => a.artifactClass === artifactClass).map((a) => freezeRecord(a));
  }
}
