import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStateStore } from "../file-store.js";

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
});
