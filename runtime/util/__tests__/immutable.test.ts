import { describe, expect, it } from "vitest";
import { deepFreeze, deepFreezeClone, freezeRecord } from "../immutable.js";

describe(
  "P1 fix (independent Codex review, 'traverse symbol keys when deep-freezing configuration'): deepFreeze() " +
    "must reach every own property Reflect.ownKeys() reports, not just string-keyed ones",
  () => {
    it(
      "BLOCKER regression, exact reproduction: a nested object stored behind a symbol key must be frozen too " +
        "— a caller retaining a reference to it can no longer mutate it after deepFreeze()",
      () => {
        const secretKey = Symbol("config");
        const provider: Record<PropertyKey, unknown> = {};
        const nested = { endpoint: "A" };
        provider[secretKey] = nested;

        deepFreeze(provider);

        expect(Object.isFrozen(nested)).toBe(true);
        expect(() => {
          (nested as { endpoint: string }).endpoint = "B";
        }).toThrow(TypeError);
        expect(nested.endpoint).toBe("A");
        expect((provider[secretKey] as { endpoint: string }).endpoint).toBe("A");
      }
    );

    it(
      "BLOCKER regression: an already-frozen ROOT with a mutable symbol-keyed descendant is still deep-frozen " +
        "(mirrors the 37th round's own already-frozen-root fix, extended to symbol keys)",
      () => {
        const secretKey = Symbol("config");
        const nested = { endpoint: "A" };
        const provider = Object.freeze({ [secretKey]: nested } as Record<PropertyKey, unknown>);

        expect(Object.isFrozen(provider)).toBe(true);
        expect(Object.isFrozen(nested)).toBe(false);

        deepFreeze(provider);

        expect(Object.isFrozen(nested)).toBe(true);
        expect(() => {
          (nested as { endpoint: string }).endpoint = "B";
        }).toThrow(TypeError);
      }
    );

    it("no regression: a plain string-keyed nested object is still frozen exactly as before", () => {
      const nested = { endpoint: "A" };
      const root = { config: nested };
      deepFreeze(root);
      expect(Object.isFrozen(nested)).toBe(true);
      expect(() => {
        (nested as { endpoint: string }).endpoint = "B";
      }).toThrow(TypeError);
    });

    it("no regression: a genuine reference cycle (string-keyed) still terminates safely", () => {
      const node: Record<string, unknown> = { name: "n" };
      node.self = node;
      expect(() => deepFreeze(node)).not.toThrow();
      expect(Object.isFrozen(node)).toBe(true);
    });

    it("no regression: a genuine reference cycle reached via a symbol key still terminates safely", () => {
      const cycleKey = Symbol("cycle");
      const node: Record<PropertyKey, unknown> = { name: "n" };
      node[cycleKey] = node;
      expect(() => deepFreeze(node)).not.toThrow();
      expect(Object.isFrozen(node)).toBe(true);
    });

    it("no regression: deepFreezeClone() still detaches and freezes a plain object graph", () => {
      const original = { nested: { endpoint: "A" } };
      const cloned = deepFreezeClone(original);
      expect(cloned).not.toBe(original);
      expect(cloned.nested).not.toBe(original.nested);
      expect(Object.isFrozen(cloned)).toBe(true);
      expect(Object.isFrozen(cloned.nested)).toBe(true);
      original.nested.endpoint = "B";
      expect(cloned.nested.endpoint).toBe("A");
    });

    it("no regression: freezeRecord() is unaffected by this fix (still shallow + array fields only)", () => {
      const record = freezeRecord({ id: "x", tags: ["a", "b"] });
      expect(Object.isFrozen(record)).toBe(true);
      expect(Object.isFrozen(record.tags)).toBe(true);
    });
  }
);
