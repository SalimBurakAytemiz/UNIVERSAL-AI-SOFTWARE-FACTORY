// Baseline section 59: Model Gateway — sağlayıcı soyutlaması. Çekirdek
// testler asla ücretli bir API gerektirmemelidir; bu yüzden gateway,
// sağlayıcıları isimle kayıt altına alan basit bir arayüzdür ve
// MockProvider (providers/mock-provider.ts) varsayılan/test sağlayıcısıdır.
//
// P1 fix (10th independent review round, "public ModelGateway.invoke()
// bypasses enforcement"): Codex, `gateway.invoke(...)`'in HERKESE açık,
// PolicyEngine/BudgetGuard'dan TAMAMEN habersiz bir sağlayıcı çağrısı
// yaptığını gösterdi — router.ts'nin KENDİ `invokeAuthorized()` sarmalayıcısı
// düzeltilmiş olsa bile, bu, "hiçbir gerçek provider çağrısı yetkisiz
// gerçekleşemez" (bölüm 147) sistemik değişmezini GARANTİ ETMEZ, çünkü
// `gateway.invoke()`'e doğrudan erişimi olan HERHANGİ bir çağıran (aynı
// dosyadaki bir proof dahil) bu korumayı tamamen atlayabilir. "routeAndExecute
// kullan" gibi bir GELİŞTİRİCİ SÖZLEŞMESİYLE çözülemez — bu YAPISAL olarak
// engellenmelidir. Fix: PolicyEngine/BudgetGuard rezervasyon+mutabakat
// mantığının TAMAMI artık BU sınıfın KENDİ `invoke()` metodunun içinde
// yaşıyor (router.ts artık yalnızca ince bir sarmalayıcı) — HAM sağlayıcı
// çağrısı (`provider.invoke`) `#rawInvoke` özel metoduna taşındı ve bu
// sınıfın DIŞINDAN hiçbir şekilde erişilemez hale getirildi. `invoke()`
// artık bir `ModelInvocationContext` (policy + budget + risk + taskId)
// parametresini ZORUNLU kılar — TypeScript bunu atlayan bir çağrıyı
// DERLEME ZAMANINDA reddeder, ve parametre isteğe bağlı bir bayrak/bağlam
// DEĞİLDİR (bölüm 147 gereği bu tür bir "atlanabilir" tasarım kabul
// edilemez): gerçek yetkilendirme mantığının kendisi bu metodun GÖVDESİNDE
// çalışır, bu yüzden "yanlış bağlam geçmek" bile yetkilendirmeyi ATLATAMAZ.

import type { ModelRecord } from "./registry.js";
import { CapabilityGateway } from "../capability-gateway/gateway.js";
import type { PolicyEngine, RiskLevel } from "../policy-engine/policy-engine.js";
import type { BudgetGuard } from "../budget/budget.js";

export interface ModelInvocationRequest {
  readonly prompt: string;
  readonly taskType?: string;
}

export interface ModelInvocationResponse {
  readonly modelId: string;
  readonly provider: string;
  readonly costUsd: number;
  readonly output: string;
}

export interface ModelProvider {
  readonly id: string;
  invoke(model: ModelRecord, request: ModelInvocationRequest): Promise<ModelInvocationResponse>;
}

/**
 * `ModelGateway.invoke()`'in atlanamaz şekilde ZORUNLU kıldığı yetkilendirme
 * bağlamı. `policy`/`budget` isteğe bağlı DEĞİLDİR — bölüm 147'nin gereği
 * budur: gerçek bir provider çağrısına giden HİÇBİR yol, bu ikisi olmadan
 * DERLENEMEZ bile.
 */
export interface ModelInvocationContext {
  readonly policy: PolicyEngine;
  readonly budget: BudgetGuard;
  readonly risk: RiskLevel;
  readonly taskId: string;
  readonly projectId?: string;
  readonly description?: string;
  /**
   * Zaten bir `CapabilityGateway` örneğine sahip çağıranlar (ör.
   * router.ts, tek bir mantıksal işlem boyunca birden fazla adayı
   * yetkilendirirken) onu yeniden kullanabilir; verilmezse `policy`'den
   * yeni bir tane oluşturulur. Bu, davranışı DEĞİL yalnızca nesne
   * yeniden kullanımını etkiler.
   */
  readonly capabilityGateway?: CapabilityGateway;
}

export class UnknownProviderError extends Error {
  constructor(provider: string) {
    super(`No provider registered for '${provider}'. Register it via ModelGateway.registerProvider().`);
    this.name = "UnknownProviderError";
  }
}

export class ModelGateway {
  // Gerçek ECMAScript private alan (`#`), TypeScript'in `private`
  // anahtar kelimesinden BİLEREK farklı: `private` yalnızca DERLEME
  // ZAMANINDA (tsc) uyarır — derlenmiş JS çıktısında sıradan bir genel
  // (public) özelliktir ve `(gateway as any).rawInvoke(...)` gibi bir tip
  // atlatmasıyla ÇALIŞMA ZAMANINDA hâlâ çağrılabilir. `#` ile tanımlanan
  // alanlar/metodlar ise JS ÇALIŞMA ZAMANININ KENDİSİ tarafından bu sınıf
  // gövdesinin DIŞINDAN erişilemez kılınır — `as any`, `Object.getOwnPropertyNames`,
  // Reflect, hiçbiri bunu atlatamaz (bir `SyntaxError`/`TypeError`
  // üretir). Bölüm 147'nin "yapısal olarak engellenmeli, geliştirici
  // sözleşmesiyle değil" gereksinimini KARŞILAYAN budur.
  readonly #providers = new Map<string, ModelProvider>();

  registerProvider(provider: ModelProvider): void {
    this.#providers.set(provider.id, provider);
  }

  hasProvider(id: string): boolean {
    return this.#providers.has(id);
  }

  /**
   * TEK genel invocation API'si — bir gerçek sağlayıcıya ulaşan TEK yol
   * budur. Sıra HER ZAMAN: PolicyEngine (ALLOW zorunlu) -> BudgetGuard
   * rezervasyonu (tahmini maliyet, provider çağrılmadan ÖNCE atomik olarak
   * ayrılır) -> provider çağrısı -> mutabakat (`commit()` başarıda,
   * `release()` provider hata fırlatırsa). Bu ikisi arasına HİÇBİR
   * "kısayol" eklenemez çünkü hepsi AYNI fonksiyon gövdesinde yaşar.
   */
  async invoke(
    model: ModelRecord,
    request: ModelInvocationRequest,
    context: ModelInvocationContext
  ): Promise<ModelInvocationResponse> {
    const capabilityGateway = context.capabilityGateway ?? new CapabilityGateway(context.policy);

    return capabilityGateway.authorize(
      {
        actionType: "model.invoke",
        risk: context.risk,
        description:
          context.description ?? `Invoke model '${model.modelId}' (${model.tier}) for task ${context.taskId}`,
        costUsd: model.costPerCall
      },
      async () => {
        // Provider ÇAĞRILMADAN ÖNCE, tahmini maliyet (costPerCall) TÜM
        // ilgili tavanlara (mevcut açık rezervasyonlar dahil) karşı ATOMİK
        // olarak ayrılır — 10th independent review round fix, bkz.
        // runtime/budget/budget.ts'deki `reserve()` notu. Yetersiz bütçe,
        // hiçbir provider çağrısı yapılmadan reddeder (fail closed).
        const reservation = context.budget.reserve(
          { taskId: context.taskId, projectId: context.projectId },
          model.costPerCall
        );

        let response: ModelInvocationResponse;
        try {
          response = await this.#rawInvoke(model, request);
        } catch (err) {
          // Belgelenen mutabakat kuralı: provider hata fırlatırsa hiçbir
          // gerçek maliyet oluşmadığı varsayılır, rezervasyon TAMAMEN
          // serbest bırakılır (bkz. budget.ts release() notu).
          context.budget.release(reservation.id);
          throw err;
        }

        // Gerçek maliyet, validate() çağrılmadan ÖNCE ve KOŞULSUZ olarak
        // kaydedilir — bir çıktının sonradan geçersiz sayılması, zaten
        // gerçekleşmiş harcamanın kayıtlardan düşmesine ASLA yol açmaz.
        context.budget.commit(reservation.id, {
          taskId: context.taskId,
          projectId: context.projectId,
          provider: response.provider,
          modelId: response.modelId,
          amountUsd: response.costUsd
        });

        return response;
      }
    );
  }

  /**
   * HAM sağlayıcı çağrısı. Gerçek bir ECMAScript private metodu (`#`) —
   * bu sınıfın DIŞINDAN (bir proof, bir test, başka bir modül) HİÇBİR
   * ŞEKİLDE, hatta bir tip atlatmasıyla bile erişilemez (bkz. `#providers`
   * üstündeki not). PolicyEngine/BudgetGuard'ı atlayan tek yol, bu metoda
   * doğrudan erişim olurdu — artık bu erişim JS çalışma zamanının kendisi
   * tarafından engellenir, bir geliştirici sözleşmesi/kongvansiyonu
   * değil.
   */
  async #rawInvoke(model: ModelRecord, request: ModelInvocationRequest): Promise<ModelInvocationResponse> {
    const provider = this.#providers.get(model.provider);
    if (!provider) throw new UnknownProviderError(model.provider);
    return provider.invoke(model, request);
  }
}
