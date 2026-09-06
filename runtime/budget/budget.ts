// Baseline section 70-72 (Project AI Budget, Agent/Task Budgets, Cost
// Ceilings) + Proof E (bölüm 306): bütçe tavanları kaçak (runaway) yürütmeyi
// DURDURUR. Bu koruma, harcama gerçekleşmeden ÖNCE (projected amount ile)
// çağrılmalıdır — yoksa tavanı aştıktan sonra durdurmak "sessiz harcama
// yok" ilkesini ihlal eder.
//
// dailyUsd/monthlyUsd DÖNEMSEL tavanlardır: her gün/ay başında sıfırlanır
// (UTC takvim günü/ayı — kayan 24 saat/30 gün penceresi DEĞİL, çünkü
// dönemin ne zaman başladığı belirsizleşirse denetim de belirsizleşir).
// `now` enjekte edilebilir bir saat fonksiyonudur; testler bunu ilerleterek
// gün/ay sınırlarını (rollover) gerçek zaman geçmeden doğrulayabilir.

import { assertValidMonetaryAmount, exceedsMonetaryAmount } from "../cost/cost-engine.js";
import type { CostEngine, CostEntry, CostScope } from "../cost/cost-engine.js";
import type { AuditLog } from "../audit/audit-log.js";
import { freezeRecord } from "../util/immutable.js";

export type BudgetCeilingName = "perTaskUsd" | "perRunUsd" | "dailyUsd" | "monthlyUsd";

export interface BudgetLimits {
  readonly perTaskUsd?: number;
  readonly perRunUsd?: number;
  readonly dailyUsd?: number;
  readonly monthlyUsd?: number;
}

export class InvalidBudgetLimitError extends Error {
  constructor(ceiling: BudgetCeilingName, limit: number) {
    super(
      `Invalid budget limit for '${ceiling}': ${limit}. Configured ceilings must be ` +
        `finite and non-negative (NaN/Infinity/-Infinity/negative are rejected).`
    );
    this.name = "InvalidBudgetLimitError";
  }
}

function assertValidLimit(ceiling: BudgetCeilingName, limit: number | undefined): void {
  if (limit === undefined) return;
  if (!Number.isFinite(limit) || limit < 0) {
    throw new InvalidBudgetLimitError(ceiling, limit);
  }
}

export class BudgetExceededError extends Error {
  constructor(
    public readonly ceiling: BudgetCeilingName,
    public readonly limit: number,
    public readonly wouldBeTotal: number
  ) {
    super(
      `Budget ceiling '${ceiling}' ($${limit}) would be exceeded by this action ` +
        `(projected total $${wouldBeTotal.toFixed(4)}). Execution blocked before spending occurred.`
    );
    this.name = "BudgetExceededError";
  }
}

interface CeilingCheck {
  readonly ceiling: BudgetCeilingName;
  readonly limit: number;
  readonly projected: number;
}

export interface Reservation {
  readonly id: string;
  readonly scope: Readonly<CostScope>;
  readonly amountUsd: number;
}

export class UnknownReservationError extends Error {
  constructor(reservationId: string) {
    super(
      `No open reservation '${reservationId}' — it may have already been committed/released, ` +
        `or never existed. commit()/release() must be called at most once per reserve() call.`
    );
    this.name = "UnknownReservationError";
  }
}

/**
 * İki AYRI CostScope'un aynı "sorguyu" karşılayıp karşılamadığını
 * kontrol eder — cost-engine.ts'nin `matchesScope`'u ile AYNI alan-eşleme
 * mantığı (taskId/agentId/projectId), ama bir CostEntry yerine bekleyen
 * bir rezervasyonun KENDİ kapsamına karşı çalışır. Tavan hesaplamalarının
 * (buildCeilingChecks) hem GERÇEKLEŞMİŞ harcamaları (CostEngine) hem de
 * HENÜZ gerçekleşmemiş ama zaten "ayrılmış" tutarları (reservations) AYNI
 * kapsam kuralıyla toplayabilmesi için tek kaynak.
 */
function scopeMatches(record: CostScope, query: CostScope): boolean {
  return (
    (query.taskId === undefined || record.taskId === query.taskId) &&
    (query.agentId === undefined || record.agentId === query.agentId) &&
    (query.projectId === undefined || record.projectId === query.projectId)
  );
}

/** Verilen anın ait olduğu UTC takvim gününün başlangıcını (00:00:00.000Z) döndürür. */
function startOfUtcDay(date: Date): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString();
}

/** Verilen anın ait olduğu UTC takvim ayının başlangıcını (1. gün, 00:00:00.000Z) döndürür. */
function startOfUtcMonth(date: Date): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();
}

export class BudgetGuard {
  /**
   * P1 fix (4th independent review round): eskiden constructor,
   * ÇAĞIRANIN geçtiği `limits` nesnesinin REFERANSINI doğrudan saklıyordu.
   * TypeScript'in `readonly` işaretleyicisi yalnızca derleme zamanında
   * uyarır — çağıran, kaydettikten SONRA aynı nesneyi
   * (`limits.dailyUsd = -1` gibi) mutasyona uğratırsa, bu doğrudan
   * yetkili (authoritative) tavanları da bozardı; kurulum anındaki
   * doğrulama bunu YAKALAYAMAZ çünkü mutasyon doğrulamadan SONRA olur.
   * Artık: doğrula, SONRA çağıranın nesnesinden BAĞIMSIZ, donmuş bir iç
   * kopya oluştur — orijinal nesneye yapılan hiçbir sonraki mutasyon iç
   * durumu etkileyemez.
   */
  private readonly limits: Readonly<BudgetLimits>;

  /**
   * P1 fix (10th independent review round, "concurrent model invocations
   * can exceed budgets"): Codex reproduced two concurrent $0.60 provider
   * calls against a $1.00 ceiling BOTH executing — each independently
   * called `assertWithinBudget()` (a pure read of ALREADY-recorded totals)
   * BEFORE either had recorded anything, so both passed; the actual
   * `spend()` call only happened AFTER an `await`ed provider round-trip,
   * by which point BOTH providers had already been invoked and BOTH real
   * costs had already been incurred — `spend()` itself is atomic
   * (no `await` between its own check and its own record), so it correctly
   * rejected the SECOND `spend()` call, but that rejection happened AFTER
   * the second $0.60 was already spent for real, silently losing track of
   * $0.60 of genuinely incurred cost. The root cause is a classic
   * check-then-(async-gap)-then-act race: `assertWithinBudget()` alone
   * checks but never RESERVES anything, so nothing stops a second
   * concurrent caller from also passing the same check during that gap.
   * Fixed with a reservation/reconciliation model: `reserve()` atomically
   * (synchronously, no `await` inside it — JS's single-threaded run-to-
   * completion semantics make "check its ceilings" and "record the
   * reservation" a single indivisible step, exactly like the existing
   * `spend()`) evaluates ALL ceilings INCLUDING every other currently-open
   * reservation, and only if none would be exceeded does it add a new
   * reservation and return an opaque handle — this must happen and
   * complete BEFORE any provider is ever invoked. After the (awaited,
   * genuinely concurrent-safe) provider call, `commit()` deletes the
   * reservation and records the ACTUAL incurred cost unconditionally
   * (never re-checked against ceilings, and never dropped, even if that
   * pushes a ceiling into overage on paper — bölüm 147, "sessiz harcama
   * yok" means an already-incurred real-world cost may NEVER be silently
   * discarded just because accounting it would look bad); an overage is
   * still detected and logged to the audit trail for visibility, but the
   * cost itself is always recorded. `release()` is the documented
   * reconciliation rule for a provider call that THROWS (P0's providers
   * are assumed not to partially bill on failure — a real provider
   * adapter that CAN incur a partial cost on failure must report that
   * partial cost via `commit()` with the partial amount, not `release()`,
   * which is out of scope for the MockProvider this repository ships).
   */
  private readonly reservations = new Map<string, { scope: Readonly<CostScope>; amountUsd: number }>();
  private reservationSeq = 0;

  constructor(
    private readonly costEngine: CostEngine,
    limits: BudgetLimits,
    private readonly now: () => Date = () => new Date(),
    private readonly auditLog?: AuditLog
  ) {
    // Yanlış yapılandırılmış bir tavan (NaN/Infinity/negatif), kurulum
    // anında hemen reddedilir — ilk harcama denemesine kadar beklenmez.
    assertValidLimit("perTaskUsd", limits.perTaskUsd);
    assertValidLimit("perRunUsd", limits.perRunUsd);
    assertValidLimit("dailyUsd", limits.dailyUsd);
    assertValidLimit("monthlyUsd", limits.monthlyUsd);
    this.limits = freezeRecord({ ...limits });
  }

  /**
   * Yapılandırılmış tavanların salt-okunur, ayrık bir anlık görüntüsü.
   * Döndürülen nesne üzerindeki hiçbir mutasyon iç `this.limits`'i
   * etkilemez (donmuş + kopya).
   */
  getLimits(): Readonly<BudgetLimits> {
    return freezeRecord({ ...this.limits });
  }

  /**
   * P1 fix (5th independent review round, "per-task budgets mix
   * projects"): perTaskUsd eskiden yalnızca `taskId`'ye göre kapsamlanıyordu
   * — Codex, aynı `taskId`'yi kullanan İKİ FARKLI projenin (ör. genel bir
   * "bootstrap" görev şablonu) aynı $X tavanını PAYLAŞTIĞINI gösterdi:
   * Proje A kendi $1'lık tavanını harcadığında, Proje B'nin kendi ayrı ve
   * hiç kullanılmamış $1'lık tavanı da BOŞ YERE reddediliyordu.
   *
   * Kapsamlama semantiği (bölüm 70-72), artık AÇIKÇA şu şekilde
   * tanımlanır: bir `projectId` VERİLMİŞSE, görev bütçesi anahtarı
   * `projectId + taskId`'dir (aynı projedeki aynı görev tekrar tekrar
   * kullanılabilir/paylaşılabilir, ama FARKLI projeler asla aynı tavanı
   * paylaşmaz). `projectId` verilMEMİŞSE (ör. proje-bağımsız bir arka
   * plan/altyapı görevi), tavan KASITLI OLARAK global kalır — yalnızca
   * `taskId`'ye göre kapsamlanır — çünkü bu, mevcut sözleşmenin
   * (`spend()` her zaman `projectId` geçmek ZORUNDA değildir) desteklediği
   * meşru bir kullanım şeklidir.
   */
  /** Verilen sorguyla eşleşen TÜM açık rezervasyonların toplamı (bkz. scopeMatches). */
  private reservedTotal(query: CostScope): number {
    let total = 0;
    for (const reservation of this.reservations.values()) {
      if (scopeMatches(reservation.scope, query)) {
        total += reservation.amountUsd;
      }
    }
    return total;
  }

  /**
   * Her tavan kontrolü artık ÜÇ bileşenin toplamına karşı değerlendirilir:
   * (1) CostEngine'e zaten KAYDEDİLMİŞ gerçek harcamalar, (2) henüz
   * mutabakata varılmamış ama zaten AYRILMIŞ (`reserve()` ile açılmış,
   * henüz `commit()`/`release()` edilmemiş) tutarlar, (3) bu ÇAĞRININ
   * kendi projeksiyonu. (2)'nin dahil edilmesi, tam olarak 10th
   * independent review round'un eşzamanlılık düzeltmesidir — onsuz, iki
   * eşzamanlı `reserve()` çağrısı yine birbirini GÖRMEZ ve ikisi de geçer.
   */
  private buildCeilingChecks(scope: CostScope, projectedAmountUsd: number): CeilingCheck[] {
    const checks: CeilingCheck[] = [];

    if (this.limits.perTaskUsd !== undefined && scope.taskId !== undefined) {
      const taskScope: CostScope =
        scope.projectId !== undefined ? { taskId: scope.taskId, projectId: scope.projectId } : { taskId: scope.taskId };
      checks.push({
        ceiling: "perTaskUsd",
        limit: this.limits.perTaskUsd,
        projected: this.costEngine.totalFor(taskScope) + this.reservedTotal(taskScope) + projectedAmountUsd
      });
    }

    if (this.limits.perRunUsd !== undefined) {
      checks.push({
        ceiling: "perRunUsd",
        limit: this.limits.perRunUsd,
        projected: this.costEngine.total() + this.reservedTotal({}) + projectedAmountUsd
      });
    }

    // dailyUsd/monthlyUsd: taskId'ye göre DEĞİL, verilirse projectId'ye göre
    // (yoksa motorun tamamına göre) kapsamlanır — perTaskUsd'nin aksine, bu
    // tavanlar tek bir görev için değil bir dönem için tanımlıdır.
    const periodScope: CostScope = scope.projectId !== undefined ? { projectId: scope.projectId } : {};

    if (this.limits.dailyUsd !== undefined) {
      checks.push({
        ceiling: "dailyUsd",
        limit: this.limits.dailyUsd,
        projected:
          this.costEngine.totalInWindow(periodScope, startOfUtcDay(this.now())) +
          this.reservedTotal(periodScope) +
          projectedAmountUsd
      });
    }

    if (this.limits.monthlyUsd !== undefined) {
      checks.push({
        ceiling: "monthlyUsd",
        limit: this.limits.monthlyUsd,
        projected:
          this.costEngine.totalInWindow(periodScope, startOfUtcMonth(this.now())) +
          this.reservedTotal(periodScope) +
          projectedAmountUsd
      });
    }

    return checks;
  }

  /**
   * Bir eylem gerçekleştirilmeden önce çağrılır. Eylem, herhangi bir tavanı
   * aşacaksa BudgetExceededError fırlatır ve harcama hiç gerçekleşmez.
   * Her kontrol (izin verilen ya da engellenen), bir AuditLog verildiyse,
   * kalıcı kanıt olarak kaydedilir (bölüm 242, 303 — "no claim without
   * evidence" bütçe kararları için de geçerlidir).
   */
  assertWithinBudget(scope: CostScope, projectedAmountUsd: number): void {
    // Herhangi bir karşılaştırma yapılmadan veya durum değiştirilmeden ÖNCE
    // doğrula: NaN sızarsa `NaN > limit` HER ZAMAN false döner (tavan
    // sessizce atlanmış olur) ve negatif bir tutar yapay bütçe payı
    // yaratabilir. Bu yüzden fail-closed burada, en başta gerçekleşir.
    try {
      assertValidMonetaryAmount(projectedAmountUsd, "BudgetGuard.assertWithinBudget");
    } catch (err) {
      this.auditLog?.append({
        type: "BUDGET_INVALID_AMOUNT_REJECTED",
        actor: "budget-guard",
        payload: { scope, projectedAmountUsd, reason: err instanceof Error ? err.message : String(err) },
        timestamp: this.now().toISOString()
      });
      throw err;
    }

    const checks = this.buildCeilingChecks(scope, projectedAmountUsd);

    // P2 fix (8th independent review round, "floating-point comparisons
    // reject exact budget spend"): eskiden burada ÇIPLAK `>` operatörü
    // kullanılıyordu — `0.10` + `0.20` gibi ikili kayan noktalı toplamalar
    // `0.30000000000000004` ürettiğinde, TAM tavan harcaması (`0.30`)
    // yanlışlıkla reddediliyordu. `exceedsMonetaryAmount()` (runtime/cost/
    // cost-engine.ts), TÜM dört tavan türü için AYNI, merkezi, belgelenen
    // hassasiyet politikasını (mikro-dolar tam sayı birimleri) kullanır —
    // dağınık/rastgele bir epsilon değil.
    for (const check of checks) {
      if (exceedsMonetaryAmount(check.projected, check.limit)) {
        this.auditLog?.append({
          type: "BUDGET_BLOCKED",
          actor: "budget-guard",
          payload: { scope, projectedAmountUsd, ...check },
          timestamp: this.now().toISOString()
        });
        throw new BudgetExceededError(check.ceiling, check.limit, check.projected);
      }
    }

    this.auditLog?.append({
      type: "BUDGET_CHECK_PASSED",
      actor: "budget-guard",
      payload: { scope, projectedAmountUsd, checks },
      timestamp: this.now().toISOString()
    });
  }

  /**
   * Bütçe kontrolünü geçerse maliyeti kaydeder; geçmezse hiçbir şey
   * kaydedilmeden hata fırlatır. Bu, "kontrol et sonra harca" sırasını
   * tek bir atomik adımda garanti eder. Node.js tek iş parçacıklı olduğu
   * ve bu iki adım arasında hiçbir `await` bulunmadığı için, aynı anda
   * gelen birçok `spend()` çağrısı arasında bir yarış durumu (race
   * condition) OLUŞAMAZ — her çağrı, bir sonraki başlamadan tamamen biter
   * (eşzamanlılık güvenliği, JS çalışma zamanının kendisinden gelir).
   */
  spend(entry: {
    taskId: string;
    agentId?: string;
    projectId?: string;
    provider: string;
    modelId: string;
    amountUsd: number;
  }) {
    this.assertWithinBudget({ taskId: entry.taskId, projectId: entry.projectId }, entry.amountUsd);
    return this.costEngine.record(entry);
  }

  /**
   * Bir provider/model çağrısı yapılmadan ÖNCE çağrılır — `spend()`'in
   * "kontrol et + kaydet" atomikliğinin AYNISINI, ama gerçek maliyet henüz
   * bilinmezken (yalnızca TAHMİNİ maliyet bilinirken) sağlar. `reserve()`
   * içinde HİÇBİR `await` yoktur; kontrol VE yeni rezervasyonun eklenmesi
   * tek bir senkron JS "tick"inde gerçekleşir, bu yüzden eşzamanlı iki
   * `reserve()` çağrısı arasında ARADA KALAN bir an OLAMAZ — biri
   * tamamlanmadan diğeri BAŞLAYAMAZ (10th independent review round fix,
   * bkz. `reservations` alanının üstündeki not). Tavan aşılıyorsa (mevcut
   * kayıtlı harcamalar + TÜM diğer açık rezervasyonlar + bu tahmini tutar),
   * fail-closed olunur ve HİÇBİR rezervasyon oluşturulmaz — çağıran,
   * provider'ı ASLA çağırmamalıdır.
   */
  reserve(scope: CostScope, amountUsd: number): Reservation {
    try {
      assertValidMonetaryAmount(amountUsd, "BudgetGuard.reserve");
    } catch (err) {
      this.auditLog?.append({
        type: "BUDGET_INVALID_AMOUNT_REJECTED",
        actor: "budget-guard",
        payload: { scope, amountUsd, reason: err instanceof Error ? err.message : String(err) },
        timestamp: this.now().toISOString()
      });
      throw err;
    }

    const checks = this.buildCeilingChecks(scope, amountUsd);
    for (const check of checks) {
      if (exceedsMonetaryAmount(check.projected, check.limit)) {
        this.auditLog?.append({
          type: "BUDGET_RESERVATION_BLOCKED",
          actor: "budget-guard",
          payload: { scope, amountUsd, ...check },
          timestamp: this.now().toISOString()
        });
        throw new BudgetExceededError(check.ceiling, check.limit, check.projected);
      }
    }

    const id = `res-${++this.reservationSeq}`;
    const frozenScope = freezeRecord({ ...scope });
    this.reservations.set(id, { scope: frozenScope, amountUsd });

    this.auditLog?.append({
      type: "BUDGET_RESERVATION_CREATED",
      actor: "budget-guard",
      payload: { reservationId: id, scope, amountUsd, checks },
      timestamp: this.now().toISOString()
    });

    return freezeRecord({ id, scope: frozenScope, amountUsd });
  }

  /**
   * Provider çağrısı BAŞARIYLA tamamlandıktan sonra çağrılır — GERÇEK
   * (tahmini değil) maliyeti KOŞULSUZ olarak kaydeder ve YALNIZCA bu
   * kayıt GÜVENLE tamamlandıktan SONRA açık rezervasyonu siler.
   * "Koşulsuz" kastidir: bir çıktının SONRADAN `validate()`'i geçememesi
   * (ya da mutabakat anında bir tavanın kağıt üzerinde aşılmış görünmesi)
   * zaten GERÇEKLEŞMİŞ bir maliyeti asla SİLEMEZ (bölüm 147, "sessiz
   * harcama yok") — bu yüzden burada `assertWithinBudget` TEKRAR
   * ÇAĞRILMAZ. Aşım yine de AuditLog'a `overages` olarak kaydedilir
   * (görünürlük için), ama harcamanın kendisi HER ZAMAN kaydedilir.
   * Rezervasyon zaten mevcut değilse (örn. `commit()`/`release()` daha
   * önce çağrılmışsa) UnknownReservationError fırlatır — aynı
   * rezervasyonun İKİ KEZ mutabakata varılması yapısal olarak
   * imkânsızdır.
   *
   * P1 fix (11th independent review round, "failed reconciliation
   * releases reservation before cost is safely recorded"): Codex
   * reproduced: bir rezervasyon var, mutabakat BAŞLAR, rezervasyon ÖNCE
   * SİLİNİR, ardından `entry.amountUsd` (ör. NaN) doğrulaması BAŞARISIZ
   * OLUR — rezervasyon artık YOK, hiçbir maliyet KAYDEDİLMEDİ, ve
   * korunan bütçe kapasitesi SESSİZCE geri gelir: başka (tam tavanlık)
   * bir rezervasyon şimdi başarıyla oluşturulabilir, üstelik GERÇEK (ya
   * da potansiyel olarak gerçek) bir provider çağrısı zaten olmuş
   * olabilir. Kök neden: silme İŞLEMİ, doğrulama/kayıt BAŞARIYLA
   * tamamlanmadan ÖNCE gerçekleşiyordu. Fix: sıra TERSİNE ÇEVRİLDİ —
   * `assertValidMonetaryAmount` VE `costEngine.record()` artık
   * rezervasyon HÂLÂ AÇIKKEN çalışır; rezervasyon SADECE bu ikisi
   * GERÇEKTEN başarılı olduktan SONRA silinir. Doğrulama veya kayıt
   * BAŞARISIZ olursa: rezervasyon KORUNUR (silinmez — bu yüzden
   * `reservedTotal()` üzerinden HÂLÂ her tavana karşı sayılmaya devam
   * eder, "korunan bütçe kapasitesi" asla sessizce serbest kalmaz),
   * başarısızlık BUDGET_RESERVATION_COMMIT_FAILED olarak audit'e
   * KAYDEDİLİR (sessiz değil — mutabakatın ÇÖZÜLMEMİŞ kaldığının
   * kanıtı), ve hata YENİDEN fırlatılır (fail closed). Rezervasyon hâlâ
   * açık olduğundan, çağıran DAHA SONRA (ör. gerçek tutar netleştiğinde)
   * `commit()`'i AYNI `reservationId` ile GÜVENLE TEKRAR deneyebilir —
   * yeniden deneme doğası gereği güvenlidir (idempotent), çünkü
   * rezervasyon hâlâ oradadır.
   */
  commit(
    reservationId: string,
    entry: { taskId: string; agentId?: string; projectId?: string; provider: string; modelId: string; amountUsd: number }
  ) {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) {
      throw new UnknownReservationError(reservationId);
    }

    let recorded: CostEntry;
    try {
      assertValidMonetaryAmount(entry.amountUsd, `BudgetGuard.commit(reservationId=${reservationId})`);
      recorded = this.costEngine.record(entry);
    } catch (err) {
      // Rezervasyon KASITLI OLARAK silinmez — mutabakat başarısız oldu,
      // korunan kapasite açık/çözülmemiş kalmalıdır.
      this.auditLog?.append({
        type: "BUDGET_RESERVATION_COMMIT_FAILED",
        actor: "budget-guard",
        payload: {
          reservationId,
          reservedScope: reservation.scope,
          reservedAmountUsd: reservation.amountUsd,
          attemptedActualAmountUsd: entry.amountUsd,
          reason: err instanceof Error ? err.message : String(err)
        },
        timestamp: this.now().toISOString()
      });
      throw err;
    }

    // Rezervasyon ANCAK ŞİMDİ, gerçek maliyet GÜVENLE ve KALICI olarak
    // kaydedildikten SONRA silinir — "başarılı mutabakat, rezervasyonu
    // TAM OLARAK BİR KEZ serbest bırakır/dönüştürür."
    this.reservations.delete(reservationId);

    const overages = this.buildCeilingChecks({ taskId: entry.taskId, projectId: entry.projectId }, 0).filter((check) =>
      exceedsMonetaryAmount(check.projected, check.limit)
    );

    this.auditLog?.append({
      type: "BUDGET_RESERVATION_COMMITTED",
      actor: "budget-guard",
      payload: {
        reservationId,
        reservedScope: reservation.scope,
        reservedAmountUsd: reservation.amountUsd,
        actualAmountUsd: entry.amountUsd,
        entry: recorded,
        overages
      },
      timestamp: this.now().toISOString()
    });

    return recorded;
  }

  /**
   * Provider çağrısı BAŞARISIZ olduğunda (istisna fırlattığında) çağrılır
   * — belgelenen mutabakat kuralı budur: HİÇBİR gerçek maliyet
   * OLUŞMADIĞI varsayılır (bu depodaki MockProvider için doğru olan
   * varsayım), bu yüzden rezervasyon hiçbir kayıt oluşturmadan tamamen
   * SERBEST BIRAKILIR. Kısmi faturalandırma yapabilen GERÇEK bir provider
   * adaptörü bunun yerine `commit()`'i KISMİ gerçek tutarla çağırmalıdır
   * — bu P0 kapsamının dışındadır.
   */
  release(reservationId: string): void {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) {
      throw new UnknownReservationError(reservationId);
    }
    this.reservations.delete(reservationId);

    this.auditLog?.append({
      type: "BUDGET_RESERVATION_RELEASED",
      actor: "budget-guard",
      payload: { reservationId, scope: reservation.scope, amountUsd: reservation.amountUsd },
      timestamp: this.now().toISOString()
    });
  }
}
