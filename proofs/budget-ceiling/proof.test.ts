// Proof E (baseline section 306): "Budget ceilings stop runaway execution."
import { describe, expect, it } from "vitest";
import { CostEngine } from "../../runtime/cost/cost-engine.js";
import { BudgetExceededError, BudgetGuard } from "../../runtime/budget/budget.js";

describe("Proof: Budget ceilings stop runaway execution", () => {
  it("stops a simulated infinite retry loop at the configured daily-equivalent run ceiling", () => {
    const costEngine = new CostEngine();
    const guard = new BudgetGuard(costEngine, { perRunUsd: 5 });

    let callsMade = 0;
    let stoppedByBudget = false;

    try {
      // Simulate an agent stuck retrying a failing task forever.
      for (let i = 0; i < 100_000; i++) {
        guard.spend({ taskId: "stuck-agent", provider: "mock", modelId: "m1", amountUsd: 0.2 });
        callsMade++;
      }
    } catch (err) {
      if (err instanceof BudgetExceededError) stoppedByBudget = true;
    }

    expect(stoppedByBudget).toBe(true);
    expect(callsMade).toBeLessThan(100); // stopped almost immediately, not after 100,000 iterations
    expect(costEngine.total()).toBeLessThanOrEqual(5);
  });
});
