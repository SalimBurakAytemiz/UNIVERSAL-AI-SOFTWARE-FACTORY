import { describe, expect, it, afterEach } from "vitest";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix as pathPosix, win32 as pathWin32 } from "node:path";
import {
  HardLinkAliasError,
  InvalidProjectIdError,
  PathEscapeError,
  SandboxTimeoutError,
  assertFilesystemConfinement,
  assertValidProjectId,
  assertWithinRoot,
  isContainedRelativePath,
  withTimeout
} from "../sandbox.js";

/**
 * Hard link creation can fail across filesystem boundaries (EXDEV) or on
 * platforms/filesystems that don't support it — an honestly-documented
 * platform limitation (see assertNoHardLinkAlias's own doc comment in
 * sandbox.ts). Skip rather than fail on an environment limitation unrelated
 * to the code under test.
 */
function tryLink(existingPath: string, newPath: string): boolean {
  try {
    linkSync(existingPath, newPath);
    return true;
  } catch {
    return false;
  }
}

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

describe(
  "P2 fix (15th independent review round, 'filesystem root containment incorrectly rejects valid " +
    "descendants'): assertWithinRoot() now reasons over path.relative()'s result instead of a naive " +
    "string-prefix concatenation, so a configured root that is ITSELF a filesystem root (POSIX '/', a " +
    "Windows drive root) no longer wrongly rejects its own genuine descendants",
  () => {
    describe("POSIX", () => {
      it(
        "BLOCKER regression, exact reproduction: assertWithinRoot('/', '/tmp') is ACCEPTED — the old " +
          "'/' + sep === '//' double-separator prefix check wrongly rejected this",
        () => {
          expect(() => assertWithinRoot("/", "/tmp")).not.toThrow();
          expect(assertWithinRoot("/", "/tmp")).toBe("/tmp");
        }
      );

      it("assertWithinRoot('/', '/') accepts the root itself", () => {
        expect(() => assertWithinRoot("/", "/")).not.toThrow();
        expect(assertWithinRoot("/", "/")).toBe("/");
      });

      it("a normal (non-root) root with a nested candidate still works — no regression", () => {
        expect(assertWithinRoot("/safe", "/safe/file")).toBe("/safe/file");
      });

      it("'/safe' vs '/safe-evil' (prefix collision) is still REJECTED", () => {
        expect(() => assertWithinRoot("/safe", "/safe-evil")).toThrow(PathEscapeError);
      });

      it("traversal outside a root that is itself '/' is still REJECTED (there is nothing above '/' to escape to, but a relative '..' must not resolve to something outside)", () => {
        // resolve("/", "..") normalizes back to "/" itself on POSIX (there is
        // no parent of the filesystem root) — this must remain ACCEPTED
        // (it resolves to root itself), not conflated with a genuine escape.
        expect(() => assertWithinRoot("/", "..")).not.toThrow();
        expect(assertWithinRoot("/", "..")).toBe("/");
      });

      it("traversal outside a normal root is still REJECTED", () => {
        expect(() => assertWithinRoot("/safe", "..")).toThrow(PathEscapeError);
        expect(() => assertWithinRoot("/safe", "../etc/passwd")).toThrow(PathEscapeError);
      });

      it("a sibling directory (not a descendant) is still REJECTED", () => {
        expect(() => assertWithinRoot("/safe/project-a", "/safe/project-b")).toThrow(PathEscapeError);
      });

      it("trailing-separator variants of the root normalize correctly and still accept genuine descendants", () => {
        expect(() => assertWithinRoot("/safe/", "/safe/file")).not.toThrow();
        expect(() => assertWithinRoot("/safe//", "/safe/file")).not.toThrow();
      });

      it("a deeply nested descendant of the root '/' is accepted", () => {
        expect(assertWithinRoot("/", "/a/b/c")).toBe("/a/b/c");
      });
    });

    describe("Windows semantics (verified via the exported, path-module-agnostic isContainedRelativePath predicate — this CI runs on POSIX, so node:path's own resolve()/relative() are always POSIX regardless of the path STRINGS passed in; path.win32 lets the exact same containment predicate assertWithinRoot() uses be verified under genuine win32 rules on any host OS)", () => {
      it("a drive-root descendant is ACCEPTED", () => {
        const rel = pathWin32.relative("C:\\", "C:\\foo");
        expect(isContainedRelativePath(rel, { sep: pathWin32.sep, isAbsolute: pathWin32.isAbsolute })).toBe(true);
      });

      it("the drive root itself is ACCEPTED", () => {
        const rel = pathWin32.relative("C:\\", "C:\\");
        expect(isContainedRelativePath(rel, { sep: pathWin32.sep, isAbsolute: pathWin32.isAbsolute })).toBe(true);
      });

      it("a different drive (sibling root) is REJECTED", () => {
        const rel = pathWin32.relative("C:\\", "D:\\foo");
        expect(isContainedRelativePath(rel, { sep: pathWin32.sep, isAbsolute: pathWin32.isAbsolute })).toBe(false);
      });

      it("a prefix-collision sibling directory is REJECTED", () => {
        const rel = pathWin32.relative("C:\\safe", "C:\\safe-evil");
        expect(isContainedRelativePath(rel, { sep: pathWin32.sep, isAbsolute: pathWin32.isAbsolute })).toBe(false);
      });

      it("a genuine nested descendant under a non-root drive path is ACCEPTED", () => {
        const rel = pathWin32.relative("C:\\safe", "C:\\safe\\nested\\file.txt");
        expect(isContainedRelativePath(rel, { sep: pathWin32.sep, isAbsolute: pathWin32.isAbsolute })).toBe(true);
      });

      it("parent traversal above a non-root drive path is REJECTED", () => {
        const rel = pathWin32.relative("C:\\safe", "C:\\");
        expect(isContainedRelativePath(rel, { sep: pathWin32.sep, isAbsolute: pathWin32.isAbsolute })).toBe(false);
      });
    });

    describe("isContainedRelativePath (the pure predicate itself, exercised directly for both POSIX and Windows path modules)", () => {
      it("empty string (root itself) is contained", () => {
        expect(isContainedRelativePath("")).toBe(true);
      });

      it("'..' alone is not contained", () => {
        expect(isContainedRelativePath("..")).toBe(false);
      });

      it("a path starting with '../' is not contained (POSIX default sep)", () => {
        expect(isContainedRelativePath("../evil")).toBe(false);
      });

      it("an ordinary relative descendant is contained (POSIX default sep)", () => {
        expect(isContainedRelativePath("nested/file.txt")).toBe(true);
      });

      it("an absolute relative-path result (no common base) is not contained, using explicit posix path ops", () => {
        // path.posix.relative() essentially never returns an absolute
        // result for two absolute inputs, but the predicate must still
        // correctly reject one if ever fed one (e.g. by a future caller).
        expect(isContainedRelativePath("/elsewhere", { sep: pathPosix.sep, isAbsolute: pathPosix.isAbsolute })).toBe(
          false
        );
      });
    });
  }
);

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

  describe("P1 fix (5th independent review round): dangling and final-destination symlinks", () => {
    it("blocks a DANGLING symlink (target does not exist) planted at the final destination", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-fsconfine-dangling-"));
      const nonexistentOutsideTarget = join(tmpdir(), `uasf-fsconfine-never-created-${process.pid}-${Date.now()}`);
      const linkPath = join(tempRoot, "evil-project");

      if (!trySymlink(nonexistentOutsideTarget, linkPath)) return;

      // Sanity: the symlink target genuinely does not exist (this is what
      // made the old existsSync()-based check treat it as "not there yet").
      expect(existsSyncFollows(nonexistentOutsideTarget)).toBe(false);

      expect(() => assertFilesystemConfinement(tempRoot, "evil-project")).toThrow(PathEscapeError);
      expect(existsSyncFollows(nonexistentOutsideTarget)).toBe(false); // still never created
    });

    it("blocks a DANGLING symlink used as an intermediate (parent) path component", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-fsconfine-dangling-"));
      const nonexistentOutsideTarget = join(tmpdir(), `uasf-fsconfine-never-created-parent-${process.pid}-${Date.now()}`);
      const linkedParent = join(tempRoot, "dangling-parent");

      if (!trySymlink(nonexistentOutsideTarget, linkedParent)) return;

      expect(() => assertFilesystemConfinement(tempRoot, join("dangling-parent", "new-file.json"))).toThrow(
        PathEscapeError
      );
    });

    it("blocks a final-FILE symlink (not a directory) pointing outside baseDir, existing and non-dangling", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-fsconfine-finalfile-"));
      const outside = mkdtempSync(join(tmpdir(), "uasf-fsconfine-finalfile-outside-"));
      writeFileSync(join(outside, "real-target.json"), "{}");
      const linkPath = join(tempRoot, "state.json");

      if (!trySymlink(join(outside, "real-target.json"), linkPath)) {
        rmSync(outside, { recursive: true, force: true });
        return;
      }

      expect(() => assertFilesystemConfinement(tempRoot, "state.json")).toThrow(PathEscapeError);
      rmSync(outside, { recursive: true, force: true });
    });

    it("blocks a DANGLING final-FILE symlink pointing outside baseDir", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-fsconfine-finalfile-dangling-"));
      const outside = mkdtempSync(join(tmpdir(), "uasf-fsconfine-finalfile-dangling-outside-"));
      const outsideTargetNeverCreated = join(outside, "would-be-written-here.json");
      const linkPath = join(tempRoot, "state.json");

      if (!trySymlink(outsideTargetNeverCreated, linkPath)) {
        rmSync(outside, { recursive: true, force: true });
        return;
      }

      expect(() => assertFilesystemConfinement(tempRoot, "state.json")).toThrow(PathEscapeError);

      // The whole point: a real writeFileSync would have followed this
      // dangling symlink and CREATED the file at the outside location.
      // Confirm confinement rejected it before any such write happened.
      expect(existsSyncFollows(outsideTargetNeverCreated)).toBe(false);
      rmSync(outside, { recursive: true, force: true });
    });

    it("leaves no partial/unsafe state anywhere when a dangling-symlink attempt is rejected", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-fsconfine-partial-"));
      const outsideTargetNeverCreated = join(tmpdir(), `uasf-fsconfine-partial-outside-${process.pid}-${Date.now()}`);
      const linkPath = join(tempRoot, "evil");

      if (!trySymlink(outsideTargetNeverCreated, linkPath)) return;

      expect(() => assertFilesystemConfinement(tempRoot, "evil")).toThrow(PathEscapeError);

      // Nothing new appeared in tempRoot beyond the attacker's own
      // pre-planted symlink (we created nothing further while rejecting).
      expect(readdirSync(tempRoot)).toEqual(["evil"]);
      expect(existsSyncFollows(outsideTargetNeverCreated)).toBe(false);
    });

    it("normal (non-symlink) project creation still succeeds after this fix", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-fsconfine-normal-"));
      const resolved = assertFilesystemConfinement(tempRoot, "normal-project");
      expect(resolved).toBe(join(tempRoot, "normal-project"));
    });
  });

  describe("P1 fix (6th independent review round): project-root alias (in-baseDir symlink to a DIFFERENT location) is rejected", () => {
    it("blocks baseDir/A -> baseDir/B: an alias that stays inside baseDir but redirects to a different entry", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-alias-"));
      mkdirSync(join(tempRoot, "B"));
      if (!trySymlink(join(tempRoot, "B"), join(tempRoot, "A"))) return;

      // The old prefix-only check would have allowed this: realpath(A) =
      // tempRoot/B, which IS still inside tempRoot. The new check compares
      // the RELATIVE path, catching that "A" resolves to "B", not "A".
      expect(() => assertFilesystemConfinement(tempRoot, "A")).toThrow(PathEscapeError);
    });

    it("a project root that does not exist yet is never an alias (guaranteed unique, no rejection)", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-alias-"));
      expect(() => assertFilesystemConfinement(tempRoot, "brand-new-project")).not.toThrow();
    });

    it("blocks a nested alias variant: a subdirectory inside a real project root aliasing a sibling subdirectory", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-alias-nested-"));
      const projectRoot = join(tempRoot, "proj");
      mkdirSync(join(projectRoot, "organization"), { recursive: true });
      if (!trySymlink(join(projectRoot, "organization"), join(projectRoot, "project-genome"))) return;

      expect(() => assertFilesystemConfinement(projectRoot, "project-genome")).toThrow(PathEscapeError);
    });

    it("previously fixed dangling-symlink and outside-pointing-symlink escapes remain blocked after this stricter check", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-alias-regress-"));
      const outside = mkdtempSync(join(tmpdir(), "uasf-alias-regress-outside-"));
      const danglingTarget = join(tmpdir(), `uasf-alias-regress-dangling-${process.pid}-${Date.now()}`);

      if (trySymlink(outside, join(tempRoot, "outside-link"))) {
        expect(() => assertFilesystemConfinement(tempRoot, "outside-link")).toThrow(PathEscapeError);
      }
      if (trySymlink(danglingTarget, join(tempRoot, "dangling-link"))) {
        expect(() => assertFilesystemConfinement(tempRoot, "dangling-link")).toThrow(PathEscapeError);
      }
      rmSync(outside, { recursive: true, force: true });
    });
  });

  describe("P1 fix (7th independent review round, 'static hard-link aliases permit cross-project overwrites')", () => {
    it("blocks writing through a destination that is a hard link to another (project B's) authoritative file", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-hardlink-"));
      const projectBFile = join(tempRoot, "project-b-genome.json");
      writeFileSync(projectBFile, JSON.stringify({ owner: "B" }));
      const projectAFile = join(tempRoot, "project-a-genome.json");

      if (!tryLink(projectBFile, projectAFile)) return;

      expect(() => assertFilesystemConfinement(tempRoot, "project-a-genome.json")).toThrow(HardLinkAliasError);
    });

    it("REPRODUCTION: project A's destination hard-linked to project B's existing genome.json — bootstrapping A never overwrites B's authoritative content", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-hardlink-repro-"));
      const projectBDir = join(tempRoot, "project-b");
      mkdirSync(projectBDir);
      const projectBGenome = join(projectBDir, "genome.json");
      writeFileSync(projectBGenome, JSON.stringify({ projectId: "B", authoritative: true }));

      const projectADir = join(tempRoot, "project-a");
      mkdirSync(projectADir);
      const projectAGenome = join(projectADir, "genome.json");

      if (!tryLink(projectBGenome, projectAGenome)) return;

      // Simulates bootstrapProject("A") attempting to write its own genome
      // at what it believes is its own, exclusively-owned destination.
      expect(() => assertFilesystemConfinement(projectADir, "genome.json")).toThrow(HardLinkAliasError);

      // B's authoritative content must never have been touched.
      expect(JSON.parse(readFileSync(projectBGenome, "utf8"))).toEqual({ projectId: "B", authoritative: true });
    });

    it("does not reject a brand-new destination that does not exist yet (no false positive on ordinary first-time creation)", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-hardlink-new-"));
      expect(() => assertFilesystemConfinement(tempRoot, "brand-new-file.json")).not.toThrow();
    });

    it("does not reject an ordinary, singly-linked existing file (no false positive on legitimate re-writes)", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-hardlink-normal-"));
      writeFileSync(join(tempRoot, "state.json"), "{}");
      expect(() => assertFilesystemConfinement(tempRoot, "state.json")).not.toThrow();
    });

    it("does not reject an existing plain directory destination (hard-link aliasing check is file-scoped; POSIX directories cannot be hard-linked)", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-hardlink-dir-"));
      mkdirSync(join(tempRoot, "project-subdir"));
      expect(() => assertFilesystemConfinement(tempRoot, "project-subdir")).not.toThrow();
    });

    it("once the extra hard link is removed (back to nlink 1), the same destination is accepted again", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-hardlink-recover-"));
      const original = join(tempRoot, "shared-origin.json");
      writeFileSync(original, "{}");
      const aliasPath = join(tempRoot, "alias.json");

      if (!tryLink(original, aliasPath)) return;

      expect(() => assertFilesystemConfinement(tempRoot, "alias.json")).toThrow(HardLinkAliasError);

      unlinkSync(original); // only one directory entry (alias.json) remains -> nlink back to 1
      expect(() => assertFilesystemConfinement(tempRoot, "alias.json")).not.toThrow();
    });

    it("the HardLinkAliasError message names the destination path and reports the link count", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-hardlink-msg-"));
      const original = join(tempRoot, "origin.json");
      writeFileSync(original, "{}");
      const aliasPath = join(tempRoot, "alias.json");

      if (!tryLink(original, aliasPath)) return;

      try {
        assertFilesystemConfinement(tempRoot, "alias.json");
        throw new Error("expected assertFilesystemConfinement to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(HardLinkAliasError);
        expect((err as Error).message).toContain("alias.json");
        expect((err as Error).message).toMatch(/\b2\b/); // nlink count is reported
      }
    });

    it("hard-link detection does not weaken existing symlink escape protection (both checks remain active)", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-hardlink-symlink-"));
      const outside = mkdtempSync(join(tmpdir(), "uasf-hardlink-symlink-outside-"));
      const linkPath = join(tempRoot, "evil-project");

      if (!trySymlink(outside, linkPath)) {
        rmSync(outside, { recursive: true, force: true });
        return;
      }

      expect(() => assertFilesystemConfinement(tempRoot, "evil-project")).toThrow(PathEscapeError);
      rmSync(outside, { recursive: true, force: true });
    });

    it("hard-link detection does not weaken the project-root alias (in-baseDir symlink) protection", () => {
      tempRoot = mkdtempSync(join(tmpdir(), "uasf-hardlink-alias-"));
      mkdirSync(join(tempRoot, "B"));
      if (!trySymlink(join(tempRoot, "B"), join(tempRoot, "A"))) return;

      expect(() => assertFilesystemConfinement(tempRoot, "A")).toThrow(PathEscapeError);
    });
  });
});

/** `fs.existsSync` follows symlinks — used here purely to assert a target was never actually created. */
function existsSyncFollows(path: string): boolean {
  return existsSync(path);
}

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
