import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AssumptionRegister,
  CorruptPersistedAssumptionError,
  DuplicateAssumptionIdError,
  FounderConfirmationRequiredError
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
});
