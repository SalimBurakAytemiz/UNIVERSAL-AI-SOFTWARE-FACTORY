// Baseline section 286: `factory trace requirement` komutu. Kayıt
// defterindeki her gereksinimi tarar ve iddia edilen durum ile gerçek
// kanıtlar arasında bir uyuşmazlık varsa raporlar (bölüm 49, 303).

import { loadRequirementsFromDir } from "./baseline-status.js";
import { adaptRequirementRecord, detectTraceabilityIssues, type TraceabilityIssue } from "../../requirements-traceability/traceability.js";

export function traceRequirements(requirementsDir: string): TraceabilityIssue[] {
  const records = loadRequirementsFromDir(requirementsDir);
  const traceable = records.map((r) =>
    adaptRequirementRecord({
      id: r.id,
      status: r.status as string,
      implementation_refs: r.implementation_refs as string[] | undefined,
      test_refs: r.test_refs as string[] | undefined,
      proof_refs: r.proof_refs as string[] | undefined
    })
  );
  return detectTraceabilityIssues(traceable);
}
