import { describe, expect, it } from "vitest";
import { CostEngine, InvalidMonetaryAmountError } from "../../cost/cost-engine.js";
import {
  BudgetExceededError,
  BudgetGuard,
  InvalidBudgetLimitError,
  UnknownReservationError,
  UnresolvedReconciliationError,
  ReservationOwnershipMismatchError
} from "../budget.js";
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

  describe("invalid monetary input (BLOCKER: NaN/Infinity/negative must never bypass budget enforcement)", () => {
    it("rejects a NaN spend amount before it can poison the running total", () => {
      const costEngine = new CostEngine();
      const guard = new BudgetGuard(costEngine, { dailyUsd: 5 });

      expect(() => guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: NaN })).toThrow(
        InvalidMonetaryAmountError
      );
      // Nothing was recorded — total() must not become NaN.
      expect(costEngine.total()).toBe(0);
      expect(Number.isNaN(costEngine.total())).toBe(false);
    });

    it("rejects Infinity as a spend amount", () => {
      const costEngine = new CostEngine();
      const guard = new BudgetGuard(costEngine, { dailyUsd: 5 });
      expect(() => guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: Infinity })).toThrow(
        InvalidMonetaryAmountError
      );
      expect(costEngine.total()).toBe(0);
    });

    it("rejects -Infinity as a spend amount (which would otherwise manufacture infinite headroom)", () => {
      const costEngine = new CostEngine();
      const guard = new BudgetGuard(costEngine, { dailyUsd: 5 });
      expect(() => guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: -Infinity })).toThrow(
        InvalidMonetaryAmountError
      );
      expect(costEngine.total()).toBe(0);
    });

    it("rejects a negative spend amount (refunds/credits must be a separate, explicit operation)", () => {
      const costEngine = new CostEngine();
      const guard = new BudgetGuard(costEngine, { dailyUsd: 5 });
      guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 3 });

      expect(() => guard.spend({ taskId: "t2", provider: "mock", modelId: "m1", amountUsd: -10 })).toThrow(
        InvalidMonetaryAmountError
      );
      // The negative "spend" was not recorded — it cannot manufacture artificial headroom.
      expect(costEngine.total()).toBe(3);
    });

    it("a spend attempted immediately after a rejected invalid spend is still correctly evaluated (no poisoned state)", () => {
      const costEngine = new CostEngine();
      const guard = new BudgetGuard(costEngine, { dailyUsd: 5 });

      expect(() => guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: NaN })).toThrow(
        InvalidMonetaryAmountError
      );
      // The ceiling is still correctly enforced afterward — NaN never entered the running total.
      guard.spend({ taskId: "t2", provider: "mock", modelId: "m1", amountUsd: 5 });
      expect(() => guard.spend({ taskId: "t3", provider: "mock", modelId: "m1", amountUsd: 0.01 })).toThrow(
        BudgetExceededError
      );
      expect(costEngine.total()).toBe(5);
    });

    it("rejects a NaN configured limit at construction time, before any spend is attempted", () => {
      const costEngine = new CostEngine();
      expect(() => new BudgetGuard(costEngine, { dailyUsd: NaN })).toThrow(InvalidBudgetLimitError);
    });

    it("rejects Infinity/-Infinity as a configured limit", () => {
      const costEngine = new CostEngine();
      expect(() => new BudgetGuard(costEngine, { monthlyUsd: Infinity })).toThrow(InvalidBudgetLimitError);
      expect(() => new BudgetGuard(costEngine, { monthlyUsd: -Infinity })).toThrow(InvalidBudgetLimitError);
    });

    it("rejects a negative configured limit for every ceiling kind", () => {
      const costEngine = new CostEngine();
      expect(() => new BudgetGuard(costEngine, { perTaskUsd: -1 })).toThrow(InvalidBudgetLimitError);
      expect(() => new BudgetGuard(costEngine, { perRunUsd: -1 })).toThrow(InvalidBudgetLimitError);
      expect(() => new BudgetGuard(costEngine, { dailyUsd: -1 })).toThrow(InvalidBudgetLimitError);
      expect(() => new BudgetGuard(costEngine, { monthlyUsd: -1 })).toThrow(InvalidBudgetLimitError);
    });

    it("protects direct CostEngine.record() calls too, bypassing BudgetGuard entirely", () => {
      const costEngine = new CostEngine();
      expect(() => costEngine.record({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: NaN })).toThrow(
        InvalidMonetaryAmountError
      );
      expect(() => costEngine.record({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: -5 })).toThrow(
        InvalidMonetaryAmountError
      );
      expect(() => costEngine.record({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: Infinity })).toThrow(
        InvalidMonetaryAmountError
      );
      expect(costEngine.all()).toHaveLength(0);
      expect(costEngine.total()).toBe(0);
    });

    it("exact boundary: zero is a valid amount (allowed); the smallest negative value is not", () => {
      const costEngine = new CostEngine();
      const guard = new BudgetGuard(costEngine, { dailyUsd: 5 });
      expect(() => guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 0 })).not.toThrow();
      expect(() => guard.spend({ taskId: "t2", provider: "mock", modelId: "m1", amountUsd: -0.0001 })).toThrow(
        InvalidMonetaryAmountError
      );
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

    it("records a rejected invalid-amount attempt to the audit log", () => {
      const costEngine = new CostEngine();
      const auditLog = new AuditLog();
      const guard = new BudgetGuard(costEngine, { dailyUsd: 5 }, () => new Date(), auditLog);

      expect(() => guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: NaN })).toThrow(
        InvalidMonetaryAmountError
      );

      const types = auditLog.all().map((r) => r.type);
      expect(types).toEqual(["BUDGET_INVALID_AMOUNT_REJECTED"]);
      expect(auditLog.verifyIntegrity()).toBe(true);
    });
  });

  describe("P1 fix: limits ownership (caller-owned config object cannot mutate authoritative ceilings)", () => {
    it("mutating the ORIGINAL limits object after construction does not change internal ceilings", () => {
      const costEngine = new CostEngine();
      const originalLimits: { perTaskUsd: number } = { perTaskUsd: 1 };
      const guard = new BudgetGuard(costEngine, originalLimits);

      // Caller mutates the very object they passed in, after the fact.
      originalLimits.perTaskUsd = 1000;

      expect(() => guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 1.5 })).toThrow(
        BudgetExceededError
      );
    });

    it("mutating the original limits object to NaN/Infinity/negative after construction does not corrupt enforcement", () => {
      const costEngine = new CostEngine();
      const originalLimits: { perTaskUsd: number; dailyUsd: number } = { perTaskUsd: 1, dailyUsd: 5 };
      const guard = new BudgetGuard(costEngine, originalLimits);

      originalLimits.perTaskUsd = NaN;
      originalLimits.dailyUsd = -Infinity;

      // Internal ceilings remain the original, valid values — the guard
      // still blocks over-ceiling spend rather than silently allowing it
      // (which is what would happen if NaN/-Infinity leaked in: `x > NaN`
      // and `x > -Infinity` comparisons never block appropriately).
      expect(() => guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 1.5 })).toThrow(
        BudgetExceededError
      );
      expect(Number.isFinite(costEngine.total())).toBe(true);
      expect(costEngine.total()).toBeGreaterThanOrEqual(0);
    });

    it("getLimits() returns a frozen, detached snapshot that cannot mutate internal state", () => {
      const costEngine = new CostEngine();
      const guard = new BudgetGuard(costEngine, { perTaskUsd: 2 });

      const snapshot = guard.getLimits();
      expect(() => {
        (snapshot as { perTaskUsd: number }).perTaskUsd = 9999;
      }).toThrow(TypeError);

      // Internal ceiling is unaffected regardless.
      expect(() => guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 3 })).toThrow(
        BudgetExceededError
      );
      expect(guard.getLimits().perTaskUsd).toBe(2);
    });

    it("getLimits() never returns the same object reference on repeated calls", () => {
      const guard = new BudgetGuard(new CostEngine(), { perTaskUsd: 2 });
      const a = guard.getLimits();
      const b = guard.getLimits();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });

    it("daily/monthly enforcement still works after the ownership fix (regression guard)", () => {
      const clock = makeClock("2026-05-01T00:00:00.000Z");
      const costEngine = new CostEngine(clock.now);
      const guard = new BudgetGuard(costEngine, { dailyUsd: 10, monthlyUsd: 20 }, clock.now);

      guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 9 });
      expect(() => guard.spend({ taskId: "t2", provider: "mock", modelId: "m1", amountUsd: 2 })).toThrow(
        BudgetExceededError
      );

      // A new UTC day resets the daily ceiling but not the monthly one.
      clock.advanceTo("2026-05-02T00:00:01.000Z");
      guard.spend({ taskId: "t3", provider: "mock", modelId: "m1", amountUsd: 9 });
      expect(() => guard.spend({ taskId: "t4", provider: "mock", modelId: "m1", amountUsd: 3 })).toThrow(
        BudgetExceededError
      ); // would push monthly total (9 + 9 + 3 = 21) over 20
    });
  });

  describe("P1 fix (5th independent review round): per-task budgets scope by projectId + taskId, not taskId alone", () => {
    it("the SAME taskId used by two DIFFERENT projects gets independent per-task allowances", () => {
      const costEngine = new CostEngine();
      const guard = new BudgetGuard(costEngine, { perTaskUsd: 1 });

      // Project A spends its entire $1 allowance under taskId "shared-task".
      guard.spend({ taskId: "shared-task", projectId: "project-a", provider: "mock", modelId: "m1", amountUsd: 1 });

      // Project B, using the SAME taskId, has its own unused $1 allowance —
      // this must succeed, not be rejected by Project A's spend.
      expect(() =>
        guard.spend({ taskId: "shared-task", projectId: "project-b", provider: "mock", modelId: "m1", amountUsd: 1 })
      ).not.toThrow();
    });

    it("spending in Project A does not consume Project B's allowance for the same taskId", () => {
      const costEngine = new CostEngine();
      const guard = new BudgetGuard(costEngine, { perTaskUsd: 1 });

      guard.spend({ taskId: "shared-task", projectId: "project-a", provider: "mock", modelId: "m1", amountUsd: 0.9 });

      expect(costEngine.totalFor({ taskId: "shared-task", projectId: "project-a" })).toBe(0.9);
      expect(costEngine.totalFor({ taskId: "shared-task", projectId: "project-b" })).toBe(0);
    });

    it("the SAME project + SAME taskId still shares the intended single allowance", () => {
      const costEngine = new CostEngine();
      const guard = new BudgetGuard(costEngine, { perTaskUsd: 1 });

      guard.spend({ taskId: "t1", projectId: "project-a", provider: "mock", modelId: "m1", amountUsd: 0.6 });
      expect(() =>
        guard.spend({ taskId: "t1", projectId: "project-a", provider: "mock", modelId: "m1", amountUsd: 0.6 })
      ).toThrow(BudgetExceededError); // 0.6 + 0.6 = 1.2 > 1, same project+task
    });

    it("a task budget WITHOUT projectId follows the documented global (project-agnostic) semantics", () => {
      const costEngine = new CostEngine();
      const guard = new BudgetGuard(costEngine, { perTaskUsd: 1 });

      // No projectId supplied at all — this is the intentionally-supported
      // project-agnostic/global task budget case; it must still be
      // enforced globally by taskId alone, exactly as before this fix.
      guard.spend({ taskId: "global-task", provider: "mock", modelId: "m1", amountUsd: 0.7 });
      expect(() => guard.spend({ taskId: "global-task", provider: "mock", modelId: "m1", amountUsd: 0.7 })).toThrow(
        BudgetExceededError
      );
    });

    it("daily/monthly/per-run budgets remain unaffected by the per-task scoping fix", () => {
      const clock = makeClock("2026-06-01T00:00:00.000Z");
      const costEngine = new CostEngine(clock.now);
      const guard = new BudgetGuard(costEngine, { perRunUsd: 5, dailyUsd: 5, monthlyUsd: 10 }, clock.now);

      // Two different projects, same taskId, both contribute to the SAME
      // global perRunUsd/dailyUsd/monthlyUsd ceilings (those were never
      // task-scoped and must stay that way).
      guard.spend({ taskId: "shared-task", projectId: "project-a", provider: "mock", modelId: "m1", amountUsd: 3 });
      expect(() =>
        guard.spend({ taskId: "shared-task", projectId: "project-b", provider: "mock", modelId: "m1", amountUsd: 3 })
      ).toThrow(BudgetExceededError); // 3 + 3 = 6 > 5 perRunUsd, regardless of per-task scoping
    });

    it("invalid monetary inputs remain rejected regardless of project/task scoping", () => {
      const costEngine = new CostEngine();
      const guard = new BudgetGuard(costEngine, { perTaskUsd: 1 });
      expect(() =>
        guard.spend({ taskId: "t1", projectId: "project-a", provider: "mock", modelId: "m1", amountUsd: NaN })
      ).toThrow(InvalidMonetaryAmountError);
      expect(costEngine.totalFor({ taskId: "t1", projectId: "project-a" })).toBe(0);
    });
  });

  describe("P2 fix (8th independent review round, 'floating-point comparisons reject exact budget spend')", () => {
    it("0.10 + 0.20 landing exactly on a 0.30 per-task ceiling is accepted, not rejected by float noise", () => {
      const costEngine = new CostEngine();
      const guard = new BudgetGuard(costEngine, { perTaskUsd: 0.3 });
      guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 0.1 });
      // Native `0.1 + 0.2 > 0.3` is `true` in JS — this must not leak into rejection.
      expect(() => guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 0.2 })).not.toThrow();
      expect(costEngine.totalFor({ taskId: "t1" })).toBeCloseTo(0.3);
    });

    it("spending one precision unit ($0.000001) above the ceiling is still correctly rejected", () => {
      const costEngine = new CostEngine();
      const guard = new BudgetGuard(costEngine, { perTaskUsd: 0.3 });
      guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 0.1 });
      expect(() =>
        guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 0.200001 })
      ).toThrow(BudgetExceededError);
    });

    it("repeated small decimal spends accumulate correctly across many calls without spurious rejection", () => {
      const costEngine = new CostEngine();
      const guard = new BudgetGuard(costEngine, { perTaskUsd: 1 });
      // Ten spends of $0.10 should land exactly on a $1.00 ceiling.
      for (let i = 0; i < 10; i++) {
        expect(() => guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 0.1 })).not.toThrow();
      }
      expect(costEngine.totalFor({ taskId: "t1" })).toBeCloseTo(1.0);
      expect(() => guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 0.000001 })).toThrow(
        BudgetExceededError
      );
    });

    it("the same exact-ceiling precision fix applies identically to the perRunUsd ceiling", () => {
      const costEngine = new CostEngine();
      const guard = new BudgetGuard(costEngine, { perRunUsd: 0.3 });
      guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 0.1 });
      expect(() => guard.spend({ taskId: "t2", provider: "mock", modelId: "m1", amountUsd: 0.2 })).not.toThrow();
    });

    it("the same exact-ceiling precision fix applies identically to the dailyUsd ceiling", () => {
      const clock = makeClock("2026-06-15T00:00:00.000Z");
      const costEngine = new CostEngine(clock.now);
      const guard = new BudgetGuard(costEngine, { dailyUsd: 0.3 }, clock.now);
      guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 0.1 });
      expect(() => guard.spend({ taskId: "t2", provider: "mock", modelId: "m1", amountUsd: 0.2 })).not.toThrow();
    });

    it("the same exact-ceiling precision fix applies identically to the monthlyUsd ceiling", () => {
      const clock = makeClock("2026-06-15T00:00:00.000Z");
      const costEngine = new CostEngine(clock.now);
      const guard = new BudgetGuard(costEngine, { monthlyUsd: 0.3 }, clock.now);
      guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 0.1 });
      expect(() => guard.spend({ taskId: "t2", provider: "mock", modelId: "m1", amountUsd: 0.2 })).not.toThrow();
    });

    it("project/task scoping remains correct alongside the precision fix", () => {
      const costEngine = new CostEngine();
      const guard = new BudgetGuard(costEngine, { perTaskUsd: 0.3 });
      guard.spend({ taskId: "shared", projectId: "project-a", provider: "mock", modelId: "m1", amountUsd: 0.2 });
      guard.spend({ taskId: "shared", projectId: "project-b", provider: "mock", modelId: "m1", amountUsd: 0.1 });
      // Each project has its own independent $0.30 allowance; landing exactly
      // on it for BOTH must be accepted for both, not confused by float noise.
      expect(() =>
        guard.spend({ taskId: "shared", projectId: "project-a", provider: "mock", modelId: "m1", amountUsd: 0.1 })
      ).not.toThrow();
      expect(() =>
        guard.spend({ taskId: "shared", projectId: "project-b", provider: "mock", modelId: "m1", amountUsd: 0.2 })
      ).not.toThrow();
    });

    it("daily/monthly rollover enforcement remains correct alongside the precision fix", () => {
      const clock = makeClock("2026-06-30T23:00:00.000Z");
      const costEngine = new CostEngine(clock.now);
      const guard = new BudgetGuard(costEngine, { dailyUsd: 0.3 }, clock.now);
      guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 0.3 });
      expect(() => guard.spend({ taskId: "t2", provider: "mock", modelId: "m1", amountUsd: 0.01 })).toThrow(
        BudgetExceededError
      );

      clock.advanceTo("2026-07-01T00:00:00.001Z"); // new UTC day -> resets
      expect(() => guard.spend({ taskId: "t3", provider: "mock", modelId: "m1", amountUsd: 0.3 })).not.toThrow();
    });

    it("a free/zero monetary spend remains valid alongside the precision fix", () => {
      const costEngine = new CostEngine();
      const guard = new BudgetGuard(costEngine, { perTaskUsd: 0 });
      expect(() => guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 0 })).not.toThrow();
    });

    it("NaN/Infinity/negative monetary values remain rejected by the precision fix's comparison path", () => {
      const costEngine = new CostEngine();
      const guard = new BudgetGuard(costEngine, { perTaskUsd: 1 });
      expect(() => guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: NaN })).toThrow(
        InvalidMonetaryAmountError
      );
      expect(() => guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: Infinity })).toThrow(
        InvalidMonetaryAmountError
      );
      expect(() => guard.spend({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: -0.01 })).toThrow(
        InvalidMonetaryAmountError
      );
    });
  });

  describe(
    "reserve()/commit()/release() (P1 fix, 10th independent review round, " +
      "'concurrent model invocations can exceed budgets')",
    () => {
      it("BLOCKER regression: two reservations for $0.60 each against a $1.00 ceiling cannot both succeed", () => {
        const guard = new BudgetGuard(new CostEngine(), { perRunUsd: 1.0 });
        const first = guard.reserve({ taskId: "a" }, 0.6);
        expect(first.amountUsd).toBe(0.6);
        // The SECOND reservation must see the FIRST's outstanding amount —
        // this is the exact mechanism that closes the race Codex reproduced
        // (two concurrent pre-checks that neither saw the other).
        expect(() => guard.reserve({ taskId: "b" }, 0.6)).toThrow(BudgetExceededError);
      });

      it("reservations are included in available-budget calculations (perTaskUsd, perRunUsd, dailyUsd, monthlyUsd)", () => {
        const clock = makeClock("2026-05-01T00:00:00.000Z");
        const costEngine = new CostEngine(clock.now);
        const guard = new BudgetGuard(costEngine, { perTaskUsd: 1, perRunUsd: 1, dailyUsd: 1, monthlyUsd: 1 }, clock.now);
        guard.reserve({ taskId: "t1" }, 0.7);
        // A second reservation against ANY of the four ceilings must see the
        // first reservation's $0.70 as already-committed exposure.
        expect(() => guard.reserve({ taskId: "t1" }, 0.4)).toThrow(BudgetExceededError); // perTaskUsd
        expect(() => guard.reserve({ taskId: "t2" }, 0.4)).toThrow(BudgetExceededError); // perRunUsd (global)
      });

      it("incurred cost is never lost: commit() records the ACTUAL amount, matching what was really spent", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 10 });
        const reservation = guard.reserve({ taskId: "t1" }, 0.5);
        const recorded = guard.commit(reservation.id, {
          taskId: "t1",
          provider: "mock",
          modelId: "m1",
          amountUsd: 0.5
        });
        expect(recorded.amountUsd).toBe(0.5);
        expect(costEngine.totalFor({ taskId: "t1" })).toBe(0.5);
      });

      it("commit() records the actual cost even when it differs from the reserved estimate, and never discards it for exceeding a ceiling", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 0.5 });
        const reservation = guard.reserve({ taskId: "t1" }, 0.5); // exactly at the ceiling
        // The REAL provider call turned out to cost more than estimated —
        // this can genuinely happen (e.g. token-metered pricing). The
        // already-incurred cost must still be recorded in full, even though
        // it now exceeds perRunUsd on paper — "never silently discard an
        // incurred cost because a ceiling was exceeded after execution."
        const recorded = guard.commit(reservation.id, {
          taskId: "t1",
          provider: "mock",
          modelId: "m1",
          amountUsd: 0.9
        });
        expect(recorded.amountUsd).toBe(0.9);
        expect(costEngine.total()).toBe(0.9);
      });

      it("commit() on an unknown/already-resolved reservation id fails closed instead of silently recording a phantom cost", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 10 });
        expect(() =>
          guard.commit("never-reserved", { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 0.1 })
        ).toThrow(UnknownReservationError);
        expect(costEngine.total()).toBe(0);
      });

      it("a committed reservation cannot be committed or released a second time", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 10 });
        const reservation = guard.reserve({ taskId: "t1" }, 0.3);
        guard.commit(reservation.id, { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 0.3 });
        expect(() =>
          guard.commit(reservation.id, { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 0.3 })
        ).toThrow(UnknownReservationError);
        expect(() => guard.release(reservation.id, reservation.scope)).toThrow(UnknownReservationError);
        // Exactly one commit's worth of cost was ever recorded.
        expect(costEngine.total()).toBe(0.3);
      });

      it("release() frees a reservation's budget back up without recording any cost (provider-failure reconciliation rule)", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 0.6 });
        const reservation = guard.reserve({ taskId: "t1" }, 0.6);
        expect(() => guard.reserve({ taskId: "t2" }, 0.6)).toThrow(BudgetExceededError); // fully reserved

        guard.release(reservation.id, reservation.scope);
        expect(costEngine.total()).toBe(0); // nothing was ever recorded

        // The released amount is available again for a subsequent reservation.
        expect(() => guard.reserve({ taskId: "t2" }, 0.6)).not.toThrow();
      });

      it("release() on an unknown/already-resolved reservation id fails closed", () => {
        const guard = new BudgetGuard(new CostEngine(), { perRunUsd: 10 });
        expect(() => guard.release("never-reserved", {})).toThrow(UnknownReservationError);
      });

      it("task/project isolation remains correct: a reservation for one task does not block a DIFFERENT task's own perTaskUsd ceiling", () => {
        const guard = new BudgetGuard(new CostEngine(), { perTaskUsd: 0.5, perRunUsd: 100 });
        guard.reserve({ taskId: "task-a" }, 0.5); // uses all of task-a's own ceiling
        // task-b's OWN perTaskUsd ceiling is untouched by task-a's reservation.
        expect(() => guard.reserve({ taskId: "task-b" }, 0.5)).not.toThrow();
      });

      it("task/project isolation remains correct: a reservation for one project does not block a DIFFERENT project's dailyUsd ceiling", () => {
        const clock = makeClock("2026-05-01T00:00:00.000Z");
        const guard = new BudgetGuard(new CostEngine(clock.now), { dailyUsd: 0.5 }, clock.now);
        guard.reserve({ taskId: "t1", projectId: "project-a" }, 0.5);
        expect(() => guard.reserve({ taskId: "t2", projectId: "project-b" }, 0.5)).not.toThrow();
      });

      it("daily/monthly enforcement remains correct with reservations: a reservation counts toward the current period, and rolls over correctly", () => {
        const clock = makeClock("2026-06-30T23:00:00.000Z");
        const costEngine = new CostEngine(clock.now);
        const guard = new BudgetGuard(costEngine, { dailyUsd: 0.3 }, clock.now);
        const reservation = guard.reserve({ taskId: "t1" }, 0.3);
        expect(() => guard.reserve({ taskId: "t2" }, 0.01)).toThrow(BudgetExceededError);

        guard.commit(reservation.id, { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 0.3 });
        clock.advanceTo("2026-07-01T00:00:00.001Z"); // new UTC day -> resets
        expect(() => guard.reserve({ taskId: "t3" }, 0.3)).not.toThrow();
      });

      it("CostEngine/BudgetGuard ownership protections remain intact: a returned Reservation is a frozen, detached snapshot", () => {
        const guard = new BudgetGuard(new CostEngine(), { perRunUsd: 10 });
        const reservation = guard.reserve({ taskId: "t1" }, 0.3);
        expect(() => {
          (reservation as { amountUsd: number }).amountUsd = 0;
        }).toThrow(TypeError);
        // Mutating the returned snapshot cannot affect the authoritative
        // outstanding reservation used by subsequent ceiling checks.
        const guardWithTightCeiling = new BudgetGuard(new CostEngine(), { perRunUsd: 0.3 });
        const r = guardWithTightCeiling.reserve({ taskId: "t1" }, 0.3);
        expect(() => {
          (r as { amountUsd: number }).amountUsd = 0;
        }).toThrow(TypeError);
        expect(() => guardWithTightCeiling.reserve({ taskId: "t2" }, 0.01)).toThrow(BudgetExceededError);
      });

      it("invalid reservation amounts (NaN/Infinity/negative) are rejected before any reservation is created", () => {
        const guard = new BudgetGuard(new CostEngine(), { perRunUsd: 10 });
        expect(() => guard.reserve({ taskId: "t1" }, NaN)).toThrow(InvalidMonetaryAmountError);
        expect(() => guard.reserve({ taskId: "t1" }, Infinity)).toThrow(InvalidMonetaryAmountError);
        expect(() => guard.reserve({ taskId: "t1" }, -0.01)).toThrow(InvalidMonetaryAmountError);
        // No phantom reservation was left behind by any of the rejected attempts.
        expect(() => guard.reserve({ taskId: "t1" }, 10)).not.toThrow();
      });
    }
  );

  describe(
    "commit() reconciliation failure handling (P1 fix, 11th independent review round, " +
      "'failed reconciliation releases reservation before cost is safely recorded')",
    () => {
      it("BLOCKER regression, exact reproduction: a NaN actual amount cannot release the reservation", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 0.6 });
        const reservation = guard.reserve({ taskId: "t1" }, 0.6);

        expect(() =>
          guard.commit(reservation.id, { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: NaN })
        ).toThrow(InvalidMonetaryAmountError);

        // The reservation must still be OPEN — proven by: (1) another
        // reservation for the SAME protected capacity is still blocked,
        // and (2) nothing was recorded.
        expect(() => guard.reserve({ taskId: "t2" }, 0.6)).toThrow(BudgetExceededError);
        expect(costEngine.total()).toBe(0);
      });

      it("+Infinity actual amount cannot release the reservation", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 0.6 });
        const reservation = guard.reserve({ taskId: "t1" }, 0.6);

        expect(() =>
          guard.commit(reservation.id, { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: Infinity })
        ).toThrow(InvalidMonetaryAmountError);
        expect(() => guard.reserve({ taskId: "t2" }, 0.6)).toThrow(BudgetExceededError);
        expect(costEngine.total()).toBe(0);
      });

      it("-Infinity actual amount cannot release the reservation", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 0.6 });
        const reservation = guard.reserve({ taskId: "t1" }, 0.6);

        expect(() =>
          guard.commit(reservation.id, { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: -Infinity })
        ).toThrow(InvalidMonetaryAmountError);
        expect(() => guard.reserve({ taskId: "t2" }, 0.6)).toThrow(BudgetExceededError);
        expect(costEngine.total()).toBe(0);
      });

      it("a negative actual amount cannot release the reservation (no implicit credit/refund semantics)", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 0.6 });
        const reservation = guard.reserve({ taskId: "t1" }, 0.6);

        expect(() =>
          guard.commit(reservation.id, { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: -0.1 })
        ).toThrow(InvalidMonetaryAmountError);
        expect(() => guard.reserve({ taskId: "t2" }, 0.6)).toThrow(BudgetExceededError);
        expect(costEngine.total()).toBe(0);
      });

      it("another reservation cannot consume the capacity a failed-reconciliation reservation is still protecting", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perTaskUsd: 1, perRunUsd: 1 });
        const reservation = guard.reserve({ taskId: "t1" }, 1.0); // uses the ENTIRE ceiling

        expect(() =>
          guard.commit(reservation.id, { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: NaN })
        ).toThrow(InvalidMonetaryAmountError);

        // A DIFFERENT task attempting to reserve ANY amount against the
        // shared perRunUsd ceiling must still see the full $1.00 as
        // occupied — the failed reconciliation must not have silently
        // freed it.
        expect(() => guard.reserve({ taskId: "t2" }, 0.01)).toThrow(BudgetExceededError);
      });

      it("retrying commit() with a corrected amount after a failed attempt safely completes reconciliation exactly once", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 1 });
        const reservation = guard.reserve({ taskId: "t1" }, 0.6);

        // First attempt fails (e.g. a transient malformed reading).
        expect(() =>
          guard.commit(reservation.id, { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: NaN })
        ).toThrow(InvalidMonetaryAmountError);

        // Retry with the corrected amount, using the SAME reservation id —
        // this is safe/idempotent because the reservation was never deleted.
        const recorded = guard.commit(reservation.id, {
          taskId: "t1",
          provider: "mock",
          modelId: "m1",
          amountUsd: 0.6
        });
        expect(recorded.amountUsd).toBe(0.6);
        expect(costEngine.total()).toBe(0.6); // exactly once

        // The reservation is now genuinely closed — a second commit() attempt fails closed.
        expect(() =>
          guard.commit(reservation.id, { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 0.6 })
        ).toThrow(UnknownReservationError);
        expect(costEngine.total()).toBe(0.6); // still exactly once
      });

      it("a successful commit() releases the reservation only AFTER cost is safely recorded, freeing capacity for a subsequent reservation", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 0.6 });
        const reservation = guard.reserve({ taskId: "t1" }, 0.6);
        expect(() => guard.reserve({ taskId: "t2" }, 0.01)).toThrow(BudgetExceededError); // fully reserved

        guard.commit(reservation.id, { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 0.6 });

        // Recorded cost now occupies the ceiling instead of the reservation
        // — still fully occupied, but via a real recorded entry, not a
        // dangling reservation.
        expect(costEngine.total()).toBe(0.6);
        expect(() => guard.reserve({ taskId: "t2" }, 0.01)).toThrow(BudgetExceededError);
      });

      it("a commit-failure audit event is recorded (reconciliation failure is never silent)", () => {
        const auditLog = new AuditLog();
        const guard = new BudgetGuard(new CostEngine(), { perRunUsd: 1 }, undefined, auditLog);
        const reservation = guard.reserve({ taskId: "t1" }, 0.5);

        expect(() =>
          guard.commit(reservation.id, { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: NaN })
        ).toThrow(InvalidMonetaryAmountError);

        const events = auditLog.all();
        expect(events.some((e) => e.type === "BUDGET_RESERVATION_COMMIT_FAILED")).toBe(true);
      });

      it("concurrent reservations remain safe across a failed-then-retried reconciliation", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 1.2 });
        const reservationA = guard.reserve({ taskId: "a" }, 0.6);
        const reservationB = guard.reserve({ taskId: "b" }, 0.6); // exactly fills the ceiling alongside A

        // B's reconciliation fails first.
        expect(() =>
          guard.commit(reservationB.id, { taskId: "b", provider: "mock", modelId: "m1", amountUsd: NaN })
        ).toThrow(InvalidMonetaryAmountError);
        // A commits successfully — unaffected by B's still-open, failed reservation.
        guard.commit(reservationA.id, { taskId: "a", provider: "mock", modelId: "m1", amountUsd: 0.6 });
        expect(costEngine.totalFor({ taskId: "a" })).toBe(0.6);

        // B retries successfully afterward.
        guard.commit(reservationB.id, { taskId: "b", provider: "mock", modelId: "m1", amountUsd: 0.6 });
        expect(costEngine.totalFor({ taskId: "b" })).toBe(0.6);
        expect(costEngine.total()).toBe(1.2);
      });
    }
  );

  describe(
    "reservation lifecycle: release() must reject an unresolved-reconciliation reservation (P1 fix, 12th " +
      "independent review round, 'failed reconciliation reservations can still be released')",
    () => {
      it("BLOCKER regression, exact reproduction: reserve -> commit(NaN) -> release() is REJECTED, not silently accepted", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 1 });
        const reservation = guard.reserve({ taskId: "t1" }, 0.6);

        expect(() =>
          guard.commit(reservation.id, { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: NaN })
        ).toThrow(InvalidMonetaryAmountError);

        expect(() => guard.release(reservation.id, reservation.scope)).toThrow(UnresolvedReconciliationError);

        // The reservation is STILL open (not deleted by the rejected
        // release() attempt) — a second, full-ceiling reservation remains blocked.
        expect(() => guard.reserve({ taskId: "t2" }, 1.0)).toThrow(BudgetExceededError);
        expect(costEngine.total()).toBe(0);
      });

      it("reserve -> commit(Infinity) -> release() is REJECTED", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 1 });
        const reservation = guard.reserve({ taskId: "t1" }, 0.6);

        expect(() =>
          guard.commit(reservation.id, { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: Infinity })
        ).toThrow(InvalidMonetaryAmountError);
        expect(() => guard.release(reservation.id, reservation.scope)).toThrow(UnresolvedReconciliationError);
        expect(() => guard.reserve({ taskId: "t2" }, 1.0)).toThrow(BudgetExceededError);
      });

      it("an accounting failure of any kind leaves release() rejected — full-ceiling second reservation remains blocked", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 0.6 });
        const reservation = guard.reserve({ taskId: "t1" }, 0.6);

        expect(() =>
          guard.commit(reservation.id, { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: -0.1 })
        ).toThrow(InvalidMonetaryAmountError);

        expect(() => guard.release(reservation.id, reservation.scope)).toThrow(UnresolvedReconciliationError);
        expect(() => guard.reserve({ taskId: "t2" }, 0.6)).toThrow(BudgetExceededError);
      });

      it("a reconciliation retry after a failed commit() succeeds safely and records cost exactly once", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 1 });
        const reservation = guard.reserve({ taskId: "t1" }, 0.6);

        expect(() =>
          guard.commit(reservation.id, { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: NaN })
        ).toThrow(InvalidMonetaryAmountError);
        // release() would have been rejected here too, but the caller instead retries commit().
        const recorded = guard.commit(reservation.id, {
          taskId: "t1",
          provider: "mock",
          modelId: "m1",
          amountUsd: 0.6
        });
        expect(recorded.amountUsd).toBe(0.6);
        expect(costEngine.total()).toBe(0.6);

        // Now genuinely terminal: neither commit() nor release() accepts it again.
        expect(() =>
          guard.commit(reservation.id, { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 0.6 })
        ).toThrow(UnknownReservationError);
        expect(() => guard.release(reservation.id, reservation.scope)).toThrow(UnknownReservationError);
        expect(costEngine.total()).toBe(0.6); // still exactly once
      });

      it("an ORDINARY (never-failed) reservation can still be release()d before provider execution, per the documented rule", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 0.6 });
        const reservation = guard.reserve({ taskId: "t1" }, 0.6);
        expect(() => guard.reserve({ taskId: "t2" }, 0.6)).toThrow(BudgetExceededError); // fully reserved

        expect(() => guard.release(reservation.id, reservation.scope)).not.toThrow();
        expect(costEngine.total()).toBe(0);
        expect(() => guard.reserve({ taskId: "t2" }, 0.6)).not.toThrow(); // capacity genuinely freed
      });

      it("release() rejection for an unresolved reservation is audited (never silent)", () => {
        const auditLog = new AuditLog();
        const guard = new BudgetGuard(new CostEngine(), { perRunUsd: 1 }, undefined, auditLog);
        const reservation = guard.reserve({ taskId: "t1" }, 0.5);
        expect(() =>
          guard.commit(reservation.id, { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: NaN })
        ).toThrow(InvalidMonetaryAmountError);
        expect(() => guard.release(reservation.id, reservation.scope)).toThrow(UnresolvedReconciliationError);

        const events = auditLog.all();
        expect(events.some((e) => e.type === "BUDGET_RESERVATION_RELEASE_REJECTED_UNRESOLVED")).toBe(true);
      });

      it("concurrent reservation lifecycles remain safe: one reservation's failed reconciliation cannot be released to free capacity another reservation is relying on", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 1.0 });
        const reservationA = guard.reserve({ taskId: "a" }, 0.6);
        expect(() =>
          guard.commit(reservationA.id, { taskId: "a", provider: "mock", modelId: "m1", amountUsd: NaN })
        ).toThrow(InvalidMonetaryAmountError);

        // B cannot fit alongside A's still-protected (unresolved) $0.60.
        expect(() => guard.reserve({ taskId: "b" }, 0.6))
          .toThrow(BudgetExceededError);
        // A caller cannot manually release A to make room for B either.
        expect(() => guard.release(reservationA.id, reservationA.scope)).toThrow(UnresolvedReconciliationError);
        expect(() => guard.reserve({ taskId: "b" }, 0.6)).toThrow(BudgetExceededError);

        // The only safe path forward is retrying A's own reconciliation.
        guard.commit(reservationA.id, { taskId: "a", provider: "mock", modelId: "m1", amountUsd: 0.6 });
        expect(() => guard.reserve({ taskId: "b" }, 0.4)).not.toThrow();
      });
    }
  );

  describe(
    "commit() ownership binding (P1 fix, 12th independent review round, 'commit() accepts accounting ownership " +
      "unrelated to the reservation')",
    () => {
      it("BLOCKER regression, exact reproduction: reserve P/A then commit Q/B is REJECTED", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 1 });
        const reservation = guard.reserve({ taskId: "a", projectId: "P" }, 0.6);

        expect(() =>
          guard.commit(reservation.id, { taskId: "b", projectId: "Q", provider: "mock", modelId: "m1", amountUsd: 0.6 })
        ).toThrow(ReservationOwnershipMismatchError);
      });

      it("an ownership mismatch leaves the reservation intact (not deleted, still counted)", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perTaskUsd: 0.6, perRunUsd: 10 });
        const reservation = guard.reserve({ taskId: "a" }, 0.6);

        expect(() =>
          guard.commit(reservation.id, { taskId: "b", provider: "mock", modelId: "m1", amountUsd: 0.6 })
        ).toThrow(ReservationOwnershipMismatchError);

        // Reservation A is still open and still fully occupies task A's own ceiling.
        expect(() => guard.reserve({ taskId: "a" }, 0.01)).toThrow(BudgetExceededError);
        // A legitimate retry with the CORRECT ownership still succeeds.
        const recorded = guard.commit(reservation.id, { taskId: "a", provider: "mock", modelId: "m1", amountUsd: 0.6 });
        expect(recorded.taskId).toBe("a");
      });

      it("an ownership mismatch records no cost under the mismatched (Q/B) scope", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 1 });
        const reservation = guard.reserve({ taskId: "a", projectId: "P" }, 0.6);

        expect(() =>
          guard.commit(reservation.id, { taskId: "b", projectId: "Q", provider: "mock", modelId: "m1", amountUsd: 0.6 })
        ).toThrow(ReservationOwnershipMismatchError);

        expect(costEngine.totalFor({ taskId: "b", projectId: "Q" })).toBe(0);
        expect(costEngine.total()).toBe(0);
      });

      it("an ownership mismatch does not restore the original reservation's protected capacity", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 0.6 });
        const reservation = guard.reserve({ taskId: "a" }, 0.6); // uses the ENTIRE ceiling

        expect(() =>
          guard.commit(reservation.id, { taskId: "b", provider: "mock", modelId: "m1", amountUsd: 0.6 })
        ).toThrow(ReservationOwnershipMismatchError);

        // The ceiling remains fully occupied by A's still-open reservation.
        expect(() => guard.reserve({ taskId: "c" }, 0.01)).toThrow(BudgetExceededError);
      });

      it("a correct, matching P/A commit succeeds normally", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 1 });
        const reservation = guard.reserve({ taskId: "a", projectId: "P" }, 0.6);
        const recorded = guard.commit(reservation.id, {
          taskId: "a",
          projectId: "P",
          provider: "mock",
          modelId: "m1",
          amountUsd: 0.6
        });
        expect(recorded.taskId).toBe("a");
        expect(recorded.projectId).toBe("P");
      });

      it("a project-only mismatch (same taskId, different projectId) is rejected", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 1 });
        const reservation = guard.reserve({ taskId: "a", projectId: "P" }, 0.6);
        expect(() =>
          guard.commit(reservation.id, { taskId: "a", projectId: "Q", provider: "mock", modelId: "m1", amountUsd: 0.6 })
        ).toThrow(ReservationOwnershipMismatchError);
      });

      it("a task-only mismatch (same projectId, different taskId) is rejected", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 1 });
        const reservation = guard.reserve({ taskId: "a", projectId: "P" }, 0.6);
        expect(() =>
          guard.commit(reservation.id, { taskId: "b", projectId: "P", provider: "mock", modelId: "m1", amountUsd: 0.6 })
        ).toThrow(ReservationOwnershipMismatchError);
      });

      it("a reservation with no projectId rejects a commit() that supplies one", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 1 });
        const reservation = guard.reserve({ taskId: "a" }, 0.6); // no projectId
        expect(() =>
          guard.commit(reservation.id, { taskId: "a", projectId: "P", provider: "mock", modelId: "m1", amountUsd: 0.6 })
        ).toThrow(ReservationOwnershipMismatchError);
      });

      it("concurrent commits cannot transfer ownership between two independently-reserved tasks", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 2 });
        const reservationA = guard.reserve({ taskId: "a" }, 0.6);
        const reservationB = guard.reserve({ taskId: "b" }, 0.7);

        // Attempting to commit A's reservation under B's ownership (or vice
        // versa) is rejected either way — no cross-contamination possible.
        expect(() =>
          guard.commit(reservationA.id, { taskId: "b", provider: "mock", modelId: "m1", amountUsd: 0.6 })
        ).toThrow(ReservationOwnershipMismatchError);
        expect(() =>
          guard.commit(reservationB.id, { taskId: "a", provider: "mock", modelId: "m1", amountUsd: 0.7 })
        ).toThrow(ReservationOwnershipMismatchError);

        // Both reservations remain intact and correctly committable under their OWN ownership.
        guard.commit(reservationA.id, { taskId: "a", provider: "mock", modelId: "m1", amountUsd: 0.6 });
        guard.commit(reservationB.id, { taskId: "b", provider: "mock", modelId: "m1", amountUsd: 0.7 });
        expect(costEngine.totalFor({ taskId: "a" })).toBe(0.6);
        expect(costEngine.totalFor({ taskId: "b" })).toBe(0.7);
      });
    }
  );

  describe(
    "P1 fix (13th independent review round, 'ownership-mismatch failure leaves reservation releasable'): a " +
      "commit() ownership mismatch now marks the reservation RECONCILIATION_FAILED BEFORE throwing, so a caller " +
      "catching the thrown error cannot then call release() to restore the protected capacity",
    () => {
      it(
        "BLOCKER regression, exact reproduction: reserve -> mismatched commit() -> catch -> release() is " +
          "REJECTED, not silently accepted",
        () => {
          const costEngine = new CostEngine();
          const guard = new BudgetGuard(costEngine, { perRunUsd: 1 });
          const reservation = guard.reserve({ taskId: "a" }, 0.6);

          expect(() =>
            guard.commit(reservation.id, { taskId: "b", provider: "mock", modelId: "m1", amountUsd: 0.6 })
          ).toThrow(ReservationOwnershipMismatchError);

          // The caller catches the mismatch error and (incorrectly)
          // assumes release() is now the safe cleanup path — it must be
          // REJECTED, not silently accepted, since a real provider call
          // may already have occurred under this reservation's authority.
          expect(() => guard.release(reservation.id, reservation.scope)).toThrow(UnresolvedReconciliationError);

          // The full ceiling remains protected — a second full-ceiling
          // reservation cannot slip through a release() that should never
          // have succeeded.
          expect(() => guard.reserve({ taskId: "c" }, 1.0)).toThrow(BudgetExceededError);
          expect(costEngine.total()).toBe(0);
        }
      );

      it("a project mismatch also protects the reservation from release()", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 1 });
        const reservation = guard.reserve({ taskId: "a", projectId: "P" }, 0.6);
        expect(() =>
          guard.commit(reservation.id, { taskId: "a", projectId: "Q", provider: "mock", modelId: "m1", amountUsd: 0.6 })
        ).toThrow(ReservationOwnershipMismatchError);
        expect(() => guard.release(reservation.id, reservation.scope)).toThrow(UnresolvedReconciliationError);
      });

      it("a retry with the CORRECT ownership after a protected mismatch still succeeds and accounts exactly once", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 1 });
        const reservation = guard.reserve({ taskId: "a" }, 0.6);

        expect(() =>
          guard.commit(reservation.id, { taskId: "b", provider: "mock", modelId: "m1", amountUsd: 0.6 })
        ).toThrow(ReservationOwnershipMismatchError);
        expect(() => guard.release(reservation.id, reservation.scope)).toThrow(UnresolvedReconciliationError);

        // The ONLY safe path forward: retry commit() with the CORRECT ownership.
        const recorded = guard.commit(reservation.id, { taskId: "a", provider: "mock", modelId: "m1", amountUsd: 0.6 });
        expect(recorded.amountUsd).toBe(0.6);
        expect(costEngine.total()).toBe(0.6); // exactly once

        // Now genuinely terminal.
        expect(() =>
          guard.commit(reservation.id, { taskId: "a", provider: "mock", modelId: "m1", amountUsd: 0.6 })
        ).toThrow(UnknownReservationError);
        expect(() => guard.release(reservation.id, reservation.scope)).toThrow(UnknownReservationError);
      });

      it("an ownership-mismatch release() rejection is audited with the same event type as an amount-failure rejection", () => {
        const auditLog = new AuditLog();
        const guard = new BudgetGuard(new CostEngine(), { perRunUsd: 1 }, undefined, auditLog);
        const reservation = guard.reserve({ taskId: "a" }, 0.5);
        expect(() =>
          guard.commit(reservation.id, { taskId: "b", provider: "mock", modelId: "m1", amountUsd: 0.5 })
        ).toThrow(ReservationOwnershipMismatchError);
        expect(() => guard.release(reservation.id, reservation.scope)).toThrow(UnresolvedReconciliationError);

        const events = auditLog.all();
        expect(events.some((e) => e.type === "BUDGET_RESERVATION_OWNERSHIP_MISMATCH")).toBe(true);
        expect(events.some((e) => e.type === "BUDGET_RESERVATION_RELEASE_REJECTED_UNRESOLVED")).toBe(true);
      });
    }
  );

  describe(
    "P1 fix (13th independent review round, 'reservation ownership checks omit agent identity'): commit()'s " +
      "ownership check now covers agentId, provider, and modelId in addition to taskId/projectId — every " +
      "dimension a reservation actually captured at reserve() time is authoritative",
    () => {
      it(
        "BLOCKER regression, exact reproduction: an owner-agent reservation, committed as a DIFFERENT agent, is " +
          "REJECTED — the reservation remains protected and no spending is recorded for the other agent",
        () => {
          const costEngine = new CostEngine();
          const guard = new BudgetGuard(costEngine, { perRunUsd: 1 });
          const reservation = guard.reserve({ taskId: "a", agentId: "owner-agent" }, 0.6);

          expect(() =>
            guard.commit(reservation.id, {
              taskId: "a",
              agentId: "other-agent",
              provider: "mock",
              modelId: "m1",
              amountUsd: 0.6
            })
          ).toThrow(ReservationOwnershipMismatchError);

          // No spend was ever recorded under the other agent's identity.
          expect(costEngine.totalFor({ agentId: "other-agent" })).toBe(0);
          expect(costEngine.total()).toBe(0);
          // The reservation remains protected — release() is also rejected
          // (bkz. the mismatch-marks-RECONCILIATION_FAILED fix above).
          expect(() => guard.release(reservation.id, reservation.scope)).toThrow(UnresolvedReconciliationError);

          // A correct retry under the ORIGINAL owner-agent still succeeds.
          const recorded = guard.commit(reservation.id, {
            taskId: "a",
            agentId: "owner-agent",
            provider: "mock",
            modelId: "m1",
            amountUsd: 0.6
          });
          expect(recorded.agentId).toBe("owner-agent");
          expect(costEngine.totalFor({ agentId: "owner-agent" })).toBe(0.6);
        }
      );

      it("a reservation with no agentId rejects a commit() that supplies one", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 1 });
        const reservation = guard.reserve({ taskId: "a" }, 0.6); // no agentId
        expect(() =>
          guard.commit(reservation.id, { taskId: "a", agentId: "some-agent", provider: "mock", modelId: "m1", amountUsd: 0.6 })
        ).toThrow(ReservationOwnershipMismatchError);
      });

      it("a provider mismatch is REJECTED when the reservation itself recorded a provider at reserve() time", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 1 });
        const reservation = guard.reserve({ taskId: "a", provider: "authorized-provider" }, 0.6);

        expect(() =>
          guard.commit(reservation.id, { taskId: "a", provider: "substituted-provider", modelId: "m1", amountUsd: 0.6 })
        ).toThrow(ReservationOwnershipMismatchError);
        expect(costEngine.total()).toBe(0);

        const recorded = guard.commit(reservation.id, { taskId: "a", provider: "authorized-provider", modelId: "m1", amountUsd: 0.6 });
        expect(recorded.provider).toBe("authorized-provider");
      });

      it("a modelId mismatch is REJECTED when the reservation itself recorded a modelId at reserve() time", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 1 });
        const reservation = guard.reserve({ taskId: "a", modelId: "authorized-model" }, 0.6);

        expect(() =>
          guard.commit(reservation.id, { taskId: "a", provider: "mock", modelId: "substituted-model", amountUsd: 0.6 })
        ).toThrow(ReservationOwnershipMismatchError);
        expect(costEngine.total()).toBe(0);

        const recorded = guard.commit(reservation.id, { taskId: "a", provider: "mock", modelId: "authorized-model", amountUsd: 0.6 });
        expect(recorded.modelId).toBe("authorized-model");
      });

      it(
        "a reservation with NO provider/modelId recorded (the pre-existing, still-supported call shape) does " +
          "not enforce those dimensions — no regression for callers that never declared them",
        () => {
          const costEngine = new CostEngine();
          const guard = new BudgetGuard(costEngine, { perRunUsd: 1 });
          const reservation = guard.reserve({ taskId: "a" }, 0.6); // no provider/modelId
          const recorded = guard.commit(reservation.id, {
            taskId: "a",
            provider: "whatever-provider",
            modelId: "whatever-model",
            amountUsd: 0.6
          });
          expect(recorded.provider).toBe("whatever-provider");
          expect(recorded.modelId).toBe("whatever-model");
        }
      );

      it("agentId/provider/modelId mismatches can combine with taskId/projectId mismatches — ANY dimension mismatching is sufficient to reject", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 1 });
        const reservation = guard.reserve(
          { taskId: "a", projectId: "P", agentId: "agent-1", provider: "prov-1", modelId: "model-1" },
          0.6
        );

        expect(() =>
          guard.commit(reservation.id, {
            taskId: "a",
            projectId: "P",
            agentId: "agent-1",
            provider: "prov-1",
            modelId: "model-2", // only modelId differs
            amountUsd: 0.6
          })
        ).toThrow(ReservationOwnershipMismatchError);

        const recorded = guard.commit(reservation.id, {
          taskId: "a",
          projectId: "P",
          agentId: "agent-1",
          provider: "prov-1",
          modelId: "model-1",
          amountUsd: 0.6
        });
        expect(recorded.modelId).toBe("model-1");
      });

      it("the ownership-mismatch audit event identifies the reservation's authoritative owner across ALL dimensions, never the caller's rejected values", () => {
        const auditLog = new AuditLog();
        const guard = new BudgetGuard(new CostEngine(), { perRunUsd: 1 }, undefined, auditLog);
        const reservation = guard.reserve({ taskId: "a", agentId: "owner-agent", provider: "authorized-provider", modelId: "authorized-model" }, 0.5);

        expect(() =>
          guard.commit(reservation.id, {
            taskId: "a",
            agentId: "attacker-agent",
            provider: "attacker-provider",
            modelId: "attacker-model",
            amountUsd: 0.5
          })
        ).toThrow(ReservationOwnershipMismatchError);

        const event = auditLog.all().find((e) => e.type === "BUDGET_RESERVATION_OWNERSHIP_MISMATCH");
        expect(event).toBeDefined();
        const payload = event!.payload as { reservedScope: { agentId?: string; provider?: string; modelId?: string } };
        expect(payload.reservedScope.agentId).toBe("owner-agent");
        expect(payload.reservedScope.provider).toBe("authorized-provider");
        expect(payload.reservedScope.modelId).toBe("authorized-model");
      });
    }
  );

  describe(
    "P1 fix (16th independent review round, 'outstanding budget reservations are not shared across guards " +
      "using one cost ledger'): reservation state now lives on the shared CostEngine, so every BudgetGuard " +
      "bound to the same ledger enforces ceilings against the SAME outstanding reservations, not a private map",
    () => {
      it(
        "BLOCKER regression, exact reproduction: shared CostEngine + Guard A + Guard B, $1 ceiling, A reserves " +
          "$0.60, B's $0.60 attempt is REJECTED before any provider invocation would occur",
        () => {
          const costEngine = new CostEngine();
          const guardA = new BudgetGuard(costEngine, { perRunUsd: 1 });
          const guardB = new BudgetGuard(costEngine, { perRunUsd: 1 });

          const reservationA = guardA.reserve({ taskId: "a" }, 0.6);
          expect(reservationA.amountUsd).toBe(0.6);

          // Guard B must see A's outstanding reservation on the SHARED
          // ledger and reject before ever reaching a provider call.
          expect(() => guardB.reserve({ taskId: "b" }, 0.6)).toThrow(BudgetExceededError);

          // Nothing was ever committed by either guard.
          expect(costEngine.total()).toBe(0);
        }
      );

      it("two concurrent $0.60 reservations across two guards over one ledger cannot both succeed", () => {
        const costEngine = new CostEngine();
        const guardA = new BudgetGuard(costEngine, { perRunUsd: 1 });
        const guardB = new BudgetGuard(costEngine, { perRunUsd: 1 });

        const reservationA = guardA.reserve({ taskId: "a" }, 0.6);
        expect(() => guardB.reserve({ taskId: "b" }, 0.6)).toThrow(BudgetExceededError);

        // A's own reservation is still intact and can be committed normally
        // — rejecting B never disturbed A's outstanding reservation.
        const committed = guardA.commit(reservationA.id, {
          taskId: "a",
          provider: "mock",
          modelId: "m1",
          amountUsd: 0.6
        });
        expect(committed.amountUsd).toBe(0.6);
        expect(costEngine.total()).toBe(0.6);
      });

      it("committed + reserved is enforced together across guards: A commits $0.60, B's further $0.60 reservation still sees the committed total via the shared CostEngine", () => {
        const costEngine = new CostEngine();
        const guardA = new BudgetGuard(costEngine, { perRunUsd: 1 });
        const guardB = new BudgetGuard(costEngine, { perRunUsd: 1 });

        const reservationA = guardA.reserve({ taskId: "a" }, 0.6);
        guardA.commit(reservationA.id, { taskId: "a", provider: "mock", modelId: "m1", amountUsd: 0.6 });

        // $0.60 already committed (shared CostEngine) — B's own $0.60
        // reservation would push the shared $1 ceiling to $1.20.
        expect(() => guardB.reserve({ taskId: "b" }, 0.6)).toThrow(BudgetExceededError);
        expect(costEngine.total()).toBe(0.6);
      });

      it("release() from either guard restores only the correct, exact capacity on the shared ledger", () => {
        const costEngine = new CostEngine();
        const guardA = new BudgetGuard(costEngine, { perRunUsd: 1 });
        const guardB = new BudgetGuard(costEngine, { perRunUsd: 1 });

        const reservationA = guardA.reserve({ taskId: "a" }, 0.6);
        expect(() => guardB.reserve({ taskId: "b" }, 0.6)).toThrow(BudgetExceededError);

        // Releasing A's reservation (even via a DIFFERENT guard instance
        // bound to the same ledger) frees EXACTLY its $0.60 — no more, no
        // less — since release() is a shared-ledger operation identified
        // by reservation id, not by which guard object created it.
        guardB.release(reservationA.id, reservationA.scope);
        expect(() => guardB.reserve({ taskId: "b" }, 0.6)).not.toThrow();
        expect(costEngine.total()).toBe(0);
      });

      it("a protected RECONCILIATION_FAILED reservation (created via Guard A) remains protected when Guard B attempts to release() it", () => {
        const costEngine = new CostEngine();
        const guardA = new BudgetGuard(costEngine, { perRunUsd: 1 });
        const guardB = new BudgetGuard(costEngine, { perRunUsd: 1 });

        const reservationA = guardA.reserve({ taskId: "a" }, 0.6);
        expect(() =>
          guardA.commit(reservationA.id, { taskId: "a", provider: "mock", modelId: "m1", amountUsd: NaN })
        ).toThrow(InvalidMonetaryAmountError);

        // Guard B (a DIFFERENT guard instance, same ledger) sees the
        // SAME protected, unresolved reservation and is likewise
        // rejected from releasing it.
        expect(() => guardB.release(reservationA.id, reservationA.scope)).toThrow(UnresolvedReconciliationError);
        expect(() => guardB.reserve({ taskId: "b" }, 1.0)).toThrow(BudgetExceededError);

        // The only safe path forward — retrying commit() with a
        // corrected amount — works from EITHER guard, since ownership is
        // defined by the reservation's own scope, not by which guard
        // object originally created it.
        const recorded = guardB.commit(reservationA.id, { taskId: "a", provider: "mock", modelId: "m1", amountUsd: 0.6 });
        expect(recorded.amountUsd).toBe(0.6);
        expect(costEngine.total()).toBe(0.6);
      });

      it("a correct commit() made through Guard A is immediately visible to Guard B's own ceiling checks", () => {
        const costEngine = new CostEngine();
        const guardA = new BudgetGuard(costEngine, { perTaskUsd: 0.6 });
        const guardB = new BudgetGuard(costEngine, { perTaskUsd: 0.6 });

        const reservationA = guardA.reserve({ taskId: "shared-task" }, 0.6);
        guardA.commit(reservationA.id, { taskId: "shared-task", provider: "mock", modelId: "m1", amountUsd: 0.6 });

        // Guard B's OWN perTaskUsd ceiling for the SAME task is now
        // fully consumed, even though Guard B never reserved/committed
        // anything itself — because committed spend has ALWAYS been
        // shared via CostEngine (this was already true before this
        // round's fix; verified here alongside the reservation-sharing
        // fix for completeness).
        expect(() => guardB.reserve({ taskId: "shared-task" }, 0.01)).toThrow(BudgetExceededError);
      });

      it("task/project ownership remains correctly isolated across guards sharing one ledger (no cross-task/cross-project interference)", () => {
        const costEngine = new CostEngine();
        const guardA = new BudgetGuard(costEngine, { perTaskUsd: 0.6 });
        const guardB = new BudgetGuard(costEngine, { perTaskUsd: 0.6 });

        guardA.reserve({ taskId: "task-a", projectId: "project-1" }, 0.6);
        // A DIFFERENT task (even on the SAME shared ledger, via a
        // DIFFERENT guard) has its OWN, unaffected $0.6 ceiling.
        expect(() => guardB.reserve({ taskId: "task-b", projectId: "project-1" }, 0.6)).not.toThrow();
        // A different project reusing the SAME taskId is likewise isolated.
        expect(() => guardB.reserve({ taskId: "task-a", projectId: "project-2" }, 0.6)).not.toThrow();
      });

      it("agent ownership remains correctly isolated across guards sharing one ledger", () => {
        const costEngine = new CostEngine();
        const guardA = new BudgetGuard(costEngine, { perRunUsd: 1.2 });
        const guardB = new BudgetGuard(costEngine, { perRunUsd: 1.2 });

        const reservationA = guardA.reserve({ taskId: "t", agentId: "agent-1" }, 0.6);
        const reservationB = guardB.reserve({ taskId: "t", agentId: "agent-2" }, 0.6);

        guardA.commit(reservationA.id, { taskId: "t", agentId: "agent-1", provider: "mock", modelId: "m1", amountUsd: 0.6 });
        guardB.commit(reservationB.id, { taskId: "t", agentId: "agent-2", provider: "mock", modelId: "m1", amountUsd: 0.6 });

        expect(costEngine.totalFor({ agentId: "agent-1" })).toBe(0.6);
        expect(costEngine.totalFor({ agentId: "agent-2" })).toBe(0.6);
      });

      it("provider/model ownership dimensions remain correctly isolated across guards sharing one ledger", () => {
        const costEngine = new CostEngine();
        const guardA = new BudgetGuard(costEngine, { perRunUsd: 1.2 });
        const guardB = new BudgetGuard(costEngine, { perRunUsd: 1.2 });

        const reservationA = guardA.reserve({ taskId: "t", provider: "prov-a", modelId: "model-a" }, 0.6);
        const reservationB = guardB.reserve({ taskId: "t2", provider: "prov-b", modelId: "model-b" }, 0.6);

        // Guard B cannot commit reservationA under provider/model B's identity.
        expect(() =>
          guardB.commit(reservationA.id, { taskId: "t", provider: "prov-b", modelId: "model-b", amountUsd: 0.6 })
        ).toThrow(ReservationOwnershipMismatchError);

        // Correct commits from either guard succeed independently.
        guardA.commit(reservationA.id, { taskId: "t", provider: "prov-a", modelId: "model-a", amountUsd: 0.6 });
        guardB.commit(reservationB.id, { taskId: "t2", provider: "prov-b", modelId: "model-b", amountUsd: 0.6 });
        expect(costEngine.total()).toBeCloseTo(1.2);
      });

      it("different, independent CostEngine ledgers remain fully independent (no cross-ledger interference)", () => {
        const ledgerOne = new CostEngine();
        const ledgerTwo = new CostEngine();
        const guardOne = new BudgetGuard(ledgerOne, { perRunUsd: 1 });
        const guardTwo = new BudgetGuard(ledgerTwo, { perRunUsd: 1 });

        guardOne.reserve({ taskId: "a" }, 0.6);
        // guardTwo's ledger has never seen guardOne's reservation at all.
        expect(() => guardTwo.reserve({ taskId: "b" }, 0.6)).not.toThrow();
        expect(ledgerOne.reservedTotal({})).toBe(0.6);
        expect(ledgerTwo.reservedTotal({})).toBe(0.6);
      });

      it("no double accounting occurs: a single committed spend is counted exactly once regardless of how many guards share the ledger", () => {
        const costEngine = new CostEngine();
        const guardA = new BudgetGuard(costEngine, { perRunUsd: 10 });
        const guardB = new BudgetGuard(costEngine, { perRunUsd: 10 });
        void guardB;

        const reservationA = guardA.reserve({ taskId: "a" }, 0.6);
        guardA.commit(reservationA.id, { taskId: "a", provider: "mock", modelId: "m1", amountUsd: 0.6 });

        expect(costEngine.all()).toHaveLength(1);
        expect(costEngine.total()).toBe(0.6);
      });

      it("constructing a second BudgetGuard over an existing ledger does not reset or hide already-outstanding reservations", () => {
        const costEngine = new CostEngine();
        const guardA = new BudgetGuard(costEngine, { perRunUsd: 1 });
        guardA.reserve({ taskId: "a" }, 0.6);

        // Guard B is constructed AFTER the reservation already exists.
        const guardB = new BudgetGuard(costEngine, { perRunUsd: 1 });
        expect(() => guardB.reserve({ taskId: "b" }, 0.6)).toThrow(BudgetExceededError);
      });
    }
  );

  describe(
    "P1 fix (25th independent review round, 'callers must not release someone else's active reservation'): " +
      "release() now REQUIRES a callerScope argument, validated against the reservation's own authoritative " +
      "scope before any deletion — a reservation id alone (a predictable, sequential bearer token) is never " +
      "sufficient to release capacity reserved under a different owner's scope",
    () => {
      it("BLOCKER regression, exact reproduction: caller B, knowing only caller A's reservation id, cannot release A's active reservation via BudgetGuard", () => {
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 1 });
        const reservationA = guard.reserve({ taskId: "a", projectId: "A" }, 0.6);

        // Caller B supplies its OWN scope, not A's — merely knowing A's
        // reservation id must never be sufficient.
        expect(() => guard.release(reservationA.id, { taskId: "b", projectId: "B" })).toThrow(
          ReservationOwnershipMismatchError
        );

        // A's reservation is safely preserved: still counted, still
        // protecting its own capacity, unaffected by B's rejected attempt.
        expect(() => guard.reserve({ taskId: "c" }, 0.5)).toThrow(BudgetExceededError);

        // A's own legitimate release still works normally afterward.
        expect(() => guard.release(reservationA.id, reservationA.scope)).not.toThrow();
        expect(() => guard.reserve({ taskId: "c" }, 0.6)).not.toThrow();
      });

      it("a release-ownership mismatch is audited via BUDGET_RESERVATION_RELEASE_REJECTED_OWNERSHIP_MISMATCH and does not mark the reservation RECONCILIATION_FAILED", () => {
        const auditLog = new AuditLog();
        const costEngine = new CostEngine();
        const guard = new BudgetGuard(costEngine, { perRunUsd: 1 }, undefined, auditLog);
        const reservation = guard.reserve({ taskId: "owner" }, 0.4);

        expect(() => guard.release(reservation.id, { taskId: "someone-else" })).toThrow(
          ReservationOwnershipMismatchError
        );

        const events = auditLog.all();
        expect(events.some((e) => e.type === "BUDGET_RESERVATION_RELEASE_REJECTED_OWNERSHIP_MISMATCH")).toBe(true);

        // Unlike a commit() mismatch, the reservation is NOT marked
        // RECONCILIATION_FAILED — the legitimate owner can still commit it normally.
        const recorded = guard.commit(reservation.id, { taskId: "owner", provider: "mock", modelId: "m1", amountUsd: 0.4 });
        expect(recorded.amountUsd).toBe(0.4);
      });
    }
  );
});
