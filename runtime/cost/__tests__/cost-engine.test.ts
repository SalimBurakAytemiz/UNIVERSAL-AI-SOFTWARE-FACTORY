import { describe, expect, it } from "vitest";
import { CostEngine } from "../cost-engine.js";

describe("CostEngine", () => {
  it("accumulates cost entries and reports totals scoped by task", () => {
    const engine = new CostEngine();
    engine.record({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 0.01 });
    engine.record({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 0.02 });
    engine.record({ taskId: "t2", provider: "mock", modelId: "m1", amountUsd: 0.5 });

    expect(engine.totalFor({ taskId: "t1" })).toBeCloseTo(0.03);
    expect(engine.totalFor({ taskId: "t2" })).toBeCloseTo(0.5);
    expect(engine.total()).toBeCloseTo(0.53);
  });

  it("scopes by project when provided", () => {
    const engine = new CostEngine();
    engine.record({ taskId: "t1", projectId: "p1", provider: "mock", modelId: "m1", amountUsd: 1 });
    engine.record({ taskId: "t2", projectId: "p2", provider: "mock", modelId: "m1", amountUsd: 5 });
    expect(engine.totalFor({ projectId: "p1" })).toBe(1);
  });
});
