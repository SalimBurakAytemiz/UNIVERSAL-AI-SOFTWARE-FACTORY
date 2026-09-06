import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnserializableStateError } from "../file-store.js";

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

  describe(
    "P2 fix (14th independent review round, 'reject unserializable state before replacing valid durable " +
      "state'): write() validates that the new value GENUINELY serializes to JSON before touching the " +
      "destination at all — JSON.stringify() returning undefined (without throwing) is no longer silently " +
      "coerced into the literal text \"undefined\" and promoted over previously valid state",
    () => {
      it("BLOCKER regression, exact reproduction: valid state A -> write(undefined) is REJECTED -> A remains readable and unchanged", () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-state-unserializable-"));
        const path = join(tempRoot, "state.json");
        const store = new FileStateStore();
        store.write(path, { version: 1 });
        const beforeRaw = readFileSync(path, "utf8");

        expect(() => store.write(path, undefined)).toThrow(UnserializableStateError);

        expect(readFileSync(path, "utf8")).toBe(beforeRaw);
        expect(store.read<{ version: number }>(path)).toEqual({ version: 1 });
      });

      it("valid state A -> write(a function) is REJECTED -> A remains intact", () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-state-unserializable-"));
        const path = join(tempRoot, "state.json");
        const store = new FileStateStore();
        store.write(path, { version: 1 });

        expect(() => store.write(path, () => "not data")).toThrow(UnserializableStateError);

        expect(store.read<{ version: number }>(path)).toEqual({ version: 1 });
      });

      it("valid state A -> write(object with toJSON() returning undefined) is REJECTED -> A remains intact", () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-state-unserializable-"));
        const path = join(tempRoot, "state.json");
        const store = new FileStateStore();
        store.write(path, { version: 1 });

        const poisoned = { toJSON: () => undefined };
        expect(() => store.write(path, poisoned)).toThrow(UnserializableStateError);

        expect(store.read<{ version: number }>(path)).toEqual({ version: 1 });
      });

      it("a value that makes JSON.stringify THROW (circular reference) is also rejected without touching the destination", () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-state-unserializable-"));
        const path = join(tempRoot, "state.json");
        const store = new FileStateStore();
        store.write(path, { version: 1 });

        const circular: Record<string, unknown> = { version: 2 };
        circular.self = circular;

        expect(() => store.write(path, circular)).toThrow(UnserializableStateError);
        expect(store.read<{ version: number }>(path)).toEqual({ version: 1 });
      });

      it("a value containing an unrepresentable BigInt is also rejected without touching the destination", () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-state-unserializable-"));
        const path = join(tempRoot, "state.json");
        const store = new FileStateStore();
        store.write(path, { version: 1 });

        expect(() => store.write(path, { amount: 10n })).toThrow(UnserializableStateError);
        expect(store.read<{ version: number }>(path)).toEqual({ version: 1 });
      });

      it("a genuinely valid, serializable state B still atomically replaces A", () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-state-unserializable-"));
        const path = join(tempRoot, "state.json");
        const store = new FileStateStore();
        store.write(path, { version: 1 });
        store.write(path, { version: 2, ok: true });

        expect(store.read(path)).toEqual({ version: 2, ok: true });
      });

      it("a rejected write leaves no corrupt temporary artifact behind — the destination directory contains only the original valid file", () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-state-unserializable-"));
        const path = join(tempRoot, "state.json");
        const store = new FileStateStore();
        store.write(path, { version: 1 });

        expect(() => store.write(path, undefined)).toThrow(UnserializableStateError);

        // No ".tmp-" file was ever created — validation happens BEFORE any
        // filesystem write, not merely cleaned up afterward.
        const entries = readdirSync(tempRoot);
        expect(entries).toEqual(["state.json"]);
      });

      it("a fresh store instance (simulated restart) still recovers the previous valid state after a rejected write", () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-state-unserializable-"));
        const path = join(tempRoot, "state.json");
        const store = new FileStateStore();
        store.write(path, { version: 1, important: "original data" });

        expect(() => store.write(path, undefined)).toThrow(UnserializableStateError);

        const freshStore = new FileStateStore();
        expect(freshStore.read<{ version: number; important: string }>(path)).toEqual({
          version: 1,
          important: "original data"
        });
      });

      it("rejecting an unserializable write does NOT create the destination's parent directory when it didn't already exist", () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-state-unserializable-"));
        const path = join(tempRoot, "brand-new-nested-dir", "state.json");
        const store = new FileStateStore();

        expect(() => store.write(path, undefined)).toThrow(UnserializableStateError);
        expect(store.exists(path)).toBe(false);
      });

      it("the UnserializableStateError names the rejected path and preserves the underlying cause for a thrown serialization failure", () => {
        tempRoot = mkdtempSync(join(tmpdir(), "uasf-state-unserializable-"));
        const path = join(tempRoot, "state.json");
        const store = new FileStateStore();

        const circular: Record<string, unknown> = {};
        circular.self = circular;

        try {
          store.write(path, circular);
          expect.unreachable("write() should have thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(UnserializableStateError);
          expect((err as Error).message).toContain(path);
          expect((err as UnserializableStateError).cause).toBeDefined();
        }
      });
    }
  );
});
