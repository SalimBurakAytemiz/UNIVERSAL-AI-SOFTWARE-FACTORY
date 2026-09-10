import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { FileStateStore } from "../../state/file-store.js";
import { FileCache, computeWithFileCache, InvalidComputeLeaseTtlError } from "../file-cache.js";
import { InvalidTtlError } from "../cache.js";

/** Mirrors FileCache's own private computeLeasePath() exactly, so a test can inspect/fabricate the durable lease record directly. */
function computeLeasePathFor(cachePath: string, key: string): string {
  return `${cachePath}.compute.${createHash("sha256").update(key).digest("hex")}.lease`;
}

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

  describe(
    "P1 fix (independent review, 'renew compute leases while their owners are active', finding 3): a " +
      "genuinely long-running compute() must keep its lease alive rather than looking abandoned once the " +
      "original computeLeaseTtlMs window elapses",
    () => {
      it(
        "BLOCKER regression, exact reproduction: a compute() call taking far longer than computeLeaseTtlMs " +
          "keeps renewing its own lease, so a SECOND FileCache instance (simulating another process, via a " +
          "separate instance sharing the SAME durable path — never the same in-process inFlight dedup) never " +
          "sees the lease as abandoned and never runs its own duplicate compute()",
        async () => {
          tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-lease-renewal-"));
          const cachePath = join(tempRoot, "cache.json");
          const leaseTtlMs = 150;
          // Two DISTINCT instances sharing one durable path — this is what
          // actually exercises `negotiateComputeOwnership()`'s cross-
          // instance lease negotiation; two calls through the SAME
          // instance would instead be deduplicated in-process by
          // `inFlight` before ever reaching it (bkz. the "do not hold the
          // lock across await" describe block above), which would hide
          // this exact defect.
          const processA = new FileCache<string>(new FileStateStore(), cachePath, undefined, leaseTtlMs);
          const processB = new FileCache<string>(new FileStateStore(), cachePath, undefined, leaseTtlMs);

          let computeCallsA = 0;
          let computeCallsB = 0;

          const resultAPromise = processA.computeAndSet("shared-key", async () => {
            computeCallsA++;
            // Deliberately several multiples of leaseTtlMs — under the
            // unfixed, one-shot-lease implementation this alone would let
            // B observe an "expired" lease and claim ownership for itself.
            await new Promise((resolve) => setTimeout(resolve, 600));
            return "A-value";
          });

          // Give A a head start so it has genuinely claimed ownership
          // (and persisted its own lease) before B ever contends.
          await new Promise((resolve) => setTimeout(resolve, 40));

          const resultBPromise = processB.computeAndSet("shared-key", async () => {
            computeCallsB++;
            return "B-value";
          });

          const [resultA, resultB] = await Promise.all([resultAPromise, resultBPromise]);

          expect(computeCallsA).toBe(1);
          // The critical assertion: B's compute callback never ran at
          // all — it kept observing a live (renewed) lease and simply
          // waited/reused A's genuine result, exactly as a same-process
          // `inFlight` follower would, but achieved here purely through
          // the durable, cross-instance lease protocol.
          expect(computeCallsB).toBe(0);
          expect(resultA.value).toBe("A-value");
          expect(resultB.value).toBe("A-value");
          expect(resultA.cached).toBe(false);
          expect(resultB.cached).toBe(true);
        },
        10_000
      );

      it(
        "no-regression: a compute() call that finishes well within computeLeaseTtlMs behaves exactly as before " +
          "(a concurrent second instance still single-flights normally)",
        async () => {
          tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-lease-renewal-fast-"));
          const cachePath = join(tempRoot, "cache.json");
          const processA = new FileCache<string>(new FileStateStore(), cachePath, undefined, 5_000);
          const processB = new FileCache<string>(new FileStateStore(), cachePath, undefined, 5_000);

          let computeCallsB = 0;
          const resultAPromise = processA.computeAndSet("fast-key", async () => "fast-value");
          const resultBPromise = processB.computeAndSet("fast-key", async () => {
            computeCallsB++;
            return "should-never-be-used";
          });

          const [resultA, resultB] = await Promise.all([resultAPromise, resultBPromise]);
          expect(resultA.value).toBe("fast-value");
          expect([resultA.cached, resultB.cached].includes(false)).toBe(true);
          // Whichever instance did not win still observes the genuine
          // persisted value, never its own placeholder.
          expect([resultA.value, resultB.value]).toEqual(["fast-value", "fast-value"]);
          expect(computeCallsB).toBeLessThanOrEqual(1);
        }
      );
    }
  );

  describe(
    "P1 fix (independent review, 'fence compute-lease release by owner', finding 4): a failed compute() must " +
      "never delete a successor's already-claimed, genuinely live lease",
    () => {
      it(
        "BLOCKER regression, exact reproduction: while an owner's compute() is still in flight, a successor " +
          "claims a fresh lease for the SAME key (simulating 'the original lease legitimately expired and " +
          "someone else took over') — when the ORIGINAL owner's call then fails, the successor's live lease " +
          "must survive completely untouched",
        async () => {
          tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-lease-fence-"));
          const cachePath = join(tempRoot, "cache.json");
          const stateStore = new FileStateStore();
          const cache = new FileCache<string>(stateStore, cachePath, undefined, 10_000);
          const leasePath = computeLeasePathFor(cachePath, "fence-key");
          const fabricatedSuccessorExpiresAt = Date.now() + 60_000;

          const failure = new Error("simulated compute failure");
          await expect(
            cache.computeAndSet("fence-key", () => {
              // At this point the REAL implementation has already claimed
              // ownership and persisted ITS OWN lease record — confirm
              // that precondition, then fabricate a successor's fresh,
              // genuinely live lease directly (a DIFFERENT ownerId),
              // simulating "this owner's lease already (legitimately)
              // expired, and another process has since claimed a brand
              // new one" without needing a real timing race.
              const ownersLease = stateStore.read<{ ownerId: string; expiresAt: number }>(leasePath);
              expect(ownersLease).toBeDefined();
              expect(typeof ownersLease!.ownerId).toBe("string");
              stateStore.write(leasePath, { ownerId: "successor-owner", expiresAt: fabricatedSuccessorExpiresAt });
              throw failure;
            })
          ).rejects.toThrow(failure);

          // The successor's lease must be EXACTLY as fabricated — the
          // failed original owner's release must have changed nothing.
          const leaseAfter = stateStore.read<{ ownerId: string; expiresAt: number }>(leasePath);
          expect(leaseAfter).toEqual({ ownerId: "successor-owner", expiresAt: fabricatedSuccessorExpiresAt });
        }
      );

      it("no-regression: a failed compute() whose lease was never taken over by anyone else still releases its own lease immediately (no full-TTL wait for a retry)", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-lease-fence-noop-"));
        const cachePath = join(tempRoot, "cache.json");
        const stateStore = new FileStateStore();
        const cache = new FileCache<string>(stateStore, cachePath, undefined, 10_000);
        const leasePath = computeLeasePathFor(cachePath, "retry-key");

        await expect(
          cache.computeAndSet("retry-key", () => {
            throw new Error("simulated compute failure");
          })
        ).rejects.toThrow("simulated compute failure");

        const releasedLease = stateStore.read<{ ownerId: string; expiresAt: number }>(leasePath);
        expect(releasedLease?.expiresAt).toBe(0);

        // A fresh attempt for the same key must succeed immediately —
        // never blocked waiting out the original 10s TTL.
        const result = await cache.computeAndSet("retry-key", () => "recovered-value");
        expect(result).toEqual({ value: "recovered-value", cached: false });
      });
    }
  );

  describe(
    "P1 fix (P0 final closure remediation, finding 2, 'paid bootstrap checkpoint must be atomic with provider " +
      "completion'): a persistence failure on the main cache write must never let a retry invoke compute() " +
      "(the real, billable provider) a second time for work already paid for",
    () => {
      it("BLOCKER regression, exact reproduction: the main cache's durable write fails once after compute() succeeds; a subsequent retry recovers the already-computed value without calling compute() again", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-atomic-checkpoint-"));
        const cachePath = join(tempRoot, "cache.json");
        const realStore = new FileStateStore();
        let failNextWriteToMainFile = true;
        const flakyStore = {
          read: realStore.read.bind(realStore),
          exists: realStore.exists.bind(realStore),
          write: (path: string, data: unknown) => {
            if (path === cachePath && failNextWriteToMainFile) {
              failNextWriteToMainFile = false;
              throw new Error("simulated transient store failure on the main cache file");
            }
            realStore.write(path, data);
          }
        };
        const cache = new FileCache<{ readonly costUsd: number }>(flakyStore, cachePath, undefined, 10_000);

        let providerCalls = 0;
        const compute = () => {
          providerCalls++;
          return { costUsd: 0.25 };
        };

        // First attempt: compute() succeeds (the provider is genuinely
        // billed), but the main cache write fails — this attempt is
        // expected to surface that failure rather than silently succeed,
        // exactly like the original unfixed behavior did for THIS attempt.
        await expect(cache.computeAndSet("project-x", compute)).rejects.toThrow(
          "simulated transient store failure on the main cache file"
        );
        expect(providerCalls).toBe(1);

        // Second attempt (the caller's retry, exactly as bootstrapProject()
        // would be retried): must recover the SAME already-billed result
        // from the durable lease checkpoint — never invoke compute() again.
        const retryResult = await cache.computeAndSet("project-x", compute);
        expect(providerCalls).toBe(1);
        expect(retryResult.value).toEqual({ costUsd: 0.25 });

        let totalCostUsd = 0;
        for (let i = 0; i < providerCalls; i++) totalCostUsd += 0.25;
        expect(totalCostUsd).toBe(0.25);
      });

      it("no-regression: when the main cache write succeeds normally, the completed value is reflected in the main cache file (not just the lease) and a later lookup finds it without touching compute() at all", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-atomic-checkpoint-heal-"));
        const cachePath = join(tempRoot, "cache.json");
        const stateStore = new FileStateStore();
        const cache = new FileCache<string>(stateStore, cachePath, undefined, 10_000);

        let calls = 0;
        await cache.computeAndSet("k", () => {
          calls++;
          return "v";
        });
        expect(calls).toBe(1);
        expect(cache.get("k")).toBe("v");

        // A fresh instance sharing the same durable path (simulating a
        // new process) must see the healed main-cache entry directly,
        // never needing to consult the lease file at all.
        const otherInstance = new FileCache<string>(stateStore, cachePath, undefined, 10_000);
        expect(otherInstance.get("k")).toBe("v");
      });

      it("no-regression: the completed-lease recovery path also heals a still-missing main cache entry once it eventually succeeds", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-atomic-checkpoint-heal2-"));
        const cachePath = join(tempRoot, "cache.json");
        const realStore = new FileStateStore();
        let failMainWrites = true;
        const flakyStore = {
          read: realStore.read.bind(realStore),
          exists: realStore.exists.bind(realStore),
          write: (path: string, data: unknown) => {
            if (path === cachePath && failMainWrites) {
              throw new Error("main cache file still unwritable");
            }
            realStore.write(path, data);
          }
        };
        const cache = new FileCache<string>(flakyStore, cachePath, undefined, 10_000);

        await expect(cache.computeAndSet("k", () => "v")).rejects.toThrow();
        // The main cache file genuinely has no entry yet.
        expect(realStore.read(cachePath)).toBeUndefined();

        // Now the store recovers — the retry heals the main cache from
        // the durable lease record, without recomputing.
        failMainWrites = false;
        let calls = 0;
        const result = await cache.computeAndSet("k", () => {
          calls++;
          return "should-never-run";
        });
        expect(calls).toBe(0);
        expect(result.value).toBe("v");
        expect(cache.get("k")).toBe("v");
      });
    }
  );

  describe(
    "P1 fix (P0 final closure remediation, finding 5, 'successful stale compute-lease owners must not " +
      "commit'): a compute() call whose lease was reclaimed by a successor WHILE it was still running must " +
      "never overwrite the successor's already-committed result",
    () => {
      it(
        "BLOCKER regression, exact reproduction: owner A's lease is replaced by successor B's lease (with B's " +
          "own already-completed result) while A's compute() is still in flight; A's own stale result must " +
          "never be committed over B's",
        async () => {
          tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-stale-owner-commit-"));
          const cachePath = join(tempRoot, "cache.json");
          const stateStore = new FileStateStore();
          const cache = new FileCache<string>(stateStore, cachePath, undefined, 10_000);
          const leasePath = computeLeasePathFor(cachePath, "shared-key");

          const result = await cache.computeAndSet("shared-key", () => {
            // At this point A has already claimed ownership and persisted
            // its own lease. Simulate a successor B having reclaimed the
            // key (this lease was legitimately treated as abandoned) AND
            // already completed and committed its own genuine result —
            // exactly the race finding 5 describes, without needing a
            // real timing race.
            const ownersLease = stateStore.read<{ ownerId: string }>(leasePath);
            expect(ownersLease).toBeDefined();
            stateStore.write(leasePath, {
              ownerId: "successor-B",
              expiresAt: Date.now() + 60_000,
              completed: true,
              value: "B-value"
            });
            return "A-stale-value";
          });

          // A's own (stale) result must never win — B's already-committed
          // result must be what both the return value AND the main cache
          // reflect.
          expect(result.value).toBe("B-value");
          expect(cache.get("shared-key")).toBe("B-value");
        }
      );

      it("no-regression: an owner that genuinely still holds its lease when compute() finishes commits normally", async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-stale-owner-commit-noregression-"));
        const cachePath = join(tempRoot, "cache.json");
        const cache = new FileCache<string>(new FileStateStore(), cachePath, undefined, 10_000);
        const result = await cache.computeAndSet("k", () => "genuine-value");
        expect(result).toEqual({ value: "genuine-value", cached: false });
        expect(cache.get("k")).toBe("genuine-value");
      });
    }
  );

  describe(
    "P1 fix (P0 final closure remediation, finding 11, 'invalid lease timing configuration'): a compute lease " +
      "TTL of 0 (or NaN/Infinity/negative, or one too short for its own derived renewal interval to precede " +
      "expiry) must be rejected at construction, not silently destroy mutual exclusion at runtime",
    () => {
      it(
        "BLOCKER regression, exact reproduction: two FileCache instances sharing ONE path with " +
          "computeLeaseTtlMs = 0 both concurrently compute the same key, since a lease that expires the " +
          "instant it is granted excludes no one",
        async () => {
          tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-zero-lease-ttl-"));
          const cachePath = join(tempRoot, "cache.json");
          const store = new FileStateStore();

          expect(() => new FileCache<string>(store, cachePath, undefined, 0)).toThrow(InvalidComputeLeaseTtlError);
        }
      );

      it("rejects NaN, Infinity, and negative compute lease TTLs at construction", () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-invalid-lease-ttl-"));
        const cachePath = join(tempRoot, "cache.json");
        const store = new FileStateStore();

        expect(() => new FileCache<string>(store, cachePath, undefined, NaN)).toThrow(InvalidComputeLeaseTtlError);
        expect(() => new FileCache<string>(store, cachePath, undefined, Infinity)).toThrow(
          InvalidComputeLeaseTtlError
        );
        expect(() => new FileCache<string>(store, cachePath, undefined, -1)).toThrow(InvalidComputeLeaseTtlError);
      });

      it(
        "rejects a compute lease TTL so short its derived renewal interval would not run strictly before the " +
          "lease's own expiry",
        () => {
          tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-thrashing-lease-ttl-"));
          const cachePath = join(tempRoot, "cache.json");
          const store = new FileStateStore();

          // renewalIntervalMs = max(1, floor(1/3)) = 1, which does NOT run
          // strictly before a 1ms expiry — the renewal and the expiry land
          // at the exact same instant.
          expect(() => new FileCache<string>(store, cachePath, undefined, 1)).toThrow(InvalidComputeLeaseTtlError);
        }
      );

      it("no regression: the default compute lease TTL, and other genuinely valid custom TTLs, still construct fine", () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-valid-lease-ttl-"));
        const cachePath = join(tempRoot, "cache.json");
        const store = new FileStateStore();

        expect(() => new FileCache<string>(store, cachePath)).not.toThrow();
        expect(() => new FileCache<string>(store, cachePath, undefined, 10_000)).not.toThrow();
        expect(() => new FileCache<string>(store, cachePath, undefined, 3)).not.toThrow();
      });
    }
  );
});
