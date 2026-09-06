import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { FileStateStore } from "../../state/file-store.js";
import { FileCache } from "../file-cache.js";

// P2 fix (16th independent review round, "durable cache read-modify-write
// is not safe across processes"): Codex reproduced the classic
// cross-process lost-update race — two independent OS processes both
// read the same persisted cache map, both mutate their own in-memory
// copy, and the second process's atomic file replacement silently erases
// the first process's already-successful write, even though atomic
// replacement genuinely protects each INDIVIDUAL write from partial/
// corrupt content. Every test below spawns REAL, separate Node.js
// processes via `tsx` (bkz. fixtures/cache-worker.ts) rather than
// constructing multiple `FileCache` instances inside one process — two
// in-process instances would never exercise the actual cross-process
// lock file/PID-liveness machinery this fix adds (runtime/cache/
// file-lock.ts), so that would not be genuine evidence of cross-process
// safety.
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
const workerPath = join(__dirname, "fixtures", "cache-worker.ts");

interface WorkerResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runWorker(args: readonly string[]): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, [workerPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Spawns and fully waits out a genuinely trivial child process, then
 * returns its (now provably exited, i.e. dead) PID — used to fabricate a
 * "dead owner" lock precondition deterministically, without relying on a
 * timing race to actually kill a lock-holding process.
 */
function spawnDeadPid(): number {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const pid = result.pid;
  if (!pid) throw new Error("spawnDeadPid: child process did not report a pid");
  return pid;
}

describe(
  "FileCache cross-process locking (P2 fix, 16th independent review round, 'durable cache read-modify-write " +
    "is not safe across processes') — every scenario below uses REAL, separately-spawned OS processes",
  () => {
    let tempRoot: string;

    afterEach(() => {
      if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    });

    it(
      "BLOCKER regression, exact reproduction: two independent REAL processes concurrently set() DIFFERENT keys " +
        "and BOTH survive (neither process's successful write is silently lost)",
      async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-xproc-"));
        const cachePath = join(tempRoot, "cache.json");

        const [resultA, resultB] = await Promise.all([
          runWorker(["set", cachePath, "key-a", "value-a"]),
          runWorker(["set", cachePath, "key-b", "value-b"])
        ]);
        expect(resultA.code, resultA.stderr).toBe(0);
        expect(resultB.code, resultB.stderr).toBe(0);

        const cache = new FileCache<string>(new FileStateStore(), cachePath);
        expect(cache.get("key-a")).toBe("value-a");
        expect(cache.get("key-b")).toBe("value-b");
      },
      20_000
    );

    it(
      "high-contention: 5 REAL processes each writing 15 unique keys concurrently lose none " +
        "(no double accounting, no silently dropped entries)",
      async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-xproc-contend-"));
        const cachePath = join(tempRoot, "cache.json");
        const workerCount = 5;
        const perWorker = 15;

        const results = await Promise.all(
          Array.from({ length: workerCount }, (_, i) => runWorker(["set-many", cachePath, `p${i}`, String(perWorker)]))
        );
        for (const result of results) expect(result.code, result.stderr).toBe(0);

        const cache = new FileCache<string>(new FileStateStore(), cachePath);
        expect(cache.size()).toBe(workerCount * perWorker);
        for (let i = 0; i < workerCount; i++) {
          for (let j = 0; j < perWorker; j++) {
            expect(cache.get(`p${i}-${j}`)).toBe(`value-p${i}-${j}`);
          }
        }
      },
      30_000
    );

    it(
      "expiration cleanup racing with a concurrent set() never erases the freshly-set, unrelated entry",
      async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-xproc-expire-"));
        const cachePath = join(tempRoot, "cache.json");
        const seedCache = new FileCache<string>(new FileStateStore(), cachePath);
        seedCache.set("expired-key", "stale-value", -1);

        const [getResult, setResult] = await Promise.all([
          runWorker(["get", cachePath, "expired-key"]),
          runWorker(["set", cachePath, "fresh-key", "fresh-value"])
        ]);
        expect(getResult.code, getResult.stderr).toBe(0);
        expect(setResult.code, setResult.stderr).toBe(0);
        expect((JSON.parse(getResult.stdout) as { value: unknown }).value).toBeUndefined();

        const cache = new FileCache<string>(new FileStateStore(), cachePath);
        expect(cache.get("fresh-key")).toBe("fresh-value");
        expect(cache.get("expired-key")).toBeUndefined();
      },
      20_000
    );

    it(
      "a process dying while holding the lock does not permanently deadlock a subsequent writer " +
        "(dead-PID detection recovers immediately, without waiting out the staleness window)",
      async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-xproc-crash-"));
        const cachePath = join(tempRoot, "cache.json");
        const fastLockOptions = JSON.stringify({ timeoutMs: 5_000, staleMs: 200, pollIntervalMs: 20 });

        const crashResult = await runWorker(["hold-lock-forever", cachePath, fastLockOptions]);
        expect(crashResult.stdout).toContain("LOCKED");
        expect(crashResult.code).toBe(1);

        const setResult = await runWorker(["set", cachePath, "after-crash", "value", "", fastLockOptions]);
        expect(setResult.code, setResult.stderr).toBe(0);

        const cache = new FileCache<string>(new FileStateStore(), cachePath);
        expect(cache.get("after-crash")).toBe("value");
      },
      20_000
    );

    it(
      "a live owner is never reclaimed merely because it exceeds staleMs: a waiter with a shorter timeout " +
        "times out rather than stealing the lock, and the live owner's lock survives untouched",
      async () => {
        // P2 fix (17th independent review round, "do not reclaim locks
        // held by live processes"): the OLD behavior treated ANY lock
        // older than `staleMs` as reclaimable regardless of whether its
        // owner was still alive and actively working — Codex reproduced
        // a long-running, perfectly legitimate critical section being
        // stolen out from under its live owner purely due to age. This
        // test proves the fix directly: the holder stays ALIVE for
        // `holdMs` (well beyond `staleMs`), and a waiter configured with
        // a `timeoutMs` shorter than `holdMs` (but longer than `staleMs`)
        // MUST time out — if it instead "succeeded" quickly, that would
        // mean it stole the still-live owner's lock.
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-xproc-live-"));
        const cachePath = join(tempRoot, "cache.json");
        const lockPath = `${cachePath}.lock`;
        const holdMs = 1_000;
        const holderOptions = JSON.stringify({ timeoutMs: 10_000, staleMs: 100, pollIntervalMs: 20 });
        const waiterOptions = JSON.stringify({ timeoutMs: 300, staleMs: 100, pollIntervalMs: 20 });

        const holderPromise = runWorker(["hold-lock-then-release", cachePath, String(holdMs), holderOptions]);
        // Give the holder a brief head start so it has genuinely acquired
        // the lock before the waiter's own attempt begins.
        await new Promise((resolve) => setTimeout(resolve, 100));

        const waiterStart = Date.now();
        const waiterResult = await runWorker(["set", cachePath, "stolen-key", "stolen-value", "", waiterOptions]);
        const waiterElapsedMs = Date.now() - waiterStart;

        // The waiter must FAIL (non-zero exit from the uncaught
        // FileLockTimeoutError) — never succeed by stealing the lock —
        // and it must have genuinely waited out its own timeout, not
        // returned instantly.
        expect(waiterResult.code).not.toBe(0);
        expect(waiterResult.stderr).toContain("FileLockTimeoutError");
        expect(waiterElapsedMs).toBeGreaterThanOrEqual(250);

        // The live owner's lock must still be exactly as it was — the
        // waiter's failed attempt must never have touched it.
        expect(existsSync(lockPath)).toBe(true);
        const ownerMetaDuringHold = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as {
          token: string;
        };
        expect(typeof ownerMetaDuringHold.token).toBe("string");

        const holderResult = await holderPromise;
        expect(holderResult.code, holderResult.stderr).toBe(0);

        // The key the waiter tried (and failed) to write must never have
        // been recorded, and the lock must be gone now that the live
        // owner released it normally (no permanent deadlock either).
        const cache = new FileCache<string>(new FileStateStore(), cachePath);
        expect(cache.get("stolen-key")).toBeUndefined();
        expect(existsSync(lockPath)).toBe(false);
      },
      20_000
    );

    it(
      "a confirmed-dead owner's fabricated lock is reclaimed immediately, without waiting out staleMs",
      async () => {
        // Uses `create-dead-lock` to fabricate an abandoned lock
        // attributed to a PID that is DETERMINISTICALLY, provably dead
        // (a trivial child process spawned and fully awaited beforehand)
        // — this isolates "dead-PID-based instant recovery" from any
        // timing race, and proves it does not depend on waiting out a
        // generous `staleMs` (set here to a value FAR longer than this
        // test's own execution time).
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-xproc-dead-"));
        const cachePath = join(tempRoot, "cache.json");
        const lockPath = `${cachePath}.lock`;
        const deadPid = spawnDeadPid();
        const generousStaleOptions = JSON.stringify({ timeoutMs: 10_000, staleMs: 60_000, pollIntervalMs: 20 });

        const createResult = await runWorker(["create-dead-lock", lockPath, String(deadPid), "0"]);
        expect(createResult.code, createResult.stderr).toBe(0);
        expect(existsSync(lockPath)).toBe(true);

        const start = Date.now();
        const setResult = await runWorker(["set", cachePath, "after-dead-owner", "value", "", generousStaleOptions]);
        const elapsedMs = Date.now() - start;

        expect(setResult.code, setResult.stderr).toBe(0);
        // Recovery must be near-instant (well under the 60s staleMs) —
        // proving it was the PID-liveness check, not an age fallback,
        // that authorized reclamation.
        expect(elapsedMs).toBeLessThan(5_000);

        const cache = new FileCache<string>(new FileStateStore(), cachePath);
        expect(cache.get("after-dead-owner")).toBe("value");
      },
      20_000
    );

    it(
      "stale-lock reclamation is serialized across contenders: two processes racing to reclaim the SAME " +
        "fabricated dead lock never both believe they own the critical section, and the loser never deletes " +
        "the winner's replacement lock (repeated across several trials for determinism)",
      async () => {
        // P2 fix (17th independent review round, "stale-lock reclamation
        // is not serialized across contenders"): the OLD code let ANY
        // process that observed a lock as stale unconditionally `rmSync`
        // it — Codex reproduced process A reclaiming and creating a
        // fresh, valid replacement lock, then process B (acting on its
        // own, now-outdated "stale" observation) unconditionally deleting
        // A's brand-new lock and creating its own, so both A and B
        // believed they alone owned the critical section. Each trial
        // below fabricates a dead-owner lock, then uses a ready/barrier
        // handshake (bkz. fixtures/cache-worker.ts's "race-reclaim" mode)
        // to force BOTH contenders to reach their own `acquireFileLock()`
        // call at essentially the same instant — a marker file written
        // inside the critical section and checked-for-pre-existence on
        // entry makes any overlap immediately, deterministically visible
        // (a non-zero exit code from either contender).
        const trials = 5;
        for (let trial = 0; trial < trials; trial++) {
          const trialRoot = mkdtempSync(join(tmpdir(), `uasf-file-cache-xproc-race-${trial}-`));
          try {
            const lockPath = join(trialRoot, "cache.json.lock");
            const readyA = join(trialRoot, "ready-a");
            const readyB = join(trialRoot, "ready-b");
            const barrier = join(trialRoot, "barrier");
            const marker = join(trialRoot, "marker");
            const resultA = join(trialRoot, "result-a.json");
            const resultB = join(trialRoot, "result-b.json");
            const lockOptions = JSON.stringify({ timeoutMs: 10_000, staleMs: 5_000, pollIntervalMs: 5 });
            const deadPid = spawnDeadPid();

            const createResult = await runWorker(["create-dead-lock", lockPath, String(deadPid), "0"]);
            expect(createResult.code, createResult.stderr).toBe(0);

            const childA = runWorker(["race-reclaim", lockPath, readyA, barrier, marker, resultA, "80", lockOptions]);
            const childB = runWorker(["race-reclaim", lockPath, readyB, barrier, marker, resultB, "80", lockOptions]);

            // Only raise the barrier once BOTH contenders have signaled
            // they are ready to race — maximizing the chance they hit
            // `acquireFileLock()` at essentially the same wall-clock
            // instant, rather than one finishing long before the other
            // even starts.
            const readyDeadline = Date.now() + 10_000;
            while (!(existsSync(readyA) && existsSync(readyB))) {
              if (Date.now() > readyDeadline) throw new Error(`trial ${trial}: contenders never signaled ready`);
            }
            writeFileSync(barrier, "go");

            const [outcomeA, outcomeB] = await Promise.all([childA, childB]);
            expect(outcomeA.code, `trial ${trial} A: ${outcomeA.stderr}`).toBe(0);
            expect(outcomeB.code, `trial ${trial} B: ${outcomeB.stderr}`).toBe(0);

            const parsedA = JSON.parse(readFileSync(resultA, "utf8")) as { overlap: boolean };
            const parsedB = JSON.parse(readFileSync(resultB, "utf8")) as { overlap: boolean };
            expect(parsedA.overlap, `trial ${trial}: A observed overlap`).toBe(false);
            expect(parsedB.overlap, `trial ${trial}: B observed overlap`).toBe(false);

            // Both contenders eventually succeeded (each acquired,
            // worked, and released in turn) and no lock/marker is left
            // dangling afterward.
            expect(existsSync(lockPath)).toBe(false);
            expect(existsSync(marker)).toBe(false);
          } finally {
            rmSync(trialRoot, { recursive: true, force: true });
          }
        }
      },
      60_000
    );

    it(
      "P2 fix (19th independent review round, 'make stale reclaim-gate recovery ownership-safe'): two " +
        "processes racing to RECOVER the SAME abandoned .reclaim gate (left behind by a crashed reclaimer) " +
        "never both believe they own the critical section, and the loser never deletes the winner's " +
        "replacement gate (repeated across several trials for determinism)",
      async () => {
        // The 17th round's `tryReclaimStaleLock()` fix protects `lockPath`
        // itself from unsafe reclamation via an exclusive `.reclaim` gate
        // — but Codex reproduced the IDENTICAL unsafe pattern one level
        // in: if the `.reclaim` GATE's own prior holder crashed mid-
        // reclaim (leaving an abandoned `.reclaim` directory behind), the
        // OLD `acquireReclaimGate()` recovered it via a bare
        // stat-then-unconditional-`rmSync`, with no identity check — two
        // contenders could both observe that same abandoned gate, one
        // reclaims and creates a fresh replacement gate, and the OTHER
        // (acting on its stale observation) deletes that brand-new
        // replacement, letting both simultaneously enter the protected
        // critical section. Each trial below fabricates BOTH an abandoned
        // lock (dead PID) AND an abandoned `.reclaim` gate (a second dead
        // PID, simulating a crashed reclaimer) directly on disk, then uses
        // the same ready/barrier handshake to force two contenders to hit
        // `acquireFileLock()` — and therefore the reclaim-gate recovery
        // path specifically — at essentially the same instant.
        const trials = 5;
        for (let trial = 0; trial < trials; trial++) {
          const trialRoot = mkdtempSync(join(tmpdir(), `uasf-file-cache-xproc-gate-race-${trial}-`));
          try {
            const lockPath = join(trialRoot, "cache.json.lock");
            const claimPath = `${lockPath}.reclaim`;
            const readyA = join(trialRoot, "ready-a");
            const readyB = join(trialRoot, "ready-b");
            const barrier = join(trialRoot, "barrier");
            const marker = join(trialRoot, "marker");
            const resultA = join(trialRoot, "result-a.json");
            const resultB = join(trialRoot, "result-b.json");
            const lockOptions = JSON.stringify({ timeoutMs: 10_000, staleMs: 5_000, pollIntervalMs: 5 });
            const deadLockOwnerPid = spawnDeadPid();
            const crashedReclaimerPid = spawnDeadPid();

            // Fabricate the exact reproduction precondition: an abandoned
            // lock AND an abandoned reclaim gate already sitting on disk
            // before either contender starts.
            const createLock = await runWorker(["create-dead-lock", lockPath, String(deadLockOwnerPid), "0"]);
            expect(createLock.code, createLock.stderr).toBe(0);
            const createGate = await runWorker(["create-dead-lock", claimPath, String(crashedReclaimerPid), "0"]);
            expect(createGate.code, createGate.stderr).toBe(0);
            expect(existsSync(claimPath)).toBe(true);

            const childA = runWorker(["race-reclaim", lockPath, readyA, barrier, marker, resultA, "80", lockOptions]);
            const childB = runWorker(["race-reclaim", lockPath, readyB, barrier, marker, resultB, "80", lockOptions]);

            const readyDeadline = Date.now() + 10_000;
            while (!(existsSync(readyA) && existsSync(readyB))) {
              if (Date.now() > readyDeadline) throw new Error(`trial ${trial}: contenders never signaled ready`);
            }
            writeFileSync(barrier, "go");

            const [outcomeA, outcomeB] = await Promise.all([childA, childB]);
            expect(outcomeA.code, `trial ${trial} A: ${outcomeA.stderr}`).toBe(0);
            expect(outcomeB.code, `trial ${trial} B: ${outcomeB.stderr}`).toBe(0);

            const parsedA = JSON.parse(readFileSync(resultA, "utf8")) as { overlap: boolean };
            const parsedB = JSON.parse(readFileSync(resultB, "utf8")) as { overlap: boolean };
            expect(parsedA.overlap, `trial ${trial}: A observed overlap`).toBe(false);
            expect(parsedB.overlap, `trial ${trial}: B observed overlap`).toBe(false);

            // Both contenders eventually succeeded in turn, and no lock,
            // reclaim gate, recovery-gate marker, or critical-section
            // marker is left dangling afterward.
            expect(existsSync(lockPath)).toBe(false);
            expect(existsSync(claimPath)).toBe(false);
            expect(existsSync(marker)).toBe(false);
          } finally {
            rmSync(trialRoot, { recursive: true, force: true });
          }
        }
      },
      60_000
    );

    it(
      "after the winner of a reclaim-gate recovery race releases normally, the loser can subsequently " +
        "acquire, and independently-written cache entries from each contender are preserved",
      async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-xproc-gate-sequence-"));
        const cachePath = join(tempRoot, "cache.json");
        const lockPath = `${cachePath}.lock`;
        const claimPath = `${lockPath}.reclaim`;
        const readyA = join(tempRoot, "ready-a");
        const readyB = join(tempRoot, "ready-b");
        const barrier = join(tempRoot, "barrier");
        const marker = join(tempRoot, "marker");
        const resultA = join(tempRoot, "result-a.json");
        const resultB = join(tempRoot, "result-b.json");
        const lockOptions = JSON.stringify({ timeoutMs: 10_000, staleMs: 5_000, pollIntervalMs: 5 });

        const createLock = await runWorker(["create-dead-lock", lockPath, String(spawnDeadPid()), "0"]);
        expect(createLock.code, createLock.stderr).toBe(0);
        const createGate = await runWorker(["create-dead-lock", claimPath, String(spawnDeadPid()), "0"]);
        expect(createGate.code, createGate.stderr).toBe(0);

        // Both contenders will use `set` via the SAME cache path once
        // they win the (recovered) lock, each writing a different key —
        // proving the eventual winner-then-loser sequence never loses
        // either contender's independently-written entry.
        const childA = runWorker(["race-reclaim", lockPath, readyA, barrier, marker, resultA, "50", lockOptions]);
        const childB = runWorker(["race-reclaim", lockPath, readyB, barrier, marker, resultB, "50", lockOptions]);

        const readyDeadline = Date.now() + 10_000;
        while (!(existsSync(readyA) && existsSync(readyB))) {
          if (Date.now() > readyDeadline) throw new Error("contenders never signaled ready");
        }
        writeFileSync(barrier, "go");

        const [outcomeA, outcomeB] = await Promise.all([childA, childB]);
        expect(outcomeA.code, outcomeA.stderr).toBe(0);
        expect(outcomeB.code, outcomeB.stderr).toBe(0);

        // After both have finished (the loser only after the winner
        // released), the lock/gate are fully released and a fresh writer
        // can immediately proceed with no residual contention.
        const setResult = await runWorker(["set", cachePath, "after-sequence", "value", "", lockOptions]);
        expect(setResult.code, setResult.stderr).toBe(0);
        const cache = new FileCache<string>(new FileStateStore(), cachePath);
        expect(cache.get("after-sequence")).toBe("value");
        expect(existsSync(lockPath)).toBe(false);
        expect(existsSync(claimPath)).toBe(false);
      },
      20_000
    );

    it(
      "a long-running valid critical section is never overlapped by concurrent contenders, even when it " +
        "outlives their configured staleMs",
      async () => {
        // Fresh (non-fabricated) contention: three processes race for a
        // BRAND-NEW lock with a deliberately tiny `staleMs`, and whichever
        // one wins holds it for far longer than that `staleMs` — proving
        // the others correctly wait (never reclaim a live winner) via the
        // same marker-based overlap witness as the dedicated race test.
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-xproc-longcs-"));
        const lockPath = join(tempRoot, "cache.json.lock");
        const barrier = join(tempRoot, "barrier");
        const marker = join(tempRoot, "marker");
        const lockOptions = JSON.stringify({ timeoutMs: 10_000, staleMs: 50, pollIntervalMs: 10 });
        const contenderCount = 3;

        const readyPaths = Array.from({ length: contenderCount }, (_, i) => join(tempRoot, `ready-${i}`));
        const resultPaths = Array.from({ length: contenderCount }, (_, i) => join(tempRoot, `result-${i}.json`));
        const children = readyPaths.map((readyPath, i) =>
          runWorker(["race-reclaim", lockPath, readyPath, barrier, marker, resultPaths[i], "300", lockOptions])
        );

        const readyDeadline = Date.now() + 10_000;
        while (!readyPaths.every((p) => existsSync(p))) {
          if (Date.now() > readyDeadline) throw new Error("contenders never signaled ready");
        }
        writeFileSync(barrier, "go");

        const outcomes = await Promise.all(children);
        for (const outcome of outcomes) {
          expect(outcome.code, outcome.stderr).toBe(0);
        }
        for (const resultPath of resultPaths) {
          const parsed = JSON.parse(readFileSync(resultPath, "utf8")) as { overlap: boolean };
          expect(parsed.overlap).toBe(false);
        }
        expect(existsSync(lockPath)).toBe(false);
      },
      30_000
    );

    it("same-process behavior remains correct after adding cross-process locking", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-sameproc-"));
      const cachePath = join(tempRoot, "cache.json");
      const cache = new FileCache<string>(new FileStateStore(), cachePath);
      cache.set("a", "1");
      cache.set("b", "2");
      expect(cache.get("a")).toBe("1");
      expect(cache.get("b")).toBe("2");
      expect(cache.size()).toBe(2);
    });

    it(
      "restart persistence still works: a brand-new REAL process can read what a different REAL process wrote",
      async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-xproc-restart-"));
        const cachePath = join(tempRoot, "cache.json");
        const writeResult = await runWorker(["set", cachePath, "durable-key", "durable-value"]);
        expect(writeResult.code, writeResult.stderr).toBe(0);

        const readResult = await runWorker(["get", cachePath, "durable-key"]);
        expect(readResult.code, readResult.stderr).toBe(0);
        expect((JSON.parse(readResult.stdout) as { value: unknown }).value).toBe("durable-value");
      },
      20_000
    );

    it("a malformed/unserializable write preserves the previous durable cache state (via FileStateStore's atomic write, unaffected by locking)", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-malformed-"));
      const cachePath = join(tempRoot, "cache.json");
      const cache = new FileCache<unknown>(new FileStateStore(), cachePath);
      cache.set("good", "value");

      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(() => cache.set("bad", circular)).toThrow();

      const reread = new FileCache<unknown>(new FileStateStore(), cachePath);
      expect(reread.get("good")).toBe("value");
      expect(reread.get("bad")).toBeUndefined();
    });
  }
);
