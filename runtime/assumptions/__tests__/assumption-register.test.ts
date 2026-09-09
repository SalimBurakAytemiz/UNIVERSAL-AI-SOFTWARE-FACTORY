import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AssumptionAlreadySupersededError,
  AssumptionNotFoundError,
  AssumptionRegister,
  CorruptPersistedAssumptionError,
  DuplicateAssumptionIdError,
  FounderConfirmationRequiredError,
  InvalidAssumptionSupersessionError
} from "../assumption-register.js";
import { FileStateStore, type StateStore } from "../../state/file-store.js";

describe("AssumptionRegister", () => {
  it("proposes an assumption as PROPOSED", () => {
    const register = new AssumptionRegister();
    const a = register.propose({
      id: "a1",
      description: "Users are mostly on mobile",
      reason: "no analytics yet",
      impact: "LOW",
      source: "product intuition"
    });
    expect(a.status).toBe("PROPOSED");
  });

  it("allows accepting a LOW/MEDIUM impact assumption without Founder confirmation", () => {
    const register = new AssumptionRegister();
    register.propose({ id: "a1", description: "d", reason: "r", impact: "MEDIUM", source: "s" });
    const accepted = register.accept("a1");
    expect(accepted.status).toBe("ACCEPTED");
  });

  it("blocks accepting a HIGH impact assumption without explicit Founder confirmation", () => {
    const register = new AssumptionRegister();
    register.propose({ id: "a1", description: "Store card numbers in plaintext for speed", reason: "r", impact: "HIGH", source: "s" });
    expect(() => register.accept("a1")).toThrow(FounderConfirmationRequiredError);
  });

  it("allows accepting a HIGH impact assumption once a Founder confirms it", () => {
    const register = new AssumptionRegister();
    register.propose({ id: "a1", description: "d", reason: "r", impact: "HIGH", source: "s" });
    const accepted = register.accept("a1", "founder@example.com");
    expect(accepted.status).toBe("ACCEPTED");
    expect(accepted.confirmedBy).toBe("founder@example.com");
  });

  it("tracks assumptions by status", () => {
    const register = new AssumptionRegister();
    register.propose({ id: "a1", description: "d", reason: "r", impact: "LOW", source: "s" });
    register.propose({ id: "a2", description: "d2", reason: "r2", impact: "LOW", source: "s" });
    register.reject("a2");
    expect(register.allWithStatus("PROPOSED")).toHaveLength(1);
    expect(register.allWithStatus("REJECTED")).toHaveLength(1);
  });

  describe("persistence (durable, not just in-memory)", () => {
    let tempRoot: string;

    afterEach(() => {
      if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    });

    it("saveTo()/loadFrom() round-trips assumptions, including a HIGH-impact confirmation", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-assumptions-"));
      const path = join(tempRoot, "assumptions.json");
      const store = new FileStateStore();

      const register = new AssumptionRegister();
      register.propose({ id: "a1", description: "d", reason: "r", impact: "HIGH", source: "s" });
      register.accept("a1", "founder@example.com");
      register.saveTo(store, path);

      const restored = AssumptionRegister.loadFrom(store, path);
      expect(restored.get("a1")?.status).toBe("ACCEPTED");
      expect(restored.get("a1")?.confirmedBy).toBe("founder@example.com");
    });
  });

  describe("P1 cross-cutting fix: HIGH-impact confirmation cannot be bypassed via a leaked mutable reference", () => {
    it("mutating an object returned by propose()/get() cannot ACCEPT a HIGH-impact assumption without confirmedBy", () => {
      const register = new AssumptionRegister();
      const proposed = register.propose({
        id: "a1",
        description: "Store card numbers in plaintext for speed",
        reason: "r",
        impact: "HIGH",
        source: "s"
      });

      expect(() => {
        (proposed as { status: string }).status = "ACCEPTED";
      }).toThrow(TypeError);

      const got = register.get("a1")!;
      expect(() => {
        (got as { status: string }).status = "ACCEPTED";
      }).toThrow(TypeError);

      expect(register.get("a1")!.status).toBe("PROPOSED");
      expect(() => register.accept("a1")).toThrow(FounderConfirmationRequiredError);
    });

    it("mutating an object returned by allWithStatus() does not change internal state", () => {
      const register = new AssumptionRegister();
      register.propose({ id: "a1", description: "d", reason: "r", impact: "LOW", source: "s" });

      const [listed] = register.allWithStatus("PROPOSED");
      expect(() => {
        (listed as { status: string }).status = "REJECTED";
      }).toThrow(TypeError);

      expect(register.get("a1")!.status).toBe("PROPOSED");
    });
  });

  describe("P2 targeted-audit fix (7th independent review round, same class as 'duplicate approval IDs replace authoritative history')", () => {
    it("rejects a second propose() with the same id while the first is still PROPOSED", () => {
      const register = new AssumptionRegister();
      register.propose({ id: "dup-1", description: "original", reason: "r", impact: "LOW", source: "s" });
      expect(() =>
        register.propose({ id: "dup-1", description: "replacement", reason: "r", impact: "LOW", source: "s" })
      ).toThrow(DuplicateAssumptionIdError);
      expect(register.get("dup-1")!.description).toBe("original");
    });

    it("BLOCKER regression: propose() cannot silently erase a Founder-confirmed HIGH-impact assumption's confirmation history", () => {
      const register = new AssumptionRegister();
      register.propose({
        id: "dup-2",
        description: "Store card numbers in plaintext for speed",
        reason: "r",
        impact: "HIGH",
        source: "s"
      });
      register.accept("dup-2", "founder@example.com");

      expect(() =>
        register.propose({ id: "dup-2", description: "sneaky replacement", reason: "r", impact: "HIGH", source: "s" })
      ).toThrow(DuplicateAssumptionIdError);

      const stillAuthoritative = register.get("dup-2")!;
      expect(stillAuthoritative.status).toBe("ACCEPTED");
      expect(stillAuthoritative.confirmedBy).toBe("founder@example.com");
      expect(stillAuthoritative.description).toBe("Store card numbers in plaintext for speed");
    });

    it("a rejected duplicate propose() cannot be used to bypass the Founder-confirmation gate on a fresh PROPOSED record", () => {
      const register = new AssumptionRegister();
      register.propose({ id: "dup-3", description: "original HIGH assumption", reason: "r", impact: "HIGH", source: "s" });
      register.accept("dup-3", "founder@example.com");

      expect(() =>
        register.propose({ id: "dup-3", description: "attacker replacement", reason: "r", impact: "HIGH", source: "s" })
      ).toThrow(DuplicateAssumptionIdError);

      // The record is still the original, already-confirmed one — there is
      // no unconfirmed PROPOSED record left to accept() without a founder.
      expect(register.get("dup-3")!.status).toBe("ACCEPTED");
    });

    it("distinct ids remain independent — the duplicate-id guard does not cross-contaminate", () => {
      const register = new AssumptionRegister();
      register.propose({ id: "dup-4-a", description: "A", reason: "r", impact: "LOW", source: "s" });
      register.propose({ id: "dup-4-b", description: "B", reason: "r", impact: "LOW", source: "s" });
      expect(register.get("dup-4-a")!.description).toBe("A");
      expect(register.get("dup-4-b")!.description).toBe("B");
    });

    it("the DuplicateAssumptionIdError message names the offending id", () => {
      const register = new AssumptionRegister();
      register.propose({ id: "dup-5", description: "d", reason: "r", impact: "LOW", source: "s" });
      try {
        register.propose({ id: "dup-5", description: "d2", reason: "r", impact: "LOW", source: "s" });
        throw new Error("expected propose() to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(DuplicateAssumptionIdError);
        expect((err as Error).message).toContain("dup-5");
      }
    });
  });

  describe(
    "P2 fix (23rd independent review round, 'reject blank founder confirmation identities'): confirmedBy " +
      "must be a semantically non-blank identity, not merely a truthy string",
    () => {
      it("rejects a whitespace-only confirmedBy for a HIGH-impact assumption", () => {
        const register = new AssumptionRegister();
        register.propose({ id: "blank-1", description: "d", reason: "r", impact: "HIGH", source: "s" });
        expect(() => register.accept("blank-1", "   ")).toThrow(FounderConfirmationRequiredError);
        expect(register.get("blank-1")!.status).toBe("PROPOSED");
      });

      it("rejects a tab/newline-only confirmedBy for a HIGH-impact assumption", () => {
        const register = new AssumptionRegister();
        register.propose({ id: "blank-2", description: "d", reason: "r", impact: "HIGH", source: "s" });
        expect(() => register.accept("blank-2", "\t\n")).toThrow(FounderConfirmationRequiredError);
      });

      it("still accepts a genuine, non-blank confirmedBy (no regression)", () => {
        const register = new AssumptionRegister();
        register.propose({ id: "blank-3", description: "d", reason: "r", impact: "HIGH", source: "s" });
        const accepted = register.accept("blank-3", "  founder@example.com  ");
        expect(accepted.status).toBe("ACCEPTED");
      });
    }
  );

  describe(
    "P1 fix (23rd independent review round, 'validate persisted assumptions before restoring authoritative " +
      "state'): loadFrom() must enforce the same domain invariants live propose()/accept() enforce",
    () => {
      function fakeStore(data: unknown): StateStore {
        return {
          write: () => undefined,
          read: () => data as never,
          exists: () => true
        };
      }

      it(
        "REGRESSION, exact reproduction: a persisted HIGH-impact ACCEPTED record with a missing confirmedBy " +
          "is refused, not silently restored into authoritative state",
        () => {
          const store = fakeStore([
            {
              id: "corrupt-1",
              description: "Store card numbers in plaintext for speed",
              reason: "r",
              impact: "HIGH",
              source: "s",
              status: "ACCEPTED",
              createdAt: new Date().toISOString()
              // confirmedBy is missing entirely
            }
          ]);

          expect(() => AssumptionRegister.loadFrom(store, "assumptions.json")).toThrow(
            CorruptPersistedAssumptionError
          );
        }
      );

      it("a persisted HIGH-impact ACCEPTED record with a whitespace-only confirmedBy is also refused", () => {
        const store = fakeStore([
          {
            id: "corrupt-2",
            description: "d",
            reason: "r",
            impact: "HIGH",
            source: "s",
            status: "ACCEPTED",
            createdAt: new Date().toISOString(),
            confirmedBy: "   "
          }
        ]);

        expect(() => AssumptionRegister.loadFrom(store, "assumptions.json")).toThrow(CorruptPersistedAssumptionError);
      });

      it("rejects a record with an invalid 'impact' enum value", () => {
        const store = fakeStore([
          { id: "corrupt-3", description: "d", reason: "r", impact: "CRITICAL", source: "s", status: "PROPOSED", createdAt: "x" }
        ]);
        expect(() => AssumptionRegister.loadFrom(store, "assumptions.json")).toThrow(CorruptPersistedAssumptionError);
      });

      it("rejects a record with an invalid 'status' enum value", () => {
        const store = fakeStore([
          { id: "corrupt-4", description: "d", reason: "r", impact: "LOW", source: "s", status: "MAYBE", createdAt: "x" }
        ]);
        expect(() => AssumptionRegister.loadFrom(store, "assumptions.json")).toThrow(CorruptPersistedAssumptionError);
      });

      it("rejects a record missing a required field (id)", () => {
        const store = fakeStore([{ description: "d", reason: "r", impact: "LOW", source: "s", status: "PROPOSED", createdAt: "x" }]);
        expect(() => AssumptionRegister.loadFrom(store, "assumptions.json")).toThrow(CorruptPersistedAssumptionError);
      });

      it("rejects two persisted records sharing the same id (duplicate authoritative identity)", () => {
        const record = { id: "dup", description: "d", reason: "r", impact: "LOW", source: "s", status: "PROPOSED", createdAt: "x" };
        const store = fakeStore([record, { ...record }]);
        expect(() => AssumptionRegister.loadFrom(store, "assumptions.json")).toThrow(CorruptPersistedAssumptionError);
      });

      it("rejects a non-object record (e.g. a bare string in the array)", () => {
        const store = fakeStore(["not-an-object"]);
        expect(() => AssumptionRegister.loadFrom(store, "assumptions.json")).toThrow(CorruptPersistedAssumptionError);
      });

      it("a genuinely valid persisted set (including a properly-confirmed HIGH-impact record) still loads correctly (no regression)", () => {
        const store = fakeStore([
          {
            id: "ok-1",
            description: "d",
            reason: "r",
            impact: "HIGH",
            source: "s",
            status: "ACCEPTED",
            createdAt: new Date().toISOString(),
            confirmedAt: new Date().toISOString(),
            confirmedBy: "founder@example.com"
          },
          { id: "ok-2", description: "d2", reason: "r2", impact: "LOW", source: "s", status: "PROPOSED", createdAt: new Date().toISOString() }
        ]);

        const restored = AssumptionRegister.loadFrom(store, "assumptions.json");
        expect(restored.get("ok-1")?.status).toBe("ACCEPTED");
        expect(restored.get("ok-1")?.confirmedBy).toBe("founder@example.com");
        expect(restored.get("ok-2")?.status).toBe("PROPOSED");
      });

      it("an empty persisted array loads a genuinely empty register (no regression)", () => {
        const store = fakeStore([]);
        const restored = AssumptionRegister.loadFrom(store, "assumptions.json");
        expect(restored.allWithStatus("PROPOSED")).toHaveLength(0);
      });
    }
  );

  describe("P1 fix (24th independent review round, 'restored assumptions must be detached')", () => {
    function fakeStore(data: unknown): StateStore {
      return {
        write: () => undefined,
        read: () => data as never,
        exists: () => true
      };
    }

    it(
      "REGRESSION: mutating the original object returned by the store AFTER loadFrom() does not change " +
        "the register's authoritative state",
      () => {
        const original: { id: string; description: string; reason: string; impact: string; source: string; status: string; createdAt: string } = {
          id: "detach-1",
          description: "original description",
          reason: "r",
          impact: "LOW",
          source: "s",
          status: "PROPOSED",
          createdAt: new Date().toISOString()
        };
        const store = fakeStore([original]);
        const register = AssumptionRegister.loadFrom(store, "assumptions.json");

        // The caller/store still holds this exact reference and mutates it
        // AFTER the load completed — simulating a cache or in-memory store
        // that returns (and later mutates) the same object.
        original.status = "ACCEPTED";
        original.description = "mutated after load";

        expect(register.get("detach-1")!.status).toBe("PROPOSED");
        expect(register.get("detach-1")!.description).toBe("original description");
      }
    );

    it(
      "REGRESSION: mutating the original object cannot smuggle a HIGH-impact assumption into ACCEPTED " +
        "without ever going through accept()'s Founder-confirmation check",
      () => {
        const original: { id: string; description: string; reason: string; impact: string; source: string; status: string; createdAt: string } = {
          id: "detach-2",
          description: "d",
          reason: "r",
          impact: "LOW", // valid at load time — passes describeInvalidPersistedAssumption()
          source: "s",
          status: "PROPOSED",
          createdAt: new Date().toISOString()
        };
        const store = fakeStore([original]);
        const register = AssumptionRegister.loadFrom(store, "assumptions.json");

        // If the register retained the same reference, this would silently
        // create a HIGH-impact ACCEPTED record with no confirmedBy at all —
        // a state accept() itself could never produce.
        original.impact = "HIGH";
        original.status = "ACCEPTED";

        expect(register.get("detach-2")!.impact).toBe("LOW");
        expect(register.get("detach-2")!.status).toBe("PROPOSED");
      }
    );
  });

  describe(
    "P1 fix (25th independent review round targeted audit, 'assumption records must be runtime-private'): the " +
      "internal assumptions Map now uses a genuine ECMAScript #private field, not TypeScript's compile-time-only " +
      "`private`",
    () => {
      it("the internal assumptions Map is not reachable as an ordinary JS property (real encapsulation, not just TS `private`)", () => {
        const register = new AssumptionRegister();
        register.propose({ id: "a1", description: "d", reason: "r", impact: "HIGH", source: "s" });

        expect((register as unknown as Record<string, unknown>).assumptions).toBeUndefined();
        expect((register as unknown as Record<string, unknown>)["assumptions"]).toBeUndefined();
      });

      it("no reflection API (Object.getOwnPropertyNames / Reflect.ownKeys) exposes the private assumptions Map", () => {
        const register = new AssumptionRegister();
        register.propose({ id: "a1", description: "d", reason: "r", impact: "HIGH", source: "s" });

        expect(Object.getOwnPropertyNames(register)).not.toContain("assumptions");
        expect(Reflect.ownKeys(register).map(String)).not.toContain("assumptions");
      });

      it("REGRESSION: a plain JS consumer cannot flip a HIGH-impact assumption straight to ACCEPTED via property access, bypassing accept()'s Founder-confirmation gate", () => {
        const register = new AssumptionRegister();
        register.propose({ id: "a1", description: "d", reason: "r", impact: "HIGH", source: "s" });

        const forged = (register as unknown as Record<string, unknown>).assumptions as
          | Map<string, { status: string; confirmedBy?: string }>
          | undefined;
        expect(forged).toBeUndefined(); // there is nothing to reach in and mutate at all

        const spread: Record<string, unknown> = { ...register };
        expect(spread.assumptions).toBeUndefined();

        expect(register.get("a1")!.status).toBe("PROPOSED");
      });
    }
  );

  describe(
    "P1 fix (28th independent review round, finding 12, 'snapshot registry records before validation/storage'): " +
      "propose() reads input.id exactly once, then the duplicate check, the stored record, and the Map key all " +
      "use that SAME snapshot",
    () => {
      it("BLOCKER regression, exact reproduction: a getter-backed id that answers a NON-colliding value for the duplicate check and a DIFFERENT (colliding) value afterward must not corrupt the store", () => {
        const register = new AssumptionRegister();
        register.propose({ id: "existing", description: "d", reason: "r", impact: "LOW", source: "s" });

        let reads = 0;
        const hostile = {
          get id() {
            reads += 1;
            return reads === 1 ? "new-one" : "existing";
          },
          description: "hostile",
          reason: "r",
          impact: "LOW" as const,
          source: "s"
        };

        const result = register.propose(hostile);
        expect(reads).toBe(1); // id consulted exactly once
        expect(result.id).toBe("new-one");
        expect(register.get("new-one")).toBeDefined();
        expect(register.get("existing")!.description).toBe("d"); // untouched
      });
    }
  );

  describe(
    "P1 fix (29th independent review round, finding 3, 'assumption authoritative lookup must be runtime-" +
      "private'): the internal mustGet() lookup helper is now a genuine #private method, not TypeScript's " +
      "compile-time-only `private`",
    () => {
      it("mustGet is not reachable as an ordinary JS property/method (BLOCKER regression)", () => {
        const register = new AssumptionRegister();
        register.propose({ id: "a1", description: "d", reason: "r", impact: "HIGH", source: "s" });

        const asAny = register as unknown as { mustGet?: (id: string) => { status: string; confirmedBy?: string } };
        expect(asAny.mustGet).toBeUndefined();

        // Before the fix, this call would have returned the ACTUAL mutable
        // internal record — mutating its `status`/`confirmedBy` directly
        // would flip a HIGH-impact assumption to ACCEPTED with no Founder
        // confirmation, no accept() call, and no FounderConfirmationRequiredError
        // ever thrown. There is no such method to call now.
        expect(() => asAny.mustGet?.("a1")).not.toThrow();
        expect(asAny.mustGet).toBeUndefined();
      });

      it("no reflection API exposes mustGet", () => {
        const register = new AssumptionRegister();
        expect(Object.getOwnPropertyNames(register)).not.toContain("mustGet");
        expect(Reflect.ownKeys(register).map(String)).not.toContain("mustGet");
        const proto = Object.getPrototypeOf(register) as object;
        expect(Object.getOwnPropertyNames(proto)).not.toContain("mustGet");
      });

      it("BLOCKER regression: a HIGH-impact assumption cannot be pushed to ACCEPTED (with no confirmedBy) via the former mutable-record escape hatch", () => {
        const register = new AssumptionRegister();
        register.propose({ id: "a2", description: "d", reason: "r", impact: "HIGH", source: "s" });

        // Simulates the exact pre-fix attack this finding describes:
        // reaching mustGet() via a forged/any-typed reference and mutating
        // the record it returned directly, bypassing accept()'s Founder-
        // confirmation gate entirely.
        const forged = register as unknown as Record<string, unknown>;
        if (typeof forged.mustGet === "function") {
          const record = (forged.mustGet as (id: string) => { status: string; confirmedBy?: string })("a2");
          record.status = "ACCEPTED";
        }

        expect(register.get("a2")!.status).toBe("PROPOSED");
        expect(register.get("a2")!.confirmedBy).toBeUndefined();
      });

      it("HIGH-impact assumptions still can only become ACCEPTED through the validated Founder-confirmation transition (no regression)", () => {
        const register = new AssumptionRegister();
        register.propose({ id: "a3", description: "d", reason: "r", impact: "HIGH", source: "s" });

        expect(() => register.accept("a3")).toThrow(FounderConfirmationRequiredError);
        expect(register.get("a3")!.status).toBe("PROPOSED");

        const accepted = register.accept("a3", "founder@example.com");
        expect(accepted.status).toBe("ACCEPTED");
        expect(accepted.confirmedBy).toBe("founder@example.com");
      });
    }
  );

  describe(
    "P2 fix (31st independent review round, finding 6, 'implement the SUPERSEDED assumption transition'): " +
      "an explicit, invariant-enforcing supersede() operation",
    () => {
      it("supersede() marks the old assumption SUPERSEDED and records which assumption replaces it", () => {
        const register = new AssumptionRegister();
        register.propose({ id: "old", description: "d1", reason: "r1", impact: "LOW", source: "s" });
        register.propose({ id: "new", description: "d2", reason: "r2", impact: "LOW", source: "s" });

        const superseded = register.supersede("old", "new");
        expect(superseded.status).toBe("SUPERSEDED");
        expect(superseded.supersededBy).toBe("new");
        expect(register.get("old")!.status).toBe("SUPERSEDED");
        expect(register.get("new")!.status).toBe("PROPOSED"); // untouched
      });

      it("BLOCKER: replacement assumption must exist — superseding with an unknown id fails closed, and the original assumption is untouched", () => {
        const register = new AssumptionRegister();
        register.propose({ id: "old", description: "d", reason: "r", impact: "LOW", source: "s" });

        expect(() => register.supersede("old", "does-not-exist")).toThrow(AssumptionNotFoundError);
        expect(register.get("old")!.status).toBe("PROPOSED");
      });

      it("superseding an unknown assumption id fails closed", () => {
        const register = new AssumptionRegister();
        register.propose({ id: "new", description: "d", reason: "r", impact: "LOW", source: "s" });
        expect(() => register.supersede("does-not-exist", "new")).toThrow(AssumptionNotFoundError);
      });

      it("BLOCKER: prevents self-supersession", () => {
        const register = new AssumptionRegister();
        register.propose({ id: "a", description: "d", reason: "r", impact: "LOW", source: "s" });
        expect(() => register.supersede("a", "a")).toThrow(InvalidAssumptionSupersessionError);
        expect(register.get("a")!.status).toBe("PROPOSED");
      });

      it("BLOCKER: prevents a direct two-node supersession cycle (A -> B -> A)", () => {
        const register = new AssumptionRegister();
        register.propose({ id: "a", description: "d", reason: "r", impact: "LOW", source: "s" });
        register.propose({ id: "b", description: "d", reason: "r", impact: "LOW", source: "s" });

        register.supersede("a", "b");
        expect(() => register.supersede("b", "a")).toThrow(InvalidAssumptionSupersessionError);
        // The first, legitimate supersession must remain intact.
        expect(register.get("a")!.status).toBe("SUPERSEDED");
        expect(register.get("b")!.status).toBe("PROPOSED");
      });

      it("BLOCKER: prevents a longer supersession cycle (A -> B -> C -> A)", () => {
        const register = new AssumptionRegister();
        register.propose({ id: "a", description: "d", reason: "r", impact: "LOW", source: "s" });
        register.propose({ id: "b", description: "d", reason: "r", impact: "LOW", source: "s" });
        register.propose({ id: "c", description: "d", reason: "r", impact: "LOW", source: "s" });

        register.supersede("a", "b");
        register.supersede("b", "c");
        expect(() => register.supersede("c", "a")).toThrow(InvalidAssumptionSupersessionError);
      });

      it("BLOCKER: a replacement that is itself already SUPERSEDED cannot serve as an active replacement (invalid chain)", () => {
        const register = new AssumptionRegister();
        register.propose({ id: "a", description: "d", reason: "r", impact: "LOW", source: "s" });
        register.propose({ id: "b", description: "d", reason: "r", impact: "LOW", source: "s" });
        register.propose({ id: "c", description: "d", reason: "r", impact: "LOW", source: "s" });

        register.supersede("a", "b"); // "a" is now SUPERSEDED (replaced by "b")
        // Trying to supersede "c" WITH "a" as the replacement must fail — "a" is
        // itself already SUPERSEDED, so it cannot serve as an active replacement.
        expect(() => register.supersede("c", "a")).toThrow(InvalidAssumptionSupersessionError);
      });

      describe(
        "P1 fix (33rd independent review round, finding 5 / root class D, 'make live assumption supersession " +
          "obey the persisted graph invariant'): the live API must never be able to reach a graph shape the " +
          "restore-time validator would then refuse to reload",
        () => {
          it("BLOCKER regression, exact reproduction: a second, distinct predecessor naming an already-claimed replacement is rejected live, not merely at restore time", () => {
            const register = new AssumptionRegister();
            register.propose({ id: "a", description: "d", reason: "r", impact: "LOW", source: "s" });
            register.propose({ id: "b", description: "d", reason: "r", impact: "LOW", source: "s" });
            register.propose({ id: "c", description: "d", reason: "r", impact: "LOW", source: "s" });

            register.supersede("a", "c");
            expect(() => register.supersede("b", "c")).toThrow(InvalidAssumptionSupersessionError);
            // The first, legitimate supersession must remain intact, and "b" must
            // remain untouched — the rejected call must not have mutated anything.
            expect(register.get("a")!.status).toBe("SUPERSEDED");
            expect(register.get("a")!.supersededBy).toBe("c");
            expect(register.get("b")!.status).toBe("PROPOSED");
          });

          it("root-cause proof: a register state the old code would have allowed live can no longer be persisted and silently become unrestorable — saveTo()/loadFrom() never even sees the invalid shape, because supersede() itself now refuses to create it", () => {
            const register = new AssumptionRegister();
            register.propose({ id: "a", description: "d", reason: "r", impact: "LOW", source: "s" });
            register.propose({ id: "b", description: "d", reason: "r", impact: "LOW", source: "s" });
            register.propose({ id: "c", description: "d", reason: "r", impact: "LOW", source: "s" });
            register.supersede("a", "c");

            expect(() => register.supersede("b", "c")).toThrow(InvalidAssumptionSupersessionError);

            // Had the rejected call above been allowed to succeed, saveTo()/
            // loadFrom() would reproduce exactly the restore-time rejection
            // already covered by "a persisted merged supersession chain ...
            // is rejected" above — proving the two paths now agree BEFORE the
            // fact, rather than only after a save/restore round-trip exposes
            // the disagreement.
            expect(register.get("c")!.status).toBe("PROPOSED");
          });

          it("no regression: two different predecessors superseded by two DIFFERENT replacements is still allowed", () => {
            const register = new AssumptionRegister();
            register.propose({ id: "a", description: "d", reason: "r", impact: "LOW", source: "s" });
            register.propose({ id: "b", description: "d", reason: "r", impact: "LOW", source: "s" });
            register.propose({ id: "c", description: "d", reason: "r", impact: "LOW", source: "s" });
            register.propose({ id: "d", description: "d", reason: "r", impact: "LOW", source: "s" });

            expect(() => register.supersede("a", "c")).not.toThrow();
            expect(() => register.supersede("b", "d")).not.toThrow();
            expect(register.get("a")!.supersededBy).toBe("c");
            expect(register.get("b")!.supersededBy).toBe("d");
          });

          it("no regression: a normal chain (A -> B -> C, each superseded by exactly one predecessor) is still allowed", () => {
            const register = new AssumptionRegister();
            register.propose({ id: "a", description: "d", reason: "r", impact: "LOW", source: "s" });
            register.propose({ id: "b", description: "d", reason: "r", impact: "LOW", source: "s" });
            register.propose({ id: "c", description: "d", reason: "r", impact: "LOW", source: "s" });

            expect(() => register.supersede("a", "b")).not.toThrow();
            expect(() => register.supersede("b", "c")).not.toThrow();
            expect(register.get("a")!.supersededBy).toBe("b");
            expect(register.get("b")!.supersededBy).toBe("c");
          });
        }
      );

      it("supersede() is rejected a second time on an already-SUPERSEDED assumption", () => {
        const register = new AssumptionRegister();
        register.propose({ id: "a", description: "d", reason: "r", impact: "LOW", source: "s" });
        register.propose({ id: "b", description: "d", reason: "r", impact: "LOW", source: "s" });
        register.propose({ id: "c", description: "d", reason: "r", impact: "LOW", source: "s" });

        register.supersede("a", "b");
        expect(() => register.supersede("a", "c")).toThrow(AssumptionAlreadySupersededError);
      });

      it("a SUPERSEDED assumption is terminal: accept()/reject()/validate() all refuse to operate on it", () => {
        const register = new AssumptionRegister();
        register.propose({ id: "a", description: "d", reason: "r", impact: "LOW", source: "s" });
        register.propose({ id: "b", description: "d", reason: "r", impact: "LOW", source: "s" });
        register.supersede("a", "b");

        expect(() => register.accept("a")).toThrow(AssumptionAlreadySupersededError);
        expect(() => register.reject("a")).toThrow(AssumptionAlreadySupersededError);
        expect(() => register.validate("a")).toThrow(AssumptionAlreadySupersededError);
      });

      it("no regression: superseding a HIGH-impact, already-Founder-accepted assumption still requires no additional confirmation, and the replacement can independently go through its own Founder confirmation", () => {
        const register = new AssumptionRegister();
        register.propose({ id: "old", description: "d", reason: "r", impact: "HIGH", source: "s" });
        register.accept("old", "founder@example.com");
        register.propose({ id: "new", description: "d", reason: "r", impact: "HIGH", source: "s" });
        register.accept("new", "founder@example.com");

        const superseded = register.supersede("old", "new");
        expect(superseded.status).toBe("SUPERSEDED");
        expect(register.get("new")!.status).toBe("ACCEPTED");
      });

      describe("restore regressions: a persisted SUPERSEDED graph must satisfy the same invariants live supersede() enforces", () => {
        let tempRoot: string;

        afterEach(() => {
          if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
        });

        it("saveTo()/loadFrom() round-trips a genuine supersede() chain, including supersededBy", () => {
          tempRoot = mkdtempSync(join(tmpdir(), "uasf-assumption-supersede-"));
          const path = join(tempRoot, "assumptions.json");
          const store = new FileStateStore();

          const register = new AssumptionRegister();
          register.propose({ id: "old", description: "d", reason: "r", impact: "LOW", source: "s" });
          register.propose({ id: "new", description: "d", reason: "r", impact: "LOW", source: "s" });
          register.supersede("old", "new");
          register.saveTo(store, path);

          const restored = AssumptionRegister.loadFrom(store, path);
          expect(restored.get("old")!.status).toBe("SUPERSEDED");
          expect(restored.get("old")!.supersededBy).toBe("new");
        });

        it("BLOCKER: a persisted record claiming SUPERSEDED without supersededBy is rejected", () => {
          const fakeStore: StateStore = {
            write: () => {},
            read: () =>
              [
                {
                  id: "a",
                  description: "d",
                  reason: "r",
                  impact: "LOW",
                  source: "s",
                  status: "SUPERSEDED",
                  createdAt: new Date().toISOString()
                }
              ] as never,
            exists: () => true
          };
          expect(() => AssumptionRegister.loadFrom(fakeStore, "irrelevant.json")).toThrow(
            CorruptPersistedAssumptionError
          );
        });

        it("BLOCKER: a persisted record claiming a non-SUPERSEDED status while carrying supersededBy is rejected", () => {
          const fakeStore: StateStore = {
            write: () => {},
            read: () =>
              [
                {
                  id: "a",
                  description: "d",
                  reason: "r",
                  impact: "LOW",
                  source: "s",
                  status: "PROPOSED",
                  createdAt: new Date().toISOString(),
                  supersededBy: "b"
                }
              ] as never,
            exists: () => true
          };
          expect(() => AssumptionRegister.loadFrom(fakeStore, "irrelevant.json")).toThrow(
            CorruptPersistedAssumptionError
          );
        });

        it("BLOCKER: a persisted supersededBy referencing a non-existent assumption is rejected", () => {
          const fakeStore: StateStore = {
            write: () => {},
            read: () =>
              [
                {
                  id: "a",
                  description: "d",
                  reason: "r",
                  impact: "LOW",
                  source: "s",
                  status: "SUPERSEDED",
                  createdAt: new Date().toISOString(),
                  supersededBy: "ghost"
                }
              ] as never,
            exists: () => true
          };
          expect(() => AssumptionRegister.loadFrom(fakeStore, "irrelevant.json")).toThrow(
            CorruptPersistedAssumptionError
          );
        });

        it("BLOCKER: a persisted supersession cycle (A -> B -> A) is rejected", () => {
          const now = new Date().toISOString();
          const fakeStore: StateStore = {
            write: () => {},
            read: () =>
              [
                { id: "a", description: "d", reason: "r", impact: "LOW", source: "s", status: "SUPERSEDED", createdAt: now, supersededBy: "b" },
                { id: "b", description: "d", reason: "r", impact: "LOW", source: "s", status: "SUPERSEDED", createdAt: now, supersededBy: "a" }
              ] as never,
            exists: () => true
          };
          expect(() => AssumptionRegister.loadFrom(fakeStore, "irrelevant.json")).toThrow(
            CorruptPersistedAssumptionError
          );
        });

        it("BLOCKER: a persisted merged supersession chain (two predecessors claiming the same successor) is rejected", () => {
          const now = new Date().toISOString();
          const fakeStore: StateStore = {
            write: () => {},
            read: () =>
              [
                { id: "a", description: "d", reason: "r", impact: "LOW", source: "s", status: "SUPERSEDED", createdAt: now, supersededBy: "c" },
                { id: "b", description: "d", reason: "r", impact: "LOW", source: "s", status: "SUPERSEDED", createdAt: now, supersededBy: "c" },
                { id: "c", description: "d", reason: "r", impact: "LOW", source: "s", status: "PROPOSED", createdAt: now }
              ] as never,
            exists: () => true
          };
          expect(() => AssumptionRegister.loadFrom(fakeStore, "irrelevant.json")).toThrow(
            CorruptPersistedAssumptionError
          );
        });

        it("BLOCKER: a persisted self-superseding record (supersededBy === id) is rejected", () => {
          const fakeStore: StateStore = {
            write: () => {},
            read: () =>
              [
                {
                  id: "a",
                  description: "d",
                  reason: "r",
                  impact: "LOW",
                  source: "s",
                  status: "SUPERSEDED",
                  createdAt: new Date().toISOString(),
                  supersededBy: "a"
                }
              ] as never,
            exists: () => true
          };
          expect(() => AssumptionRegister.loadFrom(fakeStore, "irrelevant.json")).toThrow(
            CorruptPersistedAssumptionError
          );
        });
      });
    }
  );
});
