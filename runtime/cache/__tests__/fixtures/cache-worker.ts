// Test-only fixture (16th/17th independent review rounds, "durable cache
// read-modify-write is not safe across processes" and its follow-up lock-
// correctness findings). Deliberately a standalone, REAL Node.js entry
// point (spawned as its own OS process by runtime/cache/__tests__/
// file-cache.cross-process.test.ts via `tsx`) — two `FileCache`/
// `acquireFileLock` calls inside ONE test process would never exercise
// the actual cross-process lock file, PID-liveness machinery, or genuine
// OS-level race timing at all. This file is only ever invoked by `tsx`
// directly, never imported.
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { FileStateStore } from "../../../state/file-store.js";
import { FileCache, computeWithFileCache } from "../../file-cache.js";
import { acquireFileLock, type FileLockOptions } from "../../file-lock.js";

function parseLockOptions(raw: string | undefined): FileLockOptions | undefined {
  if (!raw) return undefined;
  return JSON.parse(raw) as FileLockOptions;
}

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/** Busy-waits (synchronously) until `path` exists, or `timeoutMs` elapses. */
function waitForFile(path: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(`waitForFile: '${path}' did not appear within ${timeoutMs}ms`);
    }
  }
}

const [, , mode, ...rest] = process.argv;

switch (mode) {
  case "set": {
    const [cachePath, key, value, ttlArg, lockOptionsArg] = rest;
    const ttlMs = ttlArg ? Number(ttlArg) : undefined;
    const cache = new FileCache<string>(new FileStateStore(), cachePath, parseLockOptions(lockOptionsArg));
    cache.set(key, value, ttlMs);
    process.exit(0);
    break;
  }
  case "set-many": {
    const [cachePath, prefix, countArg, lockOptionsArg] = rest;
    const count = Number(countArg);
    const cache = new FileCache<string>(new FileStateStore(), cachePath, parseLockOptions(lockOptionsArg));
    for (let i = 0; i < count; i++) {
      cache.set(`${prefix}-${i}`, `value-${prefix}-${i}`);
    }
    process.exit(0);
    break;
  }
  case "get": {
    const [cachePath, key, lockOptionsArg] = rest;
    const cache = new FileCache<string>(new FileStateStore(), cachePath, parseLockOptions(lockOptionsArg));
    const value = cache.get(key);
    process.stdout.write(JSON.stringify({ value }));
    process.exit(0);
    break;
  }
  case "hold-lock-forever": {
    // Acquires the SAME lock a FileCache over `cachePath` would use, then
    // exits WITHOUT ever releasing it — simulating a process that
    // crashes while holding the cross-process lock.
    const [cachePath, lockOptionsArg] = rest;
    acquireFileLock(`${cachePath}.lock`, parseLockOptions(lockOptionsArg));
    process.stdout.write("LOCKED\n");
    process.exit(1);
    break;
  }
  case "hold-lock-then-release": {
    // Acquires the lock, stays ALIVE (this process never exits) for
    // `holdMs`, then releases normally — used to prove a CONFIRMED-LIVE
    // holder is never reclaimed by age alone (17th independent review
    // round fix), however long `holdMs` exceeds the waiter's `staleMs`.
    const [cachePath, holdMsArg, lockOptionsArg] = rest;
    const holdMs = Number(holdMsArg);
    const release = acquireFileLock(`${cachePath}.lock`, parseLockOptions(lockOptionsArg));
    process.stdout.write("LOCKED\n");
    sleepSync(holdMs);
    release();
    process.exit(0);
    break;
  }
  case "create-dead-lock": {
    // Fabricates an ABANDONED lock directly on disk, attributed to a PID
    // that is GENUINELY dead (the parent test spawns and awaits a
    // trivial child, then hands us its now-exited PID) — this lets tests
    // deterministically set up a "dead owner" precondition without
    // relying on any timing race to actually kill a lock-holding process.
    const [lockDirPath, deadPidArg, ageMsArg] = rest;
    const deadPid = Number(deadPidArg);
    const ageMs = ageMsArg ? Number(ageMsArg) : 0;
    mkdirSync(lockDirPath, { recursive: true });
    writeFileSync(
      `${lockDirPath}/owner.json`,
      JSON.stringify({ pid: deadPid, token: "fabricated-dead-owner", acquiredAt: Date.now() - ageMs }),
      "utf8"
    );
    process.exit(0);
    break;
  }
  case "compute": {
    // P2 fix (independent Codex review, "deduplicate concurrent durable
    // cache computations"): calls the REAL `computeWithFileCache()` on a
    // cache-miss key, appending to `logPath` exactly once per ACTUAL
    // `compute()` invocation — the parent test counts lines in that file
    // across MULTIPLE real processes racing the SAME key to prove the
    // callback ran exactly once, not once per process.
    const [cachePath, key, value, logPath, delayMsArg, lockOptionsArg] = rest;
    const delayMs = delayMsArg ? Number(delayMsArg) : 0;
    const cache = new FileCache<string>(new FileStateStore(), cachePath, parseLockOptions(lockOptionsArg));
    computeWithFileCache(cache, key, () => {
      appendFileSync(logPath, "1\n");
      if (delayMs > 0) sleepSync(delayMs);
      return value;
    })
      .then((result) => {
        process.stdout.write(JSON.stringify(result));
        process.exit(0);
      })
      .catch((err: unknown) => {
        process.stderr.write(err instanceof Error ? (err.stack ?? err.message) : String(err));
        process.exit(1);
      });
    break;
  }
  case "compute-fail": {
    // Proves a compute() failure never gets silently cached as a success
    // and never leaves the per-key lease permanently held (bkz.
    // FileCache.computeAndSet()'in fix notu — the lease is released in a
    // `finally`, so a subsequent caller must be able to proceed normally).
    const [cachePath, key, logPath, lockOptionsArg] = rest;
    const cache = new FileCache<string>(new FileStateStore(), cachePath, parseLockOptions(lockOptionsArg));
    computeWithFileCache(cache, key, () => {
      appendFileSync(logPath, "1\n");
      throw new Error("simulated compute failure");
    })
      .then(() => {
        process.stderr.write("expected compute() to throw, but computeWithFileCache resolved normally");
        process.exit(1);
      })
      .catch((err: unknown) => {
        process.stdout.write(err instanceof Error ? err.message : String(err));
        process.exit(0);
      });
    break;
  }
  case "race-reclaim": {
    // Two (or more) instances of this mode, pointed at the SAME
    // `lockPath`/`markerPath` but each with a DISTINCT `resultPath`, are
    // used to force a genuine, tightly-synchronized race for the exact
    // same lock: each writes its own `readyPath` immediately, then
    // busy-waits for a SHARED `barrierPath` the parent test only creates
    // once EVERY contender has signaled ready — so all contenders reach
    // `acquireFileLock()` at essentially the same instant, deterministically
    // exercising the reclaim race rather than hoping OS scheduling happens
    // to interleave two independently-timed spawns. `markerPath` is used
    // as a mutual-exclusion witness: whoever's `acquireFileLock()` call
    // returns, we check whether the marker ALREADY exists (which could
    // only happen if another contender is ALSO currently inside the
    // critical section, i.e. that other contender's own removal of the
    // marker on exit hasn't happened yet) — an unmistakable, deterministic
    // proof of overlapping "exclusive" ownership if the lock is ever
    // actually broken.
    const [lockPath, readyPath, barrierPath, markerPath, resultPath, holdMsArg, lockOptionsArg] = rest;
    writeFileSync(readyPath, String(process.pid));
    waitForFile(barrierPath, 10_000);
    const release = acquireFileLock(lockPath, parseLockOptions(lockOptionsArg));
    let overlap = false;
    if (existsSync(markerPath)) {
      overlap = true;
    } else {
      writeFileSync(markerPath, String(process.pid));
    }
    sleepSync(Number(holdMsArg));
    if (!overlap) {
      try {
        rmSync(markerPath, { force: true });
      } catch {
        // best-effort
      }
    }
    release();
    writeFileSync(resultPath, JSON.stringify({ pid: process.pid, overlap }));
    process.exit(overlap ? 1 : 0);
    break;
  }
  default: {
    console.error(`Unknown worker mode: ${mode}`);
    process.exit(2);
  }
}
