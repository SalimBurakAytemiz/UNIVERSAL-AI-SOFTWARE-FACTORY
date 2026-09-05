import { describe, expect, it } from "vitest";
import { CostEngine } from "../../cost/cost-engine.js";
import { BudgetExceededError, BudgetGuard } from "../budget.js";
import { AuditLog } from "../../audit/audit-log.js";

/**
 * Testlerin gerçek zamanı beklemeden gün/ay sınırlarını (rollover)
 * doğrulayabilmesi için basit, değiştirilebilir bir "saat". CostEngine ve
 * BudgetGuard AYNI clock.now referansını paylaşır, böylece kayıtların
 * zaman damgası ile bütçe kontrolünün "şu an"ı tutarlı kalır.
 */
function makeClock(initialIso: string) {
  let current = new Date(initialIso);
  return {
    now: () => current,
    advanceTo(iso: string) {
      current = new Date(iso);
    }
  };
}

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

  describe("dailyUsd ceiling (real enforcement, not just a defined field)", () => {
    it("blocks spending that would exceed the daily ceiling within the same UTC day", () => {
      const clock = makeClock("2026-03-10T08:00:00.000Z");
      const costEngine = new CostEngine(clock.now);
      const guard = new BudgetGuard(costEngine, { dailyUsd: 5 }, clock.now);

      guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 3 });
      clock.advanceTo("2026-03-10T20:00:00.000Z"); // later the same UTC day
      expect(() =>
        guard.spend({ taskId: "t2", provider: "mock", modelId: "m1", amountUsd: 3 })
      ).toThrow(BudgetExceededError);

      // The blocked spend was never recorded.
      expect(costEngine.total()).toBe(3);
    });

    it("boundary: spending that lands exactly on the daily ceiling is allowed; one cent more is blocked", () => {
      const clock = makeClock("2026-03-10T08:00:00.000Z");
      const costEngine = new CostEngine(clock.now);
      const guard = new BudgetGuard(costEngine, { dailyUsd: 5 }, clock.now);

      guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 5 }); // exactly at ceiling: allowed
      expect(costEngine.total()).toBe(5);

      expect(() =>
        guard.spend({ taskId: "t2", provider: "mock", modelId: "m1", amountUsd: 0.01 })
      ).toThrow(BudgetExceededError);
    });

    it("rollover: the daily ceiling resets at UTC midnight, even though cumulative lifetime spend exceeds it", () => {
      const clock = makeClock("2026-03-10T23:00:00.000Z");
      const costEngine = new CostEngine(clock.now);
      const guard = new BudgetGuard(costEngine, { dailyUsd: 5 }, clock.now);

      guard.spend({ taskId: "day1", provider: "mock", modelId: "m1", amountUsd: 5 });

      clock.advanceTo("2026-03-11T00:00:01.000Z"); // one second into the next UTC day
      // Would be 10 total lifetime spend, but the daily window has reset — this must succeed.
      expect(() =>
        guard.spend({ taskId: "day2", provider: "mock", modelId: "m1", amountUsd: 5 })
      ).not.toThrow();

      expect(costEngine.total()).toBe(10); // lifetime total, unaffected by the daily reset
    });

    it("scopes the daily ceiling per project when a projectId is given", () => {
      const clock = makeClock("2026-03-10T08:00:00.000Z");
      const costEngine = new CostEngine(clock.now);
      const guard = new BudgetGuard(costEngine, { dailyUsd: 5 }, clock.now);

      guard.spend({ taskId: "t1", projectId: "proj-a", provider: "mock", modelId: "m1", amountUsd: 5 });
      // proj-b has its own, independent daily budget.
      expect(() =>
        guard.spend({ taskId: "t2", projectId: "proj-b", provider: "mock", modelId: "m1", amountUsd: 5 })
      ).not.toThrow();
      // proj-a is exhausted for the day.
      expect(() =>
        guard.spend({ taskId: "t3", projectId: "proj-a", provider: "mock", modelId: "m1", amountUsd: 0.01 })
      ).toThrow(BudgetExceededError);
    });
  });

  describe("monthlyUsd ceiling (real enforcement, not just a defined field)", () => {
    it("blocks spending that would exceed the monthly ceiling within the same UTC month", () => {
      const clock = makeClock("2026-03-01T00:00:00.000Z");
      const costEngine = new CostEngine(clock.now);
      const guard = new BudgetGuard(costEngine, { monthlyUsd: 100 }, clock.now);

      guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 60 });
      clock.advanceTo("2026-03-30T00:00:00.000Z"); // later the same UTC month
      expect(() =>
        guard.spend({ taskId: "t2", provider: "mock", modelId: "m1", amountUsd: 60 })
      ).toThrow(BudgetExceededError);
    });

    it("rollover: the monthly ceiling resets at the start of the next UTC month", () => {
      const clock = makeClock("2026-03-31T23:00:00.000Z");
      const costEngine = new CostEngine(clock.now);
      const guard = new BudgetGuard(costEngine, { monthlyUsd: 100 }, clock.now);

      guard.spend({ taskId: "march", provider: "mock", modelId: "m1", amountUsd: 100 });

      clock.advanceTo("2026-04-01T00:00:01.000Z"); // one second into April
      expect(() =>
        guard.spend({ taskId: "april", provider: "mock", modelId: "m1", amountUsd: 100 })
      ).not.toThrow();

      expect(costEngine.total()).toBe(200); // lifetime total, unaffected by the monthly reset
    });

    it("a daily ceiling breach still applies even when comfortably within the monthly ceiling", () => {
      const clock = makeClock("2026-03-10T08:00:00.000Z");
      const costEngine = new CostEngine(clock.now);
      const guard = new BudgetGuard(costEngine, { dailyUsd: 5, monthlyUsd: 1000 }, clock.now);

      guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 5 });
      expect(() =>
        guard.spend({ taskId: "t2", provider: "mock", modelId: "m1", amountUsd: 0.01 })
      ).toThrow(BudgetExceededError);
    });
  });

  describe("concurrency-safe behavior", () => {
    it("a burst of synchronous spend() calls never allows the daily ceiling to be exceeded", () => {
      const clock = makeClock("2026-03-10T08:00:00.000Z");
      const costEngine = new CostEngine(clock.now);
      const guard = new BudgetGuard(costEngine, { dailyUsd: 5 }, clock.now);

      let allowed = 0;
      let blocked = 0;
      for (let i = 0; i < 1000; i++) {
        try {
          guard.spend({ taskId: `burst-${i}`, provider: "mock", modelId: "m1", amountUsd: 0.37 });
          allowed++;
        } catch (err) {
          if (err instanceof BudgetExceededError) blocked++;
          else throw err;
        }
      }

      // check-then-record is synchronous with no `await` between the two steps, so no
      // interleaved call can ever observe a stale total — the running total never exceeds the ceiling.
      expect(costEngine.total()).toBeLessThanOrEqual(5);
      expect(allowed).toBeGreaterThan(0);
      expect(blocked).toBeGreaterThan(0);
    });
  });

  describe("audit evidence", () => {
    it("records both allowed and blocked budget checks to the audit log", () => {
      const clock = makeClock("2026-03-10T08:00:00.000Z");
      const costEngine = new CostEngine(clock.now);
      const auditLog = new AuditLog();
      const guard = new BudgetGuard(costEngine, { perTaskUsd: 1 }, clock.now, auditLog);

      guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 0.5 });
      expect(() => guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 0.9 })).toThrow(
        BudgetExceededError
      );

      const types = auditLog.all().map((r) => r.type);
      expect(types).toEqual(["BUDGET_CHECK_PASSED", "BUDGET_BLOCKED"]);
      expect(auditLog.verifyIntegrity()).toBe(true);

      const blockedRecord = auditLog.all()[1]!;
      expect(blockedRecord.payload).toMatchObject({ ceiling: "perTaskUsd", limit: 1 });
    });
  });
});
