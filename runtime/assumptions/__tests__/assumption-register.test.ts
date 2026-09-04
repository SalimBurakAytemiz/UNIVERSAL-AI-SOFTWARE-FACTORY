import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssumptionRegister, FounderConfirmationRequiredError } from "../assumption-register.js";
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
});
