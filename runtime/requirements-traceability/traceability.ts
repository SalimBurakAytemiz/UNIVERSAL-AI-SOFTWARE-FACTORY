// Baseline section 49 (Requirements Traceability) + 303 (No Claim Without
// Evidence): bir gereksinim, ilerleme durumu iddia ediyorsa (ör.
// UNIT_TESTED), buna karşılık gelen kanıt (implementation_refs/test_refs/
// proof_refs) gerçekten var olmalıdır. Bu modül, kayıt defterindeki
// "kanıtsız iddiaları" (orphan status claims) tespit eder — bölüm 294'teki
// "no unsupported upgrades" kuralının denetlenebilir hâlidir.

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
 */
export function detectTraceabilityIssues(requirements: readonly TraceableRequirement[]): TraceabilityIssue[] {
  const issues: TraceabilityIssue[] = [];

  for (const req of requirements) {
    const rank = progressRank(req.status);
    if (rank === -1) continue;

    const hasProof = req.proofRefs.length > 0;
    const hasTest = req.testRefs.length > 0;
    const hasImplementation = req.implementationRefs.length > 0;

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
