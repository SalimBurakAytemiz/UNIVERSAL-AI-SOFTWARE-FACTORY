import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ScopeLock,
  BacklogRouter,
  InvalidPhaseTransitionError,
  GovernanceInvariantViolationError,
  DuplicateBacklogItemError,
  CorruptPersistedPhaseLockError,
  CorruptPersistedBacklogRecordError,
  type BacklogItem
} from "../scope-lock.js";
import { FounderDecisionLedger, DuplicateDecisionError } from "../../decisions/decision-ledger.js";
import { FileStateStore } from "../../state/file-store.js";
import type { InvariantGuardReport } from "../../invariants/invariant-guard.js";

const CLEAN_REPORT: InvariantGuardReport = {
  allBlockingSatisfied: true,
  evaluatedAt: new Date().toISOString(),
  violations: []
};

function dirtyReport(): InvariantGuardReport {
  return {
    allBlockingSatisfied: false,
    evaluatedAt: new Date().toISOString(),
    violations: [{ invariantId: "fake", description: "d", severity: "BLOCKING", detail: "simulated violation" }]
  };
}

describe("ScopeLock: phase state machine", () => {
  it("a never-locked phase defaults to OPEN", () => {
    const lock = new ScopeLock(new FounderDecisionLedger());
    expect(lock.getState("P0")).toBe("OPEN");
  });

  it("lock() transitions OPEN -> LOCKED_FOR_CLOSURE and records a decision", () => {
    const ledger = new FounderDecisionLedger();
    const lock = new ScopeLock(ledger);
    const record = lock.lock("P0", "all local gates passed", CLEAN_REPORT, "d1");
    expect(record.state).toBe("LOCKED_FOR_CLOSURE");
    expect(lock.getState("P0")).toBe("LOCKED_FOR_CLOSURE");
    expect(ledger.allFor("P0")).toHaveLength(1);
  });

  it("BLOCKER: lock() refuses to transition when the invariant guard reports a BLOCKING violation", () => {
    const ledger = new FounderDecisionLedger();
    const lock = new ScopeLock(ledger);
    expect(() => lock.lock("P0", "premature", dirtyReport(), "d1")).toThrow(GovernanceInvariantViolationError);
    expect(lock.getState("P0")).toBe("OPEN");
    expect(ledger.allFor("P0")).toHaveLength(0);
  });

  it("close() requires LOCKED_FOR_CLOSURE as the starting state (cannot skip the checkpoint)", () => {
    const ledger = new FounderDecisionLedger();
    const lock = new ScopeLock(ledger);
    expect(() => lock.close("P0", "skip", CLEAN_REPORT, "d1")).toThrow(InvalidPhaseTransitionError);
  });

  it("close() transitions LOCKED_FOR_CLOSURE -> CLOSED and records a decision", () => {
    const ledger = new FounderDecisionLedger();
    const lock = new ScopeLock(ledger);
    lock.lock("P0", "ready", CLEAN_REPORT, "d1");
    const record = lock.close("P0", "independent review clean", CLEAN_REPORT, "d2");
    expect(record.state).toBe("CLOSED");
    expect(ledger.allFor("P0")).toHaveLength(2);
  });

  it("BLOCKER: close() refuses to transition when the invariant guard reports a BLOCKING violation, even though state is LOCKED_FOR_CLOSURE", () => {
    const ledger = new FounderDecisionLedger();
    const lock = new ScopeLock(ledger);
    lock.lock("P0", "ready", CLEAN_REPORT, "d1");
    expect(() => lock.close("P0", "premature", dirtyReport(), "d2")).toThrow(GovernanceInvariantViolationError);
    expect(lock.getState("P0")).toBe("LOCKED_FOR_CLOSURE");
  });

  it("reopen() is always allowed, from CLOSED, with no invariant check required", () => {
    const ledger = new FounderDecisionLedger();
    const lock = new ScopeLock(ledger);
    lock.lock("P0", "ready", CLEAN_REPORT, "d1");
    lock.close("P0", "closed", CLEAN_REPORT, "d2");
    const record = lock.reopen("P0", "new finding surfaced", "d3");
    expect(record.state).toBe("OPEN");
    expect(ledger.allFor("P0")).toHaveLength(3);
  });

  it("reopen() succeeds even when the invariant guard would report a violation (relaxing scope is always safe)", () => {
    const ledger = new FounderDecisionLedger();
    const lock = new ScopeLock(ledger);
    lock.lock("P0", "ready", CLEAN_REPORT, "d1");
    expect(() => lock.reopen("P0", "reopening despite issues", "d2")).not.toThrow();
    expect(lock.getState("P0")).toBe("OPEN");
  });

  it("rejects OPEN -> CLOSED directly (skipping LOCKED_FOR_CLOSURE) via close()", () => {
    const ledger = new FounderDecisionLedger();
    const lock = new ScopeLock(ledger);
    expect(() => lock.close("P0", "skip straight to closed", CLEAN_REPORT, "d1")).toThrow(InvalidPhaseTransitionError);
  });
});

describe(
  "ScopeLock: P1 targeted-audit fix (35th independent review round, 'pre-audit transition exposure' root " +
    "class — same class this round's own Fix 2 closed in approval.ts): a decisionId collision must never " +
    "leave the phase transitioned with no audit trail",
  () => {
    it("BLOCKER: lock() leaves the phase OPEN when the ledger record fails (reused decisionId)", () => {
      const ledger = new FounderDecisionLedger();
      ledger.record("d1", "P0", "an unrelated, pre-existing decision", "test-setup");
      const lock = new ScopeLock(ledger);
      expect(() => lock.lock("P0", "ready", CLEAN_REPORT, "d1")).toThrow(DuplicateDecisionError);
      expect(lock.getState("P0")).toBe("OPEN");
    });

    it("BLOCKER: close() leaves the phase LOCKED_FOR_CLOSURE (not CLOSED) when the ledger record fails", () => {
      const ledger = new FounderDecisionLedger();
      const lock = new ScopeLock(ledger);
      lock.lock("P0", "ready", CLEAN_REPORT, "d1");
      ledger.record("d2", "P0", "an unrelated, pre-existing decision", "test-setup");
      expect(() => lock.close("P0", "closing", CLEAN_REPORT, "d2")).toThrow(DuplicateDecisionError);
      expect(lock.getState("P0")).toBe("LOCKED_FOR_CLOSURE");
    });

    it("BLOCKER: reopen() leaves the phase CLOSED (not OPEN) when the ledger record fails", () => {
      const ledger = new FounderDecisionLedger();
      const lock = new ScopeLock(ledger);
      lock.lock("P0", "ready", CLEAN_REPORT, "d1");
      lock.close("P0", "closed", CLEAN_REPORT, "d2");
      ledger.record("d3", "P0", "an unrelated, pre-existing decision", "test-setup");
      expect(() => lock.reopen("P0", "reopening", "d3")).toThrow(DuplicateDecisionError);
      expect(lock.getState("P0")).toBe("CLOSED");
    });

    it("no-regression: a successful lock() still records exactly one decision and transitions the phase", () => {
      const ledger = new FounderDecisionLedger();
      const lock = new ScopeLock(ledger);
      const record = lock.lock("P0", "ready", CLEAN_REPORT, "d1");
      expect(record.state).toBe("LOCKED_FOR_CLOSURE");
      expect(ledger.allFor("P0")).toHaveLength(1);
    });
  }
);

describe("ScopeLock: persistence", () => {
  let tempRoot: string;
  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it("round-trips state through saveTo/loadFrom", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-scope-lock-"));
    const store = new FileStateStore();
    const path = join(tempRoot, "scope-lock.json");
    const ledger = new FounderDecisionLedger();
    const lock = new ScopeLock(ledger);
    lock.lock("P0", "ready", CLEAN_REPORT, "d1");
    lock.saveTo(store, path);

    const restored = ScopeLock.loadFrom(store, path, ledger);
    expect(restored.getState("P0")).toBe("LOCKED_FOR_CLOSURE");
  });

  it("fails closed on a corrupt persisted record (invalid state value)", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-scope-lock-"));
    const store = new FileStateStore();
    const path = join(tempRoot, "scope-lock.json");
    store.write(path, [{ phaseId: "P0", state: "NOT_A_REAL_STATE", reason: "x", updatedAt: new Date().toISOString() }]);
    const ledger = new FounderDecisionLedger();
    expect(() => ScopeLock.loadFrom(store, path, ledger)).toThrow(CorruptPersistedPhaseLockError);
  });

  it(
    "P1 fix (37th independent review round, finding 11, 'live uniqueness invariant not enforced during " +
      "restore'): BLOCKER regression, exact reproduction — two persisted records sharing the SAME phaseId " +
      "fail the ENTIRE restore closed instead of the later one silently overwriting the earlier one",
    () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-scope-lock-dup-phase-"));
      const store = new FileStateStore();
      const path = join(tempRoot, "scope-lock.json");
      store.write(path, [
        { phaseId: "P0", state: "LOCKED_FOR_CLOSURE", reason: "first record", updatedAt: new Date().toISOString() },
        { phaseId: "P0", state: "OPEN", reason: "second, duplicate-phaseId record", updatedAt: new Date().toISOString() }
      ]);
      const ledger = new FounderDecisionLedger();
      expect(() => ScopeLock.loadFrom(store, path, ledger)).toThrow(CorruptPersistedPhaseLockError);
    }
  );

  it("no-regression: two persisted records for DIFFERENT phaseIds both restore correctly", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-scope-lock-two-phases-"));
    const store = new FileStateStore();
    const path = join(tempRoot, "scope-lock.json");
    const ledger = new FounderDecisionLedger();
    const lock = new ScopeLock(ledger);
    lock.lock("P0", "ready", CLEAN_REPORT, "d1");
    lock.lock("P1", "also ready", CLEAN_REPORT, "d2");
    lock.saveTo(store, path);

    const restored = ScopeLock.loadFrom(store, path, ledger);
    expect(restored.getState("P0")).toBe("LOCKED_FOR_CLOSURE");
    expect(restored.getState("P1")).toBe("LOCKED_FOR_CLOSURE");
  });
});

describe("BacklogRouter", () => {
  function makeItem(overrides: Partial<BacklogItem> = {}): BacklogItem {
    return { itemId: "item-1", phaseId: "P0", description: "a new ask", category: "FEATURE", ...overrides };
  }

  it("routes an item into an OPEN phase directly, with no decision-ledger entry required", () => {
    const ledger = new FounderDecisionLedger();
    const lock = new ScopeLock(ledger);
    const router = new BacklogRouter(lock, ledger);
    const record = router.route(makeItem());
    expect(record.decision).toBe("ACCEPT_INTO_PHASE");
    expect(ledger.allFor("P0")).toHaveLength(0);
  });

  it("BLOCKER: routes an item to the backlog once its phase is LOCKED_FOR_CLOSURE, and records the denial in the Decision Ledger", () => {
    const ledger = new FounderDecisionLedger();
    const lock = new ScopeLock(ledger);
    lock.lock("P0", "ready", CLEAN_REPORT, "d1");
    const router = new BacklogRouter(lock, ledger);
    const record = router.route(makeItem(), "d2");
    expect(record.decision).toBe("ROUTE_TO_BACKLOG");
    expect(ledger.allFor("P0")).toHaveLength(2); // lock + this routing denial
    expect(router.listBacklogged()).toHaveLength(1);
  });

  it("BLOCKER: routes an item to the backlog once its phase is CLOSED", () => {
    const ledger = new FounderDecisionLedger();
    const lock = new ScopeLock(ledger);
    lock.lock("P0", "ready", CLEAN_REPORT, "d1");
    lock.close("P0", "closed", CLEAN_REPORT, "d2");
    const router = new BacklogRouter(lock, ledger);
    const record = router.route(makeItem(), "d3");
    expect(record.decision).toBe("ROUTE_TO_BACKLOG");
  });

  it("requires a decisionId when routing to the backlog", () => {
    const ledger = new FounderDecisionLedger();
    const lock = new ScopeLock(ledger);
    lock.lock("P0", "ready", CLEAN_REPORT, "d1");
    const router = new BacklogRouter(lock, ledger);
    expect(() => router.route(makeItem())).toThrow(/requires a decisionId/);
  });

  it("rejects a duplicate itemId", () => {
    const ledger = new FounderDecisionLedger();
    const lock = new ScopeLock(ledger);
    const router = new BacklogRouter(lock, ledger);
    router.route(makeItem());
    expect(() => router.route(makeItem())).toThrow(DuplicateBacklogItemError);
  });

  it("no-regression: a later ACCEPT_INTO_PHASE routing for a DIFFERENT, still-OPEN phase is unaffected by an unrelated LOCKED phase", () => {
    const ledger = new FounderDecisionLedger();
    const lock = new ScopeLock(ledger);
    lock.lock("P0", "ready", CLEAN_REPORT, "d1");
    const router = new BacklogRouter(lock, ledger);
    const record = router.route(makeItem({ itemId: "item-2", phaseId: "P1" }));
    expect(record.decision).toBe("ACCEPT_INTO_PHASE");
  });

  it(
    "BLOCKER (35th independent review round, 'pre-audit transition exposure' root class): a decisionId " +
      "collision must never leave the item committed to the backlog with no audit trail",
    () => {
      const ledger = new FounderDecisionLedger();
      const lock = new ScopeLock(ledger);
      lock.lock("P0", "ready", CLEAN_REPORT, "d1");
      ledger.record("d2", "P0", "an unrelated, pre-existing decision", "test-setup");
      const router = new BacklogRouter(lock, ledger);
      expect(() => router.route(makeItem(), "d2")).toThrow(DuplicateDecisionError);
      expect(router.get("item-1")).toBeUndefined();
      expect(router.list()).toHaveLength(0);
    }
  );
});

describe("BacklogRouter: persistence", () => {
  let tempRoot: string;
  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  function makeItem(overrides: Partial<BacklogItem> = {}): BacklogItem {
    return { itemId: "item-1", phaseId: "P0", description: "a new ask", category: "FEATURE", ...overrides };
  }

  it("round-trips state through saveTo/loadFrom", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-backlog-router-"));
    const store = new FileStateStore();
    const path = join(tempRoot, "backlog.json");
    const ledger = new FounderDecisionLedger();
    const lock = new ScopeLock(ledger);
    lock.lock("P0", "ready", CLEAN_REPORT, "d1");
    const router = new BacklogRouter(lock, ledger);
    router.route(makeItem(), "d2");
    router.saveTo(store, path);

    const restored = BacklogRouter.loadFrom(store, path, lock, ledger);
    expect(restored.get("item-1")?.decision).toBe("ROUTE_TO_BACKLOG");
  });

  it(
    "P2 fix (37th independent review round, finding 12, 'live uniqueness invariant not enforced during " +
      "restore', same root class as ScopeLock.loadFrom()'s own fix): BLOCKER regression, exact reproduction " +
      "— two persisted records sharing the SAME itemId fail the ENTIRE restore closed instead of the later " +
      "one silently overwriting the earlier one (route()'s own live check already refuses this exact case)",
    () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-backlog-router-dup-item-"));
      const store = new FileStateStore();
      const path = join(tempRoot, "backlog.json");
      store.write(path, [
        {
          itemId: "item-1",
          phaseId: "P0",
          description: "first record",
          category: "FEATURE",
          decision: "ROUTE_TO_BACKLOG",
          routedAt: new Date().toISOString()
        },
        {
          itemId: "item-1",
          phaseId: "P1",
          description: "second, duplicate-itemId record",
          category: "FIX",
          decision: "ACCEPT_INTO_PHASE",
          routedAt: new Date().toISOString()
        }
      ]);
      const ledger = new FounderDecisionLedger();
      const lock = new ScopeLock(ledger);
      expect(() => BacklogRouter.loadFrom(store, path, lock, ledger)).toThrow(CorruptPersistedBacklogRecordError);
    }
  );

  it("no-regression: two persisted records for DIFFERENT itemIds both restore correctly", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-backlog-router-two-items-"));
    const store = new FileStateStore();
    const path = join(tempRoot, "backlog.json");
    const ledger = new FounderDecisionLedger();
    const lock = new ScopeLock(ledger);
    lock.lock("P0", "ready", CLEAN_REPORT, "d1");
    const router = new BacklogRouter(lock, ledger);
    router.route(makeItem(), "d2");
    router.route(makeItem({ itemId: "item-2", phaseId: "P1" }));
    router.saveTo(store, path);

    const restored = BacklogRouter.loadFrom(store, path, lock, ledger);
    expect(restored.get("item-1")?.decision).toBe("ROUTE_TO_BACKLOG");
    expect(restored.get("item-2")?.decision).toBe("ACCEPT_INTO_PHASE");
  });
});
