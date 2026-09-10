import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CorruptCostStateError,
  CostEngine,
  InvalidCostEntryIdentityError,
  InvalidMonetaryAmountError,
  InvalidReservationScopeError,
  MAX_SUPPORTED_MONETARY_AMOUNT_USD,
  ReservationOwnershipMismatchError,
  UnknownReservationError,
  UnresolvedReconciliationError,
  assertValidMonetaryAmount,
  exceedsMonetaryAmount
} from "../cost-engine.js";
import { FileStateStore, type StateStore } from "../../state/file-store.js";

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

  describe(
    "P2 fix (36th independent review round, finding 10, 'enforce restore-time identity checks before " +
      "record() persistence'): record() must reject the EXACT SAME malformed identity shapes " +
      "assertValidPersistedCostState() would refuse on the next restart, BEFORE mutating or persisting " +
      "anything — never only after the fact",
    () => {
      it.each([
        ["empty taskId", { taskId: "", provider: "mock", modelId: "m1" }],
        ["empty provider", { taskId: "t1", provider: "", modelId: "m1" }],
        ["empty modelId", { taskId: "t1", provider: "mock", modelId: "" }]
      ])("BLOCKER regression, exact reproduction: rejects %s before mutating state", (_label, identity) => {
        const engine = new CostEngine();
        expect(() => engine.record({ ...identity, amountUsd: 1 } as never)).toThrow(InvalidCostEntryIdentityError);
        expect(engine.all()).toHaveLength(0);
        expect(engine.total()).toBe(0);
      });

      it.each([
        ["agentId", { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 1, agentId: 42 }],
        ["projectId", { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 1, projectId: 42 }],
        ["runId", { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 1, runId: 42 }]
      ])("BLOCKER regression: rejects a non-string, non-undefined %s (the exact shape restore would also refuse)", (_label, entry) => {
        const engine = new CostEngine();
        expect(() => engine.record(entry as never)).toThrow(InvalidCostEntryIdentityError);
        expect(engine.all()).toHaveLength(0);
      });

      it(
        "root-cause proof: an entry record() now refuses is the EXACT same shape " +
          "assertValidPersistedCostState() (bkz. #loadFromStore()'un restore-time doğrulaması) would have " +
          "refused on the next restart — proving the two checks are now genuinely aligned, not merely " +
          "coincidentally similar",
        () => {
          const tempRoot = mkdtempSync(join(tmpdir(), "uasf-cost-engine-identity-alignment-"));
          try {
            const store = new FileStateStore();
            const statePath = join(tempRoot, "cost-state.json");
            const engine = new CostEngine(() => new Date(), { store, path: statePath });

            // record() refuses this BEFORE it ever reaches durable storage —
            // so there is nothing malformed on disk for a restart to trip
            // over. This is the fix: previously this call would have
            // SUCCEEDED, persisted, and only the NEXT restart would have
            // discovered the problem (as CorruptCostStateError, taking the
            // whole ledger down).
            expect(() =>
              engine.record({ taskId: "", provider: "mock", modelId: "m1", amountUsd: 1 })
            ).toThrow(InvalidCostEntryIdentityError);

            // A genuinely fresh instance against the same file restores
            // cleanly — nothing corrupt was ever written.
            const after = new CostEngine(() => new Date(), { store, path: statePath });
            expect(() => after.all()).not.toThrow();
            expect(after.all()).toHaveLength(0);
          } finally {
            rmSync(tempRoot, { recursive: true, force: true });
          }
        }
      );

      it("no regression: a fully valid entry (including optional agentId/projectId/runId) is recorded and survives a real restart", () => {
        const tempRoot = mkdtempSync(join(tmpdir(), "uasf-cost-engine-identity-valid-roundtrip-"));
        try {
          const store = new FileStateStore();
          const statePath = join(tempRoot, "cost-state.json");
          const before = new CostEngine(() => new Date(), { store, path: statePath });
          before.record({
            taskId: "t1",
            agentId: "a1",
            projectId: "p1",
            runId: "r1",
            provider: "mock",
            modelId: "m1",
            amountUsd: 0.5
          });
          expect(before.total()).toBeCloseTo(0.5);

          const after = new CostEngine(() => new Date(), { store, path: statePath });
          expect(after.total()).toBeCloseTo(0.5);
          expect(after.all()).toHaveLength(1);
        } finally {
          rmSync(tempRoot, { recursive: true, force: true });
        }
      });

      it("no regression: omitting the optional agentId/projectId/runId fields entirely is still accepted", () => {
        const engine = new CostEngine();
        expect(() => engine.record({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 1 })).not.toThrow();
        expect(engine.all()).toHaveLength(1);
      });
    }
  );

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
    "P1 fix (independent Codex review, 'prevent monetary unit overflow from bypassing ceilings'): scaling by " +
      "MONETARY_PRECISION_SCALE must never overflow/lose precision in a way that destroys comparison ordering",
    () => {
      it(
        "BLOCKER regression, exact reproduction: a very large but finite amount (~1e308) that would overflow " +
          "to Infinity when scaled still correctly reports as exceeding a smaller (but also huge) finite ceiling",
        () => {
          const hugeAmount = 1e308;
          const hugeLimit = 1e307;
          // Sanity: scaling either value by MONETARY_PRECISION_SCALE (1e6) overflows to Infinity,
          // and Infinity > Infinity is false — this is the exact bug this fix closes.
          expect(hugeAmount * 1_000_000).toBe(Infinity);
          expect(hugeLimit * 1_000_000).toBe(Infinity);
          expect(Infinity > Infinity).toBe(false);
          expect(exceedsMonetaryAmount(hugeAmount, hugeLimit)).toBe(true);
        }
      );

      it("no-regression: a smaller huge finite amount does not falsely exceed a larger huge finite ceiling", () => {
        expect(exceedsMonetaryAmount(1e307, 1e308)).toBe(false);
      });

      it("no-regression: two equal huge finite amounts never exceed each other", () => {
        expect(exceedsMonetaryAmount(1e308, 1e308)).toBe(false);
      });

      it(
        "boundary: an amount exactly at MAX_SUPPORTED_MONETARY_AMOUNT_USD scales to an exact safe integer and " +
          "compares correctly against itself and against a smaller value",
        () => {
          expect(exceedsMonetaryAmount(MAX_SUPPORTED_MONETARY_AMOUNT_USD, MAX_SUPPORTED_MONETARY_AMOUNT_USD)).toBe(
            false
          );
          expect(exceedsMonetaryAmount(MAX_SUPPORTED_MONETARY_AMOUNT_USD, 1)).toBe(true);
          expect(exceedsMonetaryAmount(1, MAX_SUPPORTED_MONETARY_AMOUNT_USD)).toBe(false);
        }
      );

      it("assertValidMonetaryAmount rejects an amount beyond MAX_SUPPORTED_MONETARY_AMOUNT_USD", () => {
        expect(() =>
          assertValidMonetaryAmount(MAX_SUPPORTED_MONETARY_AMOUNT_USD * 10, "test")
        ).toThrow(InvalidMonetaryAmountError);
      });

      it("assertValidMonetaryAmount still accepts an amount exactly at the boundary", () => {
        expect(() => assertValidMonetaryAmount(MAX_SUPPORTED_MONETARY_AMOUNT_USD, "test")).not.toThrow();
      });

      it("record() fails closed on an amount beyond the maximum supported monetary amount", () => {
        const engine = new CostEngine();
        expect(() =>
          engine.record({
            taskId: "t1",
            provider: "mock",
            modelId: "m1",
            amountUsd: MAX_SUPPORTED_MONETARY_AMOUNT_USD * 10
          })
        ).toThrow(InvalidMonetaryAmountError);
        expect(engine.all()).toHaveLength(0);
      });
    }
  );

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
          expect(() => engine.releaseReservation(reservation.id, { taskId: "t1" })).toThrow(UnresolvedReconciliationError);
          expect(engine.reservedTotal({ taskId: "t1" })).toBe(0.5); // still protected after the rejected release
        }
      );

      it("releaseReservation() removes an ordinary ACTIVE reservation with no cost recorded", () => {
        const engine = new CostEngine();
        const reservation = engine.createReservation({ taskId: "t1" }, 0.5);

        const released = engine.releaseReservation(reservation.id, { taskId: "t1" });

        expect(released.amountUsd).toBe(0.5);
        expect(engine.totalFor({ taskId: "t1" })).toBe(0); // never spent
        expect(engine.reservedTotal({ taskId: "t1" })).toBe(0); // capacity freed
        expect(engine.getReservation(reservation.id)).toBeUndefined();
      });

      it("releaseReservation() throws UnresolvedReconciliationError for a RECONCILIATION_FAILED reservation and does not remove it", () => {
        const engine = new CostEngine();
        const reservation = engine.createReservation({ taskId: "t1" }, 0.5);
        // P1 fix (34th independent review round, finding 2): the old,
        // ownership-free `markReservationReconciliationFailed(id)` was
        // removed entirely — `markReservationUnresolved(id, callerScope)`
        // is the one authoritative, ownership-checked way to reach this
        // state from outside.
        engine.markReservationUnresolved(reservation.id, { taskId: "t1" });

        expect(() => engine.releaseReservation(reservation.id, { taskId: "t1" })).toThrow(UnresolvedReconciliationError);
        expect(engine.getReservation(reservation.id)).toBeDefined(); // still protected, not deleted
      });

      it("commitReservation()/releaseReservation() throw UnknownReservationError for a nonexistent or already-resolved id", () => {
        const engine = new CostEngine();
        expect(() =>
          engine.commitReservation("never-existed", { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 0.1 })
        ).toThrow(UnknownReservationError);
        expect(() => engine.releaseReservation("never-existed", {})).toThrow(UnknownReservationError);

        const reservation = engine.createReservation({ taskId: "t1" }, 0.1);
        engine.releaseReservation(reservation.id, { taskId: "t1" });
        expect(() => engine.releaseReservation(reservation.id, { taskId: "t1" })).toThrow(UnknownReservationError);
      });
    }
  );

  describe(
    "P1 fix (33rd independent review round, finding 1 / root class F, 'billable provider failure " +
      "reconciliation'): markReservationUnresolved() is the entry point ModelGateway.invoke() uses for a " +
      "provider failure with no authoritative evidence of zero cost — it must protect exactly like a failed " +
      "commitReservation() already does, never delete, and validate ownership the same way releaseReservation() " +
      "does",
    () => {
      it("BLOCKER regression, exact reproduction: an ACTIVE reservation transitions to RECONCILIATION_FAILED and is NOT removed", () => {
        const engine = new CostEngine();
        const reservation = engine.createReservation({ taskId: "t1" }, 0.5);

        const result = engine.markReservationUnresolved(reservation.id, { taskId: "t1" });

        expect(result.status).toBe("RECONCILIATION_FAILED");
        expect(engine.getReservation(reservation.id)?.status).toBe("RECONCILIATION_FAILED");
        expect(engine.reservedTotal({ taskId: "t1" })).toBe(0.5); // capacity still protected
        expect(engine.totalFor({ taskId: "t1" })).toBe(0); // nothing durably recorded yet
      });

      it("root-cause proof: once marked unresolved, releaseReservation() is rejected exactly like any other RECONCILIATION_FAILED reservation", () => {
        const engine = new CostEngine();
        const reservation = engine.createReservation({ taskId: "t1" }, 0.5);
        engine.markReservationUnresolved(reservation.id, { taskId: "t1" });

        expect(() => engine.releaseReservation(reservation.id, { taskId: "t1" })).toThrow(UnresolvedReconciliationError);
        expect(engine.reservedTotal({ taskId: "t1" })).toBe(0.5);
      });

      it("no regression: a corrected commitReservation() retry on the same id still works after markReservationUnresolved()", () => {
        const engine = new CostEngine();
        const reservation = engine.createReservation({ taskId: "t1" }, 0.5);
        engine.markReservationUnresolved(reservation.id, { taskId: "t1" });

        const recorded = engine.commitReservation(reservation.id, {
          taskId: "t1",
          provider: "mock",
          modelId: "m1",
          amountUsd: 0.5
        });

        expect(recorded.amountUsd).toBe(0.5);
        expect(engine.totalFor({ taskId: "t1" })).toBe(0.5);
        expect(engine.getReservation(reservation.id)).toBeUndefined(); // committed, removed
      });

      it("BLOCKER: rejects a caller whose supplied ownership does not match the reservation's own authoritative scope, and does not mutate the reservation", () => {
        const engine = new CostEngine();
        const reservation = engine.createReservation({ taskId: "t1", provider: "openai" }, 0.5);

        expect(() =>
          engine.markReservationUnresolved(reservation.id, { taskId: "t1", provider: "anthropic" })
        ).toThrow(ReservationOwnershipMismatchError);
        expect(engine.getReservation(reservation.id)?.status).toBe("ACTIVE"); // untouched
      });

      it("throws UnknownReservationError for a nonexistent or already-resolved id", () => {
        const engine = new CostEngine();
        expect(() => engine.markReservationUnresolved("never-existed", {})).toThrow(UnknownReservationError);

        const reservation = engine.createReservation({ taskId: "t1" }, 0.1);
        engine.releaseReservation(reservation.id, { taskId: "t1" });
        expect(() => engine.markReservationUnresolved(reservation.id, { taskId: "t1" })).toThrow(UnknownReservationError);
      });

      it("is idempotent: calling it twice on an already-RECONCILIATION_FAILED reservation is a safe no-op, not an error", () => {
        const engine = new CostEngine();
        const reservation = engine.createReservation({ taskId: "t1" }, 0.5);
        engine.markReservationUnresolved(reservation.id, { taskId: "t1" });

        expect(() => engine.markReservationUnresolved(reservation.id, { taskId: "t1" })).not.toThrow();
        expect(engine.getReservation(reservation.id)?.status).toBe("RECONCILIATION_FAILED");
        expect(engine.reservedTotal({ taskId: "t1" })).toBe(0.5);
      });
    }
  );

  describe(
    "P1 fix (34th independent review round, finding 1, 'check ownership before returning failed " +
      "reservations'): the idempotent-no-op branch for an already-RECONCILIATION_FAILED reservation must " +
      "never run before the ownership check — it must not hand a mismatched caller back the reservation's " +
      "authoritative scope",
    () => {
      it("BLOCKER regression, exact reproduction: caller B, merely knowing caller A's reservation id, cannot retrieve A's scope via a mismatched markReservationUnresolved() call on an already-RECONCILIATION_FAILED reservation", () => {
        const engine = new CostEngine();
        const reservation = engine.createReservation({ taskId: "t1", provider: "openai" }, 0.5);
        // Caller A (the genuine owner) legitimately marks it unresolved first.
        engine.markReservationUnresolved(reservation.id, { taskId: "t1", provider: "openai" });
        expect(engine.getReservation(reservation.id)?.status).toBe("RECONCILIATION_FAILED");

        // Caller B knows the reservation id but supplies a DIFFERENT scope
        // (never established any relationship to this reservation). The
        // call must be rejected as an ownership mismatch — NOT silently
        // succeed as an "idempotent no-op" that discloses A's true scope.
        expect(() =>
          engine.markReservationUnresolved(reservation.id, { taskId: "t1", provider: "anthropic" })
        ).toThrow(ReservationOwnershipMismatchError);
      });

      it("no regression: the genuine owner can still call markReservationUnresolved() idempotently on an already-RECONCILIATION_FAILED reservation with their own correct scope", () => {
        const engine = new CostEngine();
        const reservation = engine.createReservation({ taskId: "t1", provider: "openai" }, 0.5);
        engine.markReservationUnresolved(reservation.id, { taskId: "t1", provider: "openai" });

        const result = engine.markReservationUnresolved(reservation.id, { taskId: "t1", provider: "openai" });
        expect(result.status).toBe("RECONCILIATION_FAILED");
      });
    }
  );

  describe(
    "P1 fix (25th independent review round, 'reservation ownership must be validated inside CostEngine'): " +
      "commitReservation() itself (not only BudgetGuard, one layer above) must reject a commit whose supplied " +
      "ownership does not match the reservation's own authoritative scope",
    () => {
      it("BLOCKER regression, exact reproduction: reserve under project A, commit under project B is REJECTED at the ledger level", () => {
        const engine = new CostEngine();
        const reservation = engine.createReservation({ taskId: "a", projectId: "A" }, 0.6);

        expect(() =>
          engine.commitReservation(reservation.id, {
            taskId: "a",
            projectId: "B",
            provider: "mock",
            modelId: "m1",
            amountUsd: 0.6
          })
        ).toThrow(ReservationOwnershipMismatchError);

        // Project A's reservation is preserved (not deleted, not silently
        // committed under B's identity) — no cost was recorded for either project.
        expect(engine.totalFor({ projectId: "A" })).toBe(0);
        expect(engine.totalFor({ projectId: "B" })).toBe(0);
        expect(engine.reservedTotal({ projectId: "A" })).toBe(0.6);
        expect(engine.getReservation(reservation.id)?.status).toBe("RECONCILIATION_FAILED");
      });

      it("a caller talking directly to CostEngine (bypassing BudgetGuard entirely) is still rejected", () => {
        const engine = new CostEngine();
        // No BudgetGuard involved anywhere in this test — the reservation
        // owner is CostEngine itself, and the ownership check must hold
        // even for a caller with a bare CostEngine reference.
        const reservation = engine.createReservation({ taskId: "owner-task" }, 0.4);

        expect(() =>
          engine.commitReservation(reservation.id, {
            taskId: "attacker-task",
            provider: "mock",
            modelId: "m1",
            amountUsd: 0.4
          })
        ).toThrow(ReservationOwnershipMismatchError);

        expect(engine.totalFor({ taskId: "attacker-task" })).toBe(0);
        // The legitimate owner can still retry with the correct ownership afterward.
        const recorded = engine.commitReservation(reservation.id, {
          taskId: "owner-task",
          provider: "mock",
          modelId: "m1",
          amountUsd: 0.4
        });
        expect(recorded.taskId).toBe("owner-task");
      });
    }
  );

  describe(
    "P1 fix (25th independent review round, 'callers must not release someone else's active reservation'): " +
      "releaseReservation() itself (not only BudgetGuard) must reject a release whose supplied ownership does " +
      "not match the reservation's own authoritative scope — a reservation id alone is never sufficient",
    () => {
      it("BLOCKER regression, exact reproduction: caller B, knowing only caller A's reservation id, cannot release A's reservation", () => {
        const engine = new CostEngine();
        const reservationA = engine.createReservation({ taskId: "a", projectId: "A" }, 0.6);

        // Caller B supplies its OWN ownership (not A's) alongside A's
        // reservation id — the id alone must never be sufficient.
        expect(() =>
          engine.releaseReservation(reservationA.id, { taskId: "b", projectId: "B" })
        ).toThrow(ReservationOwnershipMismatchError);

        // A's reservation is untouched — safely still open and still
        // protecting its own capacity, unaffected by B's illegitimate attempt.
        expect(engine.getReservation(reservationA.id)).toBeDefined();
        expect(engine.reservedTotal({ projectId: "A" })).toBe(0.6);

        // A's own legitimate release (or commit) still works normally afterward.
        const released = engine.releaseReservation(reservationA.id, { taskId: "a", projectId: "A" });
        expect(released.amountUsd).toBe(0.6);
      });

      it("a release-ownership mismatch does NOT mark the reservation RECONCILIATION_FAILED (nothing was committed by the illegitimate attempt)", () => {
        const engine = new CostEngine();
        const reservation = engine.createReservation({ taskId: "owner" }, 0.3);

        expect(() => engine.releaseReservation(reservation.id, { taskId: "someone-else" })).toThrow(
          ReservationOwnershipMismatchError
        );

        // Unlike a commit() mismatch, the reservation remains plain ACTIVE
        // — the legitimate owner can still release it normally.
        expect(engine.getReservation(reservation.id)?.status).toBe("ACTIVE");
        expect(() => engine.releaseReservation(reservation.id, { taskId: "owner" })).not.toThrow();
      });
    }
  );

  describe(
    "P1 fix (26th independent review round, finding 3, 'reservation ownership evidence must not be forgeable'): " +
      "getReservation() no longer exposes the authoritative ownership scope — a caller cannot use it as " +
      "reconnaissance to forge sufficient authority for a later commit/release",
    () => {
      it(
        "BLOCKER regression, exact reproduction: caller B, knowing caller A's reservation id, cannot use " +
          "getReservation() to fetch A's ownership data and derive sufficient authority to release it",
        () => {
          const engine = new CostEngine();
          const reservationA = engine.createReservation({ taskId: "a", projectId: "A", agentId: "agent-a" }, 0.6);

          // Caller B knows (or predicts, since ids are sequential) A's
          // reservation id and tries to use the read-only lookup as
          // reconnaissance before attempting a release.
          const lookedUp = engine.getReservation(reservationA.id) as unknown as Record<string, unknown>;
          expect(lookedUp).toBeDefined();
          // The ownership-relevant scope is simply not present anywhere in
          // the returned object — there is nothing to copy out.
          expect(lookedUp.scope).toBeUndefined();
          expect("scope" in lookedUp).toBe(false);
          expect(Object.keys(lookedUp).sort()).toEqual(["amountUsd", "id", "status"]);

          // Even having fully inspected the lookup's result, caller B has
          // no scope to replay — any guess they construct without already
          // knowing A's real scope is rejected.
          expect(() => engine.releaseReservation(reservationA.id, { taskId: "b", projectId: "B", agentId: "agent-b" })).toThrow(
            ReservationOwnershipMismatchError
          );
          // A's reservation is untouched and still safely held by its real owner.
          expect(engine.getReservation(reservationA.id)?.status).toBe("ACTIVE");
          expect(() =>
            engine.releaseReservation(reservationA.id, { taskId: "a", projectId: "A", agentId: "agent-a" })
          ).not.toThrow();
        }
      );

      it("a mismatched release attempt's thrown error does not disclose the reservation's true authoritative scope", () => {
        const engine = new CostEngine();
        const reservation = engine.createReservation({ taskId: "owner-task", projectId: "owner-project", agentId: "owner-agent" }, 0.4);

        let releaseError: unknown;
        try {
          engine.releaseReservation(reservation.id, { taskId: "guess" });
        } catch (err) {
          releaseError = err;
        }
        expect(releaseError).toBeInstanceOf(ReservationOwnershipMismatchError);
        const releaseMessage = (releaseError as Error).message;
        expect(releaseMessage).not.toContain("owner-task");
        expect(releaseMessage).not.toContain("owner-project");
        expect(releaseMessage).not.toContain("owner-agent");
        // No other enumerable property on the error carries the true scope either.
        expect(JSON.stringify(releaseError)).not.toContain("owner-task");

        // A release mismatch does not mark the reservation failed — the
        // legitimate owner can still release it normally afterward,
        // proving the redacted message didn't weaken the real check.
        expect(() =>
          engine.releaseReservation(reservation.id, { taskId: "owner-task", projectId: "owner-project", agentId: "owner-agent" })
        ).not.toThrow();
      });

      it("a mismatched commit attempt's thrown error does not disclose the reservation's true authoritative scope", () => {
        const engine = new CostEngine();
        const reservation = engine.createReservation({ taskId: "owner-task", projectId: "owner-project", agentId: "owner-agent" }, 0.4);

        let commitError: unknown;
        try {
          engine.commitReservation(reservation.id, { taskId: "guess", provider: "mock", modelId: "m1", amountUsd: 0.4 });
        } catch (err) {
          commitError = err;
        }
        expect(commitError).toBeInstanceOf(ReservationOwnershipMismatchError);
        const commitMessage = (commitError as Error).message;
        expect(commitMessage).not.toContain("owner-task");
        expect(commitMessage).not.toContain("owner-project");
        expect(commitMessage).not.toContain("owner-agent");
        expect(JSON.stringify(commitError)).not.toContain("owner-task");

        // A commit mismatch DOES mark the reservation RECONCILIATION_FAILED
        // (a real provider call may already have happened) — the only safe
        // path forward is a corrected commit() retry with the real scope.
        const recorded = engine.commitReservation(reservation.id, {
          taskId: "owner-task",
          projectId: "owner-project",
          agentId: "owner-agent",
          provider: "mock",
          modelId: "m1",
          amountUsd: 0.4
        });
        expect(recorded.amountUsd).toBe(0.4);
      });

      it("getReservation() still exposes non-authorization-relevant diagnostic fields (id, amountUsd, status)", () => {
        const engine = new CostEngine();
        const reservation = engine.createReservation({ taskId: "t1" }, 1.25);
        const view = engine.getReservation(reservation.id);
        expect(view?.id).toBe(reservation.id);
        expect(view?.amountUsd).toBe(1.25);
        expect(view?.status).toBe("ACTIVE");
      });
    }
  );

  describe(
    "P1 fix (26th independent review round, finding 2, 'cost ledger state must be runtime-private'): the " +
      "internal entries array and reservations Map now use genuine ECMAScript #private fields, not TypeScript's " +
      "compile-time-only `private`",
    () => {
      it("the internal entries array is not reachable as an ordinary JS property (real encapsulation, not just TS `private`)", () => {
        const engine = new CostEngine();
        engine.record({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 1 });

        expect((engine as unknown as Record<string, unknown>).entries).toBeUndefined();
        expect((engine as unknown as Record<string, unknown>)["entries"]).toBeUndefined();
      });

      it("the internal reservations Map is not reachable as an ordinary JS property", () => {
        const engine = new CostEngine();
        engine.createReservation({ taskId: "t1" }, 1);

        expect((engine as unknown as Record<string, unknown>).reservations).toBeUndefined();
        expect((engine as unknown as Record<string, unknown>)["reservations"]).toBeUndefined();
      });

      it("no reflection API (Object.getOwnPropertyNames / Reflect.ownKeys) exposes the private entries array or reservations Map", () => {
        const engine = new CostEngine();
        engine.record({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 1 });
        engine.createReservation({ taskId: "t2" }, 1);

        expect(Object.getOwnPropertyNames(engine)).not.toContain("entries");
        expect(Object.getOwnPropertyNames(engine)).not.toContain("reservations");
        expect(Reflect.ownKeys(engine).map(String)).not.toContain("entries");
        expect(Reflect.ownKeys(engine).map(String)).not.toContain("reservations");
      });

      it("REGRESSION: a plain JS consumer cannot push a fabricated cost entry, delete a real one, or wipe the ledger via property access", () => {
        const engine = new CostEngine();
        engine.record({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 5 });

        const forgedEntries = (engine as unknown as Record<string, unknown>).entries as unknown[] | undefined;
        expect(forgedEntries).toBeUndefined(); // there is nothing to .push()/.splice() on at all

        // A forged object shaped like the class also finds nothing to attach to.
        const spread: Record<string, unknown> = { ...engine };
        expect(spread.entries).toBeUndefined();
        expect(spread.reservations).toBeUndefined();

        expect(engine.total()).toBe(5);
        expect(engine.all()).toHaveLength(1);
      });

      it("REGRESSION: a plain JS consumer cannot fabricate or delete an outstanding reservation via property access", () => {
        const engine = new CostEngine();
        const reservation = engine.createReservation({ taskId: "t1" }, 0.5);

        const forgedReservations = (engine as unknown as Record<string, unknown>).reservations as
          | Map<string, unknown>
          | undefined;
        expect(forgedReservations).toBeUndefined();

        expect(engine.getReservation(reservation.id)?.status).toBe("ACTIVE");
        expect(engine.reservedTotal({})).toBe(0.5);
      });
    }
  );

  describe(
    "P1 fix (27th independent review round, finding 8, 'require unforgeable reservation ownership'): the " +
      "reservation id itself is now the unguessable capability — a genuine randomBytes(16) suffix, not a " +
      "predictable sequential counter",
    () => {
      it("reservation ids are not sequential/predictable — they embed a genuinely random, high-entropy component", () => {
        const engine = new CostEngine();
        const ids = new Set<string>();
        for (let i = 0; i < 20; i++) {
          ids.add(engine.createReservation({ taskId: `t${i}` }, 0.01).id);
        }
        // 20 genuinely distinct ids, and none of them is merely "res-N" —
        // each carries a long random-hex suffix no attacker could predict
        // from having seen any other id.
        expect(ids.size).toBe(20);
        for (const id of ids) {
          expect(id).toMatch(/^res-\d+-[0-9a-f]{32}$/);
        }
      });

      it(
        "BLOCKER regression, exact reproduction: an unrelated caller who correctly guesses the SEQUENTIAL " +
          "portion of a reservation id (what the old id scheme was) still cannot construct the REAL id, and so " +
          "cannot operate a reservation it was never handed",
        () => {
          const engine = new CostEngine();
          const real = engine.createReservation({ taskId: "victim-task", projectId: "victim-project" }, 1);

          // The attacker knows (or predicts) the old, purely-sequential
          // scheme's equivalent — a small guess space of plausible ids —
          // and even correctly guesses the reservation's OWN scope (task/
          // project names are not secrets). None of these guesses is the
          // real, randomized id, so every one of them is rejected as
          // unknown before any ownership/scope comparison even applies.
          const guessedIds = ["res-1", "res-2", "res-3", `res-${real.id.split("-")[1]}`];
          for (const guess of guessedIds) {
            expect(guess).not.toBe(real.id);
            expect(() =>
              engine.commitReservation(guess, {
                taskId: "victim-task",
                projectId: "victim-project",
                provider: "mock",
                modelId: "m1",
                amountUsd: 1
              })
            ).toThrow(UnknownReservationError);
            expect(() =>
              engine.releaseReservation(guess, { taskId: "victim-task", projectId: "victim-project" })
            ).toThrow(UnknownReservationError);
          }

          // The real owner, holding the actual (unguessable) id, still
          // operates it normally.
          expect(() => engine.releaseReservation(real.id, { taskId: "victim-task", projectId: "victim-project" })).not.toThrow();
        }
      );

      it("no public method on CostEngine enumerates or otherwise discloses a reservation id that was not already handed to the caller", () => {
        const engine = new CostEngine();
        engine.createReservation({ taskId: "hidden" }, 0.5);

        // The only per-reservation-id read is getReservation(id), which
        // REQUIRES already knowing the id — there is no list()/all()-style
        // method for outstanding reservations (reservedTotal() only
        // returns an aggregate number, never individual ids/records).
        expect((engine as unknown as { listReservations?: unknown }).listReservations).toBeUndefined();
        expect((engine as unknown as { allReservations?: unknown }).allReservations).toBeUndefined();
        expect(typeof engine.reservedTotal({})).toBe("number");
      });
    }
  );

  describe(
    "P1 fix (28th independent review round, finding 4, 'persist cost entries and reservations across " +
      "restarts'): an optional persistence store makes committed spend and open reservations survive a genuine " +
      "restart (a fresh CostEngine instance backed by the same durable file)",
    () => {
      let tempRoot: string;

      it("committed spend genuinely survives a fresh CostEngine instance pointed at the same durable file (real restart proof, real FileStateStore, real temp directory)", () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-cost-engine-restart-"));
        try {
          const store = new FileStateStore();
          const statePath = join(tempRoot, "cost-state.json");

          const before = new CostEngine(() => new Date(), { store, path: statePath });
          before.record({ taskId: "t1", projectId: "p1", provider: "mock", modelId: "m1", amountUsd: 0.75 });
          before.record({ taskId: "t2", projectId: "p1", provider: "mock", modelId: "m1", amountUsd: 0.25 });
          expect(before.total()).toBeCloseTo(1.0);

          // A GENUINELY NEW instance — simulates a process restart. No
          // reference to `before` is shared; only the durable file path is.
          const after = new CostEngine(() => new Date(), { store, path: statePath });
          expect(after.total()).toBeCloseTo(1.0);
          expect(after.totalFor({ projectId: "p1" })).toBeCloseTo(1.0);
          expect(after.all()).toHaveLength(2);
        } finally {
          rmSync(tempRoot, { recursive: true, force: true });
        }
      });

      it("open ACTIVE reservations genuinely survive a restart, still protecting their capacity via reservedTotal()", () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-cost-engine-restart-reservation-"));
        try {
          const store = new FileStateStore();
          const statePath = join(tempRoot, "cost-state.json");

          const before = new CostEngine(() => new Date(), { store, path: statePath });
          const reservation = before.createReservation({ taskId: "t1", projectId: "p1" }, 0.4);

          const after = new CostEngine(() => new Date(), { store, path: statePath });
          expect(after.reservedTotal({ projectId: "p1" })).toBeCloseTo(0.4);

          // The restored reservation is genuinely operable — commit succeeds
          // under the SAME ownership scope it was created under.
          const recorded = after.commitReservation(reservation.id, {
            taskId: "t1",
            projectId: "p1",
            provider: "mock",
            modelId: "m1",
            amountUsd: 0.4
          });
          expect(recorded.amountUsd).toBeCloseTo(0.4);
          expect(after.reservedTotal({ projectId: "p1" })).toBe(0);
        } finally {
          rmSync(tempRoot, { recursive: true, force: true });
        }
      });

      it("a RECONCILIATION_FAILED reservation remains protected (still rejects release()) after a restart", () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-cost-engine-restart-reconciliation-"));
        try {
          const store = new FileStateStore();
          const statePath = join(tempRoot, "cost-state.json");

          const before = new CostEngine(() => new Date(), { store, path: statePath });
          const reservation = before.createReservation({ taskId: "t1" }, 1);
          // Force RECONCILIATION_FAILED via an ownership mismatch on commit.
          expect(() =>
            before.commitReservation(reservation.id, {
              taskId: "WRONG-TASK",
              provider: "mock",
              modelId: "m1",
              amountUsd: 1
            })
          ).toThrow(ReservationOwnershipMismatchError);

          const after = new CostEngine(() => new Date(), { store, path: statePath });
          expect(() => after.releaseReservation(reservation.id, { taskId: "t1" })).toThrow(UnresolvedReconciliationError);
          // Still protected — reservedTotal() still counts it.
          expect(after.reservedTotal({ taskId: "t1" })).toBeCloseTo(1);
        } finally {
          rmSync(tempRoot, { recursive: true, force: true });
        }
      });

      it("daily/monthly-style window totals (totalInWindow) survive a restart using the restored entries' real timestamps", () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-cost-engine-restart-window-"));
        try {
          const store = new FileStateStore();
          const statePath = join(tempRoot, "cost-state.json");
          const fixedNow = new Date("2024-06-15T12:00:00.000Z");

          const before = new CostEngine(() => fixedNow, { store, path: statePath });
          before.record({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 2 });

          const after = new CostEngine(() => new Date("2024-06-15T18:00:00.000Z"), { store, path: statePath });
          expect(after.totalInWindow({ taskId: "t1" }, "2024-06-15T00:00:00.000Z")).toBeCloseTo(2);
          // A window starting AFTER the restored entry's real timestamp
          // correctly excludes it — the restored timestamp is genuine, not
          // reset to "now" on restore.
          expect(after.totalInWindow({ taskId: "t1" }, "2024-06-15T13:00:00.000Z")).toBe(0);
        } finally {
          rmSync(tempRoot, { recursive: true, force: true });
        }
      });

      it("no persistence supplied at all preserves the exact prior in-memory-only behavior (backward compatible)", () => {
        const engine = new CostEngine();
        engine.record({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 1 });
        expect(engine.total()).toBe(1);
        // No store/path was ever touched — nothing to assert beyond "this
        // still works exactly as it always did."
      });

      it("malformed persisted cost state fails closed (CorruptCostStateError), never silently discarded or coerced", () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-cost-engine-corrupt-"));
        try {
          const store = new FileStateStore();
          const statePath = join(tempRoot, "cost-state.json");
          store.write(statePath, { entries: "not-an-array", reservations: [] });

          expect(() => new CostEngine(() => new Date(), { store, path: statePath })).toThrow(CorruptCostStateError);
        } finally {
          rmSync(tempRoot, { recursive: true, force: true });
        }
      });

      it.each([
        ["entries is missing", { reservations: [] }],
        ["reservations is missing", { entries: [] }],
        ["an entry has an invalid amountUsd", { entries: [{ taskId: "t", provider: "p", modelId: "m", amountUsd: NaN, timestamp: new Date().toISOString() }], reservations: [] }],
        ["an entry has a negative amountUsd", { entries: [{ taskId: "t", provider: "p", modelId: "m", amountUsd: -1, timestamp: new Date().toISOString() }], reservations: [] }],
        ["an entry is missing taskId", { entries: [{ provider: "p", modelId: "m", amountUsd: 1, timestamp: new Date().toISOString() }], reservations: [] }],
        ["an entry has an invalid timestamp", { entries: [{ taskId: "t", provider: "p", modelId: "m", amountUsd: 1, timestamp: "not-a-date" }], reservations: [] }],
        ["an entry has a Date.parse-able but non-canonical date-only timestamp", { entries: [{ taskId: "t", provider: "p", modelId: "m", amountUsd: 1, timestamp: "2024-01-15" }], reservations: [] }],
        ["an entry has a Date.parse-able but non-canonical space-separated timestamp", { entries: [{ taskId: "t", provider: "p", modelId: "m", amountUsd: 1, timestamp: "2024-01-15 10:00:00" }], reservations: [] }],
        ["an entry has a Date.parse-able but non-canonical timezone-offset timestamp", { entries: [{ taskId: "t", provider: "p", modelId: "m", amountUsd: 1, timestamp: "2024-01-15T10:00:00+05:00" }], reservations: [] }],
        ["a reservation has an invalid status", { entries: [], reservations: [{ id: "res-1-abc", scope: {}, amountUsd: 1, status: "MADE_UP_STATUS" }] }],
        ["a reservation has an invalid amountUsd", { entries: [], reservations: [{ id: "res-1-abc", scope: {}, amountUsd: Infinity, status: "ACTIVE" }] }],
        ["a reservation's scope is not an object", { entries: [], reservations: [{ id: "res-1-abc", scope: "not-an-object", amountUsd: 1, status: "ACTIVE" }] }],
        [
          "two reservations share the same id (round 31, finding 4)",
          {
            entries: [],
            reservations: [
              { id: "res-1-dup", scope: { taskId: "a" }, amountUsd: 1, status: "ACTIVE" },
              { id: "res-1-dup", scope: { taskId: "b" }, amountUsd: 2, status: "ACTIVE" }
            ]
          }
        ]
      ])("rejects malformed persisted state: %s", (_label, malformed) => {
        const fakeStore: StateStore = {
          write: () => {},
          read: () => malformed as never,
          exists: () => true
        };
        expect(() => new CostEngine(() => new Date(), { store: fakeStore, path: "irrelevant.json" })).toThrow(
          CorruptCostStateError
        );
      });

      it(
        "BLOCKER regression, exact reproduction (31st independent review round, finding 4, 'reject duplicate " +
          "reservation IDs during ledger restore'): a persisted ledger with two reservations sharing the same " +
          "id fails restoration entirely — neither reservation is silently discarded via Map overwrite",
        () => {
          const fakeStore: StateStore = {
            write: () => {},
            read: () =>
              ({
                entries: [],
                reservations: [
                  { id: "res-1-dup", scope: { taskId: "task-a" }, amountUsd: 0.5, status: "ACTIVE" },
                  { id: "res-1-dup", scope: { taskId: "task-b" }, amountUsd: 0.7, status: "ACTIVE" }
                ]
              }) as never,
            exists: () => true
          };

          expect(() => new CostEngine(() => new Date(), { store: fakeStore, path: "irrelevant.json" })).toThrow(
            CorruptCostStateError
          );
        }
      );

      it("a fresh, never-before-used persistence path (no file yet) starts with genuinely empty state, not an error", () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-cost-engine-fresh-"));
        try {
          const store = new FileStateStore();
          const statePath = join(tempRoot, "never-written.json");
          const engine = new CostEngine(() => new Date(), { store, path: statePath });
          expect(engine.total()).toBe(0);
          expect(engine.all()).toHaveLength(0);
        } finally {
          rmSync(tempRoot, { recursive: true, force: true });
        }
      });
    }
  );

  describe(
    "P1 fix (28th independent review round, finding 6, 'make cost ledger clock runtime-private'): #now is a " +
      "genuine ECMAScript private field, not TypeScript's compile-time-only `private readonly`",
    () => {
      it("now is not reachable as an ordinary JS property", () => {
        const engine = new CostEngine();
        expect((engine as unknown as Record<string, unknown>).now).toBeUndefined();
      });

      it("no reflection API exposes the private clock", () => {
        const engine = new CostEngine();
        expect(Object.getOwnPropertyNames(engine)).not.toContain("now");
        expect(Reflect.ownKeys(engine).map(String)).not.toContain("now");
      });

      it("REGRESSION: a forged clock replacement is an inert stray property — recorded timestamps still use the REAL injected clock", () => {
        const fixedNow = new Date("2024-01-01T00:00:00.000Z");
        const engine = new CostEngine(() => fixedNow);

        (engine as unknown as Record<string, unknown>).now = () => new Date("2099-01-01T00:00:00.000Z");
        const spread: Record<string, unknown> = { ...engine };
        expect(typeof spread.now).toBe("function"); // an inert stray property, nothing more

        engine.record({ taskId: "t", provider: "mock", modelId: "m1", amountUsd: 1 });
        const [entry] = engine.all();
        expect(entry!.timestamp).toBe(fixedNow.toISOString());
      });
    }
  );

  describe(
    "P1 fix (28th independent review round, finding 10, 'every failed commit must enter RECONCILIATION_FAILED'): " +
      "ANY failure while actually recording a commit — not only amount-validation failure — protects the " +
      "reservation",
    () => {
      /**
       * Fails ONLY the Nth write onward (1-indexed) — lets the test set up a
       * reservation normally (its own `createReservation()` persist succeeds)
       * before the SPECIFIC write inside `commitReservation()`'s `record()`
       * call is the one that fails.
       */
      function storeThatFailsFromWrite(failFromCall: number): StateStore {
        let calls = 0;
        return {
          write: () => {
            calls += 1;
            if (calls >= failFromCall) {
              throw new Error("simulated durable-storage I/O failure");
            }
          },
          read: () => undefined,
          exists: () => false
        };
      }

      it("BLOCKER regression: a failure from the underlying persistence layer during commitReservation() marks the reservation RECONCILIATION_FAILED, never leaving it ACTIVE-and-releasable", () => {
        const failingStore = storeThatFailsFromWrite(2); // 1st write: createReservation (succeeds); 2nd: commit's record() (fails)
        const engine = new CostEngine(() => new Date(), { store: failingStore, path: "irrelevant.json" });
        const reservation = engine.createReservation({ taskId: "t1" }, 1);

        expect(() =>
          engine.commitReservation(reservation.id, { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 1 })
        ).toThrow();

        // The reservation must NOT be silently releasable after this —
        // it is RECONCILIATION_FAILED, since the persistence failure
        // happened AFTER record()'s own in-memory push, so a real cost
        // may already be reflected in this process's own totals.
        expect(() => engine.releaseReservation(reservation.id, { taskId: "t1" })).toThrow(UnresolvedReconciliationError);
      });

      it("the reservation's protected capacity (reservedTotal) survives a recording failure unrelated to the amount", () => {
        const failingStore = storeThatFailsFromWrite(2);
        const engine = new CostEngine(() => new Date(), { store: failingStore, path: "irrelevant.json" });
        const reservation = engine.createReservation({ taskId: "t1" }, 1);

        expect(() =>
          engine.commitReservation(reservation.id, { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 1 })
        ).toThrow();

        expect(engine.reservedTotal({ taskId: "t1" })).toBeCloseTo(1);
      });

      it("an amount-validation failure (the pre-existing, narrower case) still marks RECONCILIATION_FAILED (no regression)", () => {
        const engine = new CostEngine();
        const reservation = engine.createReservation({ taskId: "t1" }, 1);

        expect(() =>
          engine.commitReservation(reservation.id, { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: NaN })
        ).toThrow(InvalidMonetaryAmountError);

        expect(() => engine.releaseReservation(reservation.id, { taskId: "t1" })).toThrow(UnresolvedReconciliationError);
      });

      it("a genuinely successful commit (no persistence configured) still deletes the reservation normally (no regression for the happy path)", () => {
        const engine = new CostEngine();
        const reservation = engine.createReservation({ taskId: "t1" }, 1);
        const recorded = engine.commitReservation(reservation.id, {
          taskId: "t1",
          provider: "mock",
          modelId: "m1",
          amountUsd: 1
        });
        expect(recorded.amountUsd).toBe(1);
        expect(engine.reservedTotal({ taskId: "t1" })).toBe(0);
      });
    }
  );

  describe(
    "P1 fix (29th independent review round, finding 1, 'make persisted cost commits atomic/idempotent'): " +
      "retrying commitReservation() after a persistence failure never records the same real cost twice",
    () => {
      /**
       * A real, working in-memory StateStore whose `write()` throws on ONE
       * specific call number (1-indexed across the store's lifetime), then
       * behaves normally (actually durably storing the value) on every
       * other call — lets a test simulate "the Nth write attempt hit a
       * transient I/O failure" while still supporting a genuine retry that
       * succeeds afterward, and a genuine restart read-back.
       */
      function storeThatFailsOnceOnCall(failOnCall: number): StateStore {
        let calls = 0;
        const data = new Map<string, unknown>();
        return {
          write: (path, value) => {
            calls += 1;
            if (calls === failOnCall) {
              throw new Error("simulated transient durable-storage I/O failure");
            }
            data.set(path, value);
          },
          read: <T>(path: string) => data.get(path) as T | undefined,
          exists: (path) => data.has(path)
        };
      }

      it("BLOCKER regression, exact reproduction: provider incurs cost -> persistence fails -> retry reconciliation -> final committed amount appears EXACTLY ONCE", () => {
        // 1st write: createReservation (succeeds). 2nd write: the FIRST
        // commitReservation() attempt's internal record() persist (fails —
        // simulating "provider incurred cost, but writing that down failed").
        const store = storeThatFailsOnceOnCall(2);
        const engine = new CostEngine(() => new Date(), { store, path: "cost-state.json" });
        const reservation = engine.createReservation({ taskId: "t1" }, 1);

        // First attempt: record() pushes the entry in-memory, its own
        // persist() throws, commitReservation()'s catch marks
        // RECONCILIATION_FAILED and its own persist() (the 3rd write call)
        // succeeds this time — durable state already reflects the entry.
        expect(() =>
          engine.commitReservation(reservation.id, { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 1 })
        ).toThrow();

        // Retry reconciliation on the SAME reservation id, exactly as
        // UnresolvedReconciliationError's own message instructs.
        const recorded = engine.commitReservation(reservation.id, {
          taskId: "t1",
          provider: "mock",
          modelId: "m1",
          amountUsd: 1
        });
        expect(recorded.amountUsd).toBe(1);

        // The real cost was recorded EXACTLY ONCE — not twice.
        const matching = engine.all().filter((e) => e.taskId === "t1" && e.provider === "mock");
        expect(matching).toHaveLength(1);
        expect(engine.total()).toBe(1);
        expect(engine.reservedTotal({ taskId: "t1" })).toBe(0);
      });

      it("a retry after the reservation-REMOVAL step (not the record() step) failed is also idempotent, not a double record", () => {
        // 1st write: createReservation (succeeds). 2nd write: record()'s
        // OWN persist (succeeds — the cost is durably recorded). 3rd
        // write: commitReservation()'s post-record() reservation-deletion
        // persist (fails) — the reservation lingers even though its cost
        // was already durably recorded.
        const store = storeThatFailsOnceOnCall(3);
        const engine = new CostEngine(() => new Date(), { store, path: "cost-state.json" });
        const reservation = engine.createReservation({ taskId: "t1" }, 1);

        expect(() =>
          engine.commitReservation(reservation.id, { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 1 })
        ).toThrow();

        // A caller retrying on the still-lingering reservation id must get
        // back the SAME already-recorded entry, not a fresh duplicate.
        const recorded = engine.commitReservation(reservation.id, {
          taskId: "t1",
          provider: "mock",
          modelId: "m1",
          amountUsd: 1
        });
        expect(recorded.amountUsd).toBe(1);
        expect(engine.all().filter((e) => e.taskId === "t1")).toHaveLength(1);
        expect(engine.reservedTotal({ taskId: "t1" })).toBe(0);
      });

      it("restart proof: after the retry resolves, a FRESH CostEngine instance restored from the same durable store shows the cost exactly once and no lingering reservation", () => {
        const store = storeThatFailsOnceOnCall(2);
        const engine = new CostEngine(() => new Date(), { store, path: "cost-state.json" });
        const reservation = engine.createReservation({ taskId: "t1" }, 1);

        expect(() =>
          engine.commitReservation(reservation.id, { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 1 })
        ).toThrow();
        engine.commitReservation(reservation.id, { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 1 });

        // Simulate a real process restart: a brand new CostEngine instance
        // pointed at the SAME durable store/path.
        const restarted = new CostEngine(() => new Date(), { store, path: "cost-state.json" });
        expect(restarted.all().filter((e) => e.taskId === "t1")).toHaveLength(1);
        expect(restarted.total()).toBe(1);
        expect(restarted.reservedTotal({ taskId: "t1" })).toBe(0);
      });

      it("retrying a call whose reservation truly never recorded anything (record() never succeeded even once) still goes through the normal path and records exactly once", () => {
        const engine = new CostEngine();
        const reservation = engine.createReservation({ taskId: "t1" }, 1);
        const recorded = engine.commitReservation(reservation.id, {
          taskId: "t1",
          provider: "mock",
          modelId: "m1",
          amountUsd: 1
        });
        expect(recorded.amountUsd).toBe(1);
        expect(engine.all()).toHaveLength(1);
      });
    }
  );

  describe(
    "P1 fix (30th independent review round, finding 2, 'persist reservation deletion on idempotent retry'): " +
      "a retry must repair durable state even when the reservation is already absent from the in-memory map",
    () => {
      function storeThatFailsOnceOnCall(failOnCall: number): StateStore {
        let calls = 0;
        const data = new Map<string, unknown>();
        return {
          write: (path, value) => {
            calls += 1;
            if (calls === failOnCall) {
              throw new Error("simulated transient durable-storage I/O failure");
            }
            data.set(path, value);
          },
          read: <T>(path: string) => data.get(path) as T | undefined,
          exists: (path) => data.has(path)
        };
      }

      it(
        "BLOCKER regression, exact reproduction: commit succeeds in memory -> persistence of reservation " +
          "removal fails -> retry -> restart -> committed cost exists exactly once, reservation does NOT reappear",
        () => {
          // 1st write: createReservation (succeeds). 2nd write: record()'s own
          // persist (succeeds — the cost is durably recorded). 3rd write:
          // commitReservation()'s post-record() reservation-deletion persist
          // (fails) — in-memory the reservation Map entry is ALREADY deleted
          // by this point (bkz. commitReservation()'s own code), but the
          // durable file was never updated to reflect that.
          const store = storeThatFailsOnceOnCall(3);
          const engine = new CostEngine(() => new Date(), { store, path: "cost-state.json" });
          const reservation = engine.createReservation({ taskId: "t1" }, 1);

          expect(() =>
            engine.commitReservation(reservation.id, { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 1 })
          ).toThrow();

          // Retry on the same reservation id, exactly as documented.
          engine.commitReservation(reservation.id, { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 1 });

          // Without the fix, the retry's idempotency check finds the entry
          // already recorded but sees `#reservations` already lacks the id
          // in memory, so it never re-persists — the durable file is left
          // forever stale, still showing the reservation as present.
          // Simulate a real process restart: a brand new CostEngine instance
          // pointed at the SAME durable store/path must NOT resurrect it.
          const restarted = new CostEngine(() => new Date(), { store, path: "cost-state.json" });
          expect(restarted.all().filter((e) => e.taskId === "t1")).toHaveLength(1);
          expect(restarted.total()).toBe(1);
          expect(restarted.reservedTotal({ taskId: "t1" })).toBe(0);
          expect(restarted.getReservation(reservation.id)).toBeUndefined();
        }
      );

      it("a SECOND retry (durable state already correct) is a safe no-op, not a fresh write attempt", () => {
        const store = storeThatFailsOnceOnCall(3);
        const engine = new CostEngine(() => new Date(), { store, path: "cost-state.json" });
        const reservation = engine.createReservation({ taskId: "t1" }, 1);

        expect(() =>
          engine.commitReservation(reservation.id, { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 1 })
        ).toThrow();
        engine.commitReservation(reservation.id, { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 1 });

        // A further retry after durable state is already repaired must stay idempotent.
        const recorded = engine.commitReservation(reservation.id, {
          taskId: "t1",
          provider: "mock",
          modelId: "m1",
          amountUsd: 1
        });
        expect(recorded.amountUsd).toBe(1);
        expect(engine.all().filter((e) => e.taskId === "t1")).toHaveLength(1);
      });
    }
  );

  describe(
    "P1 fix (30th independent review round, finding 3, 'serialize persistent cost-ledger updates'): two " +
      "CostEngine instances sharing the same persisted path must not overwrite each other's newer durable state",
    () => {
      let tempRoot: string;

      afterEach(() => {
        if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
      });

      it(
        "BLOCKER regression, exact reproduction: A records cost/reservation, B (constructed from an older " +
          "snapshot) also writes -> A's data MUST remain, B's data MUST also remain",
        () => {
          tempRoot = mkdtempSync(join(tmpdir(), "uasf-cost-engine-concurrent-"));
          const store = new FileStateStore();
          const statePath = join(tempRoot, "cost-state.json");

          // Both instances are constructed from the SAME (empty) starting
          // snapshot — exactly the scenario where a naive "overwrite the
          // whole file with my own in-memory copy" implementation loses
          // whichever instance writes SECOND.
          const engineA = new CostEngine(() => new Date(), { store, path: statePath });
          const engineB = new CostEngine(() => new Date(), { store, path: statePath });

          engineA.record({ taskId: "a", provider: "mock", modelId: "m1", amountUsd: 1 });
          // Without the fix, this second write (from B, which never saw A's
          // write) would silently ERASE A's already-durably-recorded entry.
          engineB.record({ taskId: "b", provider: "mock", modelId: "m1", amountUsd: 2 });

          // A genuinely fresh THIRD instance, reading the final durable
          // state, must see BOTH entries — neither was lost.
          const engineC = new CostEngine(() => new Date(), { store, path: statePath });
          expect(engineC.all().map((e) => e.taskId).sort()).toEqual(["a", "b"]);
          expect(engineC.total()).toBe(3);
        }
      );

      it("reservations from two instances sharing the same durable path also both survive", () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-cost-engine-concurrent-reservations-"));
        const store = new FileStateStore();
        const statePath = join(tempRoot, "cost-state.json");

        const engineA = new CostEngine(() => new Date(), { store, path: statePath });
        const engineB = new CostEngine(() => new Date(), { store, path: statePath });

        const reservationA = engineA.createReservation({ taskId: "a" }, 0.5);
        const reservationB = engineB.createReservation({ taskId: "b" }, 0.5);

        const engineC = new CostEngine(() => new Date(), { store, path: statePath });
        expect(engineC.getReservation(reservationA.id)).toBeDefined();
        expect(engineC.getReservation(reservationB.id)).toBeDefined();
        expect(engineC.reservedTotal({})).toBe(1);
      });

      it("a commit on one instance does not lose a plain record() already durably written by a sibling instance", () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-cost-engine-concurrent-commit-"));
        const store = new FileStateStore();
        const statePath = join(tempRoot, "cost-state.json");

        const engineA = new CostEngine(() => new Date(), { store, path: statePath });
        const engineB = new CostEngine(() => new Date(), { store, path: statePath });

        engineA.record({ taskId: "a", provider: "mock", modelId: "m1", amountUsd: 1 });
        const reservationB = engineB.createReservation({ taskId: "b" }, 1);
        engineB.commitReservation(reservationB.id, { taskId: "b", provider: "mock", modelId: "m1", amountUsd: 1 });

        const engineC = new CostEngine(() => new Date(), { store, path: statePath });
        expect(engineC.total()).toBe(2);
        expect(engineC.all().map((e) => e.taskId).sort()).toEqual(["a", "b"]);
      });
    }
  );

  describe(
    "P1 fix (29th independent review round, finding 6, 'persisted cost timestamps must be canonical'): a " +
      "restored timestamp must exactly match Date.prototype.toISOString()'s own canonical format, not merely " +
      "be Date.parse-able",
    () => {
      let tempRoot: string;

      function fakeStoreWithData(data: unknown): StateStore {
        return { write: () => {}, read: () => data as never, exists: () => true };
      }

      it("BLOCKER regression, exact reproduction: a Date.parse-able but non-canonical timestamp representing TODAY must not silently disappear from daily-window accounting", () => {
        // "2024-06-15" (date-only) is genuinely Date.parse-able and refers
        // to a real moment within the "2024-06-15" UTC day window, but its
        // STRING form sorts lexically BEFORE "2024-06-15T00:00:00.000Z"
        // (the canonical form totalInWindow()'s string comparison expects)
        // — before this fix, such an entry could be silently excluded from
        // a same-day window query despite being real, already-incurred
        // spend within that exact day.
        const malformed = fakeStoreWithData({
          entries: [{ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 5, timestamp: "2024-06-15" }],
          reservations: []
        });
        expect(() => new CostEngine(() => new Date(), { store: malformed, path: "irrelevant.json" })).toThrow(
          CorruptCostStateError
        );
      });

      it.each([
        ["date-only, no time component", "2024-06-15"],
        ["space separator instead of 'T'", "2024-06-15 10:00:00.000Z"],
        ["timezone offset instead of 'Z'", "2024-06-15T10:00:00.000+00:00"],
        ["missing milliseconds", "2024-06-15T10:00:00Z"],
        ["completely unparseable garbage", "not-a-real-timestamp"]
      ])("rejects a non-canonical timestamp: %s", (_label, timestamp) => {
        const malformed = fakeStoreWithData({
          entries: [{ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 1, timestamp }],
          reservations: []
        });
        expect(() => new CostEngine(() => new Date(), { store: malformed, path: "irrelevant.json" })).toThrow(
          CorruptCostStateError
        );
      });

      it("accepts the EXACT canonical form Date.prototype.toISOString() itself always produces (no false positives)", () => {
        const canonical = new Date("2024-06-15T10:00:00.000Z").toISOString();
        const valid = fakeStoreWithData({
          entries: [{ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 1, timestamp: canonical }],
          reservations: []
        });
        const engine = new CostEngine(() => new Date(), { store: valid, path: "irrelevant.json" });
        expect(engine.total()).toBe(1);
      });

      it("restart proof: a genuinely canonical persisted timestamp correctly survives restart and remains inside its real daily window", () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-cost-engine-canonical-ts-"));
        try {
          const store = new FileStateStore();
          const statePath = join(tempRoot, "cost-state.json");
          const fixedNow = new Date("2024-06-15T12:00:00.000Z");
          const engine = new CostEngine(() => fixedNow, { store, path: statePath });
          engine.record({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 3 });

          const restarted = new CostEngine(() => new Date(), { store, path: statePath });
          // The restored, canonical timestamp is genuinely inside its own UTC day window.
          expect(restarted.totalInWindow({ taskId: "t1" }, "2024-06-15T00:00:00.000Z")).toBeCloseTo(3);
          // ...and genuinely outside the NEXT day's window.
          expect(restarted.totalInWindow({ taskId: "t1" }, "2024-06-16T00:00:00.000Z")).toBe(0);
        } finally {
          rmSync(tempRoot, { recursive: true, force: true });
        }
      });
    }
  );

  describe("P1 fix (32nd independent review round, finding 1, \"reservation id must not be caller-forgeable\")", () => {
    it("BLOCKER: a forged reservationId passed to the public record() cannot satisfy a real, later reservation commit", () => {
      const engine = new CostEngine();
      const reservation = engine.createReservation({ taskId: "t1", provider: "mock", modelId: "m1" }, 1);

      // Attacker (or any ordinary direct caller, since record() bypassing
      // BudgetGuard is an explicitly supported path) attempts to forge a
      // $0 entry claiming it already satisfies the real, still-open $1
      // reservation, by supplying the reservation's own real id.
      // `reservationId` is intentionally not part of record()'s public
      // parameter type — `as never` simulates a caller who bypasses the
      // type system (as any / plain JS) to attempt the forgery anyway.
      engine.record({
        taskId: "attacker-task",
        provider: "mock",
        modelId: "m1",
        amountUsd: 0,
        reservationId: reservation.id
      } as never);

      // The real reservation must still be open and unaffected by the forgery.
      expect(engine.getReservation(reservation.id)?.status).toBe("ACTIVE");
      expect(engine.reservedTotal({ taskId: "t1" })).toBe(1);

      // The actual provider cost must still be reconcilable through the
      // real commit path — it must NOT find the forged entry and treat the
      // reservation as already committed.
      const recorded = engine.commitReservation(reservation.id, {
        taskId: "t1",
        provider: "mock",
        modelId: "m1",
        amountUsd: 0.95
      });
      expect(recorded.amountUsd).toBe(0.95);
      expect(recorded.reservationId).toBe(reservation.id);
      expect(engine.getReservation(reservation.id)).toBeUndefined();
      // Total reflects the forged $0 entry (an ordinary, validly-recorded,
      // reservationId-less cost entry — record() itself is still a
      // legitimate direct-recording path) PLUS the real $0.95 commit.
      expect(engine.total()).toBeCloseTo(0.95);
    });

    it("BLOCKER: record() never attaches a reservationId even if a caller-owned object exposes one via a getter", () => {
      const engine = new CostEngine();
      const reservation = engine.createReservation({ taskId: "t1", provider: "mock", modelId: "m1" }, 1);
      const forgedEntry = {
        taskId: "attacker-task",
        provider: "mock",
        modelId: "m1",
        amountUsd: 0
      };
      Object.defineProperty(forgedEntry, "reservationId", {
        enumerable: true,
        get: () => reservation.id
      });
      const recorded = engine.record(forgedEntry as never);
      expect(recorded.reservationId).toBeUndefined();
      expect(engine.getReservation(reservation.id)?.status).toBe("ACTIVE");
    });

    it("no regression: a genuine commitReservation() retry on the SAME id remains idempotent", () => {
      const engine = new CostEngine();
      const reservation = engine.createReservation({ taskId: "t1", provider: "mock", modelId: "m1" }, 1);
      const first = engine.commitReservation(reservation.id, {
        taskId: "t1",
        provider: "mock",
        modelId: "m1",
        amountUsd: 0.5
      });
      const retry = engine.commitReservation(reservation.id, {
        taskId: "t1",
        provider: "mock",
        modelId: "m1",
        amountUsd: 0.5
      });
      expect(retry.timestamp).toBe(first.timestamp);
      expect(engine.total()).toBeCloseTo(0.5);
      expect(engine.all().filter((e) => e.reservationId === reservation.id)).toHaveLength(1);
    });

    describe(
      "P1 fix (34th independent review round, finding 7, 'validate idempotent retries before returning " +
        "authoritative entry'): the 'already committed' idempotency branch must not hand back the authoritative " +
        "entry to a caller whose own retry does not match it",
      () => {
        it("BLOCKER regression, exact reproduction: a 'retry' presenting a DIFFERENT scope (provider) than the genuinely committed entry is rejected, not handed the real entry", () => {
          const engine = new CostEngine();
          const reservation = engine.createReservation({ taskId: "t1", provider: "openai", modelId: "m1" }, 0.5);
          engine.commitReservation(reservation.id, {
            taskId: "t1",
            provider: "openai",
            modelId: "m1",
            amountUsd: 0.5
          });

          expect(() =>
            engine.commitReservation(reservation.id, {
              taskId: "t1",
              provider: "anthropic",
              modelId: "m1",
              amountUsd: 0.5
            })
          ).toThrow(ReservationOwnershipMismatchError);
          // The genuinely committed entry is untouched.
          expect(engine.total()).toBeCloseTo(0.5);
          expect(engine.all().filter((e) => e.reservationId === reservation.id)).toHaveLength(1);
        });

        it("BLOCKER regression: a 'retry' presenting a DIFFERENT amount than the genuinely committed entry is rejected", () => {
          const engine = new CostEngine();
          const reservation = engine.createReservation({ taskId: "t1", provider: "mock", modelId: "m1" }, 1);
          engine.commitReservation(reservation.id, {
            taskId: "t1",
            provider: "mock",
            modelId: "m1",
            amountUsd: 0.5
          });

          expect(() =>
            engine.commitReservation(reservation.id, {
              taskId: "t1",
              provider: "mock",
              modelId: "m1",
              amountUsd: 0.9
            })
          ).toThrow(ReservationOwnershipMismatchError);
          expect(engine.total()).toBeCloseTo(0.5);
        });

        it("no regression: a genuine retry with the EXACT SAME scope and amount still returns the authoritative entry idempotently", () => {
          const engine = new CostEngine();
          const reservation = engine.createReservation({ taskId: "t1", provider: "mock", modelId: "m1", agentId: "a1", runId: "r1" }, 1);
          const first = engine.commitReservation(reservation.id, {
            taskId: "t1",
            provider: "mock",
            modelId: "m1",
            agentId: "a1",
            runId: "r1",
            amountUsd: 0.5
          });
          const retry = engine.commitReservation(reservation.id, {
            taskId: "t1",
            provider: "mock",
            modelId: "m1",
            agentId: "a1",
            runId: "r1",
            amountUsd: 0.5
          });
          expect(retry).toEqual(first);
        });
      }
    );

    it("no regression: an ordinary direct record() call (no reservation involved at all) is unaffected", () => {
      const engine = new CostEngine();
      const entry = engine.record({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 0.25 });
      expect(entry.amountUsd).toBe(0.25);
      expect(entry.reservationId).toBeUndefined();
      expect(engine.total()).toBeCloseTo(0.25);
    });
  });

  describe(
    "P2 fix (36th independent review round, finding 11, 'roll back ledger mutations when persistence " +
      "fails'): a mutating method whose durable write fails must leave in-memory state EXACTLY as it was " +
      "before the call — never mutated-then-abandoned — so RAM and disk never disagree and a retry is safe",
    () => {
      /** Fails on exactly the Nth write call (1-indexed); every other call succeeds. */
      function storeThatFailsOnlyOnCall(failOnCall: number): StateStore {
        let calls = 0;
        return {
          write: () => {
            calls += 1;
            if (calls === failOnCall) {
              throw new Error("simulated durable-storage I/O failure");
            }
          },
          read: () => undefined,
          exists: () => false
        };
      }

      /** Fails on every write call from the Nth one onward (1-indexed). */
      function storeThatFailsFromCall(failFromCall: number): StateStore {
        let calls = 0;
        return {
          write: () => {
            calls += 1;
            if (calls >= failFromCall) {
              throw new Error("simulated durable-storage I/O failure");
            }
          },
          read: () => undefined,
          exists: () => false
        };
      }

      it("BLOCKER regression, exact reproduction: record() whose persist fails leaves total()/all() completely unchanged, not showing a phantom cost", () => {
        const engine = new CostEngine(() => new Date(), { store: storeThatFailsOnlyOnCall(1), path: "x.json" });
        expect(() => engine.record({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 5 })).toThrow(
          "simulated durable-storage I/O failure"
        );
        expect(engine.all()).toHaveLength(0);
        expect(engine.total()).toBe(0);
      });

      it("BLOCKER regression, exact reproduction: createReservation() whose persist fails leaves reservedTotal() completely unchanged, not showing a phantom reservation", () => {
        const engine = new CostEngine(() => new Date(), { store: storeThatFailsOnlyOnCall(1), path: "x.json" });
        expect(() => engine.createReservation({ taskId: "t1" }, 5)).toThrow("simulated durable-storage I/O failure");
        expect(engine.reservedTotal({ taskId: "t1" })).toBe(0);
      });

      it(
        "BLOCKER regression, exact reproduction: releaseReservation() whose persist fails leaves the " +
          "reservation genuinely ACTIVE and still protecting its capacity — not silently freed in memory " +
          "while disk still shows it reserved",
        () => {
          // Call 1: createReservation (succeeds). Call 2: releaseReservation's own persist (fails).
          const engine = new CostEngine(() => new Date(), { store: storeThatFailsFromCall(2), path: "x.json" });
          const reservation = engine.createReservation({ taskId: "t1" }, 1);

          expect(() => engine.releaseReservation(reservation.id, { taskId: "t1" })).toThrow(
            "simulated durable-storage I/O failure"
          );

          // Rolled back: the reservation was NEVER actually removed from memory.
          expect(engine.getReservation(reservation.id)).toEqual({ id: reservation.id, amountUsd: 1, status: "ACTIVE" });
          expect(engine.reservedTotal({ taskId: "t1" })).toBe(1);
        }
      );

      it(
        "BLOCKER regression, exact reproduction: a commitReservation() whose cost is durably recorded but " +
          "whose FOLLOW-UP reservation-removal persist fails leaves the reservation genuinely present " +
          "(rolled back) rather than silently vanished from memory while still on disk — and a retry " +
          "safely finishes the job once persistence recovers",
        () => {
          // Call 1: createReservation. Call 2: commitReservation's own record() persist (succeeds — the
          // cost IS durably recorded). Call 3: the reservation-removal persist that follows (fails).
          const engine = new CostEngine(() => new Date(), { store: storeThatFailsOnlyOnCall(3), path: "x.json" });
          const reservation = engine.createReservation({ taskId: "t1" }, 1);
          const entry = { taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 1 };

          expect(() => engine.commitReservation(reservation.id, entry)).toThrow("simulated durable-storage I/O failure");

          // The real cost WAS durably recorded (record()'s own persist, call 2, succeeded).
          expect(engine.total()).toBeCloseTo(1);
          // But the reservation-removal itself rolled back — it is still genuinely
          // present (not silently vanished from memory while disk disagrees).
          expect(engine.getReservation(reservation.id)).toBeDefined();
          expect(engine.reservedTotal({ taskId: "t1" })).toBeCloseTo(1);

          // Retrying the SAME commitReservation() call (call 4 — persistence now
          // recovered) finishes the interrupted removal via the existing
          // idempotent-retry path, without double-recording the cost.
          const retried = engine.commitReservation(reservation.id, entry);
          expect(retried.amountUsd).toBeCloseTo(1);
          expect(engine.total()).toBeCloseTo(1);
          expect(engine.getReservation(reservation.id)).toBeUndefined();
        }
      );

      it("no regression: an ordinary record() with a healthy persistence store still records and persists normally", () => {
        const tempRoot = mkdtempSync(join(tmpdir(), "uasf-cost-engine-publish-no-regression-"));
        try {
          const store = new FileStateStore();
          const statePath = join(tempRoot, "cost-state.json");
          const engine = new CostEngine(() => new Date(), { store, path: statePath });
          engine.record({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 2 });
          expect(engine.total()).toBeCloseTo(2);

          const after = new CostEngine(() => new Date(), { store, path: statePath });
          expect(after.total()).toBeCloseTo(2);
        } finally {
          rmSync(tempRoot, { recursive: true, force: true });
        }
      });

      it("no regression: an in-memory-only engine (no persistence configured) is entirely unaffected — record()/createReservation() still work exactly as before", () => {
        const engine = new CostEngine();
        engine.record({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 1 });
        const reservation = engine.createReservation({ taskId: "t2" }, 2);
        expect(engine.total()).toBeCloseTo(1);
        expect(engine.reservedTotal({ taskId: "t2" })).toBeCloseTo(2);
        expect(() => engine.releaseReservation(reservation.id, { taskId: "t2" })).not.toThrow();
        expect(engine.reservedTotal({ taskId: "t2" })).toBe(0);
      });
    }
  );

  describe(
    "P1 fix (independent Codex review, 'refresh durable cost ledger state before authoritative reads'): " +
      "a persistent/shared CostEngine's authoritative reads must observe the latest durable ledger state, " +
      "not a stale construction-time or last-own-mutation snapshot",
    () => {
      it(
        "BLOCKER regression, exact reproduction: Engine A and Engine B share the same persistence file; A " +
          "records cost; WITHOUT B performing any mutation of its own, B's total()/totalFor() must observe " +
          "A's already-persisted cost",
        () => {
          const tempRoot = mkdtempSync(join(tmpdir(), "uasf-cost-engine-durable-read-"));
          try {
            const store = new FileStateStore();
            const statePath = join(tempRoot, "cost-state.json");
            const engineA = new CostEngine(() => new Date(), { store, path: statePath });
            const engineB = new CostEngine(() => new Date(), { store, path: statePath });

            expect(engineB.total()).toBe(0);

            engineA.record({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 3 });

            // B never mutated anything — the OLD behavior would have kept
            // returning B's stale, empty-looking construction-time snapshot.
            expect(engineB.total()).toBeCloseTo(3);
            expect(engineB.totalFor({ taskId: "t1" })).toBeCloseTo(3);
            expect(engineB.all()).toHaveLength(1);
          } finally {
            rmSync(tempRoot, { recursive: true, force: true });
          }
        }
      );

      it(
        "BLOCKER regression: a budget precheck reading reservedTotal()/getReservation() on Engine B must see " +
          "a reservation Engine A already durably created",
        () => {
          const tempRoot = mkdtempSync(join(tmpdir(), "uasf-cost-engine-durable-read-reservation-"));
          try {
            const store = new FileStateStore();
            const statePath = join(tempRoot, "cost-state.json");
            const engineA = new CostEngine(() => new Date(), { store, path: statePath });
            const engineB = new CostEngine(() => new Date(), { store, path: statePath });

            expect(engineB.reservedTotal({ taskId: "shared-task" })).toBe(0);
            const reservation = engineA.createReservation({ taskId: "shared-task" }, 5);

            expect(engineB.reservedTotal({ taskId: "shared-task" })).toBeCloseTo(5);
            expect(engineB.getReservation(reservation.id)?.status).toBe("ACTIVE");
          } finally {
            rmSync(tempRoot, { recursive: true, force: true });
          }
        }
      );

      it("no-regression: totalInWindow() on Engine B also observes Engine A's already-persisted spend", () => {
        const tempRoot = mkdtempSync(join(tmpdir(), "uasf-cost-engine-durable-read-window-"));
        try {
          const store = new FileStateStore();
          const statePath = join(tempRoot, "cost-state.json");
          const fixedNow = new Date("2024-06-01T00:00:00.000Z");
          const engineA = new CostEngine(() => fixedNow, { store, path: statePath });
          const engineB = new CostEngine(() => fixedNow, { store, path: statePath });

          engineA.record({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 1.5 });

          expect(engineB.totalInWindow({ taskId: "t1" }, "2024-01-01T00:00:00.000Z")).toBeCloseTo(1.5);
        } finally {
          rmSync(tempRoot, { recursive: true, force: true });
        }
      });

      it("no-regression: an in-memory-only engine's reads still work exactly as before (no persistence configured, nothing to refresh from)", () => {
        const engine = new CostEngine();
        engine.record({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 1 });
        expect(engine.total()).toBeCloseTo(1);
        expect(engine.all()).toHaveLength(1);
        expect(engine.totalInWindow({ taskId: "t1" }, "2000-01-01T00:00:00.000Z")).toBeCloseTo(1);
      });

      it("no-regression: reads called from WITHIN an existing withLedgerLock() transaction still see that transaction's own already-reloaded snapshot (no double-lock, no re-entrant deadlock)", () => {
        const tempRoot = mkdtempSync(join(tmpdir(), "uasf-cost-engine-durable-read-reentrant-"));
        try {
          const store = new FileStateStore();
          const statePath = join(tempRoot, "cost-state.json");
          const engine = new CostEngine(() => new Date(), { store, path: statePath });
          engine.record({ taskId: "t1", provider: "mock", modelId: "m1", amountUsd: 4 });

          const result = engine.withLedgerLock(() => {
            // Nested authoritative reads inside an already-held lock must
            // not attempt to re-acquire it (a real file lock is not
            // reentrant) — this must simply return normally.
            return engine.total() + engine.totalFor({ taskId: "t1" });
          });
          expect(result).toBeCloseTo(8);
        } finally {
          rmSync(tempRoot, { recursive: true, force: true });
        }
      });
    }
  );

  describe(
    "P1 fix (independent Codex review, 'validate reservation ownership before live persistence'): " +
      "createReservation() must reject a scope restore() would ALSO reject, before any state mutation",
    () => {
      it("BLOCKER regression, exact reproduction: createReservation({ taskId: 123 } as any, ...) is rejected before it ever reaches memory or disk", () => {
        const tempRoot = mkdtempSync(join(tmpdir(), "uasf-cost-engine-reservation-scope-"));
        try {
          const store = new FileStateStore();
          const statePath = join(tempRoot, "cost-state.json");
          const engine = new CostEngine(() => new Date(), { store, path: statePath });

          expect(() => engine.createReservation({ taskId: 123 } as unknown as never, 0.6)).toThrow(
            InvalidReservationScopeError
          );

          // Never inserted into memory...
          expect(engine.reservedTotal({})).toBe(0);
          // ...and never durably persisted — a fresh engine over the same
          // ledger sees nothing, and does NOT throw CorruptCostStateError
          // (which it WOULD have, had the invalid scope reached disk).
          expect(() => new CostEngine(() => new Date(), { store, path: statePath })).not.toThrow();
          const reloaded = new CostEngine(() => new Date(), { store, path: statePath });
          expect(reloaded.reservedTotal({})).toBe(0);
        } finally {
          rmSync(tempRoot, { recursive: true, force: true });
        }
      });

      it("BLOCKER regression: an in-memory-only engine (no persistence configured) rejects the identical invalid scope the same way", () => {
        const engine = new CostEngine();
        expect(() => engine.createReservation({ provider: 42 } as unknown as never, 0.1)).toThrow(
          InvalidReservationScopeError
        );
        expect(engine.reservedTotal({})).toBe(0);
      });

      it("no-regression: a genuinely valid reservation scope is accepted, live, and reloadable by a new CostEngine after restart", () => {
        const tempRoot = mkdtempSync(join(tmpdir(), "uasf-cost-engine-reservation-scope-valid-"));
        try {
          const store = new FileStateStore();
          const statePath = join(tempRoot, "cost-state.json");
          const engine = new CostEngine(() => new Date(), { store, path: statePath });

          const reservation = engine.createReservation({ taskId: "t1", provider: "mock", modelId: "m1" }, 0.6);
          expect(reservation.amountUsd).toBeCloseTo(0.6);
          expect(engine.reservedTotal({ taskId: "t1" })).toBeCloseTo(0.6);

          const reloaded = new CostEngine(() => new Date(), { store, path: statePath });
          expect(reloaded.reservedTotal({ taskId: "t1" })).toBeCloseTo(0.6);
        } finally {
          rmSync(tempRoot, { recursive: true, force: true });
        }
      });

      it("no-regression: omitting optional scope fields entirely remains valid (matches assertValidPersistedScope's own contract)", () => {
        const engine = new CostEngine();
        expect(() => engine.createReservation({}, 0.1)).not.toThrow();
      });
    }
  );
});
