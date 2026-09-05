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

import { assertValidMonetaryAmount } from "../cost/cost-engine.js";
import type { CostEngine, CostScope } from "../cost/cost-engine.js";
import type { AuditLog } from "../audit/audit-log.js";

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

/** Verilen anın ait olduğu UTC takvim gününün başlangıcını (00:00:00.000Z) döndürür. */
function startOfUtcDay(date: Date): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString();
}

/** Verilen anın ait olduğu UTC takvim ayının başlangıcını (1. gün, 00:00:00.000Z) döndürür. */
function startOfUtcMonth(date: Date): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();
}

export class BudgetGuard {
  constructor(
    private readonly costEngine: CostEngine,
    private readonly limits: BudgetLimits,
    private readonly now: () => Date = () => new Date(),
    private readonly auditLog?: AuditLog
  ) {
    // Yanlış yapılandırılmış bir tavan (NaN/Infinity/negatif), kurulum
    // anında hemen reddedilir — ilk harcama denemesine kadar beklenmez.
    assertValidLimit("perTaskUsd", limits.perTaskUsd);
    assertValidLimit("perRunUsd", limits.perRunUsd);
    assertValidLimit("dailyUsd", limits.dailyUsd);
    assertValidLimit("monthlyUsd", limits.monthlyUsd);
  }

  private buildCeilingChecks(scope: CostScope, projectedAmountUsd: number): CeilingCheck[] {
    const checks: CeilingCheck[] = [];

    if (this.limits.perTaskUsd !== undefined && scope.taskId !== undefined) {
      checks.push({
        ceiling: "perTaskUsd",
        limit: this.limits.perTaskUsd,
        projected: this.costEngine.totalFor({ taskId: scope.taskId }) + projectedAmountUsd
      });
    }

    if (this.limits.perRunUsd !== undefined) {
      checks.push({
        ceiling: "perRunUsd",
        limit: this.limits.perRunUsd,
        projected: this.costEngine.total() + projectedAmountUsd
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
        projected: this.costEngine.totalInWindow(periodScope, startOfUtcDay(this.now())) + projectedAmountUsd
      });
    }

    if (this.limits.monthlyUsd !== undefined) {
      checks.push({
        ceiling: "monthlyUsd",
        limit: this.limits.monthlyUsd,
        projected: this.costEngine.totalInWindow(periodScope, startOfUtcMonth(this.now())) + projectedAmountUsd
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

    for (const check of checks) {
      if (check.projected > check.limit) {
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
}
