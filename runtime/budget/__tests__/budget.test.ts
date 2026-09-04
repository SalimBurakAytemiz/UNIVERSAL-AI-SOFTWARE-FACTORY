import { describe, expect, it } from "vitest";
import { CostEngine } from "../../cost/cost-engine.js";
import { BudgetExceededError, BudgetGuard } from "../budget.js";

describe("BudgetGuard", () => {
  it("allows spending within the per-task ceiling", () => {
    const costEngine = new CostEngine();
    const guard = new BudgetGuard(costEngine, { perTaskUsd: 1 });
    guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 0.5 });
    expect(costEngine.totalFor({ taskId: "t1" })).toBe(0.5);
  });

  it("Proof E: blocks a runaway loop before the per-task ceiling is exceeded", () => {
    const costEngine = new CostEngine();
    const guard = new BudgetGuard(costEngine, { perTaskUsd: 1 });

    let iterations = 0;
    expect(() => {
      for (let i = 0; i < 1000; i++) {
        iterations++;
        guard.spend({ taskId: "runaway", provider: "mock", modelId: "m1", amountUsd: 0.3 });
      }
    }).toThrow(BudgetExceededError);

    // Stopped well before 1000 iterations, and never recorded the call that would exceed the ceiling.
    expect(iterations).toBeLessThan(10);
    expect(costEngine.totalFor({ taskId: "runaway" })).toBeLessThanOrEqual(1);
  });

  it("blocks spending that would exceed the per-run ceiling even across different tasks", () => {
    const costEngine = new CostEngine();
    const guard = new BudgetGuard(costEngine, { perRunUsd: 1 });
    guard.spend({ taskId: "a", provider: "mock", modelId: "m1", amountUsd: 0.6 });
    expect(() => guard.spend({ taskId: "b", provider: "mock", modelId: "m1", amountUsd: 0.6 })).toThrow(
      BudgetExceededError
    );
    // The blocked spend was never recorded.
    expect(costEngine.total()).toBe(0.6);
  });
});
