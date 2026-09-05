import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_OS_SUBDIRECTORIES, scaffoldProjectOs } from "../scaffold.js";
import { PathEscapeError } from "../../sandbox/sandbox.js";

function trySymlink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path);
    return true;
  } catch {
    return false;
  }
}

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

  describe("P1 fix: symlink escape via a pre-planted project-root symlink", () => {
    it("refuses to scaffold into a project-root path that is a symlink pointing outside baseDir", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-project-os-symlink-"));
      const outside = mkdtempSync(join(tmpdir(), "uasf-project-os-symlink-outside-"));
      const linkPath = join(tempRoot, "evil-project");

      if (!trySymlink(outside, linkPath)) {
        rmSync(outside, { recursive: true, force: true });
        return;
      }

      expect(() => scaffoldProjectOs(tempRoot, "evil-project")).toThrow(PathEscapeError);

      // Nothing was created inside the real (outside) target.
      expect(readdirSync(outside)).toHaveLength(0);
      rmSync(outside, { recursive: true, force: true });
    });

    it("refuses to scaffold a subdirectory that is a pre-planted symlink pointing outside the project root", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-project-os-symlink-"));
      const outside = mkdtempSync(join(tmpdir(), "uasf-project-os-symlink-outside-"));

      // A prior (or malicious) actor pre-created "requirements" as a
      // symlink to outside the eventual project root, before scaffold runs.
      mkdirSync(join(tempRoot, "proj-2"), { recursive: true });
      const linkPath = join(tempRoot, "proj-2", "requirements");
      if (!trySymlink(outside, linkPath)) {
        rmSync(outside, { recursive: true, force: true });
        return;
      }

      expect(() => scaffoldProjectOs(tempRoot, "proj-2")).toThrow(PathEscapeError);
      expect(readdirSync(outside)).toHaveLength(0);
      rmSync(outside, { recursive: true, force: true });
    });
  });
});
