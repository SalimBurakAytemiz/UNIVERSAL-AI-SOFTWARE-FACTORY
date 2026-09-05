// Baseline section 62 (Cheapest Capable Model Policy) + 64 (Premium Fallback
// Policy). Bu, tüm maliyet mimarisinin kalbidir: bir görev için gereken en
// düşük yeterlilik seviyesini belirler, o seviyeyi karşılayan modeller
// arasından en ucuzunu seçer ve premium modele yükseltmeyi yalnızca
// kanıta dayalı, politika onaylı bir başarısızlık sonrasında — ve sadece
// açıkça izin verilmişse — yapar. `allowPremiumFallback` varsayılan olarak
// false'tur (AUTO_PREMIUM_FALLBACK = FALSE, bölüm 64).

import { ModelGateway, type ModelInvocationRequest, type ModelInvocationResponse } from "./gateway.js";
import { ModelRegistry, tierRank, type ModelRecord, type ModelTier } from "./registry.js";

export interface RoutingRequest {
  readonly taskId: string;
  /** 0 = trivial, 5 = critical. Mirrors PolicyAction.risk in the policy engine. */
  readonly risk: 0 | 1 | 2 | 3 | 4 | 5;
  readonly requiredCapabilities: readonly string[];
}

export interface RoutingDecision {
  readonly model: ModelRecord;
  readonly requiredTier: ModelTier;
  readonly escalated: boolean;
}

export class NoCapableModelError extends Error {
  constructor(request: RoutingRequest, minTier: ModelTier) {
    super(
      `No registered model satisfies capabilities [${request.requiredCapabilities.join(", ")}] ` +
        `at tier >= ${minTier} for task ${request.taskId}`
    );
    this.name = "NoCapableModelError";
  }
}

export class PremiumFallbackBlockedError extends Error {
  constructor(taskId: string) {
    super(
      `Task ${taskId} failed validation on the cheapest capable model, but premium fallback ` +
        `is not authorized (AUTO_PREMIUM_FALLBACK=false by default, baseline section 64). ` +
        `Escalation requires explicit allowPremiumFallback=true from an authorized caller.`
    );
    this.name = "PremiumFallbackBlockedError";
  }
}

/**
 * Risk seviyesinden gereken minimum model kalite eşiğine eşleme
 * (bölüm 63, "Task-Based Model Routing"). Bu, "önce yeterlilik tabanı,
 * sonra en ucuzu seç" kuralının somutlaşmış halidir.
 */
export function minTierForRisk(risk: RoutingRequest["risk"]): ModelTier {
  if (risk <= 1) return "MOCK";
  if (risk === 2) return "VERY_LOW_COST";
  if (risk === 3) return "STANDARD";
  if (risk === 4) return "PREMIUM";
  return "CRITICAL_REVIEW";
}

export interface RouteAndExecuteOptions {
  /** Defaults to false — matches baseline section 64's AUTO_PREMIUM_FALLBACK default. */
  readonly allowPremiumFallback?: boolean;
}

export interface RouteAndExecuteResult {
  readonly response: ModelInvocationResponse;
  readonly decision: RoutingDecision;
}

export class CheapestCapableModelRouter {
  constructor(private readonly registry: ModelRegistry) {}

  /**
   * Verilen görev için en ucuz yeterli modeli seçer. Asla "mevcut en güçlü
   * model" mantığı kullanmaz (bölüm 62) — sadece minimum eşiği karşılayan
   * adaylar arasından maliyeti en düşük olanı seçer.
   */
  selectModel(request: RoutingRequest, minTierOverride?: ModelTier): RoutingDecision {
    const requiredTier = minTierOverride ?? minTierForRisk(request.risk);
    const minRank = tierRank(requiredTier);

    const candidates = this.registry
      .findCapable(request.requiredCapabilities)
      .filter((m) => tierRank(m.tier) >= minRank);

    if (candidates.length === 0) {
      throw new NoCapableModelError(request, requiredTier);
    }

    const cheapest = candidates.reduce((best, current) =>
      current.costPerCall < best.costPerCall ? current : best
    );

    return { model: cheapest, requiredTier, escalated: minTierOverride !== undefined };
  }

  /**
   * Seç + çalıştır + doğrula akışı. Doğrulama başarısız olursa ve
   * premium fallback açıkça izinliyse, bir üst kalite seviyesindeki en
   * ucuz modele TEK seviye yükseltme yapar (bölüm 64'teki kontrollü
   * eskalasyon zinciri sadeleştirilmiş haliyle).
   */
  async routeAndExecute(
    request: RoutingRequest,
    gateway: ModelGateway,
    invocationRequest: ModelInvocationRequest,
    validate: (response: ModelInvocationResponse) => boolean,
    options: RouteAndExecuteOptions = {}
  ): Promise<RouteAndExecuteResult> {
    const initialDecision = this.selectModel(request);
    const initialResponse = await gateway.invoke(initialDecision.model, invocationRequest);

    if (validate(initialResponse)) {
      return { response: initialResponse, decision: initialDecision };
    }

    if (!options.allowPremiumFallback) {
      throw new PremiumFallbackBlockedError(request.taskId);
    }

    // Escalate from the tier of the model ACTUALLY SELECTED, not the
    // minimum risk-derived tier. If the capability filter already forced a
    // pricier model than the risk floor required (e.g. a risk-0 task that
    // only a STANDARD-tier model can perform), escalating from
    // `requiredTier` would pick a tier at or below the model already
    // tried — re-selecting the same (or an even cheaper/weaker) model
    // instead of genuinely moving up a quality level.
    const currentTierIndex = tierRank(initialDecision.model.tier);
    const nextTierIndex = currentTierIndex + 1;
    const nextTier = nextTierIndex < 6 ? (Object.freeze(
      ["MOCK", "LOCAL_FREE", "VERY_LOW_COST", "STANDARD", "PREMIUM", "CRITICAL_REVIEW"] as const
    )[nextTierIndex] as ModelTier) : undefined;

    if (!nextTier) {
      throw new NoCapableModelError(request, initialDecision.model.tier);
    }

    const escalatedDecision = this.selectModel(request, nextTier);
    const escalatedResponse = await gateway.invoke(escalatedDecision.model, invocationRequest);
    return { response: escalatedResponse, decision: escalatedDecision };
  }
}
