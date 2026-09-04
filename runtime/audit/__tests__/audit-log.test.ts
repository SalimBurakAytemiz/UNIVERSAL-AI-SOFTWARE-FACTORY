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
});
