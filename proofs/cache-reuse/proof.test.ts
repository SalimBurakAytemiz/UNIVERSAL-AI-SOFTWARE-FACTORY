// Proof G (baseline section 306): "Cached valid work prevents
// recomputation." Simulates an expensive repository-analysis task that must
// only run once for the same input.
import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache, computeWithCache } from "../../runtime/cache/cache.js";
import { FileCache, computeWithFileCache } from "../../runtime/cache/file-cache.js";
import { FileStateStore } from "../../runtime/state/file-store.js";

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

describe("Proof G (durable variant): cached work survives a process restart, not just in-process reuse", () => {
  let tempRoot: string;

  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it("a SECOND, independent FileCache/FileStateStore instance reuses a result computed and persisted by a FIRST, now-discarded instance", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-proof-cache-restart-"));
    const path = join(tempRoot, "analysis-cache.json");
    const analyzeRepo = vi.fn(async () => ({ findings: 3 }));

    // "Process A": computes once, persists to disk, then is discarded entirely
    // (no reference to it or its FileStateStore is kept below).
    {
      const processA = new FileCache<{ findings: number }>(new FileStateStore(), path);
      const result = await computeWithFileCache(processA, "analysis:repo-x@commit-abc", analyzeRepo);
      expect(result.cached).toBe(false);
    }

    // "Process B" (simulated restart): a brand-new FileCache backed by a
    // brand-new FileStateStore, pointed at the same durable path. It must
    // NOT call analyzeRepo again.
    const processB = new FileCache<{ findings: number }>(new FileStateStore(), path);
    const result = await computeWithFileCache(processB, "analysis:repo-x@commit-abc", analyzeRepo);

    expect(result.cached).toBe(true);
    expect(result.value.findings).toBe(3);
    expect(analyzeRepo).toHaveBeenCalledTimes(1); // still only once, across the simulated restart
  });
});
