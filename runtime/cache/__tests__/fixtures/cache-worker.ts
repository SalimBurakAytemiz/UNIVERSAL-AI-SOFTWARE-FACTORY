// Test-only fixture (16th independent review round, Finding #2: "durable
// cache read-modify-write is not safe across processes"). Deliberately a
// standalone, REAL Node.js entry point (spawned as its own OS process by
// runtime/cache/__tests__/file-cache.cross-process.test.ts via `tsx`) —
// two `FileCache` instances constructed inside ONE test process would
// never exercise the actual cross-process lock file at all, since they'd
// share the same process's file descriptors/OS-level view but not
// reproduce a genuinely independent process crashing, holding a lock
// across a real process boundary, etc. This file is excluded from the
// project's own lint/typecheck/build source set the same way other
// __tests__ content is (see tsconfig.json's excludes), since it is only
// ever invoked by `tsx` directly, never imported.
import { FileStateStore } from "../../../state/file-store.js";
import { FileCache } from "../../file-cache.js";
import { acquireFileLock, type FileLockOptions } from "../../file-lock.js";

function parseLockOptions(raw: string | undefined): FileLockOptions | undefined {
  if (!raw) return undefined;
  return JSON.parse(raw) as FileLockOptions;
}

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
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
    const [cachePath, holdMsArg, lockOptionsArg] = rest;
    const holdMs = Number(holdMsArg);
    const release = acquireFileLock(`${cachePath}.lock`, parseLockOptions(lockOptionsArg));
    process.stdout.write("LOCKED\n");
    sleepSync(holdMs);
    // If another process already reclaimed this lock as stale while we
    // were "stuck", this release() call must be a safe no-op (token
    // mismatch) rather than deleting the NEW owner's lock.
    release();
    process.exit(0);
    break;
  }
  default: {
    console.error(`Unknown worker mode: ${mode}`);
    process.exit(2);
  }
}
