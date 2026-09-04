import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_OS_SUBDIRECTORIES, scaffoldProjectOs } from "../scaffold.js";

describe("scaffoldProjectOs", () => {
  let tempRoot: string;

  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it("creates every Project OS subdirectory under baseDir/projectId", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-project-os-"));
    const result = scaffoldProjectOs(tempRoot, "proj-1");

    expect(result.projectRoot).toBe(join(tempRoot, "proj-1"));
    for (const sub of PROJECT_OS_SUBDIRECTORIES) {
      const dir = join(tempRoot, "proj-1", sub);
      expect(existsSync(dir)).toBe(true);
      expect(statSync(dir).isDirectory()).toBe(true);
    }
    expect(result.createdDirectories).toHaveLength(PROJECT_OS_SUBDIRECTORIES.length);
  });

  it("is idempotent: calling it twice does not throw or destroy anything", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-project-os-"));
    scaffoldProjectOs(tempRoot, "proj-1");
    expect(() => scaffoldProjectOs(tempRoot, "proj-1")).not.toThrow();
    expect(existsSync(join(tempRoot, "proj-1", "requirements"))).toBe(true);
  });
});
