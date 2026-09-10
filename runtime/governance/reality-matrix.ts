// 35th independent review round governance mechanism (4 of 4):
// Implementation Reality Matrix. Baseline section 296 (Baseline Coverage
// Engine) already computes a prose-free STATUS COUNT from the requirement
// registry (`runtime/cli/commands/baseline-status.ts`'s
// `summarizeRequirements()`); this module answers a DIFFERENT, sharper
// question that count alone cannot: for each requirement, is its CLAIMED
// status actually backed by real, resolvable evidence, or is it an orphan
// claim? That is exactly what `runtime/requirements-traceability/
// traceability.ts`'s `detectTraceabilityIssues()` already computes — this
// module is a thin, requirement-by-requirement VIEW over that SAME
// evidence source (Part G: "consume the EXISTING authoritative evidence/
// traceability path, do NOT create a duplicate evidence subsystem"), never
// a second opinion computed independently.
//
// A requirement whose claimed status has ANY unresolved traceability issue
// is reported with `effectiveStatus: "UNSUPPORTED_CLAIM"` rather than
// whatever status it merely CLAIMS — "reality" here means "what the
// evidence actually supports", not "what the YAML says". A requirement
// whose claimed status is BLOCKED/DEPRECATED/SUPERSEDED is left as-is
// (these are never evidence-backed progress claims in the first place —
// see traceability.ts's own PROGRESS_ORDER, which excludes them).

import { loadRequirementsFromDir, type RequirementRecord } from "../cli/commands/baseline-status.js";
import { adaptRequirementRecord, detectTraceabilityIssues, type RequirementStatus } from "../requirements-traceability/traceability.js";
import { deepFreezeClone } from "../util/immutable.js";

export type EffectiveRequirementStatus = RequirementStatus | "UNSUPPORTED_CLAIM";

export interface RealityMatrixEntry {
  readonly requirementId: string;
  readonly claimedStatus: RequirementStatus;
  readonly effectiveStatus: EffectiveRequirementStatus;
}

export interface RealityMatrixSummary {
  readonly total: number;
  readonly byEffectiveStatus: Readonly<Record<string, number>>;
  readonly blockedRequirementIds: readonly string[];
  readonly unsupportedClaimIds: readonly string[];
  readonly entries: readonly RealityMatrixEntry[];
  readonly generatedAt: string;
}

/**
 * `requirementsDir`/`rootDir` are required, never defaulted — same
 * discipline as `detectTraceabilityIssues()` itself, so a caller must
 * always state explicitly which registry and which tree it resolves
 * repository-relative evidence refs against.
 */
export function computeRealityMatrix(requirementsDir: string, rootDir: string): RealityMatrixSummary {
  const records: RequirementRecord[] = loadRequirementsFromDir(requirementsDir);
  const traceable = records.map((record) =>
    adaptRequirementRecord(
      record as unknown as {
        readonly id: string;
        readonly status: string;
        readonly implementation_refs?: readonly string[];
        readonly test_refs?: readonly string[];
        readonly proof_refs?: readonly string[];
      }
    )
  );
  const issues = detectTraceabilityIssues(traceable, rootDir);
  const requirementIdsWithIssues = new Set(issues.map((i) => i.requirementId));

  const entries: RealityMatrixEntry[] = traceable.map((req) => ({
    requirementId: req.id,
    claimedStatus: req.status,
    effectiveStatus: requirementIdsWithIssues.has(req.id) ? "UNSUPPORTED_CLAIM" : req.status
  }));

  const byEffectiveStatus = new Map<string, number>();
  for (const entry of entries) {
    byEffectiveStatus.set(entry.effectiveStatus, (byEffectiveStatus.get(entry.effectiveStatus) ?? 0) + 1);
  }

  return deepFreezeClone({
    total: entries.length,
    byEffectiveStatus: Object.fromEntries(byEffectiveStatus),
    blockedRequirementIds: entries.filter((e) => e.effectiveStatus === "BLOCKED").map((e) => e.requirementId),
    unsupportedClaimIds: entries.filter((e) => e.effectiveStatus === "UNSUPPORTED_CLAIM").map((e) => e.requirementId),
    entries,
    generatedAt: new Date().toISOString()
  });
}

/**
 * A short, beginner-friendly Turkish-language rendering of a computed
 * matrix — per CLAUDE.md's own request for beginner Turkish repository
 * documentation to accompany new governance mechanisms. This is display
 * text only; it derives nothing new and adds no additional evidence
 * source beyond what `computeRealityMatrix()` already computed.
 */
export function renderRealityMatrixTurkishSummary(summary: RealityMatrixSummary): string {
  const lines: string[] = [];
  lines.push(`Uygulama Gerçeklik Matrisi — toplam ${summary.total} gereksinim kaydı incelendi.`);
  const statusEntries = Object.entries(summary.byEffectiveStatus).sort((a, b) => b[1] - a[1]);
  for (const [status, count] of statusEntries) {
    lines.push(`  - ${status}: ${count} kayıt`);
  }
  if (summary.unsupportedClaimIds.length > 0) {
    lines.push(
      `UYARI: ${summary.unsupportedClaimIds.length} kayıt, iddia ettiği durumu destekleyecek gerçek kanıt ` +
        `içermiyor (kanıtsız iddia): ${summary.unsupportedClaimIds.join(", ")}. Bu kayıtlar "gerçek" durumları ` +
        `değil, sadece YAML'da yazılanı yansıtıyor demektir.`
    );
  }
  if (summary.blockedRequirementIds.length > 0) {
    lines.push(`BLOKE (BLOCKED) durumundaki kayıtlar: ${summary.blockedRequirementIds.join(", ")}.`);
  }
  if (summary.unsupportedClaimIds.length === 0 && summary.blockedRequirementIds.length === 0) {
    lines.push("Hiçbir kanıtsız iddia veya bloke kayıt bulunamadı.");
  }
  return lines.join("\n");
}
