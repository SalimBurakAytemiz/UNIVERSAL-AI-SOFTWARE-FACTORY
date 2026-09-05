import { describe, expect, it } from "vitest";
import { AuditLog } from "../audit-log.js";

describe("AuditLog", () => {
  it("appends records with an incrementing sequence and hash chain", () => {
    const log = new AuditLog();
    const first = log.append({ type: "POLICY_DECISION", actor: "policy-engine", payload: { decision: "ALLOW" }, timestamp: new Date().toISOString() });
    const second = log.append({ type: "POLICY_DECISION", actor: "policy-engine", payload: { decision: "DENY" }, timestamp: new Date().toISOString() });

    expect(first.sequence).toBe(0);
    expect(second.sequence).toBe(1);
    expect(second.previousHash).toBe(first.hash);
    expect(log.all()).toHaveLength(2);
  });

  it("verifies integrity of an untampered chain", () => {
    const log = new AuditLog();
    log.append({ type: "A", actor: "x", payload: {}, timestamp: new Date().toISOString() });
    log.append({ type: "B", actor: "x", payload: {}, timestamp: new Date().toISOString() });
    expect(log.verifyIntegrity()).toBe(true);
  });

  it("detects tampering with a historical record", () => {
    const log = new AuditLog();
    log.append({ type: "A", actor: "x", payload: { amount: 1 }, timestamp: new Date().toISOString() });
    log.append({ type: "B", actor: "x", payload: {}, timestamp: new Date().toISOString() });

    const records = log.all() as unknown as { payload: Record<string, unknown> }[];
    // Simulate tampering: mutate a historical payload in place.
    records[0]!.payload.amount = 9999;

    expect(log.verifyIntegrity()).toBe(false);
  });

  describe("P1 cross-cutting fix: all() cannot be used to inject or silently remove records", () => {
    it("push()-ing a fabricated record onto the array returned by all() does not affect the internal log", () => {
      const log = new AuditLog();
      log.append({ type: "A", actor: "x", payload: {}, timestamp: new Date().toISOString() });

      const leaked = log.all() as unknown as { push: (r: unknown) => number };
      leaked.push({
        type: "FORGED",
        actor: "attacker",
        payload: {},
        timestamp: new Date().toISOString(),
        sequence: 999,
        previousHash: "0".repeat(64),
        hash: "f".repeat(64)
      });

      expect(log.all()).toHaveLength(1); // the forged entry never reached internal state
      expect(log.verifyIntegrity()).toBe(true);
    });

    it("splice()-ing the array returned by all() cannot silently delete the last record undetected", () => {
      const log = new AuditLog();
      log.append({ type: "A", actor: "x", payload: {}, timestamp: new Date().toISOString() });
      log.append({ type: "B", actor: "x", payload: {}, timestamp: new Date().toISOString() });

      const leaked = log.all() as unknown as { splice: (start: number, count: number) => unknown };
      leaked.splice(1, 1); // attempt to silently drop the most recent record

      expect(log.all()).toHaveLength(2); // internal history is untouched
      expect(log.verifyIntegrity()).toBe(true);
    });

    it("mutating a top-level field on a returned record throws instead of silently succeeding (frozen snapshot)", () => {
      const log = new AuditLog();
      const record = log.append({ type: "A", actor: "x", payload: {}, timestamp: new Date().toISOString() });

      expect(() => {
        (record as { type: string }).type = "FORGED";
      }).toThrow(TypeError);

      expect(log.all()[0]!.type).toBe("A");
    });

    it("all() returns a fresh array/object on every call — no shared mutable identity to leak", () => {
      const log = new AuditLog();
      log.append({ type: "A", actor: "x", payload: {}, timestamp: new Date().toISOString() });

      const first = log.all();
      const second = log.all();
      expect(first).not.toBe(second);
      expect(first[0]).not.toBe(second[0]);
      expect(first).toEqual(second);
    });
  });
});
