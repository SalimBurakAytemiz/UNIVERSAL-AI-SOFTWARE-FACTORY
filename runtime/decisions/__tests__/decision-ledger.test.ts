import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DecisionAlreadySupersededError,
  DecisionNotFoundError,
  DuplicateDecisionError,
  FounderDecisionLedger
} from "../decision-ledger.js";
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

  describe("P1 cross-cutting fix: decision state cannot be mutated via a leaked reference", () => {
    it("mutating the object returned by record() cannot mark it SUPERSEDED without supersede()", () => {
      const ledger = new FounderDecisionLedger();
      const returned = ledger.record("dec-1", "proj-a", "Use PostgreSQL", "founder chat");

      expect(() => {
        (returned as { status: string }).status = "SUPERSEDED";
      }).toThrow(TypeError);

      expect(ledger.get("dec-1")!.status).toBe("ACTIVE");
      expect(ledger.hasActiveDecision("dec-1")).toBe(true);
    });

    it("mutating the object returned by get()/allFor() does not change internal state", () => {
      const ledger = new FounderDecisionLedger();
      ledger.record("dec-1", "proj-a", "Use PostgreSQL", "founder chat");

      const got = ledger.get("dec-1")!;
      expect(() => {
        (got as { status: string }).status = "SUPERSEDED";
      }).toThrow(TypeError);

      const [listed] = ledger.allFor("proj-a");
      expect(() => {
        (listed as { status: string }).status = "SUPERSEDED";
      }).toThrow(TypeError);

      expect(ledger.get("dec-1")!.status).toBe("ACTIVE");
    });

    it("get() and record() never return the same object reference as internal state", () => {
      const ledger = new FounderDecisionLedger();
      const returned = ledger.record("dec-1", "proj-a", "Use PostgreSQL", "founder chat");
      const got = ledger.get("dec-1")!;
      expect(returned).not.toBe(got);
      expect(returned).toEqual(got);
    });
  });

  describe("P1 fix (5th independent review round): repeated supersession cannot corrupt decision history", () => {
    it("A -> B works", () => {
      const ledger = new FounderDecisionLedger();
      ledger.record("a", "proj-a", "Use PostgreSQL", "founder chat");
      const b = ledger.supersede("a", "b", "Use MySQL", "founder chat 2");
      expect(b.status).toBe("ACTIVE");
      expect(ledger.get("a")!.status).toBe("SUPERSEDED");
      expect(ledger.get("a")!.supersededBy).toBe("b");
    });

    it("A -> B then A -> C (re-superseding an already-superseded decision) is rejected", () => {
      const ledger = new FounderDecisionLedger();
      ledger.record("a", "proj-a", "Use PostgreSQL", "founder chat");
      ledger.supersede("a", "b", "Use MySQL", "founder chat 2");

      expect(() => ledger.supersede("a", "c", "Use MongoDB", "founder chat 3")).toThrow(
        DecisionAlreadySupersededError
      );
    });

    it("history still records A -> B after a rejected A -> C attempt", () => {
      const ledger = new FounderDecisionLedger();
      ledger.record("a", "proj-a", "Use PostgreSQL", "founder chat");
      ledger.supersede("a", "b", "Use MySQL", "founder chat 2");

      expect(() => ledger.supersede("a", "c", "Use MongoDB", "founder chat 3")).toThrow();

      expect(ledger.get("a")!.status).toBe("SUPERSEDED");
      expect(ledger.get("a")!.supersededBy).toBe("b"); // NOT overwritten to "c"
    });

    it("B remains the authoritative current ACTIVE replacement after a rejected re-supersession of A", () => {
      const ledger = new FounderDecisionLedger();
      ledger.record("a", "proj-a", "Use PostgreSQL", "founder chat");
      ledger.supersede("a", "b", "Use MySQL", "founder chat 2");

      expect(() => ledger.supersede("a", "c", "Use MongoDB", "founder chat 3")).toThrow();

      expect(ledger.get("b")!.status).toBe("ACTIVE");
      expect(ledger.hasActiveDecision("b")).toBe(true);
    });

    it("B -> C works (evolving the CURRENT active decision, not re-replacing A)", () => {
      const ledger = new FounderDecisionLedger();
      ledger.record("a", "proj-a", "Use PostgreSQL", "founder chat");
      ledger.supersede("a", "b", "Use MySQL", "founder chat 2");
      const c = ledger.supersede("b", "c", "Use MongoDB", "founder chat 3");

      expect(c.status).toBe("ACTIVE");
      expect(ledger.get("b")!.status).toBe("SUPERSEDED");
      expect(ledger.get("b")!.supersededBy).toBe("c");
    });

    it("the resulting history is A -> B -> C, with exactly one ACTIVE decision (no multiple active replacements)", () => {
      const ledger = new FounderDecisionLedger();
      ledger.record("a", "proj-a", "Use PostgreSQL", "founder chat");
      ledger.supersede("a", "b", "Use MySQL", "founder chat 2");
      ledger.supersede("b", "c", "Use MongoDB", "founder chat 3");

      const all = ledger.allFor("proj-a");
      expect(all.map((d) => d.decisionId).sort()).toEqual(["a", "b", "c"]);

      const activeOnes = all.filter((d) => d.status === "ACTIVE");
      expect(activeOnes).toHaveLength(1);
      expect(activeOnes[0]!.decisionId).toBe("c");

      expect(ledger.get("a")!.status).toBe("SUPERSEDED");
      expect(ledger.get("a")!.supersededBy).toBe("b");
      expect(ledger.get("b")!.status).toBe("SUPERSEDED");
      expect(ledger.get("b")!.supersededBy).toBe("c");
    });

    it("a failed repeated supersession performs no partial mutation (the rejected replacement id is never created)", () => {
      const ledger = new FounderDecisionLedger();
      ledger.record("a", "proj-a", "Use PostgreSQL", "founder chat");
      ledger.supersede("a", "b", "Use MySQL", "founder chat 2");

      expect(() => ledger.supersede("a", "c", "Use MongoDB", "founder chat 3")).toThrow();

      expect(ledger.get("c")).toBeUndefined(); // "c" was never recorded at all
      expect(ledger.allFor("proj-a")).toHaveLength(2); // still just a and b
    });

    it("attempting to supersede an ALREADY-SUPERSEDED decision a second time reports its actual current status", () => {
      const ledger = new FounderDecisionLedger();
      ledger.record("a", "proj-a", "Use PostgreSQL", "founder chat");
      ledger.supersede("a", "b", "Use MySQL", "founder chat 2");

      try {
        ledger.supersede("a", "c", "Use MongoDB", "founder chat 3");
        throw new Error("expected supersede() to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(DecisionAlreadySupersededError);
        expect((err as Error).message).toContain("SUPERSEDED");
        expect((err as Error).message).toContain("b");
      }
    });
  });
});
