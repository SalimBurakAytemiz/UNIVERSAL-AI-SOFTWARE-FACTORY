import { describe, expect, it } from "vitest";
import { ProjectIsolationStore } from "../isolation.js";

describe("ProjectIsolationStore", () => {
  it("lets a project write and read back its own data via its own view", () => {
    const store = new ProjectIsolationStore<string>();
    const projA = store.viewFor("proj-a");
    projA.set("secret-note", "only for proj-a");
    expect(projA.get("secret-note")).toBe("only for proj-a");
  });

  it("a different project's view never sees proj-a's data (default deny)", () => {
    const store = new ProjectIsolationStore<string>();
    store.viewFor("proj-a").set("secret-note", "only for proj-a");
    const projB = store.viewFor("proj-b");
    expect(projB.get("secret-note")).toBeUndefined();
  });

  it("a different project's view lists no keys belonging to another project", () => {
    const store = new ProjectIsolationStore<string>();
    store.viewFor("proj-a").set("k1", "v1");
    expect(store.viewFor("proj-b").keys()).toEqual([]);
    expect(store.viewFor("proj-a").keys()).toEqual(["k1"]);
  });

  describe(
    "P1 fix (25th independent review round, 'project isolation must use trusted project identity'): the old " +
      "dual-string set(callerProjectId, targetProjectId, ...)/get(...)/keysFor(...) API is REMOVED entirely — " +
      "a view returned by viewFor() takes NO project-id parameter on any of its own methods, so cross-project " +
      "access is structurally inexpressible, not merely runtime-checked",
    () => {
      it(
        "BLOCKER regression, exact reproduction: the old vulnerability (supplying the SAME value for both " +
          "'caller' and 'target' trivially satisfies a naive equality check) has no surface left to exploit — " +
          "there is only ONE project id, fixed at viewFor() time, and no second argument anywhere on the view",
        () => {
          const store = new ProjectIsolationStore<string>();
          const projA = store.viewFor("proj-a");

          // The view's own methods are genuinely unary/nullary — there is
          // no argument through which code holding `projA` could ever name
          // a different project, let alone satisfy a "same value twice"
          // check. This is verified by TypeScript itself: `set`/`get` take
          // exactly (key) or (key, value), never a project id.
          expect(projA.set.length).toBe(2); // (key, value)
          expect(projA.get.length).toBe(1); // (key)
          expect(projA.keys.length).toBe(0); // ()

          projA.set("k", "v-for-a");
          const projB = store.viewFor("proj-b");
          projB.set("k", "v-for-b");

          // Each view is permanently bound to the project it was created
          // for — writing/reading through one view can never reach the
          // other project's bucket, regardless of what either view's
          // caller "claims."
          expect(projA.get("k")).toBe("v-for-a");
          expect(projB.get("k")).toBe("v-for-b");
        }
      );

      it("a view exposes no enumerable property revealing its bound project id or the underlying shared data map", () => {
        const store = new ProjectIsolationStore<string>();
        const projA = store.viewFor("secret-project-id");
        projA.set("k", "v");

        // The bound project id lives ONLY in the closure — it is not an
        // own property of the returned object, so no property-enumeration
        // trick (Object.keys/values/entries, JSON.stringify, a `for...in`
        // loop) can recover it or pivot to another project's bucket.
        expect(Object.keys(projA)).toEqual(["set", "get", "keys"]);
        expect(JSON.stringify(projA)).toBe("{}");
      });

      it("two independently-created views for the SAME trusted project id share the SAME underlying data (a view is a capability handle, not a separate store)", () => {
        const store = new ProjectIsolationStore<string>();
        const firstHandle = store.viewFor("proj-a");
        firstHandle.set("k", "v1");

        const secondHandle = store.viewFor("proj-a");
        expect(secondHandle.get("k")).toBe("v1");
        secondHandle.set("k", "v2");
        expect(firstHandle.get("k")).toBe("v2");
      });

      it("many projects can be viewed from the same store with no cross-contamination across any pair", () => {
        const store = new ProjectIsolationStore<string>();
        const ids = ["proj-a", "proj-b", "proj-c", "proj-d"];
        for (const id of ids) {
          store.viewFor(id).set("k", `value-for-${id}`);
        }
        for (const id of ids) {
          expect(store.viewFor(id).get("k")).toBe(`value-for-${id}`);
          expect(store.viewFor(id).keys()).toEqual(["k"]);
        }
      });

      it("passing an extra 'target project' argument to a view's methods (a type-unsafe caller attempting the old API shape) has no effect — the bound project id is never re-read from call arguments", () => {
        const store = new ProjectIsolationStore<string>();
        const projA = store.viewFor("proj-a");
        store.viewFor("proj-b").set("k", "v-for-b");

        // A caller bypassing the type system (`as any`/`.call`/`.apply`) to
        // smuggle in an extra argument shaped like the OLD, vulnerable
        // dual-string API — attempting to redirect this view's write/read
        // to "proj-b" despite `projA` being permanently bound to "proj-a".
        (projA.set as (...args: unknown[]) => void).call(projA, "k", "smuggled-write", "proj-b");
        expect(projA.get("k")).toBe("smuggled-write"); // written under proj-a, as always
        expect(store.viewFor("proj-b").get("k")).toBe("v-for-b"); // proj-b's own data is untouched

        const readResult = (projA.get as (...args: unknown[]) => string | undefined).call(projA, "k", "proj-b");
        expect(readResult).toBe("smuggled-write"); // still reads proj-a's own data, never proj-b's
      });

      it("a project with no data yet returns undefined/empty from its own view, never another project's data", () => {
        const store = new ProjectIsolationStore<string>();
        store.viewFor("proj-a").set("k", "v");
        const freshProject = store.viewFor("brand-new-project");
        expect(freshProject.get("k")).toBeUndefined();
        expect(freshProject.keys()).toEqual([]);
      });
    }
  );
});
