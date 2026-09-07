import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { acquireFileLock, FileLockTimeoutError } from "../file-lock.js";

// P2 fix (22nd independent review round, "validate lock metadata before
// using owner PID"): Codex reproduced that syntactically valid JSON with
// structurally MALFORMED ownership fields (e.g. `{}`, or
// `{"pid":"123"}` — a string, not a number) used to be cast directly as
// `LockMeta` with no runtime validation. The malformed `pid` then reached
// `isProcessAlive()`, whose `process.kill(pid, 0)` call threw an
// unexpected (non-ESRCH) error for the invalid PID value, which
// `isProcessAlive()` conservatively — but wrongly, in this case —
// interpreted as "the owner is alive". That falsely turned malformed
// metadata into a "confirmed live owner" result, which `isLockStale()`
// then treats as NEVER stale regardless of age — permanently blocking
// the documented UNKNOWN-owner recovery policy from ever running.
// `readLockMeta()` now structurally validates every field before trusting
// it as `LockMeta`, returning `undefined` (exactly like unreadable/corrupt
// metadata) whenever validation fails — routing malformed metadata into
// the SAME bounded, `mtime`-based UNKNOWN-owner recovery path that
// already existed for genuinely unreadable metadata, never into
// CONFIRMED-LIVE and never into an unconditional immediate delete.
//
// These tests exercise `acquireFileLock()` (the module's only public
// entry point) directly against a real, on-disk lock directory whose
// `owner.json` is manually fabricated with malformed content, proving the
// documented state machine — CONFIRMED LIVE / CONFIRMED DEAD / UNKNOWN —
// stays correct even when metadata parses as JSON but is not a valid
// owner record.

const tempDirs: string[] = [];

function makeLockDir(): string {
  const root = mkdtempSync(join(tmpdir(), "uasf-file-lock-meta-"));
  tempDirs.push(root);
  const lockDirPath = join(root, "cache.lock");
  mkdirSync(lockDirPath);
  return lockDirPath;
}

function writeRawOwnerFile(lockDirPath: string, rawContent: string): void {
  writeFileSync(join(lockDirPath, "owner.json"), rawContent, "utf8");
}

/** Backdates the lock directory's own mtime so the UNKNOWN-owner, mtime-based
 * bounded fallback in `isLockStale()` can be exercised deterministically,
 * without waiting out `staleMs` in real time. */
function ageLockDir(lockDirPath: string, ageMs: number): void {
  const past = new Date(Date.now() - ageMs);
  utimesSync(lockDirPath, past, past);
}

/** Spawns and fully awaits a trivial child process, then returns its
 * (now provably exited, i.e. dead) PID — used to fabricate a genuine
 * CONFIRMED-DEAD owner precondition deterministically. */
function spawnDeadPid(): number {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const pid = result.pid;
  if (!pid) throw new Error("spawnDeadPid: child process did not report a pid");
  return pid;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe(
  "acquireFileLock owner-metadata validation (P2 fix, 22nd independent review round, " +
    "'validate lock metadata before using owner PID')",
  () => {
    const malformedOwnerCases: ReadonlyArray<readonly [string, string]> = [
      ["empty object", "{}"],
      ["string pid", JSON.stringify({ pid: "123", token: "t", acquiredAt: Date.now() })],
      ["missing pid", JSON.stringify({ token: "t", acquiredAt: Date.now() })],
      ["pid = 0", JSON.stringify({ pid: 0, token: "t", acquiredAt: Date.now() })],
      ["negative pid", JSON.stringify({ pid: -5, token: "t", acquiredAt: Date.now() })],
      ["fractional pid", JSON.stringify({ pid: 1.5, token: "t", acquiredAt: Date.now() })],
      ["null", "null"],
      ["array", JSON.stringify([1, 2, 3])],
      [
        "wrong field types",
        JSON.stringify({ pid: 123, token: 42, acquiredAt: "yesterday" }),
      ],
      ["malformed JSON (unparsable)", "{not valid json"],
    ];

    for (const [label, rawContent] of malformedOwnerCases) {
      it(`owner.json = ${label}: is NOT treated as a confirmed-live owner and is recovered via the bounded UNKNOWN-owner policy instead of blocking acquisition forever`, () => {
        const lockDirPath = makeLockDir();
        writeRawOwnerFile(lockDirPath, rawContent);
        // Aged past staleMs so the UNKNOWN-owner mtime-based fallback is
        // eligible to reclaim it — proving malformed metadata does not
        // permanently prevent recovery (requirement C).
        ageLockDir(lockDirPath, 500);

        const start = Date.now();
        const release = acquireFileLock(lockDirPath, {
          timeoutMs: 5_000,
          staleMs: 50,
          pollIntervalMs: 5,
        });
        const elapsed = Date.now() - start;

        // Recovered promptly — nowhere near the configured timeout budget.
        // If malformed metadata had been misread as a confirmed-live
        // owner, this would have hung until FileLockTimeoutError at
        // ~5000ms instead.
        expect(elapsed).toBeLessThan(2_000);
        release();
      });
    }

    it(
      "owner.json = {} that has NOT yet aged past staleMs is NOT immediately stolen — malformed metadata still " +
        "honors the same bounded UNKNOWN-owner staleness window as unreadable metadata (requirement F)",
      () => {
        const lockDirPath = makeLockDir();
        writeRawOwnerFile(lockDirPath, "{}");
        // Deliberately left at its natural (fresh) mtime — not aged.

        expect(() =>
          acquireFileLock(lockDirPath, { timeoutMs: 150, staleMs: 60_000, pollIntervalMs: 10 })
        ).toThrow(FileLockTimeoutError);
      }
    );

    it(
      "malformed owner metadata does not bypass the acquisition deadline: acquisition still throws " +
        "FileLockTimeoutError within its configured budget when recovery genuinely cannot occur yet (requirement D)",
      () => {
        const lockDirPath = makeLockDir();
        writeRawOwnerFile(lockDirPath, JSON.stringify({ pid: "not-a-number" }));

        const start = Date.now();
        expect(() =>
          acquireFileLock(lockDirPath, { timeoutMs: 200, staleMs: 60_000, pollIntervalMs: 10 })
        ).toThrow(FileLockTimeoutError);
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(2_000);
      }
    );

    it("valid metadata for a genuinely LIVE owner (this test process' own pid) is never reclaimed, regardless of age (requirement A)", () => {
      const lockDirPath = makeLockDir();
      writeRawOwnerFile(
        lockDirPath,
        JSON.stringify({ pid: process.pid, token: "live-owner", acquiredAt: Date.now() })
      );
      // Very old by mtime — age alone must never authorize reclaiming a
      // confirmed-live owner (17th independent review round invariant,
      // unaffected by this round's metadata-validation fix).
      ageLockDir(lockDirPath, 60_000);

      expect(() =>
        acquireFileLock(lockDirPath, { timeoutMs: 150, staleMs: 1, pollIntervalMs: 10 })
      ).toThrow(FileLockTimeoutError);
    });

    it("valid metadata for a genuinely DEAD owner is still reclaimed near-instantly, unaffected by the metadata-validation fix (requirement B)", () => {
      const lockDirPath = makeLockDir();
      const deadPid = spawnDeadPid();
      writeRawOwnerFile(
        lockDirPath,
        JSON.stringify({ pid: deadPid, token: "dead-owner", acquiredAt: Date.now() })
      );

      const start = Date.now();
      const release = acquireFileLock(lockDirPath, {
        timeoutMs: 5_000,
        staleMs: 60_000, // deliberately huge — dead-owner recovery must not wait for staleMs at all
        pollIntervalMs: 10,
      });
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(2_000);
      release();
    });

    it("a legitimate live lock elsewhere is unaffected by an unrelated malformed-metadata lock (isolation sanity check, requirement E/F)", () => {
      const liveLockDirPath = makeLockDir();
      writeRawOwnerFile(
        liveLockDirPath,
        JSON.stringify({ pid: process.pid, token: "live-owner", acquiredAt: Date.now() })
      );
      ageLockDir(liveLockDirPath, 60_000);

      const otherLockDirPath = makeLockDir();
      writeRawOwnerFile(otherLockDirPath, "{}");
      ageLockDir(otherLockDirPath, 500);

      // The malformed lock recovers normally...
      const releaseOther = acquireFileLock(otherLockDirPath, {
        timeoutMs: 2_000,
        staleMs: 50,
        pollIntervalMs: 5,
      });
      releaseOther();

      // ...while the unrelated live lock remains fully protected.
      expect(() =>
        acquireFileLock(liveLockDirPath, { timeoutMs: 150, staleMs: 1, pollIntervalMs: 10 })
      ).toThrow(FileLockTimeoutError);
    });
  }
);
