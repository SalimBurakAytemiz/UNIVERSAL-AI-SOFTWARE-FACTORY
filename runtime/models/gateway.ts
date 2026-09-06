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
import { freezeRecord } from "../util/immutable.js";

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
 *
 * P1 fix (11th independent review round, "supplied capability gateway can
 * bypass authoritative policy"): bu arayüz eskiden isteğe bağlı bir
 * `capabilityGateway?: CapabilityGateway` alanı içeriyordu ("zaten bir
 * örneğe sahip çağıranlar onu yeniden kullanabilir" amacıyla, saf bir
 * nesne-yeniden-kullanım optimizasyonu). Codex, bunun GERÇEK bir politika
 * atlatma vektörü olduğunu gösterdi: `authorize()` çağrısı
 * `context.capabilityGateway ?? new CapabilityGateway(context.policy)`
 * şeklindeydi — yani BİR çağıran, YETKİLİ (authoritative,
 * default-DENY olabilecek) bir `policy` sağlarken, AYNI ANDA bunu
 * TAMAMEN görmezden gelen, ALLOW-her-şeyi bir politikayla kurulmuş bir
 * `capabilityGateway` da sağlayabilirdi — `authorize()` ikincisini
 * kullanır, `context.policy` hiçbir zaman `evaluate()` çağırmaz, ve HİÇBİR
 * audit kaydı üretilmez. `CapabilityGateway` (runtime/capability-gateway/
 * gateway.ts) durumsuz, iki satırlık bir sarmalayıcıdır (`policy`
 * referansını tutmaktan başka hiçbir şey yapmaz) — yeniden kullanmanın
 * TEK faydası önemsiz bir nesne ayırma maliyetinden kaçınmaktı, bu da
 * "yetkili politikanın asla atlatılamaması" gereksiniminin yanında hiçbir
 * ağırlığı olmayan bir optimizasyondu. Fix: bu alan TAMAMEN KALDIRILDI —
 * artık `capabilityGateway` diye bir şey enjekte ETMENİN YOLU YOK; TEK
 * yetkilendirme yolu, `invoke()`'in KENDİSİNİN, HER ÇAĞRIDA, doğrudan
 * `context.policy`'den TAZE bir `CapabilityGateway` inşa etmesidir (bkz.
 * aşağıdaki `invoke()`). Bu, "bir boolean bayrak eklemek" veya "çağıranın
 * doğru gateway'i kullanmasını belgelemek" DEĞİLDİR — atlatma vektörünün
 * kendisi (enjekte edilebilir alternatif bir CapabilityGateway) tipten
 * SİLİNDİ.
 */
export interface ModelInvocationContext {
  readonly policy: PolicyEngine;
  readonly budget: BudgetGuard;
  readonly risk: RiskLevel;
  readonly taskId: string;
  readonly projectId?: string;
  readonly description?: string;
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
   *
   * P1 fix (11th independent review round, "caller context mutation can
   * change cost ownership during invocation"): Codex reproduced: bir
   * çağıran $0.60'ı proje A için rezerve eder, provider çağrısı
   * BAŞLAR, çağıran `await` SÜRERKEN `context.projectId`'yi B'ye
   * MUTASYONA UĞRATIR, ve mutabakat (commit) daha sonra ORİJİNAL
   * `context` nesnesini TEKRAR OKUDUĞU için maliyet B'ye kaydedilir —
   * A'nın rezervasyonu A'nın hiçbir zaman gerçek bir harcamayla
   * eşleşmediği, ve tekrarlanan çağrılarla A'nın görev tavanının
   * TAMAMEN atlatılabileceği anlamına gelir. Kök neden: `context`
   * çağıranın hâlâ bir referansını tuttuğu, sıradan (donmamış) bir
   * nesnedir, ve eski kod `context.taskId`/`context.projectId`'yi HEM
   * rezervasyon anında HEM DE (bir `await`den SONRA) mutabakat anında
   * AYRI AYRI okuyordu — ikisi arasında farklı değerler görebilirdi.
   * Fix: TÜM yetkili "sahiplik" alanları (taskId, projectId, risk,
   * description, model kimliği) herhangi bir asenkron iş BAŞLAMADAN
   * ÖNCE, donmuş/ayrık bir `executionScope` anlık görüntüsüne
   * KOPYALANIR (`freezeRecord`); `policy`/`budget` REFERANSLARI da aynı
   * anda yerel `const`'lara yakalanır (bir JS referansı yakalandıktan
   * SONRA, `context.policy = ...` gibi bir mutasyon o yerel değişkeni
   * ETKİLEMEZ). Bundan sonra kodun HİÇBİR YERİNDE `context.xxx`
   * DOĞRUDAN tekrar okunmaz — rezervasyon, provider çağrısı VE mutabakat
   * SADECE bu anlık görüntüyü kullanır. Çağıranın `context`'i
   * (paylaşılan/tekrar kullanılan bir nesne olsa bile) invoke() bu
   * anlık görüntüyü aldıktan SONRA yaptığı hiçbir mutasyon, bu ÇALIŞAN
   * invocation'ı ASLA etkileyemez — eşzamanlı iki invoke() çağrısı AYNI
   * paylaşılan `context` nesnesini kullansa bile, her biri KENDİ
   * senkron ön ekinde (herhangi bir await'ten önce) kendi bağımsız anlık
   * görüntüsünü alır, bu yüzden birbirlerini kirletemezler.
   */
  /**
   * P1 fix (12th independent review round, "model identity snapshot is
   * not used during provider execution"): Codex reproduced the
   * `executionScope` snapshot above capturing `model.modelId`/
   * `model.provider`/`model.costPerCall` for ACCOUNTING purposes, but the
   * ORIGINAL, caller-owned `model` object was still what actually got
   * passed into `#rawInvoke(model, request)` — so a caller mutating the
   * `model` object's fields (id, provider, tier, costPerCall) WHILE the
   * provider call was pending could make the ACTUAL provider invocation
   * (and, if a real adapter reads `model` lazily, its costUsd) diverge
   * from the identity that was authorized/reserved/accounted for, even
   * though `executionScope`'s COPY of those same fields stayed correct.
   * A snapshot that isn't the thing actually used protects nothing. Fix:
   * `model` is copied into a frozen, detached `authorizedModel`
   * (`freezeRecord`) as the very FIRST thing `invoke()` does — before
   * `executionScope` is even built (which now reads from
   * `authorizedModel`, not `model`) and certainly before any async work
   * — and `authorizedModel` (never the original `model` parameter) is
   * what gets passed to `#rawInvoke()`. `capabilities` is an array field;
   * `freezeRecord` freezes a COPY of it too, so `model.capabilities.push(...)`
   * afterward cannot even reach the snapshot's array.
   *
   * P1 fix (13th independent review round, "provider/model identity can
   * still change accounting and audit evidence"): the 12th round's fix
   * above closed the gap for the ACTUAL PROVIDER CALL (`#rawInvoke` now
   * receives `authorizedModel`), but `commit()` (below) was STILL called
   * with `provider: response.provider, modelId: response.modelId` — i.e.
   * the IDENTITY FIELDS of the raw response the provider itself returned,
   * not the authorized identity that was reserved. Since `response` comes
   * from an external `ModelProvider.invoke()` implementation (untrusted
   * from this class's point of view — a misbehaving or compromised
   * provider adapter could return ANY `modelId`/`provider` string it
   * likes), accounting/audit/reconciliation could be silently redefined
   * by the PROVIDER'S OWN RETURN VALUE even with the model-mutation gap
   * closed. The required invariant is: AUTHORIZE one identity -> INVOKE
   * that identity -> ACCOUNT that SAME identity -> RECONCILE that SAME
   * identity -> AUDIT that SAME identity — no response object may
   * redefine it. Fixed: `commit()` is now called with
   * `provider: authorizedModel.provider, modelId: authorizedModel.modelId`
   * — the PRE-AUTHORIZED snapshot — never `response.provider`/
   * `response.modelId`. `response.costUsd` is still used for the actual
   * dollar AMOUNT (a provider legitimately reports what a call actually
   * cost; that is not an identity field), but a provider can no longer
   * redirect WHOSE ledger that amount lands on. `authorizedModel.provider`/
   * `.modelId` are also now passed to `budget.reserve()` (see below), so
   * `commit()`'s own ownership-mismatch check (runtime/budget/budget.ts)
   * independently re-verifies this at the reservation layer too —
   * defense in depth, not reliance on this call site alone getting it
   * right.
   */
  async invoke(
    model: ModelRecord,
    request: ModelInvocationRequest,
    context: ModelInvocationContext
  ): Promise<ModelInvocationResponse> {
    // Herhangi bir asenkron iş BAŞLAMADAN ÖNCE: yetkili, ayrık model
    // kimliği anlık görüntüsü — bkz. yukarıdaki fix notu. Bundan sonra
    // `model` parametresinin KENDİSİ bir daha ASLA okunmaz/geçirilmez;
    // sadece `authorizedModel` kullanılır.
    const authorizedModel: ModelRecord = freezeRecord({ ...model });

    // P1 fix (13th independent review round, "invocation payload remains
    // caller-mutable during execution"): Codex reproduced `request`
    // (prompt/taskType) being passed DIRECTLY into `#rawInvoke(model,
    // request)` with no snapshot of its own — a caller mutating
    // `request.prompt`/`.taskType` WHILE the provider call was pending
    // (the SAME microtask-ordering scenario proven for `model` above)
    // could make a replacement payload execute under the authorization/
    // budget already reserved for the ORIGINAL prompt. Fixed the same
    // way: `request` is copied into a frozen, detached `authorizedRequest`
    // in this same synchronous prefix, before any await, and
    // `authorizedRequest` (never the original `request` parameter) is
    // what gets passed to `#rawInvoke()`.
    const authorizedRequest: ModelInvocationRequest = freezeRecord({ ...request });

    // Herhangi bir asenkron iş (hatta CapabilityGateway.authorize()'ın
    // KENDİSİ) başlamadan ÖNCE: yetkili sahiplik anlık görüntüsü.
    const executionScope = freezeRecord({
      taskId: context.taskId,
      projectId: context.projectId,
      risk: context.risk,
      description:
        context.description ??
        `Invoke model '${authorizedModel.modelId}' (${authorizedModel.tier}) for task ${context.taskId}`,
      modelId: authorizedModel.modelId,
      provider: authorizedModel.provider,
      costPerCallUsd: authorizedModel.costPerCall
    });
    // `policy`/`budget` REFERANSLARI da hemen yakalanır — bkz. yukarıdaki
    // fix notu. `context.policy`/`context.budget`'a bundan sonra ASLA
    // tekrar erişilmez.
    const budget = context.budget;
    // P1 fix (11th independent review round, "supplied capability gateway
    // can bypass authoritative policy"): eskiden `context.capabilityGateway
    // ?? new CapabilityGateway(context.policy)` idi — bir çağıran YETKİLİ
    // (ör. default-DENY) bir `policy` sağlarken AYNI ZAMANDA bunu
    // TAMAMEN görmezden gelen, ALLOW-her-şeyi bir politikayla kurulmuş
    // ayrı bir `capabilityGateway` da sağlayabilir ve `authorize()`
    // ikincisini kullanırdı — `context.policy` HİÇBİR ZAMAN
    // `evaluate()` çağırmaz, sıfır audit kaydı üretilirdi. Enjekte
    // edilebilir bir `capabilityGateway` artık TİPTE BİLE YOK (bkz.
    // `ModelInvocationContext`) — TEK yetkilendirme yolu, HER ÇAĞRIDA
    // doğrudan `context.policy`'den TAZE inşa edilen BU
    // `CapabilityGateway`'dir.
    const capabilityGateway = new CapabilityGateway(context.policy);

    return capabilityGateway.authorize(
      {
        actionType: "model.invoke",
        risk: executionScope.risk,
        description: executionScope.description,
        costUsd: executionScope.costPerCallUsd
      },
      async () => {
        // Provider ÇAĞRILMADAN ÖNCE, tahmini maliyet (costPerCall) TÜM
        // ilgili tavanlara (mevcut açık rezervasyonlar dahil) karşı ATOMİK
        // olarak ayrılır — 10th independent review round fix, bkz.
        // runtime/budget/budget.ts'deki `reserve()` notu. Yetersiz bütçe,
        // hiçbir provider çağrısı yapılmadan reddeder (fail closed).
        // P1 fix (13th independent review round, "reservation ownership
        // checks omit agent identity" / "provider/model identity can
        // still change accounting"): `provider`/`modelId` are now part of
        // what's reserved too (from `authorizedModel`, the pre-authorized
        // snapshot) — `budget.ts`'s `commit()` independently validates
        // these against what is ACTUALLY committed, so even if this call
        // site's own commit() call below were ever changed incorrectly,
        // the reservation layer itself still fails closed.
        const reservation = budget.reserve(
          {
            taskId: executionScope.taskId,
            projectId: executionScope.projectId,
            provider: authorizedModel.provider,
            modelId: authorizedModel.modelId
          },
          executionScope.costPerCallUsd
        );

        let response: ModelInvocationResponse;
        try {
          response = await this.#rawInvoke(authorizedModel, authorizedRequest);
        } catch (err) {
          // Belgelenen mutabakat kuralı: provider hata fırlatırsa hiçbir
          // gerçek maliyet oluşmadığı varsayılır, rezervasyon TAMAMEN
          // serbest bırakılır (bkz. budget.ts release() notu).
          budget.release(reservation.id);
          throw err;
        }

        // Gerçek maliyet, validate() çağrılmadan ÖNCE ve KOŞULSUZ olarak
        // kaydedilir — bir çıktının sonradan geçersiz sayılması, zaten
        // gerçekleşmiş harcamanın kayıtlardan düşmesine ASLA yol açmaz.
        // taskId/projectId, `context`'ten DEĞİL, `executionScope`
        // anlık görüntüsünden okunur (bkz. yukarıdaki fix notu) — bu
        // await'ten SONRA çağıranın `context`'i mutasyona uğramış olsa
        // bile, mutabakat HER ZAMAN rezervasyonun sahibiyle AYNI kapsamı
        // kullanır. P1 fix (13th independent review round, "provider/model
        // identity can still change accounting and audit evidence"):
        // `provider`/`modelId` are now taken from `authorizedModel` (the
        // PRE-AUTHORIZED identity snapshot), NOT from `response.provider`/
        // `response.modelId` — a provider adapter's own return value can
        // no longer redefine WHOSE ledger a cost lands on, even though its
        // reported `costUsd` (a legitimate actual-amount value, not an
        // identity field) is still used for the dollar amount recorded.
        budget.commit(reservation.id, {
          taskId: executionScope.taskId,
          projectId: executionScope.projectId,
          provider: authorizedModel.provider,
          modelId: authorizedModel.modelId,
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
