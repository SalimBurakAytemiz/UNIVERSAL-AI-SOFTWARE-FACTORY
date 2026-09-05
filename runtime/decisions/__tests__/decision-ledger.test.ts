import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DecisionNotFoundError, DuplicateDecisionError, FounderDecisionLedger } from "../decision-ledger.js";
import { FileStateStore } from "../../state/file-store.js";

describe("FounderDecisionLedger", () => {
  it("records a decision as ACTIVE", () => {
    const ledger = new FounderDecisionLedger();
    const decision = ledger.record("dec-1", "proj-a", "Use PostgreSQL", "founder chat 2026-01-01");
    expect(decision.status).toBe("ACTIVE");
    expect(ledger.hasActiveDecision("dec-1")).toBe(true);
  });

  it("refuses to silently overwrite an existing decision id", () => {
    const ledger = new FounderDecisionLedger();
    ledger.record("dec-1", "proj-a", "Use PostgreSQL", "founder chat");
    expect(() => ledger.record("dec-1", "proj-a", "Use MySQL instead", "founder chat 2")).toThrow(
      DuplicateDecisionError
    );
  });

  it("supersede() marks the old decision SUPERSEDED and never deletes it", () => {
    const ledger = new FounderDecisionLedger();
    ledger.record("dec-1", "proj-a", "Use PostgreSQL", "founder chat");
    const replacement = ledger.supersede("dec-1", "dec-2", "Use MySQL instead", "founder chat 2");

    const old = ledger.get("dec-1")!;
    expect(old.status).toBe("SUPERSEDED");
    expect(old.supersededBy).toBe("dec-2");
    expect(replacement.status).toBe("ACTIVE");
    expect(ledger.hasActiveDecision("dec-1")).toBe(false);
    expect(ledger.hasActiveDecision("dec-2")).toBe(true);
  });

  it("supersede() throws for an unknown decision id rather than creating one from nothing", () => {
    const ledger = new FounderDecisionLedger();
    expect(() => ledger.supersede("missing", "dec-2", "x", "y")).toThrow(DecisionNotFoundError);
  });

  it("allFor() scopes decisions by project", () => {
    const ledger = new FounderDecisionLedger();
    ledger.record("dec-1", "proj-a", "A", "s");
    ledger.record("dec-2", "proj-b", "B", "s");
    expect(ledger.allFor("proj-a")).toHaveLength(1);
    expect(ledger.allFor("proj-a")[0]!.decisionId).toBe("dec-1");
  });

  describe("persistence (durable, not just in-memory)", () => {
    let tempRoot: string;

    afterEach(() => {
      if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    });

    it("saveTo()/loadFrom() round-trips the full decision history, including superseded entries", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-decisions-"));
      const path = join(tempRoot, "decisions.json");
      const store = new FileStateStore();

      const ledger = new FounderDecisionLedger();
      ledger.record("dec-1", "proj-a", "Use PostgreSQL", "founder chat");
      ledger.supersede("dec-1", "dec-2", "Use MySQL instead", "founder chat 2");
      ledger.saveTo(store, path);

      // Simulate a fresh process reading the ledger back from disk.
      const restored = FounderDecisionLedger.loadFrom(store, path);
      expect(restored.get("dec-1")?.status).toBe("SUPERSEDED");
      expect(restored.get("dec-1")?.supersededBy).toBe("dec-2");
      expect(restored.hasActiveDecision("dec-2")).toBe(true);
    });

    it("loadFrom() on a path that was never saved returns an empty ledger, not an error", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-decisions-"));
      const restored = FounderDecisionLedger.loadFrom(new FileStateStore(), join(tempRoot, "never-written.json"));
      expect(restored.get("anything")).toBeUndefined();
    });
  });
});
