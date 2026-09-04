// Proof G (baseline section 306): "Cached valid work prevents
// recomputation." Simulates an expensive repository-analysis task that must
// only run once for the same input.
import { describe, expect, it, vi } from "vitest";
import { Cache, computeWithCache } from "../../runtime/cache/cache.js";

describe("Proof: Cache prevents recomputation of valid results", () => {
  it("runs an expensive repository analysis exactly once across three sequential identical requests", async () => {
    const cache = new Cache<{ findings: number }>();
    const analyzeRepo = vi.fn(async () => ({ findings: 3 }));

    const first = await computeWithCache(cache, "analysis:repo-x@commit-abc", analyzeRepo);
    const second = await computeWithCache(cache, "analysis:repo-x@commit-abc", analyzeRepo);
    const third = await computeWithCache(cache, "analysis:repo-x@commit-abc", analyzeRepo);

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(third.cached).toBe(true);
    expect(third.value.findings).toBe(3);
    expect(analyzeRepo).toHaveBeenCalledTimes(1);
  });
});
