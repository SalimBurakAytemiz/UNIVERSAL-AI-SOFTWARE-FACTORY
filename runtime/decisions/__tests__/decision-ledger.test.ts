import { describe, expect, it } from "vitest";
import { DecisionNotFoundError, DuplicateDecisionError, FounderDecisionLedger } from "../decision-ledger.js";

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
});
