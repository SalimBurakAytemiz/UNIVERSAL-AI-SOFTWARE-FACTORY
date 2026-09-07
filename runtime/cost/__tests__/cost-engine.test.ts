import { describe, expect, it } from "vitest";
import {
  CostEngine,
  InvalidMonetaryAmountError,
  UnknownReservationError,
  UnresolvedReconciliationError,
  assertValidMonetaryAmount,
  exceedsMonetaryAmount
} from "../cost-engine.js";

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

  describe("exceedsMonetaryAmount (P2 fix, 8th independent review round: 'floating-point comparisons reject exact budget spend')", () => {
    it("0.1 + 0.2 does not exceed 0.3 at the Factory's fixed monetary precision, despite native float noise", () => {
      expect(0.1 + 0.2 > 0.3).toBe(true); // sanity: confirms the native bug this utility fixes
      expect(exceedsMonetaryAmount(0.1 + 0.2, 0.3)).toBe(false);
    });

    it("a genuine excess (one precision unit above) is still reported as exceeding", () => {
      expect(exceedsMonetaryAmount(0.300001, 0.3)).toBe(true);
    });

    it("equal amounts never exceed each other", () => {
      expect(exceedsMonetaryAmount(5, 5)).toBe(false);
      expect(exceedsMonetaryAmount(0, 0)).toBe(false);
    });

    it("a genuinely smaller amount never exceeds a larger one", () => {
      expect(exceedsMonetaryAmount(1, 2)).toBe(false);
    });

    it("repeated decimal accumulation lands exactly on a whole-dollar ceiling", () => {
      let total = 0;
      for (let i = 0; i < 10; i++) total += 0.1;
      expect(exceedsMonetaryAmount(total, 1)).toBe(false);
    });
  });

  describe(
    "P1 fix (24th independent review round, 'reservation deletion must not bypass reconciliation') " +
      "— reservation lifecycle is enforced at the ledger level, not only through BudgetGuard",
    () => {
      it("there is no generic, unguarded deleteReservation() left on the public API", () => {
        const engine = new CostEngine();
        expect((engine as unknown as Record<string, unknown>).deleteReservation).toBeUndefined();
      });

      it("commitReservation() records a real cost and removes the reservation on success", () => {
        const engine = new CostEngine();
        const reservation = engine.createReservation({ taskId: "t1" }, 0.5);
        expect(engine.reservedTotal({ taskId: "t1" })).toBe(0.5);

        const recorded = engine.commitReservation(reservation.id, {
          taskId: "t1",
          provider: "mock",
          modelId: "m1",
          amountUsd: 0.5
        });

        expect(recorded.amountUsd).toBe(0.5);
        expect(engine.totalFor({ taskId: "t1" })).toBe(0.5);
        expect(engine.reservedTotal({ taskId: "t1" })).toBe(0); // reservation is gone
        expect(engine.getReservation(reservation.id)).toBeUndefined();
      });

      it(
        "commitReservation() with an invalid amount marks the reservation RECONCILIATION_FAILED and " +
          "PROTECTS it — no cost is recorded and the reservation is not removed (capacity stays reserved)",
        () => {
          const engine = new CostEngine();
          const reservation = engine.createReservation({ taskId: "t1" }, 0.5);

          expect(() =>
            engine.commitReservation(reservation.id, { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: NaN })
          ).toThrow(InvalidMonetaryAmountError);

          expect(engine.totalFor({ taskId: "t1" })).toBe(0); // no cost recorded
          expect(engine.reservedTotal({ taskId: "t1" })).toBe(0.5); // capacity still protected
          expect(engine.getReservation(reservation.id)?.status).toBe("RECONCILIATION_FAILED");

          // The core invariant this finding requires: a normal consumer
          // cannot free this protected reservation's capacity for free —
          // releaseReservation() (the only other exit) refuses it outright.
          expect(() => engine.releaseReservation(reservation.id)).toThrow(UnresolvedReconciliationError);
          expect(engine.reservedTotal({ taskId: "t1" })).toBe(0.5); // still protected after the rejected release
        }
      );

      it("releaseReservation() removes an ordinary ACTIVE reservation with no cost recorded", () => {
        const engine = new CostEngine();
        const reservation = engine.createReservation({ taskId: "t1" }, 0.5);

        const released = engine.releaseReservation(reservation.id);

        expect(released.amountUsd).toBe(0.5);
        expect(engine.totalFor({ taskId: "t1" })).toBe(0); // never spent
        expect(engine.reservedTotal({ taskId: "t1" })).toBe(0); // capacity freed
        expect(engine.getReservation(reservation.id)).toBeUndefined();
      });

      it("releaseReservation() throws UnresolvedReconciliationError for a RECONCILIATION_FAILED reservation and does not remove it", () => {
        const engine = new CostEngine();
        const reservation = engine.createReservation({ taskId: "t1" }, 0.5);
        engine.markReservationReconciliationFailed(reservation.id);

        expect(() => engine.releaseReservation(reservation.id)).toThrow(UnresolvedReconciliationError);
        expect(engine.getReservation(reservation.id)).toBeDefined(); // still protected, not deleted
      });

      it("commitReservation()/releaseReservation() throw UnknownReservationError for a nonexistent or already-resolved id", () => {
        const engine = new CostEngine();
        expect(() =>
          engine.commitReservation("never-existed", { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 0.1 })
        ).toThrow(UnknownReservationError);
        expect(() => engine.releaseReservation("never-existed")).toThrow(UnknownReservationError);

        const reservation = engine.createReservation({ taskId: "t1" }, 0.1);
        engine.releaseReservation(reservation.id);
        expect(() => engine.releaseReservation(reservation.id)).toThrow(UnknownReservationError);
      });
    }
  );
});
