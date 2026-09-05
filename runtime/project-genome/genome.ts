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
 */
export function parseProjectGenome(candidate: unknown): ProjectGenome {
  const result = validateProjectGenome(candidate);
  if (!result.valid) {
    throw new InvalidProjectGenomeError(result.errors);
  }
  const genome = candidate as ProjectGenome;
  assertValidProjectId(genome.project.id);
  return genome;
}
