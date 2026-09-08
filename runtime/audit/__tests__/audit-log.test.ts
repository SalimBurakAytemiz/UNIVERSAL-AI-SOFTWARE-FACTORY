import { describe, expect, it } from "vitest";
import { AuditLog, UnsupportedAuditPayloadError } from "../audit-log.js";
import { createHash } from "node:crypto";

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

  it("a returned record's nested payload can no longer be tampered with at all (deep-freeze fix supersedes hash-only detection)", () => {
    // Historically this test mutated a returned record's nested payload
    // in place and asserted verifyIntegrity() caught it AFTER THE FACT.
    // Since the round-4 deep-ownership fix, that mutation attempt is
    // prevented OUTRIGHT (TypeError), which is a strictly stronger
    // guarantee — see the "audit payload deep-ownership" describe block
    // below for the full regression suite.
    const log = new AuditLog();
    log.append({ type: "A", actor: "x", payload: { amount: 1 }, timestamp: new Date().toISOString() });
    log.append({ type: "B", actor: "x", payload: {}, timestamp: new Date().toISOString() });

    const records = log.all() as unknown as { payload: Record<string, unknown> }[];
    expect(() => {
      records[0]!.payload.amount = 9999;
    }).toThrow(TypeError);

    expect(log.verifyIntegrity()).toBe(true); // nothing was actually tampered with
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

  describe("P1 fix (4th independent review round): audit payload deep-ownership (nested mutation cannot reach authoritative state)", () => {
    it("mutating the ORIGINAL payload object after append() does not change the stored audit record", () => {
      const log = new AuditLog();
      const originalPayload: { amount: number } = { amount: 1 };
      log.append({ type: "SPEND", actor: "x", payload: originalPayload, timestamp: new Date().toISOString() });

      originalPayload.amount = 9999; // caller mutates the object they originally passed in

      expect(log.all()[0]!.payload).toEqual({ amount: 1 });
    });

    it("mutating a NESTED object inside the original payload after append() does not change the stored record", () => {
      const log = new AuditLog();
      const originalPayload: { detail: { amount: number } } = { detail: { amount: 1 } };
      log.append({ type: "SPEND", actor: "x", payload: originalPayload, timestamp: new Date().toISOString() });

      originalPayload.detail.amount = 9999;

      expect(log.all()[0]!.payload).toEqual({ detail: { amount: 1 } });
    });

    it("mutating an ARRAY inside the original payload after append() does not change the stored record", () => {
      const log = new AuditLog();
      const originalPayload: { items: number[] } = { items: [1, 2, 3] };
      log.append({ type: "BATCH", actor: "x", payload: originalPayload, timestamp: new Date().toISOString() });

      originalPayload.items.push(999);
      originalPayload.items[0] = -1;

      expect(log.all()[0]!.payload).toEqual({ items: [1, 2, 3] });
    });

    it("mutating the RETURN VALUE of append() (including nested payload) throws and never changes stored state", () => {
      const log = new AuditLog();
      const record = log.append({
        type: "SPEND",
        actor: "x",
        payload: { detail: { amount: 1 }, items: [1, 2] },
        timestamp: new Date().toISOString()
      });

      expect(() => {
        (record.payload as { detail: { amount: number } }).detail.amount = 9999;
      }).toThrow(TypeError);
      expect(() => {
        (record.payload as { items: number[] }).items.push(999);
      }).toThrow(TypeError);

      expect(log.all()[0]!.payload).toEqual({ detail: { amount: 1 }, items: [1, 2] });
    });

    it("mutating a get()/all() result (including nested payload) throws and never changes stored state", () => {
      const log = new AuditLog();
      log.append({
        type: "SPEND",
        actor: "x",
        payload: { detail: { amount: 1 }, items: [1, 2] },
        timestamp: new Date().toISOString()
      });

      const [record] = log.all();
      expect(() => {
        (record!.payload as { detail: { amount: number } }).detail.amount = 9999;
      }).toThrow(TypeError);
      expect(() => {
        (record!.payload as { items: number[] }).items.push(999);
      }).toThrow(TypeError);

      expect(log.all()[0]!.payload).toEqual({ detail: { amount: 1 }, items: [1, 2] });
    });

    it("mutating a nested object obtained by reading INTO a returned payload throws (deep, not shallow, freeze)", () => {
      const log = new AuditLog();
      log.append({
        type: "SPEND",
        actor: "x",
        payload: { detail: { nested: { deep: { amount: 1 } } } },
        timestamp: new Date().toISOString()
      });

      const [record] = log.all();
      const deepRef = (record!.payload as { detail: { nested: { deep: { amount: number } } } }).detail.nested.deep;
      expect(() => {
        deepRef.amount = 9999;
      }).toThrow(TypeError);
    });

    it("previously written audit evidence remains structurally equivalent across many reads", () => {
      const log = new AuditLog();
      const appended = log.append({
        type: "SPEND",
        actor: "x",
        payload: { detail: { amount: 1 }, items: [1, 2, 3] },
        timestamp: "2026-01-01T00:00:00.000Z"
      });

      const readBack = log.all()[0]!;
      expect(readBack).toEqual(appended);
      expect(readBack.sequence).toBe(appended.sequence);
      expect(readBack.hash).toBe(appended.hash);
    });

    it("audit ordering, sequence numbers, and timestamps are unaffected by the ownership fix", () => {
      const log = new AuditLog();
      const a = log.append({ type: "A", actor: "x", payload: {}, timestamp: "2026-01-01T00:00:00.000Z" });
      const b = log.append({ type: "B", actor: "x", payload: {}, timestamp: "2026-01-01T00:00:01.000Z" });

      expect(a.sequence).toBe(0);
      expect(b.sequence).toBe(1);
      expect(b.previousHash).toBe(a.hash);
      expect(log.all().map((r) => r.type)).toEqual(["A", "B"]);
    });

    it("a non-serializable payload value (e.g. a function) fails closed rather than silently dropping data", () => {
      const log = new AuditLog();
      const unsupportedPayload = { handler: () => {} } as unknown as Record<string, unknown>;
      expect(() =>
        log.append({ type: "BAD", actor: "x", payload: unsupportedPayload, timestamp: new Date().toISOString() })
      ).toThrow();
      expect(log.all()).toHaveLength(0); // nothing was partially recorded
    });
  });

  describe("P1 fix (25th independent review round, 'audit records must be runtime-private and append-only')", () => {
    it("the internal records array is not reachable as an ordinary JS property (real encapsulation, not just TS `private`)", () => {
      const log = new AuditLog();
      log.append({ type: "A", actor: "x", payload: {}, timestamp: "2026-01-01T00:00:00.000Z" });

      expect((log as unknown as Record<string, unknown>).records).toBeUndefined();
      expect((log as unknown as Record<string, unknown>)["records"]).toBeUndefined();
    });

    it("no reflection API (Object.getOwnPropertyNames / Reflect.ownKeys) exposes the private records array", () => {
      const log = new AuditLog();
      log.append({ type: "A", actor: "x", payload: {}, timestamp: "2026-01-01T00:00:00.000Z" });

      expect(Object.getOwnPropertyNames(log)).not.toContain("records");
      expect(Reflect.ownKeys(log).map(String)).not.toContain("records");
    });

    it("REGRESSION: a plain JS consumer cannot push a fabricated record, delete one, or reorder history via property access", () => {
      const log = new AuditLog();
      log.append({ type: "A", actor: "x", payload: {}, timestamp: "2026-01-01T00:00:00.000Z" });
      log.append({ type: "B", actor: "x", payload: {}, timestamp: "2026-01-01T00:00:01.000Z" });

      const forged = (log as unknown as Record<string, unknown>).records as unknown[] | undefined;
      expect(forged).toBeUndefined(); // there is nothing to .push()/.splice() on at all

      // A forged object shaped like the class also finds nothing to attach to.
      const spread: Record<string, unknown> = { ...log };
      expect(spread.records).toBeUndefined();

      expect(log.all().map((r) => r.type)).toEqual(["A", "B"]);
      expect(log.verifyIntegrity()).toBe(true);
    });
  });

  describe(
    "P1 fix (31st independent review round, finding 7, 'reject or canonically serialize non-JSON audit " +
      "payloads'): a payload value JSON.stringify() would silently mis-serialize must be rejected BEFORE " +
      "the record's hash is computed or it is appended",
    () => {
      it("BLOCKER regression, exact reproduction: a Map payload value is rejected before append, never silently mis-hashed as '{}'", () => {
        const log = new AuditLog();
        const payload = { m: new Map([["k", "v"]]) } as unknown as Record<string, unknown>;

        expect(() => log.append({ type: "BAD", actor: "x", payload, timestamp: new Date().toISOString() })).toThrow(
          UnsupportedAuditPayloadError
        );
        expect(log.all()).toHaveLength(0); // nothing was partially recorded
      });

      it("a Set payload value is likewise rejected before append", () => {
        const log = new AuditLog();
        const payload = { s: new Set([1, 2, 3]) } as unknown as Record<string, unknown>;

        expect(() => log.append({ type: "BAD", actor: "x", payload, timestamp: new Date().toISOString() })).toThrow(
          UnsupportedAuditPayloadError
        );
        expect(log.all()).toHaveLength(0);
      });

      it("a Date payload value is rejected too (JSON.stringify() would silently convert it to a string, not preserve the instance the caller passed)", () => {
        const log = new AuditLog();
        const payload = { d: new Date("2026-01-01T00:00:00.000Z") } as unknown as Record<string, unknown>;

        expect(() => log.append({ type: "BAD", actor: "x", payload, timestamp: new Date().toISOString() })).toThrow(
          UnsupportedAuditPayloadError
        );
      });

      it("a Map/Set nested arbitrarily deep inside an otherwise-plain payload is still caught", () => {
        const log = new AuditLog();
        const payload = { outer: { list: [{ inner: new Map() }] } } as unknown as Record<string, unknown>;

        expect(() => log.append({ type: "BAD", actor: "x", payload, timestamp: new Date().toISOString() })).toThrow(
          UnsupportedAuditPayloadError
        );
      });

      it("no regression: NaN/Infinity amounts are still accepted (deliberately logged as forensic evidence of a rejected invalid amount elsewhere in this codebase)", () => {
        const log = new AuditLog();
        const record = log.append({
          type: "BUDGET_INVALID_AMOUNT_REJECTED",
          actor: "budget-guard",
          payload: { projectedAmountUsd: NaN, other: Infinity },
          timestamp: new Date().toISOString()
        });
        expect(log.all()).toHaveLength(1);
        expect(record.hash).toBeTruthy();
      });

      it("no regression: an ordinary plain-object/array/string/number/boolean/null payload still hashes deterministically and matches a hand-computed SHA-256 of its own canonical JSON", () => {
        const log = new AuditLog();
        const timestamp = "2026-01-01T00:00:00.000Z";
        const record = log.append({
          type: "ORDINARY",
          actor: "x",
          payload: { a: 1, b: "two", c: [true, false, null], d: { nested: "value" } },
          timestamp
        });

        const expectedHash = createHash("sha256")
          .update(
            JSON.stringify({
              type: "ORDINARY",
              actor: "x",
              payload: { a: 1, b: "two", c: [true, false, null], d: { nested: "value" } },
              timestamp,
              sequence: 0,
              previousHash: "0".repeat(64)
            })
          )
          .digest("hex");
        expect(record.hash).toBe(expectedHash);
        expect(log.verifyIntegrity()).toBe(true);
      });
    }
  );
});
