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
    // P2 fix (8th independent review round, "floating-point comparisons
    // reject exact budget spend"): 25 spends of $0.20 land EXACTLY on the
    // $5 ceiling in intent, but binary floating-point accumulation produces
    // a raw sum like 5.000000000000002 — a strict `toBeLessThanOrEqual(5)`
    // would fail on that harmless representational noise even though the
    // fixed monetary-precision comparison (runtime/cost/cost-engine.ts,
    // exceedsMonetaryAmount) correctly treats it as "at the ceiling, not
    // over it" and accepted it (this is the whole point of the fix — see
    // budget.test.ts). `toBeCloseTo` asserts the total is correct at the
    // Factory's own documented precision, not bitwise-exact float equality.
    expect(costEngine.total()).toBeCloseTo(5, 6);
  });
});
