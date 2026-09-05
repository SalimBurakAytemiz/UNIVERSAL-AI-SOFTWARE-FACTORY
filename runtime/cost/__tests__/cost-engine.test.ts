import { describe, expect, it } from "vitest";
import { CostEngine, InvalidMonetaryAmountError, assertValidMonetaryAmount } from "../cost-engine.js";

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

  describe("record() rejects invalid monetary amounts (fail closed before mutating state)", () => {
    it.each([
      ["NaN", NaN],
      ["Infinity", Infinity],
      ["-Infinity", -Infinity],
      ["a negative number", -1]
    ])("rejects %s", (_label, amountUsd) => {
      const engine = new CostEngine();
      expect(() => engine.record({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd })).toThrow(
        InvalidMonetaryAmountError
      );
      expect(engine.all()).toHaveLength(0);
    });

    it("accepts zero as a valid, non-negative amount", () => {
      const engine = new CostEngine();
      expect(() => engine.record({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 0 })).not.toThrow();
    });
  });

  describe("assertValidMonetaryAmount (shared validation primitive)", () => {
    it("passes through finite, non-negative amounts silently", () => {
      expect(() => assertValidMonetaryAmount(0, "test")).not.toThrow();
      expect(() => assertValidMonetaryAmount(42.5, "test")).not.toThrow();
    });

    it("rejects NaN/Infinity/-Infinity/negative", () => {
      for (const amount of [NaN, Infinity, -Infinity, -0.01]) {
        expect(() => assertValidMonetaryAmount(amount, "test")).toThrow(InvalidMonetaryAmountError);
      }
    });
  });

  describe("P1 fix: returned records are detached, frozen snapshots (internal state cannot be mutated from outside)", () => {
    it("mutating the object returned by record() does not change internal state", () => {
      const engine = new CostEngine();
      const returned = engine.record({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 1 });

      expect(() => {
        (returned as { amountUsd: number }).amountUsd = NaN;
      }).toThrow(TypeError); // frozen: assignment throws in strict-mode ESM

      expect(engine.total()).toBe(1); // internal state untouched regardless
    });

    it("mutating an object returned by all() does not change internal state", () => {
      const engine = new CostEngine();
      engine.record({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 2 });
      const [entry] = engine.all();

      expect(() => {
        (entry as { amountUsd: number }).amountUsd = -999;
      }).toThrow(TypeError);

      expect(engine.total()).toBe(2);
      expect(engine.all()[0]!.amountUsd).toBe(2);
    });

    it("attempting to poison a returned amountUsd to NaN cannot corrupt subsequent totals", () => {
      const engine = new CostEngine();
      const returned = engine.record({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 5 });
      try {
        (returned as { amountUsd: number }).amountUsd = NaN;
      } catch {
        /* expected: frozen object rejects the write */
      }
      engine.record({ taskId: "t2", provider: "mock", modelId: "m1", amountUsd: 3 });

      expect(engine.total()).toBe(8);
      expect(Number.isFinite(engine.total())).toBe(true);
    });

    it("attempting to poison a returned amountUsd to a negative value cannot corrupt subsequent totals", () => {
      const engine = new CostEngine();
      const returned = engine.record({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 5 });
      try {
        (returned as { amountUsd: number }).amountUsd = -1000;
      } catch {
        /* expected: frozen object rejects the write */
      }

      expect(engine.total()).toBe(5);
      expect(engine.total()).toBeGreaterThanOrEqual(0);
    });

    it("mutating a returned record after a valid spend does not affect later reads of that same record", () => {
      const engine = new CostEngine();
      const returned = engine.record({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 4 });
      try {
        (returned as { taskId: string }).taskId = "hijacked";
      } catch {
        /* expected */
      }

      expect(engine.totalFor({ taskId: "t1" })).toBe(4);
      expect(engine.totalFor({ taskId: "hijacked" })).toBe(0);
    });

    it("all cost totals remain finite and non-negative even after every mutation attempt above", () => {
      const engine = new CostEngine();
      engine.record({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 1.5 });
      const [entry] = engine.all();
      try {
        (entry as { amountUsd: number }).amountUsd = Infinity;
      } catch {
        /* expected */
      }

      const total = engine.total();
      expect(Number.isFinite(total)).toBe(true);
      expect(total).toBeGreaterThanOrEqual(0);
    });

    it("invalid internal state cannot be introduced via the public API at all (record() still validates before storing)", () => {
      const engine = new CostEngine();
      expect(() => engine.record({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: NaN })).toThrow(
        InvalidMonetaryAmountError
      );
      expect(engine.all()).toHaveLength(0);
      expect(engine.total()).toBe(0);
    });

    it("record() and all() never return the same object reference for the same logical entry", () => {
      const engine = new CostEngine();
      engine.record({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 1 });
      const [a] = engine.all();
      const [b] = engine.all();
      expect(a).not.toBe(b); // fresh snapshot every call — no shared mutable identity to leak
      expect(a).toEqual(b);
    });
  });
});
