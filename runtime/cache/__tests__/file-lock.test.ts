import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { acquireFileLock, FileLockTimeoutError, InvalidFileLockOptionsError, sanitizeReclaimToken } from "../file-lock.js";

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
      // P2 fix (23rd independent review round, "reject out-of-range lock
      // owner PIDs"): `pid: null` explicitly (a genuinely representable
      // JSON value, distinct from "missing pid" where the field is absent
      // entirely) and a PID one greater than the platform-valid upper
      // bound (2147483647, i.e. 2^31-1 — Node's own `process.kill()`
      // rejects anything larger with a TypeError, never ESRCH, confirmed
      // empirically in this exact environment) must both be treated as
      // malformed/UNKNOWN owner, never confirmed-live. JSON has no native
      // NaN/Infinity literal (a file literally containing `NaN`/`Infinity`
      // as a bare token is simply unparsable JSON, already covered by the
      // "malformed JSON (unparsable)" case above), so those two review-
      // requested cases are exercised via `pid: null` and the out-of-range
      // integer here instead — the closest genuinely JSON-representable
      // equivalents of "not a valid finite PID number".
      ["pid explicitly null", JSON.stringify({ pid: null, token: "t", acquiredAt: Date.now() })],
      [
        "pid one greater than the platform-valid PID upper bound (2147483648)",
        JSON.stringify({ pid: 2147483648, token: "t", acquiredAt: Date.now() })
      ]
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

    it(
      "P2 fix (23rd independent review round, 'reject out-of-range lock owner PIDs'): a PID exactly at the " +
        "platform-valid upper bound (2147483647) is NOT treated as malformed — it goes through the ordinary " +
        "PID-liveness check like any other syntactically valid PID, and (since no real process holds it) is " +
        "recovered as a confirmed-DEAD owner, immediately, regardless of staleMs",
      () => {
        const lockDirPath = makeLockDir();
        writeRawOwnerFile(
          lockDirPath,
          JSON.stringify({ pid: 2147483647, token: "t", acquiredAt: Date.now() })
        );
        // Deliberately NOT aged and a huge staleMs — a confirmed-dead
        // owner must be reclaimed instantly regardless of either.

        const start = Date.now();
        const release = acquireFileLock(lockDirPath, {
          timeoutMs: 5_000,
          staleMs: 60_000,
          pollIntervalMs: 10
        });
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(2_000);
        release();
      }
    );
  }
);

describe(
  "sanitizeReclaimToken (P1 fix, 23rd independent review round, " +
    "'sanitize reclaim tokens before deriving filesystem paths')",
  () => {
    it("accepts this implementation's own canonical token format (16 lowercase hex characters) unchanged", () => {
      expect(sanitizeReclaimToken("0123456789abcdef")).toBe("0123456789abcdef");
      expect(sanitizeReclaimToken("ffffffffffffffff")).toBe("ffffffffffffffff");
    });

    const rejectedTokens: ReadonlyArray<readonly [string, string | undefined]> = [
      ["undefined (token never read)", undefined],
      ["empty string", ""],
      ["POSIX relative traversal", "../x"],
      ["POSIX double traversal", "../../x"],
      ["Windows-style relative traversal", "..\\x"],
      ["contains a forward slash", "a/b"],
      ["contains a backslash", "a\\b"],
      ["absolute POSIX path", "/etc/passwd"],
      ["absolute Windows-style path", "C:\\evil"],
      ["bare double-dot", ".."],
      ["oversized (longer than 16 hex chars)", "0123456789abcdef0123456789abcdef"],
      ["too short", "abc123"],
      ["uppercase hex (not this implementation's own lowercase format)", "0123456789ABCDEF"],
      ["non-hex characters at canonical length", "ghijklmnopqrstuv"]
    ];

    for (const [label, token] of rejectedTokens) {
      it(`rejects a token that is ${label}, falling back to the safe fixed placeholder`, () => {
        expect(sanitizeReclaimToken(token)).toBe("unknown-generation");
      });
    }
  }
);

describe(
  "acquireFileLock reclaim-token path-traversal protection (P1 fix, 23rd independent review round, " +
    "'sanitize reclaim tokens before deriving filesystem paths') — end-to-end, real-filesystem proof " +
    "that a hostile persisted token cannot redirect deletion outside the intended lock/reclaim directory",
  () => {
    const tempDirs: string[] = [];

    afterEach(() => {
      while (tempDirs.length) {
        const dir = tempDirs.pop();
        if (!dir) continue;
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
    });

    /**
     * Fabricates the exact scenario Codex described: an abandoned
     * `.reclaim` gate whose `owner.json` carries a HOSTILE token
     * containing real path-separator/traversal components, structured so
     * that — WITHOUT sanitization — `acquireReclaimGate()`'s derived
     * `recoveryGatePath` genuinely resolves (via real, existing
     * intermediate directories, exactly as a real filesystem walk
     * requires) to a pre-existing, UNRELATED directory living entirely
     * outside the lock's own temp root, containing a canary file. If the
     * token is trusted as-is, `acquireRecoveryGate()`'s own stale-then-
     * `rmSync(recoveryGatePath, {recursive:true, force:true})` path
     * destroys that unrelated directory. If the token is sanitized, the
     * derived path can never leave `claimPath`'s own naming scope, and
     * the unrelated directory is untouched.
     */
    function runHostileTokenScenario(): { escapeTarget: string; canaryPath: string } {
      const root = mkdtempSync(join(tmpdir(), "uasf-file-lock-token-escape-"));
      tempDirs.push(root);

      // The real, pre-existing, UNRELATED directory the hostile token
      // will attempt to redirect deletion onto — deliberately placed as a
      // SIBLING of `root` (i.e. directly inside the shared OS temp
      // directory), simulating an entirely unrelated piece of filesystem
      // state that has nothing to do with this lock.
      const escapeTarget = mkdtempSync(join(tmpdir(), "uasf-file-lock-token-escape-target-"));
      tempDirs.push(escapeTarget);
      const canaryPath = join(escapeTarget, "canary.txt");
      writeFileSync(canaryPath, "must-survive-if-the-fix-works");
      // Backdated well past any staleMs used below, so `acquireRecoveryGate()`
      // considers it "abandoned" and proceeds to `rmSync` it once resolved.
      utimesSync(escapeTarget, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

      const lockDirPath = join(root, "cache.lock");
      const claimPath = `${lockDirPath}.reclaim`;
      const claimMetaPath = join(claimPath, "owner.json");

      // The literal staging directory a real filesystem walk needs to
      // already exist for the token's embedded ".." components to be
      // resolvable at all (a bare ".." can never escape anywhere on its
      // own — see the fix note in file-lock.ts — it only becomes a real
      // parent-directory reference once a leading "/" in the token forces
      // a genuine path-segment boundary right after the "recover-"
      // prefix). Constructing this staging directory ourselves is exactly
      // how a real attacker with enough filesystem access to plant a
      // malicious owner.json in the first place could also stage the
      // directories needed to complete the escape — proving the
      // vulnerability is genuinely reachable via real syscalls, not just
      // theoretically string-shaped.
      const hostileTokenPrefix = "STAGE";
      mkdirSync(join(root, `cache.lock.reclaim.recover-${hostileTokenPrefix}`), { recursive: true });
      const hostileToken = `${hostileTokenPrefix}/../../${basename(escapeTarget)}`;

      // The outer lock itself: a confirmed-dead owner, so acquireFileLock's
      // retry loop reaches tryReclaimStaleLock -> acquireReclaimGate.
      mkdirSync(lockDirPath, { recursive: true });
      const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
      if (!deadPid) throw new Error("expected a pid from the trivial child process");
      writeFileSync(
        join(lockDirPath, "owner.json"),
        JSON.stringify({ pid: deadPid, token: "outer-dead-owner", acquiredAt: Date.now() }),
        "utf8"
      );

      // The abandoned `.reclaim` gate itself, carrying the HOSTILE token —
      // also a confirmed-dead owner, so `acquireReclaimGate()` proceeds
      // straight to computing `recoveryGatePath` from this token.
      mkdirSync(claimPath, { recursive: true });
      writeFileSync(
        claimMetaPath,
        JSON.stringify({ pid: deadPid, token: hostileToken, acquiredAt: Date.now() }),
        "utf8"
      );

      const release = acquireFileLock(lockDirPath, { timeoutMs: 5_000, staleMs: 50, pollIntervalMs: 10 });
      release();

      return { escapeTarget, canaryPath };
    }

    it("a hostile token containing path-traversal components cannot cause the unrelated escape-target directory to be deleted", () => {
      const { canaryPath } = runHostileTokenScenario();

      // With sanitization in place, the derived recovery-gate path can
      // never leave `claimPath`'s own naming scope — the pre-existing,
      // completely unrelated escape-target directory (and its canary
      // file) must survive completely untouched.
      expect(existsSync(canaryPath)).toBe(true);
      expect(readFileSync(canaryPath, "utf8")).toBe("must-survive-if-the-fix-works");
    });
  }
);

describe(
  "P1 fix (28th independent review round, finding 11, 'validate file-lock timing options'): timeoutMs/staleMs/" +
    "pollIntervalMs are validated BEFORE any acquisition/retry logic runs — an invalid value fails closed " +
    "immediately instead of silently disabling timeout/staleness/backoff protection",
  () => {
    function freshLockDir(): string {
      const root = mkdtempSync(join(tmpdir(), "uasf-file-lock-timing-"));
      tempDirs.push(root);
      return join(root, "cache.lock");
    }

    describe("timeoutMs", () => {
      it.each([NaN, Infinity, -Infinity, -1])("rejects %s", (bad) => {
        expect(() => acquireFileLock(freshLockDir(), { timeoutMs: bad })).toThrow(InvalidFileLockOptionsError);
      });

      it("accepts 0 (try once, never wait)", () => {
        const lockDirPath = freshLockDir();
        const release = acquireFileLock(lockDirPath, { timeoutMs: 0 });
        release();
      });

      it(
        "BLOCKER regression, exact reproduction: NaN used to disable the timeout entirely (Date.now() >= NaN is " +
          "always false) — now it is rejected immediately instead of hanging",
        () => {
          const lockDirPath = freshLockDir();
          // Hold the lock in this same process so a second attempt must contend.
          const release = acquireFileLock(lockDirPath);
          try {
            expect(() => acquireFileLock(lockDirPath, { timeoutMs: NaN, pollIntervalMs: 5 })).toThrow(
              InvalidFileLockOptionsError
            );
          } finally {
            release();
          }
        }
      );
    });

    describe("staleMs", () => {
      it.each([NaN, Infinity, -Infinity, 0, -1])("rejects %s", (bad) => {
        expect(() => acquireFileLock(freshLockDir(), { staleMs: bad })).toThrow(InvalidFileLockOptionsError);
      });

      it("accepts a genuine positive value", () => {
        const lockDirPath = freshLockDir();
        const release = acquireFileLock(lockDirPath, { staleMs: 1000 });
        release();
      });
    });

    describe("pollIntervalMs", () => {
      it.each([NaN, Infinity, -Infinity, 0, -1])("rejects %s", (bad) => {
        expect(() => acquireFileLock(freshLockDir(), { pollIntervalMs: bad })).toThrow(InvalidFileLockOptionsError);
      });

      it("accepts a genuine positive value", () => {
        const lockDirPath = freshLockDir();
        const release = acquireFileLock(lockDirPath, { pollIntervalMs: 5 });
        release();
      });
    });

    describe("maxOwnerAgeMs", () => {
      it.each([NaN, Infinity, -Infinity, 0, -1])("rejects %s", (bad) => {
        expect(() => acquireFileLock(freshLockDir(), { maxOwnerAgeMs: bad })).toThrow(InvalidFileLockOptionsError);
      });

      it("accepts a genuine positive value", () => {
        const lockDirPath = freshLockDir();
        const release = acquireFileLock(lockDirPath, { maxOwnerAgeMs: 1000 });
        release();
      });
    });

    it("validation happens BEFORE any filesystem mutation — no lock directory is created for an invalid option", () => {
      const lockDirPath = freshLockDir();
      expect(() => acquireFileLock(lockDirPath, { timeoutMs: NaN })).toThrow(InvalidFileLockOptionsError);
      expect(existsSync(lockDirPath)).toBe(false);
    });

    it("the default options (no FileLockOptions supplied at all) remain valid (no regression for the common case)", () => {
      const lockDirPath = freshLockDir();
      const release = acquireFileLock(lockDirPath);
      release();
    });
  }
);

describe(
  "P1 fix (33rd independent review round, finding 6 / root class E, 'lock ownership must not rely on PID " +
    "alone'): a CONFIRMED-ALIVE PID reading must not grant unconditional, permanent trust — real OS PID reuse " +
    "(the original owner dies; the OS reassigns the exact same PID to a later, unrelated process) is " +
    "reproduced deterministically here by using THIS TEST PROCESS' OWN pid (guaranteed alive) paired with an " +
    "implausibly old recorded acquisition time — from isLockStale()'s perspective this is EXACTLY what a " +
    "PID-reused zombie lock looks like: a genuinely alive PID that is NOT the process that actually acquired it",
  () => {
    it(
      "BLOCKER regression, exact reproduction: a lock whose confirmed-alive owner's recorded acquiredAt is " +
        "far older than maxOwnerAgeMs is eventually reclaimed, rather than blocking forever",
      () => {
        const lockDirPath = makeLockDir();
        writeRawOwnerFile(
          lockDirPath,
          JSON.stringify({
            pid: process.pid,
            token: "zombie-owner",
            acquiredAt: Date.now() - 999_999_999 // far in the past
          })
        );

        const start = Date.now();
        const release = acquireFileLock(lockDirPath, {
          timeoutMs: 5_000,
          staleMs: 60_000, // irrelevant here — the confirmed-alive branch never consults staleMs
          pollIntervalMs: 10,
          maxOwnerAgeMs: 100 // far smaller than the fabricated owner's actual age
        });
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(2_000);
        release();
      }
    );

    it("root-cause proof: the SAME confirmed-alive owner is protected under the default maxOwnerAgeMs but reclaimable once an explicit, smaller ceiling is exceeded — the ceiling itself, not the fixture, is what changes the outcome", () => {
      const lockDirPath = makeLockDir();
      // One hour old: comfortably within the default 24h ceiling, so with
      // NO explicit maxOwnerAgeMs override this confirmed-alive owner
      // remains fully protected — proving the fixture alone does not
      // "cheat" the test.
      writeRawOwnerFile(
        lockDirPath,
        JSON.stringify({ pid: process.pid, token: "zombie-owner", acquiredAt: Date.now() - 60 * 60 * 1000 })
      );

      expect(() =>
        acquireFileLock(lockDirPath, { timeoutMs: 150, staleMs: 1, pollIntervalMs: 10 })
      ).toThrow(FileLockTimeoutError);
    });

    it("no regression: a confirmed-alive owner well within maxOwnerAgeMs (a normal, realistic lock age) remains fully protected", () => {
      const lockDirPath = makeLockDir();
      writeRawOwnerFile(
        lockDirPath,
        JSON.stringify({ pid: process.pid, token: "live-owner", acquiredAt: Date.now() - 500 })
      );

      expect(() =>
        acquireFileLock(lockDirPath, { timeoutMs: 150, staleMs: 1, pollIntervalMs: 10, maxOwnerAgeMs: 60_000 })
      ).toThrow(FileLockTimeoutError);
    });

    it("no regression: a genuinely DEAD owner is still reclaimed near-instantly regardless of maxOwnerAgeMs (the dead branch is checked first and never consults acquiredAt)", () => {
      const lockDirPath = makeLockDir();
      const deadPid = spawnDeadPid();
      writeRawOwnerFile(
        lockDirPath,
        JSON.stringify({ pid: deadPid, token: "dead-owner", acquiredAt: Date.now() })
      );

      const start = Date.now();
      const release = acquireFileLock(lockDirPath, {
        timeoutMs: 5_000,
        staleMs: 60_000,
        pollIntervalMs: 10,
        maxOwnerAgeMs: 24 * 60 * 60 * 1000
      });
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(2_000);
      release();
    });
  }
);
