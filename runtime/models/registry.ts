// Baseline section 60/61: Model Registry. Kayıtlar veridir, kod değil —
// bir sağlayıcının kalıcı olarak ücretsiz/ucuz/premium olduğu asla
// kod içine gömülmez (bölüm 60). Yeni model eklemek kod değişikliği
// gerektirmemelidir.

export type ModelTier =
  | "MOCK"
  | "LOCAL_FREE"
  | "VERY_LOW_COST"
  | "STANDARD"
  | "PREMIUM"
  | "CRITICAL_REVIEW";

export const TIER_ORDER: readonly ModelTier[] = [
  "MOCK",
  "LOCAL_FREE",
  "VERY_LOW_COST",
  "STANDARD",
  "PREMIUM",
  "CRITICAL_REVIEW"
];

export function tierRank(tier: ModelTier): number {
  return TIER_ORDER.indexOf(tier);
}

export type ModelStatus =
  | "DISCOVERED"
  | "EVALUATED"
  | "APPROVED"
  | "ACTIVE"
  | "MONITORED"
  | "DEPRECATED"
  | "RETIRED";

export interface ModelRecord {
  readonly provider: string;
  readonly modelId: string;
  readonly tier: ModelTier;
  readonly costPerCall: number;
  readonly capabilities: readonly string[];
  readonly status: ModelStatus;
}

const USABLE_STATUSES: readonly ModelStatus[] = ["APPROVED", "ACTIVE", "MONITORED"];

export class ModelRegistry {
  private readonly models: ModelRecord[] = [];

  register(model: ModelRecord): void {
    this.models.push(model);
  }

  all(): readonly ModelRecord[] {
    return this.models;
  }

  /**
   * Belirtilen tüm yetenekleri destekleyen ve kullanılabilir durumda olan
   * (APPROVED/ACTIVE/MONITORED) modelleri döndürür. DEPRECATED/RETIRED
   * modeller asla otomatik yönlendirmeye dahil edilmez.
   */
  findCapable(requiredCapabilities: readonly string[]): ModelRecord[] {
    return this.models.filter(
      (m) =>
        USABLE_STATUSES.includes(m.status) &&
        requiredCapabilities.every((cap) => m.capabilities.includes(cap))
    );
  }
}

/**
 * A small, representative default registry spanning MOCK through PREMIUM,
 * used by tests, proofs, and `factory routing explain`. Real deployments
 * are expected to load their own registry data rather than relying on this.
 */
export function createDefaultModelRegistry(): ModelRegistry {
  const registry = new ModelRegistry();

  registry.register({
    provider: "mock",
    modelId: "mock-classifier",
    tier: "MOCK",
    costPerCall: 0,
    capabilities: ["classification", "tagging", "formatting", "summarization"],
    status: "ACTIVE"
  });

  registry.register({
    provider: "mock",
    modelId: "mock-standard-coder",
    tier: "STANDARD",
    costPerCall: 0.01,
    capabilities: [
      "classification", "tagging", "formatting", "summarization",
      "implementation", "code-review", "debugging", "integrations", "test-generation"
    ],
    status: "ACTIVE"
  });

  registry.register({
    provider: "mock",
    modelId: "mock-premium-architect",
    tier: "PREMIUM",
    costPerCall: 0.20,
    capabilities: [
      "implementation", "code-review", "debugging", "integrations", "test-generation",
      "critical-architecture", "security-reasoning", "distributed-systems", "incident-analysis"
    ],
    status: "ACTIVE"
  });

  return registry;
}
