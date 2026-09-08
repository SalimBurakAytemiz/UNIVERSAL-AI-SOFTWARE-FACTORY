// Baseline section 49 (Requirements Traceability) + 303 (No Claim Without
// Evidence): bir gereksinim, ilerleme durumu iddia ediyorsa (ör.
// UNIT_TESTED), buna karşılık gelen kanıt (implementation_refs/test_refs/
// proof_refs) gerçekten var olmalıdır. Bu modül, kayıt defterindeki
// "kanıtsız iddiaları" (orphan status claims) tespit eder — bölüm 294'teki
// "no unsupported upgrades" kuralının denetlenebilir hâlidir.

import { existsSync } from "node:fs";
import { assertWithinRoot } from "../sandbox/sandbox.js";

export type RequirementStatus =
  | "DEFINED"
  | "PLANNED"
  | "IMPLEMENTATION_IN_PROGRESS"
  | "IMPLEMENTED"
  | "UNIT_TESTED"
  | "INTEGRATION_TESTED"
  | "PROOF_VERIFIED"
  | "PRODUCTION_VERIFIED"
  | "BLOCKED"
  | "DEPRECATED"
  | "SUPERSEDED";

export interface TraceableRequirement {
  readonly id: string;
  readonly status: RequirementStatus;
  readonly implementationRefs: readonly string[];
  readonly testRefs: readonly string[];
  readonly proofRefs: readonly string[];
}

export type TraceabilityIssueType =
  | "MISSING_IMPLEMENTATION_REFS"
  | "MISSING_TEST_REFS"
  | "MISSING_PROOF_REFS";

export interface TraceabilityIssue {
  readonly requirementId: string;
  readonly issue: TraceabilityIssueType;
  readonly status: RequirementStatus;
}

// Yalnızca "ilerleme" durumları sıralanır; BLOCKED/DEPRECATED/SUPERSEDED
// bu sıranın dışındadır çünkü onlar aktif bir ilerleme iddiası taşımaz.
const PROGRESS_ORDER: readonly RequirementStatus[] = [
  "DEFINED",
  "PLANNED",
  "IMPLEMENTATION_IN_PROGRESS",
  "IMPLEMENTED",
  "UNIT_TESTED",
  "INTEGRATION_TESTED",
  "PROOF_VERIFIED",
  "PRODUCTION_VERIFIED"
];

function progressRank(status: RequirementStatus): number {
  return PROGRESS_ORDER.indexOf(status);
}

/**
 * P1 fix (29th independent review round, finding 5, "proof references must
 * resolve to real evidence"): a ref containing whitespace is never a
 * repository-relative path in this registry's own data (verified against
 * every real ref currently in `specification/requirements/*.yml` — zero
 * false positives) — it is a legacy, pre-dating-this-convention free-text
 * audit note (e.g. UASF-REQ-0001's "Session audit: single 'Initial
 * commit'..."). Such notes are still genuine evidence under "no claim
 * without evidence" (bölüm 303), just not filesystem-checkable, so this
 * function does not attempt to verify them and treats their mere presence
 * as it always has. Every OTHER ref is treated as a path and MUST resolve
 * to a real, in-repository file or directory — see `isVerifiedEvidenceRef()`
 * below.
 */
function looksLikeFilePath(ref: string): boolean {
  return !/\s/.test(ref);
}

/**
 * P1 fix (29th independent review round, finding 5, "proof references must
 * resolve to real evidence"): `detectTraceabilityIssues()` used to treat a
 * MERELY NON-EMPTY `proofRefs`/`testRefs`/`implementationRefs` array as
 * sufficient evidence — `proof_refs: ["does/not/exist"]` (a typo, a moved/
 * deleted file, or a fabricated reference never backed by anything real)
 * satisfied `hasProof` exactly the same as a genuine, real proof file
 * would, completely defeating baseline section 303's "no claim without
 * evidence" for the one thing this module exists to enforce. Fixed: a
 * path-shaped ref (bkz. `looksLikeFilePath()`) now only counts as evidence
 * if it ACTUALLY resolves, via `assertWithinRoot()` (the same path-
 * confinement primitive `runtime/sandbox/sandbox.ts` already uses to stop
 * a scaffold escaping its project root — reused here rather than
 * reinventing traversal protection), to a real, EXISTING file or directory
 * strictly inside `rootDir` — a `../`-style reference attempting to point
 * outside the repository is rejected the same way a scaffold escape is
 * (fails closed, counts as no evidence, never throws — an invalid
 * reference is validation feedback, not a crash).
 */
function isVerifiedEvidenceRef(ref: string, rootDir: string): boolean {
  if (!looksLikeFilePath(ref)) return true;
  let resolved: string;
  try {
    resolved = assertWithinRoot(rootDir, ref);
  } catch {
    return false;
  }
  return existsSync(resolved);
}

function hasVerifiedEvidence(refs: readonly string[], rootDir: string): boolean {
  return refs.some((ref) => isVerifiedEvidenceRef(ref, rootDir));
}

/**
 * Kayıt defterindeki her gereksinimi tarar ve durumu ile kanıtları
 * arasındaki tutarsızlıkları bulur. BLOCKED/DEPRECATED/SUPERSEDED
 * durumundaki kayıtlar denetlenmez (bölüm 294'te bu durumlar için ayrı bir
 * anlam tanımlanmıştır).
 *
 * Daha güçlü bir kanıt, daha zayıf bir aşamanın kanıtı yerine de geçer:
 * bir proof_refs kaydı (örn. bir uçtan uca kanıt testi, ya da bir
 * denetim/audit notu) hem "uygulandı" hem "test edildi" iddialarını da
 * destekler; bir test_refs kaydı "uygulandı" iddiasını destekler. Bunun
 * nedeni, bazı gereksinimlerin (örn. tek seferlik bir denetim, ya da bir
 * kanıt testinin kendisinin hem uygulama hem doğrulama olduğu durumlar)
 * ayrı bir "implementation" dosyasına sahip olmayabilmesidir — önemli olan
 * HİÇBİR kanıt olmadan ilerleme iddia edilmemesidir.
 *
 * `rootDir` is the repository root every path-shaped ref is resolved
 * against (bkz. `isVerifiedEvidenceRef()`'in fix notu) — required, not
 * defaulted, so a caller must always state explicitly which tree these
 * repository-relative refs are meant to resolve inside of.
 */
export function detectTraceabilityIssues(
  requirements: readonly TraceableRequirement[],
  rootDir: string
): TraceabilityIssue[] {
  const issues: TraceabilityIssue[] = [];

  for (const req of requirements) {
    const rank = progressRank(req.status);
    if (rank === -1) continue;

    const hasProof = hasVerifiedEvidence(req.proofRefs, rootDir);
    const hasTest = hasVerifiedEvidence(req.testRefs, rootDir);
    const hasImplementation = hasVerifiedEvidence(req.implementationRefs, rootDir);

    if (rank >= progressRank("IMPLEMENTATION_IN_PROGRESS") && !hasImplementation && !hasTest && !hasProof) {
      issues.push({ requirementId: req.id, issue: "MISSING_IMPLEMENTATION_REFS", status: req.status });
    }
    if (rank >= progressRank("UNIT_TESTED") && !hasTest && !hasProof) {
      issues.push({ requirementId: req.id, issue: "MISSING_TEST_REFS", status: req.status });
    }
    if (rank >= progressRank("PROOF_VERIFIED") && !hasProof) {
      issues.push({ requirementId: req.id, issue: "MISSING_PROOF_REFS", status: req.status });
    }
  }

  return issues;
}

/** specification/requirements/*.yml içindeki ham (snake_case) kaydı bu modülün beklediği şekle dönüştürür. */
export function adaptRequirementRecord(record: {
  readonly id: string;
  readonly status: string;
  readonly implementation_refs?: readonly string[];
  readonly test_refs?: readonly string[];
  readonly proof_refs?: readonly string[];
}): TraceableRequirement {
  return {
    id: record.id,
    status: record.status as RequirementStatus,
    implementationRefs: record.implementation_refs ?? [],
    testRefs: record.test_refs ?? [],
    proofRefs: record.proof_refs ?? []
  };
}
