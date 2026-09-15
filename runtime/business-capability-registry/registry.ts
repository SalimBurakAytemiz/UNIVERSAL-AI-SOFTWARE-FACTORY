// Baseline section 29 (Business Capability Registry): CRM/ERP/Ödeme gibi
// iş yeteneklerini, hangi proje ailelerinde geçerli olduklarını ve
// mümkün teslim seçeneklerini (BUILD/INTEGRATE/REUSE/BUY_OR_SAAS/DEFER/
// NOT_REQUIRED) kaydeder. Bu, "her şeyi sıfırdan inşa etme" eğilimine
// karşı bir denge noktasıdır (bölüm 30, Build vs Buy vs Integrate Engine).

import { freezeRecord } from "../util/immutable.js";

export type DeliveryOption = "BUILD" | "INTEGRATE" | "REUSE" | "BUY_OR_SAAS" | "DEFER" | "NOT_REQUIRED";

export interface BusinessCapabilityRecord {
  readonly id: string;
  readonly purpose: string;
  readonly projectFamilies: readonly string[];
  readonly dependencies: readonly string[];
  readonly deliveryOptions: readonly DeliveryOption[];
}

/**
 * P2 fix (34th independent review round, finding 9, "reject duplicate
 * business capability IDs"): `register()` used to call
 * `this.#capabilities.set(snapshot.id, ...)` unconditionally — a SECOND
 * `register()` call for an already-registered `id` silently REPLACED the
 * authoritative purpose/dependencies/projectFamilies/deliveryOptions every
 * `get()`/`findApplicable()`/build-vs-buy decision downstream relies on,
 * with no trace anywhere that a real overwrite ever happened — exactly the
 * "no silent architectural deletion" class baseline section 147/303
 * forbids, and the SAME root cause already closed for every OTHER P0
 * registry (`DuplicateProviderIdError` in models/gateway.ts,
 * `DuplicateApprovalIdError` in policy-engine/approval.ts, the
 * technology-registry's own duplicate guard). Fixed the same way: a
 * colliding id now fails closed; there is no supported "replace" operation
 * — a genuinely revised capability definition needs a distinct id.
 */
export class DuplicateBusinessCapabilityIdError extends Error {
  constructor(id: string) {
    super(
      `Business capability id '${id}' is already registered. register() never silently replaces an existing ` +
        `capability's authoritative purpose/dependencies/projectFamilies/deliveryOptions — register a distinct id ` +
        `for a genuinely revised capability definition.`
    );
    this.name = "DuplicateBusinessCapabilityIdError";
  }
}

/**
 * P1 fix (4th independent review round, targeted follow-up ownership
 * audit): register()/get()/all() previously stored and returned the
 * caller's own object references directly. Now register() stores an
 * independent copy and every read returns a frozen, detached snapshot
 * (runtime/util/immutable.ts), consistent with every other P0 registry.
 */
export class BusinessCapabilityRegistry {
  /**
   * P1 targeted-audit fix (28th independent review round, root-class B
   * sweep, "TypeScript private used for authoritative mutable state" —
   * same class already fixed in every other P0 registry): still declared
   * with TypeScript's compile-time-only `private` — an ordinary,
   * enumerable instance property in the compiled JS, reachable via
   * `(registry as any).capabilities` with no type-system escape hatch
   * needed. Fixed the same way every other P0 registry already is.
   */
  #capabilities = new Map<string, BusinessCapabilityRecord>();

  register(capability: BusinessCapabilityRecord): void {
    const snapshot: BusinessCapabilityRecord = { ...capability };
    if (this.#capabilities.has(snapshot.id)) {
      throw new DuplicateBusinessCapabilityIdError(snapshot.id);
    }
    this.#capabilities.set(snapshot.id, freezeRecord(snapshot));
  }

  all(): readonly BusinessCapabilityRecord[] {
    return [...this.#capabilities.values()].map((c) => freezeRecord(c));
  }

  get(id: string): BusinessCapabilityRecord | undefined {
    const capability = this.#capabilities.get(id);
    return capability ? freezeRecord(capability) : undefined;
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
