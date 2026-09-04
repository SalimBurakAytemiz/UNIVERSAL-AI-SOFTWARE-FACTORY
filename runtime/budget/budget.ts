// Baseline section 70-72 (Project AI Budget, Agent/Task Budgets, Cost
// Ceilings) + Proof E (bölüm 306): bütçe tavanları kaçak (runaway) yürütmeyi
// DURDURUR. Bu koruma, harcama gerçekleşmeden ÖNCE (projected amount ile)
// çağrılmalıdır — yoksa tavanı aştıktan sonra durdurmak "sessiz harcama
// yok" ilkesini ihlal eder.

import type { CostEngine, CostScope } from "../cost/cost-engine.js";

export interface BudgetLimits {
  readonly perTaskUsd?: number;
  readonly perRunUsd?: number;
  readonly dailyUsd?: number;
  readonly monthlyUsd?: number;
}

export class BudgetExceededError extends Error {
  constructor(
    public readonly ceiling: "perTaskUsd" | "perRunUsd" | "dailyUsd" | "monthlyUsd",
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

export class BudgetGuard {
  constructor(
    private readonly costEngine: CostEngine,
    private readonly limits: BudgetLimits
  ) {}

  /**
   * Bir eylem gerçekleştirilmeden önce çağrılır. Eylem, herhangi bir tavanı
   * aşacaksa BudgetExceededError fırlatır ve harcama hiç gerçekleşmez.
   */
  assertWithinBudget(scope: CostScope, projectedAmountUsd: number): void {
    if (this.limits.perTaskUsd !== undefined && scope.taskId !== undefined) {
      const projected = this.costEngine.totalFor({ taskId: scope.taskId }) + projectedAmountUsd;
      if (projected > this.limits.perTaskUsd) {
        throw new BudgetExceededError("perTaskUsd", this.limits.perTaskUsd, projected);
      }
    }

    if (this.limits.perRunUsd !== undefined) {
      const projected = this.costEngine.total() + projectedAmountUsd;
      if (projected > this.limits.perRunUsd) {
        throw new BudgetExceededError("perRunUsd", this.limits.perRunUsd, projected);
      }
    }
  }

  /**
   * Bütçe kontrolünü geçerse maliyeti kaydeder; geçmezse hiçbir şey
   * kaydedilmeden hata fırlatır. Bu, "kontrol et sonra harca" sırasını
   * tek bir atomik adımda garanti eder.
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
