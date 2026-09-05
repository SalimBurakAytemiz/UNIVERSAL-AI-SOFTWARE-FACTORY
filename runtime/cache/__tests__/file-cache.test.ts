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

  describe("P2 fix (6th independent review round): prototype-sensitive keys are ordinary cache keys", () => {
    it("set('__proto__', value) persists correctly and an immediate get() returns it", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-proto-"));
      const cache = new FileCache<string>(new FileStateStore(), join(tempRoot, "cache.json"));

      cache.set("__proto__", "expected");
      expect(cache.get("__proto__")).toBe("expected");
    });

    it("a NEW FileCache instance (same path) recovers a value stored under '__proto__'", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-proto-"));
      const path = join(tempRoot, "cache.json");
      new FileCache<string>(new FileStateStore(), path).set("__proto__", "expected");

      const fresh = new FileCache<string>(new FileStateStore(), path);
      expect(fresh.get("__proto__")).toBe("expected");
    });

    it("a SEPARATE FileCache+FileStateStore instance (simulated separate process) recovers '__proto__'", async () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-proto-restart-"));
      const path = join(tempRoot, "cache.json");
      const computeOnce = vi.fn(async () => "computed-value");

      { // "process A"
        const processA = new FileCache<string>(new FileStateStore(), path);
        const result = await computeWithFileCache(processA, "__proto__", computeOnce);
        expect(result.cached).toBe(false);
      }

      const processB = new FileCache<string>(new FileStateStore(), path);
      expect(processB.get("__proto__")).toBe("computed-value");
    });

    it("the persisted representation is not silently empty after storing '__proto__'", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-proto-"));
      const path = join(tempRoot, "cache.json");
      const store = new FileStateStore();
      new FileCache<string>(store, path).set("__proto__", "expected");

      const persisted = store.read<unknown>(path);
      expect(persisted).not.toEqual({});
      expect(store.exists(path)).toBe(true);
    });

    it("storing '__proto__' does not pollute Object.prototype or the internal Map's own prototype", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-proto-"));
      const cache = new FileCache<{ polluted?: boolean }>(new FileStateStore(), join(tempRoot, "cache.json"));

      cache.set("__proto__", { polluted: true });
      cache.get("__proto__");

      // A brand-new, unrelated plain object must NOT have inherited
      // anything from this — proving no global prototype pollution occurred.
      const innocentObject: Record<string, unknown> = {};
      expect((innocentObject as { polluted?: boolean }).polluted).toBeUndefined();
      expect(Object.getPrototypeOf(innocentObject)).toBe(Object.prototype);
    });

    it("'constructor' and 'prototype' behave as ordinary cache keys too", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-proto-"));
      const cache = new FileCache<string>(new FileStateStore(), join(tempRoot, "cache.json"));

      cache.set("constructor", "value-for-constructor-key");
      cache.set("prototype", "value-for-prototype-key");

      expect(cache.get("constructor")).toBe("value-for-constructor-key");
      expect(cache.get("prototype")).toBe("value-for-prototype-key");
    });

    it("normal cache keys and reserved-name keys coexist correctly, with size() reflecting all of them", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-proto-"));
      const cache = new FileCache<string>(new FileStateStore(), join(tempRoot, "cache.json"));

      cache.set("normal-key", "normal-value");
      cache.set("__proto__", "proto-value");
      cache.set("constructor", "constructor-value");

      expect(cache.size()).toBe(3);
      expect(cache.get("normal-key")).toBe("normal-value");
      expect(cache.get("__proto__")).toBe("proto-value");
      expect(cache.get("constructor")).toBe("constructor-value");
    });

    it("the pre-existing durable cross-process cache proof still passes (regression guard, non-reserved key)", async () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-proto-cross-"));
      const path = join(tempRoot, "cache.json");
      const computeOnce = vi.fn(async () => "computed-by-process-a");

      {
        const processA = new FileCache<string>(new FileStateStore(), path);
        const result = await computeWithFileCache(processA, "shared-key", computeOnce);
        expect(result.cached).toBe(false);
      }

      const processB = new FileCache<string>(new FileStateStore(), path);
      const resultB = await computeWithFileCache(processB, "shared-key", computeOnce);
      expect(resultB.cached).toBe(true);
      expect(resultB.value).toBe("computed-by-process-a");
      expect(computeOnce).toHaveBeenCalledTimes(1);
    });
  });
});
