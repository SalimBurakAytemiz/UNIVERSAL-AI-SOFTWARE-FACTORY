import { afterEach, describe, expect, it, vi } from "vitest";
import { Cache, computeWithCache } from "../cache.js";

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
    cache.set("k", "v", -1); // already expired
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
});
