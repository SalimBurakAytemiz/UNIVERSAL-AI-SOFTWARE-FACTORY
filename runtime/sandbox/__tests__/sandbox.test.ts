import { describe, expect, it } from "vitest";
import { PathEscapeError, SandboxTimeoutError, assertWithinRoot, withTimeout } from "../sandbox.js";

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
