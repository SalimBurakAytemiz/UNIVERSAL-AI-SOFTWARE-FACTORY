// Test-only fixture (P0 CLOSURE REMEDIATION, blocker 6, "concurrent WEB/
// GAME bootstrapProject() calls can leave mixed-generation genome.json,
// organization.json and bootstrap.json while recording SUCCESS"). Deliberately
// a standalone, REAL Node.js entry point (spawned as its own OS process by
// runtime/project-lifecycle/__tests__/orchestrator.test.ts via `tsx`) —
// `acquireFileLock()`'s own wait loop blocks synchronously (bkz.
// file-lock.ts'in `sleepSync()`'i, gerçek `Atomics.wait`), so a single
// in-process test could never simulate "another holder releases the lock
// while I'm waiting" — the waiter's own blocking wait would starve the
// SAME process's code that would otherwise release it. A REAL second OS
// process is the only genuine way to exercise this. This file is only ever
// invoked by `tsx` directly, never imported.
import { acquireFileLock } from "../../../cache/file-lock.js";

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

const [, , lockPath, holdMsArg] = process.argv;
const holdMs = Number(holdMsArg);

const release = acquireFileLock(lockPath);
// stdout is the test harness's signal that the lock is genuinely held.
process.stdout.write("LOCK_ACQUIRED\n");
sleepSync(holdMs);
release();
process.exit(0);
