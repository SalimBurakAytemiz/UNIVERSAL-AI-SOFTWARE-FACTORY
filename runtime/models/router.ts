// Baseline section 62 (Cheapest Capable Model Policy) + 64 (Premium Fallback
// Policy). Bu, tüm maliyet mimarisinin kalbidir: bir görev için gereken en
// düşük yeterlilik seviyesini belirler, o seviyeyi karşılayan modeller
// arasından en ucuzunu seçer ve premium modele yükseltmeyi yalnızca
// kanıta dayalı, politika onaylı bir başarısızlık sonrasında — ve sadece
// açıkça izin verilmişse — yapar. `allowPremiumFallback` varsayılan olarak
// false'tur (AUTO_PREMIUM_FALLBACK = FALSE, bölüm 64).

import { ModelGateway, type ModelInvocationRequest, type ModelInvocationResponse } from "./gateway.js";
import { ModelRegistry, TIER_ORDER, tierRank, type ModelRecord, type ModelTier } from "./registry.js";
import type { PolicyEngine } from "../policy-engine/policy-engine.js";
import type { BudgetGuard } from "../budget/budget.js";
import { freezeRecord } from "../util/immutable.js";

export interface RoutingRequest {
  readonly taskId: string;
  /**
   * P1 fix (13th independent review round, "routing drops project
   * ownership"): `RoutingRequest` used to carry NO project identity field
   * at all — only `taskId` — so a project-bearing invocation routed
   * through `routeAndExecute()` was authorized/accounted under `taskId`
   * ALONE, and `runtime/budget/budget.ts`'s `perTaskUsd` ceiling (whose
   * documented scoping rule, bölüm 70-72, is `projectId + taskId` WHEN a
   * projectId is present) silently degraded to task-only scoping for
   * every routed invocation, regardless of whether the caller actually
   * had a project in mind. Codex reproduced: a project-bearing invocation
   * routed without its project, followed by a SECOND, direct invocation
   * for the SAME project/task, both succeeding against what should have
   * been a single shared per-task ceiling. `projectId` is now an optional
   * field here, captured into the SAME frozen `routingScope` snapshot as
   * every other routing field (bkz. `routeAndExecute()`'s fix note) and
   * propagated into `ModelInvocationContext.projectId` on EVERY candidate
   * invocation — initial, every escalation step, and fallback — so
   * project ownership survives the entire routing/policy/reservation/
   * invocation/reconciliation/audit path exactly the way `gateway.invoke()`
   * already required it to for a DIRECT (non-routed) caller.
   */
  readonly projectId?: string;
  /** 0 = trivial, 5 = critical. Mirrors PolicyAction.risk in the policy engine. */
  readonly risk: 0 | 1 | 2 | 3 | 4 | 5;
  readonly requiredCapabilities: readonly string[];
  /**
   * P1 fix (25th independent review round, "approval evidence must flow
   * through model invocation path"): `RoutingRequest` used to carry NO way
   * to reference approval evidence at all — a risk-5 routed invocation was
   * therefore unconditionally blocked, with no path by which a genuine,
   * reviewer-granted approval (registered in the `ModelGateway`'s own
   * `#approvals` store, bkz. gateway.ts) could ever reach
   * `gateway.invoke()`'s authorization call. `approvalId` is captured into
   * the SAME frozen `routingScope` snapshot as every other routing field
   * (bkz. `routeAndExecute()`'s fix note) and propagated into
   * `ModelInvocationContext.approvalId` on every candidate invocation.
   */
  readonly approvalId?: string;
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

export class EscalationExhaustedError extends Error {
  constructor(taskId: string, finalTier: ModelTier) {
    super(
      `Task ${taskId} failed validation even after escalating all the way to tier '${finalTier}'. ` +
        `Failing closed rather than returning unvalidated output (baseline section 64).`
    );
    this.name = "EscalationExhaustedError";
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
   * P1 fix (9th independent review round, "fallback execution bypasses
   * policy and budget enforcement"): Codex reproduced routeAndExecute()
   * invoking every candidate — initial AND every escalation/fallback
   * step — via a DIRECT `gateway.invoke()` call, with NO PolicyEngine or
   * BudgetGuard consultation anywhere in the loop. `allowPremiumFallback`
   * is a routing-level PERMISSION FLAG ("fallback may be considered at
   * all"), never an AUTHORIZATION — it must never substitute for the same
   * policy/budget gate every other risky Factory action passes through
   * (bölüm 147).
   *
   * P1 fix (10th independent review round, "public ModelGateway.invoke()
   * bypasses enforcement"): the guard logic that USED to live here
   * (evaluate policy, pre-check budget, invoke, record cost) has moved
   * INTO `ModelGateway.invoke()` itself (runtime/models/gateway.ts) — a
   * router-only wrapper could always be bypassed by any OTHER caller with
   * direct access to the gateway (exactly what the e2e proof did). This
   * method is now a thin adapter: it builds the `ModelInvocationContext`
   * and calls the gateway's own guarded `invoke()`.
   *
   * P1 fix (11th independent review round, "supplied capability gateway
   * can bypass authoritative policy"): this used to also pass a reused
   * `capabilityGateway` instance through the context — that field has
   * been REMOVED from `ModelInvocationContext` entirely (see
   * gateway.ts), since it was a real policy-substitution vector for ANY
   * caller, even though router.ts itself always built it from the same
   * `policy` it also passed. `gateway.invoke()` now always constructs its
   * own `CapabilityGateway` directly from `policy` on every call.
   */
  private async invokeAuthorized(
    decision: RoutingDecision,
    request: RoutingRequest,
    gateway: ModelGateway,
    invocationRequest: ModelInvocationRequest,
    policy: PolicyEngine,
    budget: BudgetGuard
  ): Promise<ModelInvocationResponse> {
    return gateway.invoke(decision.model, invocationRequest, {
      policy,
      budget,
      risk: request.risk,
      taskId: request.taskId,
      // P1 fix (13th independent review round, "routing drops project
      // ownership"): this used to omit `projectId` entirely, even though
      // `ModelInvocationContext` has always supported it — see
      // `RoutingRequest.projectId`'s fix note above.
      projectId: request.projectId,
      description: `Invoke model '${decision.model.modelId}' (${decision.model.tier}) for task ${request.taskId}`,
      // P1 fix (25th independent review round, "approval evidence must
      // flow through model invocation path"): bkz. `RoutingRequest.approvalId`'in
      // üstündeki fix notu.
      approvalId: request.approvalId
    });
  }

  /**
   * Seç + çalıştır + doğrula akışı. Doğrulama başarısız olursa ve premium
   * fallback açıkça izinliyse, bir üst kalite seviyesine yükselir. KRİTİK:
   * yükseltilen (fallback) yanıt da AYNI `validate` fonksiyonundan geçirilir
   * — bir yanıtın daha pahalı/daha üst seviye bir modelden gelmiş olması,
   * onu otomatik olarak güvenilir kılmaz (bölüm 64). Doğrulama yine
   * başarısız olursa ve daha yüksek bir seviye varsa, o seviyeye de
   * (yeniden doğrulanarak) yükselinir; tepe seviyeye (CRITICAL_REVIEW)
   * ulaşılıp orada da başarısız olunursa fail-closed olunur
   * (EscalationExhaustedError) — asla doğrulanmamış bir çıktı sessizce
   * döndürülmez. Seviye sayısı sonlu (6 kademe) olduğundan bu döngü
   * doğası gereği sınırlıdır; sonsuz bir yeniden deneme riski yoktur.
   *
   * `policy`/`budget` artık ZORUNLU parametrelerdir — HER aday (ilk seçim
   * dahil), invokeAuthorized() üzerinden aynı yetkilendirme kapısından
   * geçer (bkz. yukarıdaki fix notu).
   *
   * P1 fix (12th independent review round, "routing retries can change
   * execution ownership and fallback permission"): Codex reproduced
   * `request`/`options` being caller-owned, mutable objects that this
   * method kept reading DIRECTLY across MULTIPLE `await` boundaries — the
   * initial call reads `request.taskId`/`.risk`/`.requiredCapabilities`
   * and `options.allowPremiumFallback` BEFORE the first await, but the
   * escalation loop (which only runs AFTER that first await has already
   * resolved) reads `request`/`options` AGAIN via `selectModel(request,
   * nextTier)` and `invokeAuthorized(decision, request, ...)`. A caller
   * mutating `request.taskId` (A -> B) or flipping
   * `options.allowPremiumFallback` (false -> true) WHILE the first
   * candidate's provider call was still pending could make a SUBSEQUENT
   * escalation attempt run under a different task/project ownership than
   * the one that was ever authorized, or exercise a fallback permission
   * that was never actually granted when routing started — splitting
   * cost across two owners and letting a per-task ceiling be bypassed by
   * repeated calls. Fixed: `request`/`options` are captured into frozen,
   * detached snapshots (`routingScope`/`allowPremiumFallback`) as the
   * VERY FIRST thing this method does, before `selectModel()` is even
   * called the first time. `routingScope` (never the original `request`
   * parameter) is what every `selectModel()`/`invokeAuthorized()` call —
   * initial AND every escalation step — actually uses; the normalized
   * `allowPremiumFallback` boolean is captured once and reused, never
   * re-read from `options`. As with gateway.ts's identical fix, this
   * holds regardless of scheduling, because JS guarantees an async
   * function's synchronous prefix runs to completion before any
   * caller-scheduled microtask can interleave.
   *
   * P1 fix (13th independent review round, "invocation payload remains
   * caller-mutable during execution"): Codex reproduced `invocationRequest`
   * (the model prompt/taskType payload — a SEPARATE object from
   * `request`/`routingScope`, which only carries routing METADATA) being
   * passed, completely unsnapshotted, to EVERY `invokeAuthorized()` call
   * this method makes — the initial candidate AND every escalation/
   * fallback step. `gateway.invoke()` itself now protects a single call
   * against a mutation racing its OWN pending provider call (bkz.
   * gateway.ts's `authorizedRequest` fix), but that does not protect
   * ACROSS retries: a caller mutating `invocationRequest.prompt` between
   * this method's own sequential `await`ed escalation steps could make a
   * LATER escalation attempt execute a different payload than the one the
   * FIRST attempt (and this method's caller) actually authorized. Fixed:
   * `invocationRequest` is captured into a frozen `invocationScope`
   * snapshot in the SAME synchronous prefix as `routingScope`, before the
   * first `selectModel()`/`invokeAuthorized()` call, and `invocationScope`
   * (never the original `invocationRequest` parameter) is what every
   * candidate — initial, every escalation step, and fallback — actually
   * receives.
   */
  async routeAndExecute(
    request: RoutingRequest,
    gateway: ModelGateway,
    invocationRequest: ModelInvocationRequest,
    validate: (response: ModelInvocationResponse) => boolean,
    policy: PolicyEngine,
    budget: BudgetGuard,
    options: RouteAndExecuteOptions = {}
  ): Promise<RouteAndExecuteResult> {
    // Herhangi bir asenkron iş (hatta İLK selectModel() çağrısı) başlamadan
    // ÖNCE: yetkili yönlendirme girdisi anlık görüntüsü — bkz. yukarıdaki
    // fix notu. `requiredCapabilities` bir dizi alanıdır; `freezeRecord`
    // onun da bir KOPYASINI dondurur. Bundan sonra `request`/`options`
    // parametrelerinin KENDİLERİ bir daha ASLA okunmaz.
    const routingScope: RoutingRequest = freezeRecord({ ...request });
    const allowPremiumFallback = options.allowPremiumFallback ?? false;
    // `invocationRequest`'in KENDİSİ de aynı şekilde, aynı senkron ön ekte
    // donmuş bir anlık görüntüye alınır — bkz. yukarıdaki fix notu.
    // Bundan sonra `invocationRequest` parametresinin KENDİSİ bir daha
    // ASLA okunmaz; sadece `invocationScope` kullanılır.
    const invocationScope: ModelInvocationRequest = freezeRecord({ ...invocationRequest });

    let decision = this.selectModel(routingScope);
    let response = await this.invokeAuthorized(decision, routingScope, gateway, invocationScope, policy, budget);

    if (validate(response)) {
      return { response, decision };
    }

    if (!allowPremiumFallback) {
      throw new PremiumFallbackBlockedError(routingScope.taskId);
    }

    // Eskalasyon, modelin GERÇEKTEN seçildiği seviyeden başlar (risk
    // tabanlı minimum seviyeden değil) — bkz. selectModel() yorumu: bir
    // yetenek filtresi zaten daha pahalı bir modeli zorunlu kılmış
    // olabilir, bu durumda `requiredTier`'dan başlamak aynı modelin
    // tekrar seçilmesine yol açabilir.
    for (;;) {
      const nextTierIndex = tierRank(decision.model.tier) + 1;
      const nextTier = nextTierIndex < TIER_ORDER.length ? TIER_ORDER[nextTierIndex] : undefined;

      if (!nextTier) {
        throw new EscalationExhaustedError(routingScope.taskId, decision.model.tier);
      }

      decision = this.selectModel(routingScope, nextTier);
      response = await this.invokeAuthorized(decision, routingScope, gateway, invocationScope, policy, budget);

      if (validate(response)) {
        return { response, decision };
      }
      // Doğrulama yine başarısız oldu -> döngü bir üst seviyeye devam eder
      // (ya da üst seviye kalmadıysa yukarıdaki throw ile fail-closed olur).
    }
  }
}
