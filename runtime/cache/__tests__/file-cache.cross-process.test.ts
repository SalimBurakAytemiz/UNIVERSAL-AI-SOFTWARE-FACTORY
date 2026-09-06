import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
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
      "stale lock recovery is safe: a second process reclaims a lock that has outlived its own staleness " +
        "window, and the original (still-alive but overdue) holder's own release() becomes a safe no-op",
      async () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-file-cache-xproc-stale-"));
        const cachePath = join(tempRoot, "cache.json");
        const holdMs = 400;
        const fastLockOptions = JSON.stringify({ timeoutMs: 5_000, staleMs: 100, pollIntervalMs: 20 });

        const holderPromise = runWorker(["hold-lock-then-release", cachePath, String(holdMs), fastLockOptions]);
        await new Promise((resolve) => setTimeout(resolve, 50));
        const setResult = await runWorker(["set", cachePath, "reclaimed-key", "reclaimed-value", "", fastLockOptions]);

        expect(setResult.code, setResult.stderr).toBe(0);
        const holderResult = await holderPromise;
        expect(holderResult.code, holderResult.stderr).toBe(0);

        const cache = new FileCache<string>(new FileStateStore(), cachePath);
        expect(cache.get("reclaimed-key")).toBe("reclaimed-value");
      },
      20_000
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
