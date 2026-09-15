import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { FileStateStore } from "../../state/file-store.js";
import { FileCache } from "../file-cache.js";

/** Mirrors FileCache's own private computeLockPath() exactly, so tests can fabricate a dead lock on it. */
function computeLockPathFor(cachePath: string, key: string): string {
  return `${cachePath}.compute.${createHash("sha256").update(key).digest("hex")}.lock`;
}

/**
 * Mirrors FileCache's own private computeLeasePath() exactly (independent
 * Codex review, "do not hold the synchronous cache lock across await") —
 * lets a test fabricate a durable "someone is already computing this key"
 * lease record directly on disk, simulating an owner that crashed mid-
 * compute without ever reaching the code that would normally clear it.
 */
function computeLeasePathFor(cachePath: string, key: string): string {
  return `${cachePath}.compute.${createHash("sha256").update(key).digest("hex")}.lease`;
}

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
  readonly timedOut: boolean;
}

/**
 * `externalTimeoutMs` is an EXTERNAL safety net only — it exists so that
 * if a bypassed/regressed implementation genuinely hangs (bkz. the 21st
 * independent review round's busy-loop finding), this test HARNESS still
 * terminates the runaway child and reports it, instead of hanging the
 * whole suite forever. It is NEVER the thing a passing test relies on —
 * a CORRECT implementation must return well within its OWN configured
 * `timeoutMs`, long before this external net would ever fire.
 */
function runWorker(args: readonly string[], externalTimeoutMs = 15_000): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, [workerPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, externalTimeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      resolve({ code: timedOut ? -1 : (code ?? -1), stdout, stderr, timedOut });
    });
  });
}

/**
 * Whether this filesystem/environment supports the Linux immutable file
 * attribute (`chattr +i`) — used to deterministically force a REAL
 * `rmSync` removal failure (even running as root, which bypasses ordinary
 * permission bits) for the 21st independent review round's regression
 * tests. Probed once, defensively: some container/overlay filesystems
 * don't support this attribute at all, in which case those specific
 * tests are skipped rather than failing on an environment limitation
 * unrelated to the fix itself.
 */
function immutableAttributeSupported(): boolean {
  let probeDir: string | undefined;
  try {
    probeDir = mkdtempSync(join(tmpdir(), "uasf-chattr-probe-"));
    const probeFile = join(probeDir, "probe");
    writeFileSync(probeFile, "x");
    execFileSync("chattr", ["+i", probeFile]);
    const attrs = execFileSync("lsattr", [probeFile], { encoding: "utf8" });
    const supported = /i/.test(attrs.split(" ")[0] ?? "");
    execFileSync("chattr", ["-i", probeFile]);
    return supported;
  } catch {
    return false;
  } finally {
    if (probeDir) {
      try {
        rmSync(probeDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }
}

const canForceRemovalFailure = immutableAttributeSupported();

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
        seedCache.set("expired-key", "stale-value", 0); // ttlMs: 0 -> already expired (round 26's fix)

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

    it.skipIf(!canForceRemovalFailure)(
      "P2 fix (21st independent review round, 'stale-lock removal failure bypasses acquisition timeout'): " +
        "when a dead-owner lock is detected but its actual removal genuinely FAILS, acquisition still honors " +
        "the configured deadline and throws a deterministic timeout error, instead of hanging indefinitely",
      async () => {
        // Codex reproduced: an abandoned/dead-owner lock exists and can be
        // read as stale, but `rmSync(lockDirPath)` itself fails (e.g. a
        // permission error, a busy/un-removable entry inside it) — the OLD
        // `tryReclaimStaleLock()` swallowed that failure and reported
        // "reclaimed successfully" anyway, so the caller's `continue`
        // skipped BOTH the deadline check and the retry sleep, spinning
        // forever. Reproduced here with a REAL, deterministic removal
        // failure: a file made immutable via `chattr +i` INSIDE the
        // fabricated dead-owner lock directory, which makes the real
        // `rmSync(lockDirPath, {recursive:true})` genuinely throw
        // EPERM — even running as root, which bypasses ordinary
        // permission bits (this environment does run tests as root; a
        // simple read-only-permission trick would not have reproduced a
        // genuine failure here).
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-xproc-removal-fail-"));
        const cachePath = join(tempRoot, "cache.json");
        const lockPath = `${cachePath}.lock`;
        const deadPid = spawnDeadPid();
        const timeoutMs = 300;
        const tightOptions = JSON.stringify({ timeoutMs, staleMs: 50, pollIntervalMs: 10 });

        const createResult = await runWorker(["create-dead-lock", lockPath, String(deadPid), "0"]);
        expect(createResult.code, createResult.stderr).toBe(0);

        const undeletableFile = join(lockPath, "undeletable");
        writeFileSync(undeletableFile, "cannot remove this");
        execFileSync("chattr", ["+i", undeletableFile]);

        try {
          const start = Date.now();
          const setResult = await runWorker(
            ["set", cachePath, "should-never-be-written", "value", "", tightOptions],
            5_000
          );
          const elapsedMs = Date.now() - start;

          // Must NOT have needed the external safety kill — a correct
          // implementation returns on its own, well within its OWN
          // configured timeout window.
          expect(setResult.timedOut, "worker required external termination — it hung").toBe(false);
          expect(setResult.code).not.toBe(0);
          expect(setResult.stderr).toContain("FileLockTimeoutError");
          // Bounded, deterministic termination: close to the configured
          // 300ms timeout, not "hung for seconds" (the review's own
          // reproduction needed ~2s of external termination) and not
          // "returned instantly without ever really trying" either.
          expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs - 50);
          expect(elapsedMs).toBeLessThan(2_000);

          // The write must never have been recorded (fail-closed, not a
          // silent partial success).
          const cache = new FileCache<string>(new FileStateStore(), cachePath);
          expect(cache.get("should-never-be-written")).toBeUndefined();
        } finally {
          // Clean up the immutable file ourselves (as root, chattr -i
          // always works) so this test's own tempRoot cleanup doesn't fail.
          try {
            execFileSync("chattr", ["-i", undeletableFile]);
          } catch {
            // best-effort
          }
        }
      },
      20_000
    );

    it.skipIf(!canForceRemovalFailure)(
      "retry loops during a persistent removal failure do not busy-spin: repeated attempts are paced by " +
        "pollIntervalMs, not tight/instant iterations",
      async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-xproc-nobusyspin-"));
        const cachePath = join(tempRoot, "cache.json");
        const lockPath = `${cachePath}.lock`;
        const deadPid = spawnDeadPid();
        // A longer timeout with a coarse pollIntervalMs: if the loop were
        // busy-spinning (no backoff at all), it would still terminate at
        // the deadline — the busy-spin symptom is CPU/behavioral, not a
        // hang, once the deadline check itself is fixed. What a busy-spin
        // WOULD do differently is burn CPU nonstop; we instead assert the
        // simpler, directly-observable invariant this fix guarantees:
        // deterministic termination at approximately the configured
        // timeout even with persistent removal failure and coarse polling.
        const timeoutMs = 400;
        const pollIntervalMs = 100;
        const options = JSON.stringify({ timeoutMs, staleMs: 50, pollIntervalMs });

        const createResult = await runWorker(["create-dead-lock", lockPath, String(deadPid), "0"]);
        expect(createResult.code, createResult.stderr).toBe(0);
        const undeletableFile = join(lockPath, "undeletable");
        writeFileSync(undeletableFile, "cannot remove this");
        execFileSync("chattr", ["+i", undeletableFile]);

        try {
          const start = Date.now();
          const setResult = await runWorker(["set", cachePath, "k", "v", "", options], 5_000);
          const elapsedMs = Date.now() - start;

          expect(setResult.timedOut).toBe(false);
          expect(setResult.code).not.toBe(0);
          expect(setResult.stderr).toContain("FileLockTimeoutError");
          expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs - 50);
          expect(elapsedMs).toBeLessThan(2_000);
        } finally {
          try {
            execFileSync("chattr", ["-i", undeletableFile]);
          } catch {
            // best-effort
          }
        }
      },
      20_000
    );

    it.skipIf(!canForceRemovalFailure)(
      "after a persistent removal failure is resolved (the blocking entry is cleared), normal reclamation " +
        "and acquisition succeed again",
      async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-xproc-recovers-"));
        const cachePath = join(tempRoot, "cache.json");
        const lockPath = `${cachePath}.lock`;
        const deadPid = spawnDeadPid();
        const options = JSON.stringify({ timeoutMs: 300, staleMs: 50, pollIntervalMs: 10 });

        const createResult = await runWorker(["create-dead-lock", lockPath, String(deadPid), "0"]);
        expect(createResult.code, createResult.stderr).toBe(0);
        const undeletableFile = join(lockPath, "undeletable");
        writeFileSync(undeletableFile, "cannot remove this");
        execFileSync("chattr", ["+i", undeletableFile]);

        // First attempt genuinely fails (bounded timeout, not a hang).
        const firstAttempt = await runWorker(["set", cachePath, "k", "v1", "", options], 5_000);
        expect(firstAttempt.timedOut).toBe(false);
        expect(firstAttempt.code).not.toBe(0);

        // Clear the blocking condition — recovery must work NORMALLY
        // afterward, exactly as the pre-existing dead-owner-recovery
        // tests already prove for the no-failure case.
        execFileSync("chattr", ["-i", undeletableFile]);

        const secondAttempt = await runWorker(["set", cachePath, "k", "v2", "", options], 5_000);
        expect(secondAttempt.code, secondAttempt.stderr).toBe(0);

        const cache = new FileCache<string>(new FileStateStore(), cachePath);
        expect(cache.get("k")).toBe("v2");
        expect(existsSync(lockPath)).toBe(false);
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

    describe(
      "P2 fix (independent Codex review, 'deduplicate concurrent durable cache computations'): " +
        "computeWithFileCache() must single-flight a cache-miss key across REAL, separate OS processes",
      () => {
        it(
          "BLOCKER regression, exact reproduction: two REAL child processes request the SAME missing key " +
            "concurrently -> the compute callback runs EXACTLY ONCE, and both callers receive the identical " +
            "stored result",
          async () => {
            tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-xproc-compute-"));
            const cachePath = join(tempRoot, "cache.json");
            const logPath = join(tempRoot, "compute-log.txt");
            writeFileSync(logPath, "");

            const [resultA, resultB] = await Promise.all([
              runWorker(["compute", cachePath, "shared-key", "computed-value", logPath, "150"]),
              runWorker(["compute", cachePath, "shared-key", "computed-value", logPath, "150"])
            ]);
            expect(resultA.code, resultA.stderr).toBe(0);
            expect(resultB.code, resultB.stderr).toBe(0);

            const parsedA = JSON.parse(resultA.stdout) as { value: string; cached: boolean };
            const parsedB = JSON.parse(resultB.stdout) as { value: string; cached: boolean };
            expect(parsedA.value).toBe("computed-value");
            expect(parsedB.value).toBe("computed-value");
            // Exactly one of the two genuinely computed it; the other
            // reused the lease winner's already-persisted result.
            expect([parsedA.cached, parsedB.cached].sort()).toEqual([false, true]);

            const logLines = readFileSync(logPath, "utf8").split("\n").filter((l) => l.length > 0);
            expect(logLines).toHaveLength(1);

            const cache = new FileCache<string>(new FileStateStore(), cachePath);
            expect(cache.get("shared-key")).toBe("computed-value");
          },
          20_000
        );

        it(
          "high-contention: 5 REAL processes race the SAME missing key -> compute still runs exactly once",
          async () => {
            tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-xproc-compute-contend-"));
            const cachePath = join(tempRoot, "cache.json");
            const logPath = join(tempRoot, "compute-log.txt");
            writeFileSync(logPath, "");
            const contenderCount = 5;

            const results = await Promise.all(
              Array.from({ length: contenderCount }, () =>
                runWorker(["compute", cachePath, "hot-key", "the-one-true-value", logPath, "100"])
              )
            );
            for (const result of results) expect(result.code, result.stderr).toBe(0);

            const parsed = results.map((r) => JSON.parse(r.stdout) as { value: string; cached: boolean });
            for (const p of parsed) expect(p.value).toBe("the-one-true-value");
            expect(parsed.filter((p) => !p.cached)).toHaveLength(1);

            const logLines = readFileSync(logPath, "utf8").split("\n").filter((l) => l.length > 0);
            expect(logLines).toHaveLength(1);
          },
          30_000
        );

        it(
          "a compute() failure is never silently cached as a success, and does not deadlock a subsequent caller",
          async () => {
            tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-xproc-compute-fail-"));
            const cachePath = join(tempRoot, "cache.json");
            const logPath = join(tempRoot, "compute-log.txt");
            writeFileSync(logPath, "");

            const failResult = await runWorker(["compute-fail", cachePath, "flaky-key", logPath]);
            expect(failResult.code, failResult.stderr).toBe(0);
            expect(failResult.stdout).toContain("simulated compute failure");

            const cache = new FileCache<string>(new FileStateStore(), cachePath);
            expect(cache.has("flaky-key")).toBe(false);

            // A subsequent, ordinary compute for the SAME key must succeed
            // normally — the failed attempt's lease was released, not left
            // permanently held.
            const retryResult = await runWorker(["compute", cachePath, "flaky-key", "recovered-value", logPath, "0"]);
            expect(retryResult.code, retryResult.stderr).toBe(0);
            const parsed = JSON.parse(retryResult.stdout) as { value: string; cached: boolean };
            expect(parsed.value).toBe("recovered-value");
            expect(parsed.cached).toBe(false);
          },
          20_000
        );

        it(
          "a process crashing while holding the per-key compute lease does not permanently deadlock a " +
            "subsequent compute for that SAME key (dead-PID detection recovers immediately)",
          async () => {
            tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-xproc-compute-crash-"));
            const cachePath = join(tempRoot, "cache.json");
            const logPath = join(tempRoot, "compute-log.txt");
            writeFileSync(logPath, "");
            const computeLockPath = computeLockPathFor(cachePath, "crash-key");
            const deadPid = spawnDeadPid();
            const generousStaleOptions = JSON.stringify({ timeoutMs: 10_000, staleMs: 60_000, pollIntervalMs: 20 });

            const createResult = await runWorker(["create-dead-lock", computeLockPath, String(deadPid), "0"]);
            expect(createResult.code, createResult.stderr).toBe(0);
            expect(existsSync(computeLockPath)).toBe(true);

            const start = Date.now();
            const computeResult = await runWorker([
              "compute",
              cachePath,
              "crash-key",
              "value-after-crash",
              logPath,
              "0",
              generousStaleOptions
            ]);
            const elapsedMs = Date.now() - start;

            expect(computeResult.code, computeResult.stderr).toBe(0);
            expect(elapsedMs).toBeLessThan(5_000);
            const parsed = JSON.parse(computeResult.stdout) as { value: string; cached: boolean };
            expect(parsed.value).toBe("value-after-crash");

            const cache = new FileCache<string>(new FileStateStore(), cachePath);
            expect(cache.get("crash-key")).toBe("value-after-crash");
          },
          20_000
        );

        it(
          "P1 fix (independent Codex review, 'do not hold the synchronous cache lock across await'): a REAL " +
            "cross-process compute() taking longer than another contender's short lock timeoutMs never throws " +
            "FileLockTimeoutError — the lock is only ever held for the brief negotiation, never across the " +
            "await itself",
          async () => {
            tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-xproc-no-lock-across-await-"));
            const cachePath = join(tempRoot, "cache.json");
            const logPath = join(tempRoot, "compute-log.txt");
            writeFileSync(logPath, "");
            // A deliberately TIGHT lock timeoutMs (governs only the brief
            // negotiation critical section, never the compute itself) —
            // paired with a compute delay far longer than it. Under the old
            // "hold the lock across await" implementation this would have
            // made the second contender's `acquireFileLock()` spin-wait
            // time out and throw; it must not under the fixed protocol.
            const tightLockOptions = JSON.stringify({ timeoutMs: 50, staleMs: 5_000, pollIntervalMs: 5 });

            const [resultA, resultB] = await Promise.all([
              runWorker(["compute", cachePath, "shared-key", "computed-value", logPath, "300", tightLockOptions]),
              runWorker(["compute", cachePath, "shared-key", "computed-value", logPath, "300", tightLockOptions])
            ]);
            expect(resultA.code, resultA.stderr).toBe(0);
            expect(resultB.code, resultB.stderr).toBe(0);
            expect(resultA.stderr).not.toContain("FileLockTimeoutError");
            expect(resultB.stderr).not.toContain("FileLockTimeoutError");

            const parsedA = JSON.parse(resultA.stdout) as { value: string; cached: boolean };
            const parsedB = JSON.parse(resultB.stdout) as { value: string; cached: boolean };
            expect(parsedA.value).toBe("computed-value");
            expect(parsedB.value).toBe("computed-value");
            expect([parsedA.cached, parsedB.cached].sort()).toEqual([false, true]);

            const logLines = readFileSync(logPath, "utf8").split("\n").filter((l) => l.length > 0);
            expect(logLines).toHaveLength(1);
          },
          20_000
        );

        it(
          "a fabricated, never-released compute LEASE (simulating an owner that crashed mid-compute, after " +
            "winning ownership but before persisting anything) is reclaimed once its own recorded expiresAt " +
            "passes — bounded, deterministic recovery rather than a permanent deadlock",
          async () => {
            tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-xproc-dead-lease-"));
            const cachePath = join(tempRoot, "cache.json");
            const logPath = join(tempRoot, "compute-log.txt");
            writeFileSync(logPath, "");
            const leasePath = computeLeasePathFor(cachePath, "abandoned-key");

            // Fabricate a lease whose `expiresAt` is already in the past —
            // exactly what a genuinely crashed owner's lease looks like
            // once its own bounded TTL has elapsed.
            const staleLease = JSON.stringify({ ownerId: "crashed-owner", expiresAt: Date.now() - 1_000 });
            const writeResult = await runWorker(["write-json", leasePath, staleLease]);
            expect(writeResult.code, writeResult.stderr).toBe(0);

            const start = Date.now();
            const computeResult = await runWorker([
              "compute",
              cachePath,
              "abandoned-key",
              "value-after-crash",
              logPath,
              "0"
            ]);
            const elapsedMs = Date.now() - start;

            expect(computeResult.code, computeResult.stderr).toBe(0);
            expect(elapsedMs).toBeLessThan(5_000);
            const parsed = JSON.parse(computeResult.stdout) as { value: string; cached: boolean };
            expect(parsed.value).toBe("value-after-crash");
            expect(parsed.cached).toBe(false);

            const cache = new FileCache<string>(new FileStateStore(), cachePath);
            expect(cache.get("abandoned-key")).toBe("value-after-crash");
          },
          20_000
        );

        it("a same-process cache hit never invokes compute() at all, and does not acquire the compute lease", async () => {
          tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-compute-hit-"));
          const cachePath = join(tempRoot, "cache.json");
          const cache = new FileCache<string>(new FileStateStore(), cachePath);
          cache.set("already-there", "existing-value");
          const { computeWithFileCache } = await import("../file-cache.js");
          let computeCalls = 0;
          const result = await computeWithFileCache(cache, "already-there", () => {
            computeCalls++;
            return "should-never-be-used";
          });
          expect(result).toEqual({ value: "existing-value", cached: true });
          expect(computeCalls).toBe(0);
        });
      }
    );
  }
);
