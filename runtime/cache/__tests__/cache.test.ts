import { afterEach, describe, expect, it, vi } from "vitest";
import { Cache, computeWithCache, InvalidTtlError } from "../cache.js";

describe("Cache / computeWithCache", () => {
  it("Proof G: a valid cached result prevents recomputation", async () => {
    const cache = new Cache<string>();
    const expensiveCompute = vi.fn(async () => "expensive-result");

    const first = await computeWithCache(cache, "analysis:repo-x", expensiveCompute);
    const second = await computeWithCache(cache, "analysis:repo-x", expensiveCompute);

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.value).toBe("expensive-result");
    expect(expensiveCompute).toHaveBeenCalledTimes(1); // never recomputed
  });

  it("does not reuse an expired cache entry", async () => {
    const cache = new Cache<string>();
    cache.set("k", "v", 0); // ttlMs: 0 -> already expired at the deadline (round 26's fix)
    expect(cache.get("k")).toBeUndefined();
  });

  it("recomputes for a different key", async () => {
    const cache = new Cache<string>();
    const compute = vi.fn(async (k: string) => `result-${k}`);
    await computeWithCache(cache, "a", () => compute("a"));
    await computeWithCache(cache, "b", () => compute("b"));
    expect(compute).toHaveBeenCalledTimes(2);
  });

  describe(
    "P2 fix (26th independent review round, finding 7, 'cache must expire at the deadline'): an entry is expired " +
      "when now >= expiresAt, not only when now > expiresAt — the previous strict '<' comparison let a value be " +
      "read back exactly on its expiry deadline (including a ttlMs: 0 entry read in the same millisecond it was set)",
    () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      it("now < expiresAt: the entry is still valid", () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        const cache = new Cache<string>();
        cache.set("k", "v", 100); // expiresAt = 1_000_100
        vi.setSystemTime(1_000_099);
        expect(cache.get("k")).toBe("v");
      });

      it("BLOCKER regression, exact reproduction: now === expiresAt is expired, not one more valid read", () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        const cache = new Cache<string>();
        cache.set("k", "v", 100); // expiresAt = 1_000_100
        vi.setSystemTime(1_000_100); // exactly the deadline
        expect(cache.get("k")).toBeUndefined();
      });

      it("now > expiresAt: the entry is expired", () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        const cache = new Cache<string>();
        cache.set("k", "v", 100);
        vi.setSystemTime(1_000_101);
        expect(cache.get("k")).toBeUndefined();
      });

      it("ttlMs: 0 never survives its own expiration boundary, even read back at the exact same instant it was set", () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_000_000);
        const cache = new Cache<string>();
        cache.set("k", "v", 0); // expiresAt === computedAt === now
        expect(cache.get("k")).toBeUndefined();
      });

      it("an expired entry is actually removed from the store (size() reflects the deletion), not merely hidden from get()", () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        const cache = new Cache<string>();
        cache.set("k", "v", 0);
        expect(cache.get("k")).toBeUndefined();
        expect(cache.size()).toBe(0);
      });
    }
  );

  describe("P2 fix (34th independent review round, finding 10, 'distinguish cached undefined from cache miss')", () => {
    it(
      "BLOCKER regression, exact reproduction: compute() returns undefined -> the SECOND call reports a cache " +
        "hit and never recomputes",
      async () => {
        const cache = new Cache<string | undefined>();
        const compute = vi.fn(async () => undefined);

        const first = await computeWithCache(cache, "k", compute);
        const second = await computeWithCache(cache, "k", compute);

        expect(first.cached).toBe(false);
        expect(second.cached).toBe(true);
        expect(second.value).toBeUndefined();
        expect(compute).toHaveBeenCalledTimes(1); // never recomputed
      }
    );

    it("BLOCKER regression: has() reports true for a key whose cached value is genuinely undefined", () => {
      const cache = new Cache<string | undefined>();
      cache.set("k", undefined);
      expect(cache.has("k")).toBe(true);
    });

    it("no regression: has() still reports false for a genuine miss", () => {
      const cache = new Cache<string | undefined>();
      expect(cache.has("k")).toBe(false);
    });

    it("lookup() distinguishes an expired entry (found: false) from a live undefined value (found: true)", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      const cache = new Cache<string | undefined>();
      cache.set("expired", "v", 0);
      cache.set("live-undefined", undefined);

      expect(cache.lookup("expired")).toEqual({ found: false, value: undefined });
      expect(cache.lookup("live-undefined")).toEqual({ found: true, value: undefined });
      expect(cache.lookup("never-set")).toEqual({ found: false, value: undefined });
      vi.useRealTimers();
    });
  });

  describe("P2 fix (34th independent review round, finding 11, 'validate TTL values before persisting')", () => {
    it.each([NaN, Infinity, -Infinity, -1, -100])(
      "BLOCKER regression, exact reproduction: set() rejects a non-finite/negative ttlMs (%s)",
      (ttlMs) => {
        const cache = new Cache<string>();
        expect(() => cache.set("k", "v", ttlMs)).toThrow(InvalidTtlError);
        expect(cache.has("k")).toBe(false); // rejected BEFORE persisting
      }
    );

    it("no regression: ttlMs: 0 (immediately-expiring) remains explicitly valid", () => {
      const cache = new Cache<string>();
      expect(() => cache.set("k", "v", 0)).not.toThrow();
    });

    it("no regression: a genuinely positive ttlMs remains valid", () => {
      const cache = new Cache<string>();
      expect(() => cache.set("k", "v", 1000)).not.toThrow();
      expect(cache.get("k")).toBe("v");
    });

    it("no regression: omitting ttlMs entirely (no expiration) remains valid", () => {
      const cache = new Cache<string>();
      expect(() => cache.set("k", "v")).not.toThrow();
    });
  });

  describe(
    "P2 fix (independent Codex review's own narrow root-cause audit, same class as file-cache.ts's " +
      "'deduplicate concurrent durable cache computations'): concurrent computeWithCache() calls for the " +
      "SAME missing key must single-flight, never both run compute()",
    () => {
      it("BLOCKER regression, exact reproduction: two concurrent calls for the same missing key run compute() exactly once", async () => {
        const cache = new Cache<string>();
        let computeCalls = 0;
        const compute = async () => {
          computeCalls++;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return "computed-value";
        };

        const [first, second] = await Promise.all([
          computeWithCache(cache, "shared-key", compute),
          computeWithCache(cache, "shared-key", compute)
        ]);

        expect(computeCalls).toBe(1);
        expect(first.value).toBe("computed-value");
        expect(second.value).toBe("computed-value");
        expect([first.cached, second.cached].sort()).toEqual([false, true]);
        expect(cache.get("shared-key")).toBe("computed-value");
      });

      it("high-contention: 5 concurrent calls for the same missing key still run compute() exactly once", async () => {
        const cache = new Cache<string>();
        let computeCalls = 0;
        const compute = async () => {
          computeCalls++;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return "the-one-true-value";
        };

        const results = await Promise.all(
          Array.from({ length: 5 }, () => computeWithCache(cache, "hot-key", compute))
        );

        expect(computeCalls).toBe(1);
        for (const r of results) expect(r.value).toBe("the-one-true-value");
        expect(results.filter((r) => !r.cached)).toHaveLength(1);
      });

      it("a compute() failure is never cached as a success, and does not permanently block a subsequent retry for the same key", async () => {
        const cache = new Cache<string>();
        let caught: unknown;
        try {
          await computeWithCache(cache, "flaky-key", () => {
            throw new Error("simulated failure");
          });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toBe("simulated failure");

        expect(cache.has("flaky-key")).toBe(false);

        const retry = await computeWithCache(cache, "flaky-key", () => "recovered-value");
        expect(retry).toEqual({ value: "recovered-value", cached: false });
      });

      it("no-regression: concurrent calls for DIFFERENT keys each compute independently", async () => {
        const cache = new Cache<string>();
        const calls: string[] = [];
        const compute = async (key: string) => {
          calls.push(key);
          return `value-${key}`;
        };

        const [a, b] = await Promise.all([
          computeWithCache(cache, "key-a", () => compute("key-a")),
          computeWithCache(cache, "key-b", () => compute("key-b"))
        ]);

        expect(calls.sort()).toEqual(["key-a", "key-b"]);
        expect(a).toEqual({ value: "value-key-a", cached: false });
        expect(b).toEqual({ value: "value-key-b", cached: false });
      });
    }
  );
});
