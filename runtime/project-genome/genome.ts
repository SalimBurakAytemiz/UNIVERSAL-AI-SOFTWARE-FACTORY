// Baseline section 27 (Project Genome): bir projenin makine-okunur
// "genomu". Bu modül, geçersiz bir Project Genome nesnesinin sessizce
// kabul edilmesini önler (bölüm 280, "fail closed") — şema doğrulaması
// başarısız olursa, Organization Composer / Technology Engine gibi aşağı
// akış sistemleri hiç çalıştırılmamalıdır.

// Named import (not default) sidesteps a known ajv v8 + TypeScript
// "NodeNext" module resolution interop mismatch between its CJS build and
// ESM-style .d.ts (the named `Ajv` export resolves cleanly either way).
import { Ajv, type ValidateFunction } from "ajv";
import schema from "../../schemas/project-genome.schema.json" with { type: "json" };
import { assertValidProjectId } from "../sandbox/sandbox.js";
import { deepFreezeClone } from "../util/immutable.js";

export interface ProjectGenome {
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly family: string;
    readonly subtype?: string;
    readonly domain?: string;
  };
  readonly business?: { readonly model?: string; readonly capabilities?: readonly string[] };
  readonly requirements?: readonly string[];
  readonly [extra: string]: unknown;
}

export interface GenomeValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

let cachedValidator: ValidateFunction | undefined;

function getValidator(): ValidateFunction {
  if (!cachedValidator) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    cachedValidator = ajv.compile(schema);
  }
  return cachedValidator!;
}

export function validateProjectGenome(candidate: unknown): GenomeValidationResult {
  const validate = getValidator();
  const valid = validate(candidate);
  if (valid) return { valid: true, errors: [] };

  const errors = (validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message ?? ""}`.trim());
  return { valid: false, errors };
}

export class InvalidProjectGenomeError extends Error {
  constructor(errors: readonly string[]) {
    super(`Invalid Project Genome:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    this.name = "InvalidProjectGenomeError";
  }
}

/**
 * Doğrulamadan geçmeyen bir Genome nesnesini asla sessizce kabul etmez.
 * Şema doğrulaması `project.id`'nin sadece "boş olmayan bir string"
 * olduğunu garanti eder — bu, "../outside" gibi bir path-traversal
 * girişimini GEÇİRİR. Bu yüzden burada AYRICA assertValidProjectId()
 * çağrılır (bölüm 87): bir proje kimliği, aşağı akıştaki HİÇBİR
 * scaffolding/dosya sistemi adımına, güvenli bir tanımlayıcı biçimini
 * doğrulamadan ulaşamaz (fail closed, PROJECT ID -> VALIDATE akışının
 * ilk adımı).
 *
 * P1 fix (8th independent review round, "caller mutation changes project
 * identity during bootstrap"): eskiden `candidate as ProjectGenome` ile
 * ÇAĞIRANIN KENDİ nesne referansı (iç içe `project` nesnesi dahil)
 * doğrudan döndürülüyordu. Codex, `bootstrapProject()` için bir
 * `genomeCandidate` verilip henüz asenkron işlem tamamlanmadan ÇAĞIRANIN
 * `genomeCandidate.project.id`'yi A'dan B'ye DEĞİŞTİRDİĞİ bir senaryo
 * gösterdi: yetkilendirme/kök seçimi ZATEN A için yapılmıştı, ama kalıcı
 * hale getirilen projectId ve maliyet ilişkilendirmesi sonradan B'ye
 * kayıyordu — "bir kez Factory güven sınırına giren Genome, o işlemin
 * TAMAMI için TEK, ayrık, doğrulanmış bir anlık görüntü olmalıdır" ilkesini
 * ihlal ediyordu. `readonly` yalnızca derleme-zamanı bir uyarıdır;
 * çalışma zamanında çağıranın paylaşılan nesnesini korumaz. Fixed: giren
 * `candidate`, doğrulamadan ÖNCE `deepFreezeClone()` (structuredClone +
 * özyinelemeli Object.freeze, runtime/util/immutable.ts) ile TAMAMEN
 * AYRIK, donmuş bir kopyaya dönüştürülür; şema doğrulaması VE
 * assertValidProjectId bu kopya üzerinde çalışır, ve döndürülen (dolayısıyla
 * bootstrap'in geri kalanının kullandığı TEK) genome hep bu kopyadır —
 * çağıranın orijinal nesnesine yapılan HİÇBİR sonraki mutasyon (iç içe
 * `project.id` dahil) artık hiçbir şeyi etkileyemez.
 */
export function parseProjectGenome(candidate: unknown): ProjectGenome {
  const detached = deepFreezeClone(candidate) as ProjectGenome;
  const result = validateProjectGenome(detached);
  if (!result.valid) {
    throw new InvalidProjectGenomeError(result.errors);
  }
  assertValidProjectId(detached.project.id);
  return detached;
}
