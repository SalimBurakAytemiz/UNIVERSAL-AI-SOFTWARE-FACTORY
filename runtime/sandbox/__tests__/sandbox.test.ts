import { describe, expect, it } from "vitest";
import {
  InvalidProjectIdError,
  PathEscapeError,
  SandboxTimeoutError,
  assertValidProjectId,
  assertWithinRoot,
  withTimeout
} from "../sandbox.js";

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
