// P0 uçtan uca akış (bölüm 304, 305): Gereksinim İzlenebilirliği ->
// Project Genome -> Organization Composer -> Project OS -> Politika/
// Capability Gateway -> Maliyet/Model Yönlendirme -> Kalıcı Durum. Bu
// modül, ayrı ayrı test edilmiş P0 parçalarının GERÇEKTEN birlikte,
// tutarlı bir şekilde çalıştığının kanıtıdır — her adım bir öncekinin
// çıktısını kullanır, hiçbiri bağımsız/kopuk değildir.
//
// Sıra ve neden:
//   1. Ön koşul: Factory'nin KENDİ gereksinim kayıt defteri kanıtsız bir
//      iddia içeriyorsa (bölüm 303), yeni bir proje başlatılmaz —
//      "kanıtsız iddia" zemininde yeni iş üretmek, sorunu büyütür.
//   2. Project Genome doğrulanır (fail closed, bölüm 280) — geçersiz bir
//      Genome ile hiçbir aşağı akış adımı çalıştırılmaz.
//   3. Organization Composer, Genome'dan minimum gerekli takımları çıkarır.
//   4. Project OS iskeletinin oluşturulması, Capability Gateway'den
//      (dolayısıyla Policy Engine'den) geçmeden ASLA çalışmaz — riskli/
//      izinsiz bir dosya sistemi eylemi sessizce gerçekleşemez.
//   5. Bu yeni proje için ilk görev (özet çıkarma), en ucuz yeterli model
//      ile yönlendirilir ve maliyeti bütçe kontrolünden geçirilerek
//      kaydedilir — "sessiz harcama yok" (bölüm 147).
//   6. Tüm sonuç (Genome, Organizasyon, model kararı, maliyet) kalıcı
//      duruma yazılır; süreç yeniden başlasa bile kaybolmaz (bölüm 277).

import { join } from "node:path";
import { parseProjectGenome, type ProjectGenome } from "../project-genome/genome.js";
import { composeOrganizationFromGenome, type OrganizationComposition } from "../organization-composer/composer.js";
import { scaffoldProjectOs, type ScaffoldResult } from "../project-os/scaffold.js";
import { CapabilityGateway } from "../capability-gateway/gateway.js";
import type { PolicyEngine, RiskLevel } from "../policy-engine/policy-engine.js";
import type { ModelRegistry } from "../models/registry.js";
import { CheapestCapableModelRouter, type RoutingDecision } from "../models/router.js";
import { CostEngine } from "../cost/cost-engine.js";
import { BudgetGuard, type BudgetLimits } from "../budget/budget.js";
import { FileStateStore, type StateStore } from "../state/file-store.js";
import type { TraceabilityIssue } from "../requirements-traceability/traceability.js";

export class PreflightTraceabilityFailedError extends Error {
  constructor(issues: readonly TraceabilityIssue[]) {
    super(
      `Refusing to bootstrap a new project: the Factory's own requirement registry has ` +
        `${issues.length} unresolved traceability issue(s). Run \`factory trace requirement\` and fix them first.`
    );
    this.name = "PreflightTraceabilityFailedError";
  }
}

export interface BootstrapProjectInput {
  readonly genomeCandidate: unknown;
  readonly baseDir: string;
  readonly policy: PolicyEngine;
  readonly modelRegistry: ModelRegistry;
  readonly budgetLimits?: BudgetLimits;
  readonly costEngine?: CostEngine;
  readonly stateStore?: StateStore;
  /** Both the Organization Composer's team-activation threshold and the Capability Gateway action's risk level. Defaults to 1 (low). */
  readonly risk?: RiskLevel;
  /** Factory'nin kendi gereksinim kayıt defterindeki izlenebilirlik sorunları (varsa) — boş olmayan bir liste bootstrap'i durdurur. */
  readonly preflightTraceabilityIssues?: readonly TraceabilityIssue[];
}

export interface BootstrapProjectResult {
  readonly genome: ProjectGenome;
  readonly organization: OrganizationComposition;
  readonly scaffold: ScaffoldResult;
  readonly modelDecision: RoutingDecision;
  readonly statePath: string;
  readonly totalCostUsd: number;
}

export async function bootstrapProject(input: BootstrapProjectInput): Promise<BootstrapProjectResult> {
  if (input.preflightTraceabilityIssues && input.preflightTraceabilityIssues.length > 0) {
    throw new PreflightTraceabilityFailedError(input.preflightTraceabilityIssues);
  }

  const genome = parseProjectGenome(input.genomeCandidate);
  const risk = input.risk ?? 1;
  const organization = composeOrganizationFromGenome(genome, risk);

  const gateway = new CapabilityGateway(input.policy);
  const scaffold = await gateway.authorize(
    {
      actionType: "project.scaffold",
      risk,
      description: `Scaffold Project OS for '${genome.project.id}'`
    },
    () => scaffoldProjectOs(input.baseDir, genome.project.id)
  );

  const router = new CheapestCapableModelRouter(input.modelRegistry);
  const modelDecision = router.selectModel({
    taskId: `bootstrap:${genome.project.id}`,
    risk: 0,
    requiredCapabilities: ["summarization"]
  });

  const costEngine = input.costEngine ?? new CostEngine();
  const budget = new BudgetGuard(costEngine, input.budgetLimits ?? {});
  budget.spend({
    taskId: `bootstrap:${genome.project.id}`,
    projectId: genome.project.id,
    provider: modelDecision.model.provider,
    modelId: modelDecision.model.modelId,
    amountUsd: modelDecision.model.costPerCall
  });

  const stateStore = input.stateStore ?? new FileStateStore();
  stateStore.write(join(scaffold.projectRoot, "project-genome", "genome.json"), genome);
  stateStore.write(join(scaffold.projectRoot, "organization", "organization.json"), organization);

  const statePath = join(scaffold.projectRoot, "state", "bootstrap.json");
  const totalCostUsd = costEngine.totalFor({ projectId: genome.project.id });
  stateStore.write(statePath, {
    bootstrappedAt: new Date().toISOString(),
    projectId: genome.project.id,
    organizationTeams: organization.teams,
    // Bu noktaya ulaşıldıysa gateway.authorize() zaten ALLOW vermiştir —
    // aksi halde yukarıda fırlatırdı (bkz. capability-gateway/gateway.ts).
    policyDecision: "ALLOW",
    selectedModel: {
      modelId: modelDecision.model.modelId,
      tier: modelDecision.model.tier,
      costUsd: modelDecision.model.costPerCall
    },
    totalCostUsd
  });

  return { genome, organization, scaffold, modelDecision, statePath, totalCostUsd };
}
