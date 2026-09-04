import { describe, expect, it } from "vitest";
import { CrossProjectAccessDeniedError, ProjectIsolationStore } from "../isolation.js";

describe("ProjectIsolationStore", () => {
  it("lets a project read back its own data", () => {
    const store = new ProjectIsolationStore<string>();
    store.set("proj-a", "secret-note", "only for proj-a");
    expect(store.get("proj-a", "proj-a", "secret-note")).toBe("only for proj-a");
  });

  it("denies a different project reading proj-a's data (default deny)", () => {
    const store = new ProjectIsolationStore<string>();
    store.set("proj-a", "secret-note", "only for proj-a");
    expect(() => store.get("proj-b", "proj-a", "secret-note")).toThrow(CrossProjectAccessDeniedError);
  });

  it("denies listing another project's keys", () => {
    const store = new ProjectIsolationStore<string>();
    store.set("proj-a", "k1", "v1");
    expect(() => store.keysFor("proj-b", "proj-a")).toThrow(CrossProjectAccessDeniedError);
    expect(store.keysFor("proj-a", "proj-a")).toEqual(["k1"]);
  });
});
