import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssumptionRegister, DuplicateAssumptionIdError, FounderConfirmationRequiredError } from "../assumption-register.js";
import { FileStateStore } from "../../state/file-store.js";

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
});
