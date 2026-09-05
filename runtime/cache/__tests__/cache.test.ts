import { describe, expect, it, vi } from "vitest";
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
});
