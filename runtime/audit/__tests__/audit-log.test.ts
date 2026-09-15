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

  describe(
    "P2 fix (32nd independent review round, finding 7, 'reject lossy audit values before hashing'): the 31st " +
      "round's own exemption for non-finite numbers is REVERSED here — NaN/Infinity/-Infinity all collapse to " +
      "the SAME JSON.stringify() sentinel (null), so the hash cannot actually distinguish which one was logged",
    () => {
      it("BLOCKER regression, exact reproduction: a NaN payload value is rejected before append", () => {
        const log = new AuditLog();
        expect(() =>
          log.append({
            type: "BAD",
            actor: "x",
            payload: { amountUsd: NaN },
            timestamp: new Date().toISOString()
          })
        ).toThrow(UnsupportedAuditPayloadError);
        expect(log.all()).toHaveLength(0);
      });

      it("BLOCKER regression: a positive Infinity payload value is rejected before append", () => {
        const log = new AuditLog();
        expect(() =>
          log.append({
            type: "BAD",
            actor: "x",
            payload: { amountUsd: Infinity },
            timestamp: new Date().toISOString()
          })
        ).toThrow(UnsupportedAuditPayloadError);
        expect(log.all()).toHaveLength(0);
      });

      it("BLOCKER regression: a negative Infinity payload value is rejected before append", () => {
        const log = new AuditLog();
        expect(() =>
          log.append({
            type: "BAD",
            actor: "x",
            payload: { amountUsd: -Infinity },
            timestamp: new Date().toISOString()
          })
        ).toThrow(UnsupportedAuditPayloadError);
        expect(log.all()).toHaveLength(0);
      });

      it("a non-finite number nested arbitrarily deep inside an otherwise-plain payload is still caught", () => {
        const log = new AuditLog();
        expect(() =>
          log.append({
            type: "BAD",
            actor: "x",
            payload: { outer: { list: [{ inner: NaN }] } },
            timestamp: new Date().toISOString()
          })
        ).toThrow(UnsupportedAuditPayloadError);
      });

      it(
        "root-cause proof: NaN, Infinity, -Infinity, and a literal null all collapse to the IDENTICAL " +
          "JSON.stringify() output — this is exactly why the hash could not distinguish them before this fix",
        () => {
          expect(JSON.stringify({ v: NaN })).toBe(JSON.stringify({ v: null }));
          expect(JSON.stringify({ v: Infinity })).toBe(JSON.stringify({ v: null }));
          expect(JSON.stringify({ v: -Infinity })).toBe(JSON.stringify({ v: null }));
        }
      );

      it("no regression: a genuinely finite number (including negative/zero/fractional) is still accepted", () => {
        const log = new AuditLog();
        const record = log.append({
          type: "OK",
          actor: "x",
          payload: { a: -5, b: 0, c: 3.14159 },
          timestamp: new Date().toISOString()
        });
        expect(log.all()).toHaveLength(1);
        expect(record.hash).toBeTruthy();
      });

      it("no regression: a literal null payload value remains accepted (it is not a number at all)", () => {
        const log = new AuditLog();
        expect(() =>
          log.append({ type: "OK", actor: "x", payload: { v: null }, timestamp: new Date().toISOString() })
        ).not.toThrow();
      });
    }
  );

  describe(
    "P1 fix (33rd independent review round, finding 4 / root class C, 'reject or canonicalize undefined audit " +
      "values before hashing'): an undefined value must never let the stored record and the hashed record " +
      "disagree about what the payload contains",
    () => {
      it(
        "root-cause proof: structuredClone() PRESERVES an undefined object property while JSON.stringify() " +
          "DROPS it — this divergence is exactly why the stored record and the hash used to disagree",
        () => {
          const cloned = structuredClone({ a: undefined, b: 1 });
          expect(Object.prototype.hasOwnProperty.call(cloned, "a")).toBe(true);
          expect(JSON.stringify(cloned)).toBe(JSON.stringify({ b: 1 }));
        }
      );

      it("BLOCKER regression, exact reproduction: an undefined object-property payload value no longer appears in the stored record, and the record's hash matches ONLY that stripped-down shape", () => {
        const log = new AuditLog();
        const timestamp = "2026-01-01T00:00:00.000Z";
        const record = log.append({
          type: "OK",
          actor: "x",
          payload: { decidedBy: undefined, keep: "value" },
          timestamp
        });

        // The key is gone entirely from the STORED record, not merely from
        // some separate hash-time view of it.
        expect(Object.prototype.hasOwnProperty.call(record.payload, "decidedBy")).toBe(false);
        expect(record.payload).toEqual({ keep: "value" });

        const expectedHash = createHash("sha256")
          .update(
            JSON.stringify({
              type: "OK",
              actor: "x",
              payload: { keep: "value" },
              timestamp,
              sequence: 0,
              previousHash: "0".repeat(64)
            })
          )
          .digest("hex");
        expect(record.hash).toBe(expectedHash);
      });

      it("BLOCKER regression: a record with an undefined field and a record that never had the field at all now hash IDENTICALLY (both stored AND hashed forms genuinely agree, rather than merely coincidentally matching)", () => {
        const withUndefined = new AuditLog();
        const withoutField = new AuditLog();
        const timestamp = "2026-01-01T00:00:00.000Z";

        const r1 = withUndefined.append({
          type: "OK",
          actor: "x",
          payload: { decidedBy: undefined, keep: "value" },
          timestamp
        });
        const r2 = withoutField.append({
          type: "OK",
          actor: "x",
          payload: { keep: "value" },
          timestamp
        });

        expect(r1.hash).toBe(r2.hash);
        expect(r1.payload).toEqual(r2.payload);
      });

      it("BLOCKER regression, exact reproduction: an undefined ARRAY element is rejected outright (no safe 'omit' equivalent — would otherwise collide with a legitimate null)", () => {
        const log = new AuditLog();
        const payload = { list: [1, undefined, 3] } as unknown as Record<string, unknown>;
        expect(() =>
          log.append({ type: "BAD", actor: "x", payload, timestamp: new Date().toISOString() })
        ).toThrow(UnsupportedAuditPayloadError);
        expect(log.all()).toHaveLength(0);
      });

      it("an undefined value nested arbitrarily deep inside an otherwise-plain object payload is still stripped, not just at the top level", () => {
        const log = new AuditLog();
        const record = log.append({
          type: "OK",
          actor: "x",
          payload: { outer: { inner: { droppedField: undefined, kept: 1 } } },
          timestamp: new Date().toISOString()
        });
        expect(record.payload).toEqual({ outer: { inner: { kept: 1 } } });
      });

      it("no regression: a payload with no undefined values at all is unaffected", () => {
        const log = new AuditLog();
        const record = log.append({
          type: "OK",
          actor: "x",
          payload: { a: 1, b: "two", c: null },
          timestamp: new Date().toISOString()
        });
        expect(record.payload).toEqual({ a: 1, b: "two", c: null });
      });

      it("no regression: verifyIntegrity() still passes for a chain containing a canonicalized (undefined-stripped) record", () => {
        const log = new AuditLog();
        log.append({ type: "A", actor: "x", payload: { skip: undefined, keep: 1 }, timestamp: new Date().toISOString() });
        log.append({ type: "B", actor: "x", payload: { keep: 2 }, timestamp: new Date().toISOString() });
        expect(log.verifyIntegrity()).toBe(true);
      });
    }
  );

  describe(
    "P1 fix (36th independent review round, finding 9, 'store __proto__ as normal audit data'): a " +
      "JSON-derived payload's own '__proto__' key must be stored (and hashed) as ordinary data, never " +
      "interpreted as the legacy prototype-mutation accessor",
    () => {
      it(
        "root-cause proof: bracket-assigning a '__proto__' key on a plain object invokes the inherited " +
          "accessor and mutates its prototype instead of creating an own property — this is exactly why " +
          "canonicalizeAuditValue() cannot use plain assignment",
        () => {
          const obj: Record<string, unknown> = {};
          obj["__proto__"] = { polluted: true };
          expect(Object.prototype.hasOwnProperty.call(obj, "__proto__")).toBe(false);
          expect(Object.getPrototypeOf(obj)).toEqual({ polluted: true });
        }
      );

      it(
        "BLOCKER regression, exact reproduction: a payload carrying its own '__proto__' data property " +
          "(set via a computed key, never the object-literal special form) is stored as an ordinary " +
          "own property — not silently dropped, and never applied as this object's actual prototype",
        () => {
          const log = new AuditLog();
          const timestamp = "2026-01-01T00:00:00.000Z";
          // A computed property key bypasses the object-literal special case
          // for `__proto__` (which sets the prototype) — this is exactly how
          // a JSON.parse()'d payload legitimately ends up with `__proto__`
          // as a genuine OWN property, since `JSON.parse('{"__proto__":1}')`
          // also produces an own data property, never a prototype change.
          const payload = { ["__proto__"]: { polluted: true }, keep: "value" };

          const record = log.append({ type: "OK", actor: "x", payload, timestamp });

          expect(Object.prototype.hasOwnProperty.call(record.payload, "__proto__")).toBe(true);
          expect((record.payload as Record<string, unknown>)["__proto__"]).toEqual({ polluted: true });
          expect(record.payload).toEqual({ ["__proto__"]: { polluted: true }, keep: "value" });
          // The record's OWN actual prototype must be entirely unaffected —
          // no prototype pollution occurred anywhere in the pipeline.
          expect(Object.getPrototypeOf(record.payload)).toBe(Object.prototype);

          const expectedHash = createHash("sha256")
            .update(
              JSON.stringify({
                type: "OK",
                actor: "x",
                payload: { ["__proto__"]: { polluted: true }, keep: "value" },
                timestamp,
                sequence: 0,
                previousHash: "0".repeat(64)
              })
            )
            .digest("hex");
          expect(record.hash).toBe(expectedHash);
        }
      );

      it("no regression: verifyIntegrity() still passes for a chain containing a record with an own '__proto__' payload key", () => {
        const log = new AuditLog();
        log.append({
          type: "A",
          actor: "x",
          payload: { ["__proto__"]: "not-a-real-prototype", keep: 1 },
          timestamp: new Date().toISOString()
        });
        log.append({ type: "B", actor: "x", payload: { keep: 2 }, timestamp: new Date().toISOString() });
        expect(log.verifyIntegrity()).toBe(true);
      });

      it("no regression: a payload with no '__proto__' key at all is unaffected", () => {
        const log = new AuditLog();
        const record = log.append({
          type: "OK",
          actor: "x",
          payload: { a: 1, b: "two" },
          timestamp: new Date().toISOString()
        });
        expect(record.payload).toEqual({ a: 1, b: "two" });
        expect(Object.getPrototypeOf(record.payload)).toBe(Object.prototype);
      });
    }
  );

  describe(
    "P1 fix (P0 closure remediation batch, root-cause class 2, 'sparse arrays silently changing " +
      "during JSON persistence'): canonicalizeAuditValue() must reject a hole in an array payload " +
      "field, never silently reproduce it the way Array.prototype.map() does",
    () => {
      it(
        "root-cause proof: Array.prototype.map() never invokes its callback for a genuine hole, " +
          "and silently reproduces the hole in the result — this is exactly why canonicalizeAuditValue() " +
          "cannot use .map() for arrays",
        () => {
          const sparse: unknown[] = [1, , 3];
          const mapped = sparse.map((x) => x);
          expect(Object.prototype.hasOwnProperty.call(mapped, 1)).toBe(false);
          expect(JSON.stringify(mapped)).toBe("[1,null,3]");
        }
      );

      it("BLOCKER regression, exact reproduction: a sparse array payload field is rejected, never silently hashed as if it had a null", () => {
        const log = new AuditLog();
        const sparse: unknown[] = [1, , 3];
        expect(() =>
          log.append({
            type: "OK",
            actor: "x",
            payload: { items: sparse },
            timestamp: new Date().toISOString()
          })
        ).toThrow(UnsupportedAuditPayloadError);
      });

      it("no regression: a genuinely dense array payload field is still stored and hashed normally", () => {
        const log = new AuditLog();
        const record = log.append({
          type: "OK",
          actor: "x",
          payload: { items: [1, 2, 3] },
          timestamp: new Date().toISOString()
        });
        expect(record.payload).toEqual({ items: [1, 2, 3] });
        expect(log.verifyIntegrity()).toBe(true);
      });
    }
  );
});
