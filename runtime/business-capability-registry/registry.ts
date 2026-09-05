// Baseline section 29 (Business Capability Registry): CRM/ERP/Ödeme gibi
// iş yeteneklerini, hangi proje ailelerinde geçerli olduklarını ve
// mümkün teslim seçeneklerini (BUILD/INTEGRATE/REUSE/BUY_OR_SAAS/DEFER/
// NOT_REQUIRED) kaydeder. Bu, "her şeyi sıfırdan inşa etme" eğilimine
// karşı bir denge noktasıdır (bölüm 30, Build vs Buy vs Integrate Engine).

export type DeliveryOption = "BUILD" | "INTEGRATE" | "REUSE" | "BUY_OR_SAAS" | "DEFER" | "NOT_REQUIRED";

export interface BusinessCapabilityRecord {
  readonly id: string;
  readonly purpose: string;
  readonly projectFamilies: readonly string[];
  readonly dependencies: readonly string[];
  readonly deliveryOptions: readonly DeliveryOption[];
}

export class BusinessCapabilityRegistry {
  private readonly capabilities = new Map<string, BusinessCapabilityRecord>();

  register(capability: BusinessCapabilityRecord): void {
    this.capabilities.set(capability.id, capability);
  }

  all(): readonly BusinessCapabilityRecord[] {
    return [...this.capabilities.values()];
  }

  get(id: string): BusinessCapabilityRecord | undefined {
    return this.capabilities.get(id);
  }

  /** Belirli bir proje ailesi için geçerli olan iş yeteneklerini döndürür. */
  findApplicable(projectFamily: string): BusinessCapabilityRecord[] {
    return this.all().filter((c) => c.projectFamilies.includes(projectFamily));
  }
}

/**
 * Baseline section 29'da listelenen bazı temsili kayıtlar. Kapsamlı liste
 * değildir — gerçek kullanım, her proje türü için kendi kayıtlarını
 * kaydetmelidir.
 */
export function createDefaultBusinessCapabilityRegistry(): BusinessCapabilityRegistry {
  const registry = new BusinessCapabilityRegistry();

  registry.register({
    id: "identity",
    purpose: "Authentication and authorization for end users",
    projectFamilies: ["web", "saas", "ecommerce", "mobile", "marketplace"],
    dependencies: [],
    deliveryOptions: ["INTEGRATE", "BUY_OR_SAAS"]
  });

  registry.register({
    id: "payments",
    purpose: "Accept and process customer payments",
    projectFamilies: ["ecommerce", "saas", "marketplace"],
    dependencies: ["identity"],
    deliveryOptions: ["INTEGRATE", "BUY_OR_SAAS"]
  });

  registry.register({
    id: "notifications",
    purpose: "Email/SMS/push notifications to users",
    projectFamilies: ["web", "saas", "ecommerce", "mobile", "game"],
    dependencies: [],
    deliveryOptions: ["INTEGRATE", "BUY_OR_SAAS", "BUILD"]
  });

  registry.register({
    id: "anti-cheat",
    purpose: "Detect and mitigate cheating in multiplayer games",
    projectFamilies: ["game", "multiplayer_game", "mmorpg"],
    dependencies: [],
    deliveryOptions: ["BUILD", "INTEGRATE"]
  });

  return registry;
}
