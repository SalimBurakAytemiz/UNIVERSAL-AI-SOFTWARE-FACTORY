import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStateStore } from "../../state/file-store.js";
import { FileCache, computeWithFileCache } from "../file-cache.js";
import { InvalidTtlError } from "../cache.js";

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
    cache.set("k", "v", 0); // ttlMs: 0 -> already expired at the deadline (round 26's fix)
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
        processA.set("stale", "old-value", 0); // ttlMs: 0 -> already expired at write time (round 26's fix)
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

  describe(
    "P2 fix (26th independent review round, finding 7, 'cache must expire at the deadline'): identical >= boundary " +
      "semantics as cache.ts's Cache.get(), applied to BOTH FileCache.get()'s initial check and its lock-protected " +
      "re-check",
    () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      it("now < expiresAt: the durable entry is still valid", () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-expiry-"));
        const cache = new FileCache<string>(new FileStateStore(), join(tempRoot, "cache.json"));
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        cache.set("k", "v", 100); // expiresAt = 1_000_100
        vi.setSystemTime(1_000_099);
        expect(cache.get("k")).toBe("v");
      });

      it("BLOCKER regression, exact reproduction: now === expiresAt is expired, not one more valid read", () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-expiry-"));
        const cache = new FileCache<string>(new FileStateStore(), join(tempRoot, "cache.json"));
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        cache.set("k", "v", 100); // expiresAt = 1_000_100
        vi.setSystemTime(1_000_100); // exactly the deadline
        expect(cache.get("k")).toBeUndefined();
      });

      it("now > expiresAt: the durable entry is expired", () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-expiry-"));
        const cache = new FileCache<string>(new FileStateStore(), join(tempRoot, "cache.json"));
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        cache.set("k", "v", 100);
        vi.setSystemTime(1_000_101);
        expect(cache.get("k")).toBeUndefined();
      });

      it("ttlMs: 0 never survives its own expiration boundary, even read back at the exact same instant it was set", () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-expiry-"));
        const cache = new FileCache<string>(new FileStateStore(), join(tempRoot, "cache.json"));
        vi.useFakeTimers();
        vi.setSystemTime(2_000_000);
        cache.set("k", "v", 0); // expiresAt === computedAt === now
        expect(cache.get("k")).toBeUndefined();
      });

      it("a SECOND, independent FileCache instance sees the same >= boundary on a durably-persisted entry (exercises the lock-protected re-check path, not just the initial in-process check)", () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-expiry-cross-"));
        const path = join(tempRoot, "cache.json");
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        {
          const processA = new FileCache<string>(new FileStateStore(), path);
          processA.set("k", "v", 100); // expiresAt = 1_000_100
        }
        vi.setSystemTime(1_000_100); // exactly the deadline, from a fresh instance/process
        const processB = new FileCache<string>(new FileStateStore(), path);
        expect(processB.get("k")).toBeUndefined();
      });

      it("size() reflects that a boundary-expired entry is actually deleted from durable storage, not merely hidden from get()", () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-expiry-"));
        const cache = new FileCache<string>(new FileStateStore(), join(tempRoot, "cache.json"));
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        cache.set("k", "v", 0);
        expect(cache.get("k")).toBeUndefined();
        expect(cache.size()).toBe(0);
      });
    }
  );

  describe(
    "P2 fix (31st independent review round, finding 5, 'return a concurrently refreshed cache entry'): " +
      "get()'s locked re-check must reuse a value another process already refreshed while this process " +
      "was waiting for the lock, not unconditionally report undefined",
    () => {
      it(
        "BLOCKER regression, exact reproduction: initial unlocked read sees an expired entry; ANOTHER " +
          "process refreshes the same key to a fresh value while this process waits for the lock; the " +
          "locked re-read correctly sees the fresh entry -> get() must return it, not force a recompute",
        () => {
          tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-concurrent-refresh-"));
          const path = join(tempRoot, "cache.json");
          const store = new FileStateStore();
          const cache = new FileCache<string>(store, path);

          vi.useFakeTimers();
          vi.setSystemTime(1_000_000);
          // A genuinely expired entry, durably persisted — this is what
          // get()'s INITIAL (unlocked) read will see.
          cache.set("k", "stale-value", 0);
          vi.setSystemTime(1_000_001);

          // Intercept the SECOND loadAll() call (the one made AFTER the
          // lock is acquired, per get()'s own locked re-check) and, right
          // before it actually reads, write a fresh, non-expired entry for
          // the SAME key directly to the shared durable file — simulating
          // another process's ALREADY-COMPLETED, already-lock-released
          // refresh landing in the gap between this process's initial read
          // and its own locked re-read.
          let loadCount = 0;
          const cacheInternals = cache as unknown as { loadAll(): Map<string, unknown> };
          const originalLoadAll = cacheInternals.loadAll.bind(cache);
          vi.spyOn(cacheInternals, "loadAll").mockImplementation(() => {
            loadCount++;
            if (loadCount === 2) {
              store.write(path, [
                ["k", { value: "fresh-value", computedAt: Date.now(), expiresAt: Date.now() + 100_000 }]
              ]);
            }
            return originalLoadAll();
          });

          const result = cache.get("k");

          expect(loadCount).toBe(2);
          expect(result).toBe("fresh-value");
          // The fresh entry must survive — it was never actually expired
          // by the time the authoritative, locked re-check ran.
          expect(cache.size()).toBe(1);
        }
      );

      it("no regression: if the locked re-check finds the entry is STILL expired, it is deleted and get() still returns undefined", () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-still-expired-"));
        const cache = new FileCache<string>(new FileStateStore(), join(tempRoot, "cache.json"));
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        cache.set("k", "v", 0);
        vi.setSystemTime(1_000_001);

        expect(cache.get("k")).toBeUndefined();
        expect(cache.size()).toBe(0);
      });

      it("no regression: if the locked re-check finds the entry has meanwhile been removed entirely, get() returns undefined without throwing", () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-removed-"));
        const path = join(tempRoot, "cache.json");
        const store = new FileStateStore();
        const cache = new FileCache<string>(store, path);

        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        cache.set("k", "v", 0);
        vi.setSystemTime(1_000_001);

        let loadCount = 0;
        const cacheInternals = cache as unknown as { loadAll(): Map<string, unknown> };
        const originalLoadAll = cacheInternals.loadAll.bind(cache);
        vi.spyOn(cacheInternals, "loadAll").mockImplementation(() => {
          loadCount++;
          if (loadCount === 2) {
            store.write(path, []);
          }
          return originalLoadAll();
        });

        expect(cache.get("k")).toBeUndefined();
        expect(loadCount).toBe(2);
      });
    }
  );

  describe("P2 fix (34th independent review round, finding 10, 'distinguish cached undefined from cache miss')", () => {
    it(
      "BLOCKER regression, exact reproduction: compute() returns undefined -> the SECOND call reports a cache " +
        "hit and never recomputes",
      async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-undefined-"));
        const cache = new FileCache<string | undefined>(new FileStateStore(), join(tempRoot, "cache.json"));
        const compute = vi.fn(async () => undefined);

        const first = await computeWithFileCache(cache, "k", compute);
        const second = await computeWithFileCache(cache, "k", compute);

        expect(first.cached).toBe(false);
        expect(second.cached).toBe(true);
        expect(second.value).toBeUndefined();
        expect(compute).toHaveBeenCalledTimes(1);
      }
    );

    it("BLOCKER regression: has() reports true for a key whose cached value is genuinely undefined", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-has-undefined-"));
      const cache = new FileCache<string | undefined>(new FileStateStore(), join(tempRoot, "cache.json"));
      cache.set("k", undefined);
      expect(cache.has("k")).toBe(true);
    });

    it("no regression: has() still reports false for a genuine miss", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-miss-"));
      const cache = new FileCache<string | undefined>(new FileStateStore(), join(tempRoot, "cache.json"));
      expect(cache.has("k")).toBe(false);
    });

    it("lookup() distinguishes an expired entry (found: false) from a live undefined value (found: true)", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-lookup-"));
      const cache = new FileCache<string | undefined>(new FileStateStore(), join(tempRoot, "cache.json"));
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      cache.set("expired", "v", 0);
      cache.set("live-undefined", undefined);

      expect(cache.lookup("expired")).toEqual({ found: false, value: undefined });
      expect(cache.lookup("live-undefined")).toEqual({ found: true, value: undefined });
      expect(cache.lookup("never-set")).toEqual({ found: false, value: undefined });
      vi.useRealTimers();
    });
  });

  describe(
    "P1 fix (independent Codex review, 'do not hold the synchronous cache lock across await'): a compute() " +
      "call in flight must never hold the underlying synchronous file lock — a second, same-process caller " +
      "racing the SAME missing key must never observe a FileLockTimeoutError merely because compute() takes " +
      "longer than the configured lock timeoutMs",
    () => {
      it(
        "BLOCKER regression, exact reproduction: two same-process concurrent misses for the SAME key, with a " +
          "compute() delay LONGER than the configured lock timeoutMs -> compute() runs exactly once, no " +
          "FileLockTimeoutError is thrown, and both callers receive the identical value",
        async () => {
          tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-no-lock-across-await-"));
          const cache = new FileCache<string>(
            new FileStateStore(),
            join(tempRoot, "cache.json"),
            { timeoutMs: 30, staleMs: 1_000, pollIntervalMs: 5 } // deliberately shorter than the compute delay below
          );
          let computeCalls = 0;
          const compute = async () => {
            computeCalls++;
            await new Promise((resolve) => setTimeout(resolve, 80)); // longer than timeoutMs
            return "computed-value";
          };

          const [first, second] = await Promise.all([
            computeWithFileCache(cache, "shared-key", compute),
            computeWithFileCache(cache, "shared-key", compute)
          ]);

          expect(computeCalls).toBe(1);
          expect(first.value).toBe("computed-value");
          expect(second.value).toBe("computed-value");
          expect([first.cached, second.cached].sort()).toEqual([false, true]);
          expect(cache.get("shared-key")).toBe("computed-value");
        }
      );

      it("high-contention: 5 same-process concurrent calls for the same missing key still run compute() exactly once, with a tight lock timeout", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-no-lock-across-await-contend-"));
        const cache = new FileCache<string>(
          new FileStateStore(),
          join(tempRoot, "cache.json"),
          { timeoutMs: 25, staleMs: 1_000, pollIntervalMs: 5 }
        );
        let computeCalls = 0;
        const compute = async () => {
          computeCalls++;
          await new Promise((resolve) => setTimeout(resolve, 60));
          return "the-one-true-value";
        };

        const results = await Promise.all(
          Array.from({ length: 5 }, () => computeWithFileCache(cache, "hot-key", compute))
        );

        expect(computeCalls).toBe(1);
        for (const r of results) expect(r.value).toBe("the-one-true-value");
        expect(results.filter((r) => !r.cached)).toHaveLength(1);
      });
    }
  );

  describe("P2 fix (34th independent review round, finding 11, 'validate TTL values before persisting')", () => {
    it.each([NaN, Infinity, -Infinity, -1, -100])(
      "BLOCKER regression, exact reproduction: set() rejects a non-finite/negative ttlMs (%s) before it ever reaches disk",
      (ttlMs) => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-ttl-"));
        const cache = new FileCache<string>(new FileStateStore(), join(tempRoot, "cache.json"));
        expect(() => cache.set("k", "v", ttlMs)).toThrow(InvalidTtlError);
        expect(cache.has("k")).toBe(false); // rejected BEFORE persisting
      }
    );

    it("no regression: ttlMs: 0 (immediately-expiring) remains explicitly valid", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-ttl-zero-"));
      const cache = new FileCache<string>(new FileStateStore(), join(tempRoot, "cache.json"));
      expect(() => cache.set("k", "v", 0)).not.toThrow();
    });

    it("no regression: a genuinely positive ttlMs remains valid", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-ttl-positive-"));
      const cache = new FileCache<string>(new FileStateStore(), join(tempRoot, "cache.json"));
      expect(() => cache.set("k", "v", 1000)).not.toThrow();
      expect(cache.get("k")).toBe("v");
    });
  });
});
