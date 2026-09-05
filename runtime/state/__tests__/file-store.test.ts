import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// P2 fix (8th independent review round, "failed state writes destroy
// previous recoverable state"): to prove FileStateStore.write()'s atomic
// temp-then-rename behavior under a REAL write failure without depending
// on an actual disk-full/EFBIG condition (which isn't portably
// reproducible in CI), `node:fs`'s writeFileSync/unlinkSync are wrapped as
// spies that default to the REAL implementation (`vi.fn(actual.fn)`) and
// can be overridden per-test via `mockImplementationOnce`. Both this test
// file's import and file-store.ts's own import resolve to the SAME mocked
// module record, so overriding the mock here genuinely injects a failure
// into the module under test's internal call — not a separate, disconnected
// mock.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync), unlinkSync: vi.fn(actual.unlinkSync) };
});

const { writeFileSync: mockWriteFileSync, unlinkSync: mockUnlinkSync } = await import("node:fs");
const { FileStateStore } = await import("../file-store.js");
const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");

/**
 * A faithful simulation of a real EFBIG/disk-full failure: the OS accepts
 * SOME bytes before refusing the rest, so the file at `path` genuinely
 * exists on disk in a TRUNCATED, partially-written state when the error is
 * thrown — not simply "no write happened at all" (which a naive
 * `mockImplementationOnce(() => { throw ... })` would simulate, and would
 * fail to reproduce the bug: intercepting the call before touching disk
 * means nothing gets corrupted regardless of whether the code under test
 * writes directly to the destination or to a temp file).
 */
function simulatePartialWriteFailure() {
  vi.mocked(mockWriteFileSync).mockImplementationOnce((path, data) => {
    const full = typeof data === "string" ? data : String(data);
    realFs.writeFileSync(path as string, full.slice(0, Math.min(4, full.length)), "utf8");
    throw new Error("simulated EFBIG/disk-full write failure (partial content written)");
  });
}

describe("FileStateStore", () => {
  let tempRoot: string;

  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it("writes and reads back structured data", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-state-"));
    const store = new FileStateStore();
    const path = join(tempRoot, "nested", "dir", "state.json");

    store.write(path, { hello: "world", count: 3 });

    expect(store.exists(path)).toBe(true);
    expect(store.read<{ hello: string; count: number }>(path)).toEqual({ hello: "world", count: 3 });
  });

  it("read() returns undefined for a path that was never written", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-state-"));
    const store = new FileStateStore();
    expect(store.read(join(tempRoot, "missing.json"))).toBeUndefined();
    expect(store.exists(join(tempRoot, "missing.json"))).toBe(false);
  });

  it("survives a fresh store instance reading data written by a previous one (durability, not just in-memory)", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-state-"));
    const path = join(tempRoot, "durable.json");

    new FileStateStore().write(path, { persisted: true });
    const freshStore = new FileStateStore(); // simulates a new process/session
    expect(freshStore.read<{ persisted: boolean }>(path)).toEqual({ persisted: true });
  });

  describe("P2 fix (8th independent review round, 'failed state writes destroy previous recoverable state')", () => {
    it("valid existing state can be read before any failure scenario", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-state-atomic-"));
      const path = join(tempRoot, "state.json");
      const store = new FileStateStore();
      store.write(path, { version: 1 });
      expect(store.read<{ version: number }>(path)).toEqual({ version: 1 });
    });

    it("a simulated write failure leaves the previous valid state completely unchanged", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-state-atomic-"));
      const path = join(tempRoot, "state.json");
      const store = new FileStateStore();
      store.write(path, { version: 1, important: "original data" });
      const beforeRaw = readFileSync(path, "utf8");

      simulatePartialWriteFailure();

      expect(() => store.write(path, { version: 2, important: "new data" })).toThrow(
        "simulated EFBIG/disk-full write failure"
      );

      // The destination file on disk is byte-identical to before the failed write.
      expect(readFileSync(path, "utf8")).toBe(beforeRaw);
    });

    it("a new process/store instance still recovers the previous state after a failed write attempt", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-state-atomic-"));
      const path = join(tempRoot, "state.json");
      const store = new FileStateStore();
      store.write(path, { version: 1 });

      simulatePartialWriteFailure();
      expect(() => store.write(path, { version: 2 })).toThrow();

      const freshStore = new FileStateStore();
      expect(freshStore.read<{ version: number }>(path)).toEqual({ version: 1 });
    });

    it("a successful write atomically replaces the old state with the new content", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-state-atomic-"));
      const path = join(tempRoot, "state.json");
      const store = new FileStateStore();
      store.write(path, { version: 1 });
      store.write(path, { version: 2 });

      expect(store.read<{ version: number }>(path)).toEqual({ version: 2 });
    });

    it("no partially-written temporary file remains in the directory after a successful write", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-state-atomic-"));
      const path = join(tempRoot, "state.json");
      new FileStateStore().write(path, { version: 1 });

      const entries = readdirSync(tempRoot);
      expect(entries).toEqual(["state.json"]);
    });

    it("a leftover temporary file from a failed write is cleaned up and never promoted to authoritative state", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-state-atomic-"));
      const path = join(tempRoot, "state.json");
      const store = new FileStateStore();
      store.write(path, { version: 1 });

      simulatePartialWriteFailure();
      expect(() => store.write(path, { version: 2 })).toThrow();

      // Only the original, valid destination file remains — no stray
      // ".tmp-" file was left behind, and nothing malformed was promoted.
      const entries = readdirSync(tempRoot);
      expect(entries).toEqual(["state.json"]);
      expect(store.read<{ version: number }>(path)).toEqual({ version: 1 });
    });

    it("a cleanup failure on the temp file never masks the original write error", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-state-atomic-"));
      const path = join(tempRoot, "state.json");
      const store = new FileStateStore();
      store.write(path, { version: 1 });

      vi.mocked(mockWriteFileSync).mockImplementationOnce(() => {
        throw new Error("original write failure");
      });
      vi.mocked(mockUnlinkSync).mockImplementationOnce(() => {
        throw new Error("cleanup also failed");
      });

      expect(() => store.write(path, { version: 2 })).toThrow("original write failure");
      expect(store.read<{ version: number }>(path)).toEqual({ version: 1 });
    });

    it("existing durable-cache/state users (FileCache) continue to work with the atomic write path", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-state-atomic-"));
      const path = join(tempRoot, "cache.json");
      const store = new FileStateStore();
      store.write(path, [["key1", { value: "v1", computedAt: Date.now() }]]);
      expect(store.read(path)).toEqual([["key1", { value: "v1", computedAt: expect.any(Number) }]]);
    });
  });
});
