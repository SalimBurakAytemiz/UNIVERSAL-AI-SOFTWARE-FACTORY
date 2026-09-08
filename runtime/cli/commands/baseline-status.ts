// Baseline section 296 (Baseline Coverage Engine): "factory baseline
// status" durumu DÜZYAZI iddialardan değil, specification/requirements/
// altındaki makine-okunur kayıtlardan hesaplar (bölüm 303, "no claim
// without evidence"). Bu dosya, o hesaplamayı yapan saf mantığı içerir;
// dosya sistemi okuma kısmı ayrıca test edilebilsin diye yalın tutulmuştur.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
// Named import (not default) sidesteps a known ajv v8 + TypeScript
// "NodeNext" module resolution interop mismatch between its CJS build and
// ESM-style .d.ts — same reasoning as `runtime/project-genome/genome.ts`'s
// own identical import (bkz. o dosyanın notu).
import { Ajv, type ValidateFunction } from "ajv";
import requirementSchema from "../../../schemas/requirement.schema.json" with { type: "json" };

export interface RequirementRecord {
  readonly id: string;
  readonly category: string;
  readonly status: string;
  readonly [key: string]: unknown;
}

export interface BaselineStatusSummary {
  readonly total: number;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly byCategory: Readonly<Record<string, number>>;
}

/**
 * P1 fix (32nd independent review round, finding 4, "fail closed on empty
 * or malformed requirement registries"): thrown whenever this loader would
 * otherwise have to report "zero requirements" without genuinely knowing
 * whether that reflects real, authoritative ground truth (a registry with
 * genuinely zero requirement records — never actually true for this
 * Factory's own installation) or a LOADER FAILURE masquerading as one (an
 * empty/missing directory, or every file's document reducing to nothing).
 * See this file's own `loadRequirementsFromDir()` fix note for the full
 * rationale.
 */
export class EmptyRequirementRegistryError extends Error {
  constructor(dir: string) {
    super(
      `Refusing to treat '${dir}' as an authoritative requirement registry: it contains no requirement ` +
        `YAML file(s), or every file's records reduced to zero entries. An empty result here must never be ` +
        `silently interpreted as "zero traceability issues" or "baseline status: nothing to report" — a ` +
        `genuinely empty registry is not a state this Factory's own installation can be in (baseline section ` +
        `296, 303: "no claim without evidence" — including the negative claim "there is nothing to check").`
    );
    this.name = "EmptyRequirementRegistryError";
  }
}

/**
 * P1 fix (32nd independent review round, finding 4): thrown when a
 * requirement YAML file's top-level document is not an array, or when any
 * individual record inside it fails schema validation against
 * `schemas/requirement.schema.json` — the SAME schema `npm run
 * validate:requirements` already enforces at commit time (bkz.
 * `scripts/validate-requirements.mjs`), now ALSO enforced by the runtime
 * path that actually feeds `factory baseline status`/`factory trace
 * requirement`/bootstrap's own preflight check. See this file's own
 * `loadRequirementsFromDir()` fix note for the full rationale.
 */
export class MalformedRequirementRegistryError extends Error {
  constructor(file: string, reason: string) {
    super(
      `Refusing to load requirement registry file '${file}': ${reason}. Malformed/schema-invalid requirement ` +
        `data fails closed (baseline section 280, 303) rather than being silently skipped or coerced — a ` +
        `caller that skipped an unreadable/invalid record would see an artificially SMALLER, falsely-clean ` +
        `registry, exactly the "no claim without evidence" violation this loader exists to prevent.`
    );
    this.name = "MalformedRequirementRegistryError";
  }
}

let cachedValidator: ValidateFunction | undefined;

function getRequirementValidator(): ValidateFunction {
  if (!cachedValidator) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    cachedValidator = ajv.compile(requirementSchema);
  }
  return cachedValidator!;
}

/**
 * P1 fix (32nd independent review round, finding 4, "fail closed on empty
 * or malformed requirement registries"): this used to silently tolerate
 * THREE distinct loader-failure shapes, each collapsing to the SAME
 * indistinguishable "zero requirements" result a genuinely valid-but-empty
 * registry would also produce:
 *  (1) `dir` containing no `.yml`/`.yaml` files at all (e.g. a typo'd path,
 *      a registry that was never checked out, or a caller-supplied
 *      `requirementsRegistry` pointing at the wrong location) — `files`
 *      was simply `[]` and the loop never ran.
 *  (2) A file whose top-level YAML document parsed to something other than
 *      an array (`null`, a bare object, a scalar — e.g. a syntax mistake
 *      that still happens to be valid YAML, or a document accidentally
 *      saved in the wrong shape) — silently skipped via
 *      `if (Array.isArray(parsed))`, contributing zero records with no
 *      error and no trace.
 *  (3) An individual record that is schema-invalid (missing required
 *      fields, wrong `status` enum value, a malformed `id`) — never
 *      checked here at all; only `scripts/validate-requirements.mjs` (a
 *      separate, CI-time-only script) ever caught this, so any RUNTIME
 *      caller of this loader (`factory baseline status`, `factory trace
 *      requirement`, and — most consequentially — `bootstrapProject()`'s
 *      own preflight traceability check, bkz. `project-lifecycle/
 *      orchestrator.ts`) could be silently fed a registry containing
 *      garbage records with no indication anything was wrong.
 * Every one of these previously produced a report of "0 issues" /
 * "0 requirements" indistinguishable from a genuinely clean, fully-loaded
 * registry — precisely the failure mode bölüm 303's "no claim without
 * evidence" forbids: the ABSENCE of a claim (no issues found) is itself an
 * evidence-backed claim, and a loader failure must never be allowed to
 * manufacture it. Fixed: (1) and the "every file contributed zero records"
 * variant of (2) now throw `EmptyRequirementRegistryError`; any single
 * non-array document, or any schema-invalid record, now throws
 * `MalformedRequirementRegistryError` — both BEFORE this function returns,
 * so a caller (bootstrap preflight included) can never mistake a loader
 * failure for "authoritative ground truth was loaded and it is clean."
 */
export function loadRequirementsFromDir(dir: string): RequirementRecord[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  if (files.length === 0) {
    throw new EmptyRequirementRegistryError(dir);
  }
  const validate = getRequirementValidator();
  const all: RequirementRecord[] = [];
  for (const file of files) {
    const content = readFileSync(join(dir, file), "utf8");
    const parsed = yaml.load(content);
    if (!Array.isArray(parsed)) {
      throw new MalformedRequirementRegistryError(
        file,
        "its top-level YAML document is not an array of requirement records"
      );
    }
    for (const record of parsed) {
      if (!validate(record)) {
        const details = (validate.errors ?? [])
          .map((e) => `${e.instancePath || "(root)"} ${e.message ?? ""}`.trim())
          .join("; ");
        throw new MalformedRequirementRegistryError(
          file,
          `record '${(record as { id?: unknown })?.id ?? "<no id>"}' failed schema validation: ${details}`
        );
      }
    }
    all.push(...(parsed as RequirementRecord[]));
  }
  if (all.length === 0) {
    throw new EmptyRequirementRegistryError(dir);
  }
  return all;
}

/**
 * P2 targeted-audit fix (8th independent review round, same class as
 * "prototype names crash schema-valid project families" —
 * organization-composer/composer.ts): eskiden `byStatus`/`byCategory` DÜZ
 * nesnelerdi (`Record<string, number> = {}`) ve `byStatus[req.status] =
 * (byStatus[req.status] ?? 0) + 1` ile dolduruluyordu. Bu fonksiyon,
 * `requirements` argümanını YALNIZCA `RequirementRecord[]` (status/category
 * herhangi bir string) olarak tipler — şema doğrulaması (schema.json'daki
 * kapalı enum) BAŞKA bir katmanda (validate-requirements.mjs) uygulanır,
 * BURADA değil; bu fonksiyon doğrudan çağrıldığında (ör. şema kontrolünden
 * geçmemiş bir YAML dosyası, gelecekte eklenecek bir çağıran, veya bir
 * test) `req.status === "constructor"` gibi bir değer, mirasa özgü
 * `Object.prototype.constructor` fonksiyonunu okur — bu `??` ile ASLA
 * yakalanmaz (truthy'dir) ve `fonksiyon + 1` sayısal toplama yerine
 * SESSİZCE string birleştirmeye döner, sayım verisini bozar (bölüm 296,
 * 303 — "no claim without evidence" aracının kendisi hatalı rapor
 * üretemez). Fixed: sayımlar bir `Map` üzerinde tutulur (ASLA prototip
 * zincirinden okumaz), yalnızca dönüş şeklini korumak için sonunda
 * `Object.fromEntries()` ile düz nesneye çevrilir — `Object.fromEntries`,
 * `[[DefineOwnProperty]]` kullanır (`[[Set]]` DEĞİL), bu yüzden
 * `"__proto__"` dahil HER anahtar için her zaman sıradan bir "own" veri
 * özelliği oluşturur, hiçbir accessor'ı tetiklemez.
 */
export function summarizeRequirements(requirements: readonly RequirementRecord[]): BaselineStatusSummary {
  const byStatus = new Map<string, number>();
  const byCategory = new Map<string, number>();

  for (const req of requirements) {
    byStatus.set(req.status, (byStatus.get(req.status) ?? 0) + 1);
    byCategory.set(req.category, (byCategory.get(req.category) ?? 0) + 1);
  }

  return {
    total: requirements.length,
    byStatus: Object.fromEntries(byStatus),
    byCategory: Object.fromEntries(byCategory)
  };
}

export function computeBaselineStatus(requirementsDir: string): BaselineStatusSummary {
  return summarizeRequirements(loadRequirementsFromDir(requirementsDir));
}
