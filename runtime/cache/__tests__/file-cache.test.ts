import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStateStore } from "../../state/file-store.js";
import { FileCache, computeWithFileCache } from "../file-cache.js";

describe("FileCache (durable cache, backed by StateStore)", () => {
  let tempRoot: string;

  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it("Proof G still holds: a valid cached result prevents recomputation within one instance", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-"));
    const cache = new FileCache<string>(new FileStateStore(), join(tempRoot, "cache.json"));
    const expensiveCompute = vi.fn(async () => "expensive-result");

    const first = await computeWithFileCache(cache, "analysis:repo-x", expensiveCompute);
    const second = await computeWithFileCache(cache, "analysis:repo-x", expensiveCompute);

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.value).toBe("expensive-result");
    expect(expensiveCompute).toHaveBeenCalledTimes(1);
  });

  it("does not reuse an expired entry", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-"));
    const cache = new FileCache<string>(new FileStateStore(), join(tempRoot, "cache.json"));
    cache.set("k", "v", -1); // already expired
    expect(cache.get("k")).toBeUndefined();
  });

  it("recomputes for a different key", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-"));
    const cache = new FileCache<string>(new FileStateStore(), join(tempRoot, "cache.json"));
    const compute = vi.fn(async (k: string) => `result-${k}`);
    await computeWithFileCache(cache, "a", () => compute("a"));
    await computeWithFileCache(cache, "b", () => compute("b"));
    expect(compute).toHaveBeenCalledTimes(2);
  });

  describe("restart-recovery proof (BLOCKER fix: durability must not depend on the same in-memory instance)", () => {
    it("a SECOND, independent FileCache + FileStateStore instance reuses an entry written by a FIRST instance, without recomputation", async () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-restart-"));
      const path = join(tempRoot, "cache.json");
      const computeOnce = vi.fn(async () => "computed-by-process-a");

      // "Process A": computes once and persists, then goes out of scope.
      // No reference to `processA` or its FileStateStore survives past this block.
      {
        const processA = new FileCache<string>(new FileStateStore(), path);
        const result = await computeWithFileCache(processA, "shared-key", computeOnce);
        expect(result.cached).toBe(false);
      }

      // "Process B": a genuinely separate FileCache instance backed by a
      // genuinely separate FileStateStore instance, pointed at the same
      // durable path. It must find the entry WITHOUT calling computeOnce again.
      const processB = new FileCache<string>(new FileStateStore(), path);
      const resultB = await computeWithFileCache(processB, "shared-key", computeOnce);

      expect(resultB.cached).toBe(true);
      expect(resultB.value).toBe("computed-by-process-a");
      expect(computeOnce).toHaveBeenCalledTimes(1); // never recomputed by process B
    });

    it("get() on a fresh instance returns undefined for a key never written to that path", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-restart-"));
      const path = join(tempRoot, "cache.json");
      new FileCache<string>(new FileStateStore(), path).set("only-key", "value");

      const freshInstance = new FileCache<string>(new FileStateStore(), path);
      expect(freshInstance.get("missing-key")).toBeUndefined();
      expect(freshInstance.get("only-key")).toBe("value");
    });

    it("size() reflects entries persisted by a prior, now-discarded instance", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-restart-"));
      const path = join(tempRoot, "cache.json");
      {
        const processA = new FileCache<number>(new FileStateStore(), path);
        processA.set("a", 1);
        processA.set("b", 2);
      }
      const processB = new FileCache<number>(new FileStateStore(), path);
      expect(processB.size()).toBe(2);
    });

    it("an expired entry written by a prior instance is not reused by a fresh instance", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-restart-"));
      const path = join(tempRoot, "cache.json");
      {
        const processA = new FileCache<string>(new FileStateStore(), path);
        processA.set("stale", "old-value", -1); // already expired at write time
      }
      const processB = new FileCache<string>(new FileStateStore(), path);
      expect(processB.get("stale")).toBeUndefined();
      expect(processB.has("stale")).toBe(false);
    });
  });
});
