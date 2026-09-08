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
 * A ref containing whitespace is never a repository-relative path in this
 * registry's own data — it is free-text prose (either a legacy audit note
 * predating any path convention, or a human-readable description someone
 * wrote instead of pointing at a real artifact).
 *
 * P1 fix (30th independent review round, finding 7, "reject unverifiable
 * free-text evidence references"): the 29th round's own fix (bkz.
 * `isVerifiedEvidenceRef()`'in fix notu) deliberately treated a whitespace-
 * containing ref as AUTOMATICALLY-counting evidence, reasoning that it was
 * "still genuine evidence under no-claim-without-evidence, just not
 * filesystem-checkable." Codex correctly identified this as itself an
 * instance of the EXACT SAME root class the 29th round fixed one layer up:
 * `proof_refs: ["manually verified"]` (or any other prose sentence) now
 * satisfied `hasProof` with NOTHING behind it whatsoever — no artifact, no
 * re-checkable trail, not even a real file that merely failed to resolve.
 * A human typing an unverifiable claim into YAML is not meaningfully
 * different from a fabricated path; both must fail closed for an evidence-
 * backed status. `looksLikeFilePath()` itself is UNCHANGED — it still only
 * distinguishes "shaped like a path" from "prose" — but see
 * `isVerifiedEvidenceRef()` below for what changed: prose no longer
 * automatically counts as evidence. It remains fully legitimate as a NOTE
 * (nothing here deletes or rejects the data itself — a requirement's
 * `notes` field, or a non-evidence-backed status like DEFINED, can still
 * carry it), it simply can never — on its own — satisfy an evidence-backed
 * status claim.
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
 *
 * P1 fix (30th independent review round, finding 7, "reject unverifiable
 * free-text evidence references"): a NON-path-shaped ref (prose,
 * `looksLikeFilePath()` false) used to short-circuit to `return true` —
 * automatically counting as evidence with NO verification at all. Fixed:
 * it now returns `false` — the ONLY refs this function ever counts as
 * genuine evidence are path-shaped ones that actually resolve on disk.
 * There is no longer a "trust it, it's just an old-style note" carve-out;
 * every evidence-backed status claim in this registry must be backed by a
 * real, checkable artifact, full stop.
 */
function isVerifiedEvidenceRef(ref: string, rootDir: string): boolean {
  if (!looksLikeFilePath(ref)) return false;
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
