import { describe, expect, it, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InvalidProjectIdError,
  PathEscapeError,
  SandboxTimeoutError,
  assertFilesystemConfinement,
  assertValidProjectId,
  assertWithinRoot,
  withTimeout
} from "../sandbox.js";

/**
 * Symlink creation can require elevated privileges on some Windows
 * configurations (a genuine, honestly-documented platform limitation —
 * see assertFilesystemConfinement's own doc comment). CI runs on Linux
 * where this always succeeds; if a given environment cannot create
 * symlinks, skip rather than fail on an environment limitation unrelated
 * to the code under test.
 */
function trySymlink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path);
    return true;
  } catch {
    return false;
  }
}

describe("assertWithinRoot", () => {
  it("allows a legitimate nested path", () => {
    const resolved = assertWithinRoot("/sandbox/project-a", "src/index.ts");
    expect(resolved).toBe("/sandbox/project-a/src/index.ts");
  });

  it("allows the root itself", () => {
    expect(() => assertWithinRoot("/sandbox/project-a", ".")).not.toThrow();
  });

  it("blocks a path-traversal escape attempt", () => {
    expect(() => assertWithinRoot("/sandbox/project-a", "../../etc/passwd")).toThrow(PathEscapeError);
  });

  it("blocks an absolute path outside the root", () => {
    expect(() => assertWithinRoot("/sandbox/project-a", "/etc/passwd")).toThrow(PathEscapeError);
  });

  it("blocks a prefix-confusion sibling (same string prefix, but not actually nested)", () => {
    // "/sandbox/project-a-evil" starts with the string "/sandbox/project-a"
    // but is NOT inside it — a naive `startsWith(root)` check would wrongly
    // allow this; assertWithinRoot requires the path separator too.
    expect(() => assertWithinRoot("/sandbox/project-a", "../project-a-evil")).toThrow(PathEscapeError);
  });
});

describe("assertValidProjectId (P1 fix: reject unsafe project ids before they reach any filesystem path)", () => {
  it("accepts a normal project id", () => {
    expect(() => assertValidProjectId("proj-1")).not.toThrow();
    expect(() => assertValidProjectId("shop_2")).not.toThrow();
    expect(() => assertValidProjectId("ProjectABC123")).not.toThrow();
  });

  it("rejects '..' and '.'", () => {
    expect(() => assertValidProjectId("..")).toThrow(InvalidProjectIdError);
    expect(() => assertValidProjectId(".")).toThrow(InvalidProjectIdError);
  });

  it("rejects a relative traversal id", () => {
    expect(() => assertValidProjectId("../outside")).toThrow(InvalidProjectIdError);
    expect(() => assertValidProjectId("../../outside")).toThrow(InvalidProjectIdError);
  });

  it("rejects an absolute path", () => {
    expect(() => assertValidProjectId("/etc/passwd")).toThrow(InvalidProjectIdError);
  });

  it("rejects slash and backslash traversal variants", () => {
    expect(() => assertValidProjectId("a/b")).toThrow(InvalidProjectIdError);
    expect(() => assertValidProjectId("a\\b")).toThrow(InvalidProjectIdError);
    expect(() => assertValidProjectId("..\\outside")).toThrow(InvalidProjectIdError);
  });

  it("rejects encoded/path-traversal-looking variants", () => {
    expect(() => assertValidProjectId("%2e%2e")).toThrow(InvalidProjectIdError);
    expect(() => assertValidProjectId("..%2fout")).toThrow(InvalidProjectIdError);
  });

  it("rejects an empty identifier", () => {
    expect(() => assertValidProjectId("")).toThrow(InvalidProjectIdError);
  });

  it("rejects an id starting with a hyphen or underscore", () => {
    expect(() => assertValidProjectId("-hidden")).toThrow(InvalidProjectIdError);
    expect(() => assertValidProjectId("_hidden")).toThrow(InvalidProjectIdError);
  });
});

describe("assertFilesystemConfinement (P1 fix: real filesystem-aware confinement, not just lexical)", () => {
  let tempRoot: string;

  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it("a normal project directory (no symlinks involved) works", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-fsconfine-"));
    const resolved = assertFilesystemConfinement(tempRoot, "legit-project");
    expect(resolved).toBe(join(tempRoot, "legit-project"));
  });

  it("blocks lexical '../' traversal", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-fsconfine-"));
    expect(() => assertFilesystemConfinement(tempRoot, "../outside")).toThrow(PathEscapeError);
  });

  it("blocks an absolute escape", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-fsconfine-"));
    expect(() => assertFilesystemConfinement(tempRoot, "/etc/passwd")).toThrow(PathEscapeError);
  });

  it("blocks a symlink INSIDE baseDir that points OUTSIDE it", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-fsconfine-"));
    const outside = mkdtempSync(join(tmpdir(), "uasf-fsconfine-outside-"));
    const linkPath = join(tempRoot, "evil-project");

    if (!trySymlink(outside, linkPath)) {
      rmSync(outside, { recursive: true, force: true });
      return; // platform cannot create symlinks — see trySymlink() doc comment
    }

    expect(() => assertFilesystemConfinement(tempRoot, "evil-project")).toThrow(PathEscapeError);

    // Nothing must have been written into the real (outside) target.
    expect(readdirSync(outside)).toHaveLength(0);
    rmSync(outside, { recursive: true, force: true });
  });

  it("blocks a symlinked PARENT directory that points outside baseDir", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-fsconfine-"));
    const outside = mkdtempSync(join(tmpdir(), "uasf-fsconfine-outside-"));
    const linkedParent = join(tempRoot, "linked-parent");

    if (!trySymlink(outside, linkedParent)) {
      rmSync(outside, { recursive: true, force: true });
      return;
    }

    // "new-project" itself does not exist yet — the escape is via its
    // PARENT (linked-parent) being a symlink to outside baseDir.
    expect(() => assertFilesystemConfinement(tempRoot, join("linked-parent", "new-project"))).toThrow(
      PathEscapeError
    );
    rmSync(outside, { recursive: true, force: true });
  });

  it("blocks a NESTED symlink chain escape (symlink-to-symlink-to-outside)", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-fsconfine-"));
    const outside = mkdtempSync(join(tmpdir(), "uasf-fsconfine-outside-"));
    const hop1 = join(tempRoot, "hop1");
    const hop2 = join(tempRoot, "hop2");

    // hop1 -> hop2 -> outside (a chain; realpath must resolve through both hops)
    if (!trySymlink(hop2, hop1) || !trySymlink(outside, hop2)) {
      rmSync(outside, { recursive: true, force: true });
      return;
    }

    expect(() => assertFilesystemConfinement(tempRoot, "hop1")).toThrow(PathEscapeError);
    rmSync(outside, { recursive: true, force: true });
  });

  it("does not modify anything outside baseDir when confinement is rejected", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-fsconfine-"));
    const outside = mkdtempSync(join(tmpdir(), "uasf-fsconfine-outside-"));
    writeFileSync(join(outside, "marker.txt"), "untouched");
    const linkPath = join(tempRoot, "evil-project");

    if (!trySymlink(outside, linkPath)) {
      rmSync(outside, { recursive: true, force: true });
      return;
    }

    expect(() => assertFilesystemConfinement(tempRoot, "evil-project")).toThrow(PathEscapeError);
    expect(readFileSync(join(outside, "marker.txt"), "utf8")).toBe("untouched");
    rmSync(outside, { recursive: true, force: true });
  });

  it("a legitimate project that happens to share a directory with unrelated real (non-symlink) content still succeeds", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-fsconfine-"));
    mkdirSync(join(tempRoot, "existing-real-dir"));
    const resolved = assertFilesystemConfinement(tempRoot, "existing-real-dir");
    expect(resolved).toBe(join(tempRoot, "existing-real-dir"));
  });

  it("documents the actual gap this fixes: assertWithinRoot ALONE is fooled by a symlink that assertFilesystemConfinement catches", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "uasf-fsconfine-"));
    const outside = mkdtempSync(join(tmpdir(), "uasf-fsconfine-outside-"));
    const linkPath = join(tempRoot, "evil-project");

    if (!trySymlink(outside, linkPath)) {
      rmSync(outside, { recursive: true, force: true });
      return;
    }

    // The purely lexical check has no idea "evil-project" is a symlink —
    // it only ever sees the string "tempRoot/evil-project", which IS
    // lexically inside tempRoot, so it wrongly allows it.
    expect(() => assertWithinRoot(tempRoot, "evil-project")).not.toThrow();

    // The filesystem-aware check resolves the symlink and correctly
    // rejects it, because the REAL destination is outside tempRoot.
    expect(() => assertFilesystemConfinement(tempRoot, "evil-project")).toThrow(PathEscapeError);

    rmSync(outside, { recursive: true, force: true });
  });
});

describe("withTimeout", () => {
  it("resolves normally when the operation finishes before the timeout", async () => {
    const result = await withTimeout(Promise.resolve("done"), 1000);
    expect(result).toBe("done");
  });

  it("rejects with SandboxTimeoutError when the operation hangs past the timeout", async () => {
    const hangingForever = new Promise(() => {}); // never resolves
    await expect(withTimeout(hangingForever, 20)).rejects.toThrow(SandboxTimeoutError);
  });
});
