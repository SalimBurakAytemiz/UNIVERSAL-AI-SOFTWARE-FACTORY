import { describe, expect, it } from "vitest";
import { CrossProjectAccessDeniedError, ProjectIsolationStore } from "../isolation.js";

describe("ProjectIsolationStore", () => {
  it("lets a project write and read back its own data", () => {
    const store = new ProjectIsolationStore<string>();
    store.set("proj-a", "proj-a", "secret-note", "only for proj-a");
    expect(store.get("proj-a", "proj-a", "secret-note")).toBe("only for proj-a");
  });

  it("denies a different project reading proj-a's data (default deny)", () => {
    const store = new ProjectIsolationStore<string>();
    store.set("proj-a", "proj-a", "secret-note", "only for proj-a");
    expect(() => store.get("proj-b", "proj-a", "secret-note")).toThrow(CrossProjectAccessDeniedError);
  });

  it("denies listing another project's keys", () => {
    const store = new ProjectIsolationStore<string>();
    store.set("proj-a", "proj-a", "k1", "v1");
    expect(() => store.keysFor("proj-b", "proj-a")).toThrow(CrossProjectAccessDeniedError);
    expect(store.keysFor("proj-a", "proj-a")).toEqual(["k1"]);
  });

  describe("P1 fix (24th independent review round, 'project writes must require caller identity')", () => {
    it("denies a caller from project A writing into project B's bucket (cross-project write)", () => {
      const store = new ProjectIsolationStore<string>();
      expect(() => store.set("proj-a", "proj-b", "k1", "written by A, claiming to be for B")).toThrow(
        CrossProjectAccessDeniedError
      );
      // And no data was written under either project as a side effect of the rejected call.
      expect(() => store.get("proj-b", "proj-b", "k1")).not.toThrow();
      expect(store.get("proj-b", "proj-b", "k1")).toBeUndefined();
      expect(() => store.get("proj-a", "proj-a", "k1")).not.toThrow();
      expect(store.get("proj-a", "proj-a", "k1")).toBeUndefined();
    });

    it("a rejected cross-project write cannot be used to overwrite a victim project's existing data", () => {
      const store = new ProjectIsolationStore<string>();
      store.set("proj-b", "proj-b", "balance", "original-for-b");
      expect(() => store.set("proj-a", "proj-b", "balance", "overwritten-by-a")).toThrow(CrossProjectAccessDeniedError);
      expect(store.get("proj-b", "proj-b", "balance")).toBe("original-for-b");
    });

    it("a caller can only ever write for its own project id, never a third or fourth project", () => {
      const store = new ProjectIsolationStore<string>();
      expect(() => store.set("proj-a", "proj-c", "k", "v")).toThrow(CrossProjectAccessDeniedError);
      expect(() => store.set("proj-a", "proj-d", "k", "v")).toThrow(CrossProjectAccessDeniedError);
      expect(store.keysFor("proj-a", "proj-a")).toEqual([]);
    });
  });
});
