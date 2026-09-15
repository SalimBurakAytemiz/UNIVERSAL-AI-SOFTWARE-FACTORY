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

  describe(
    "P2 fix (26th independent review round, finding 5, 'detach values across project isolation views'): stored " +
      "values are deep-cloned and deep-frozen on set(), so a caller-owned mutable object can never be used to " +
      "silently mutate a project's stored data from outside, or to leak a mutation across projects",
    () => {
      it(
        "BLOCKER regression, exact reproduction: the SAME mutable object stored separately in project A and " +
          "project B — mutating the original object afterward changes NEITHER stored copy",
        () => {
          interface Payload {
            count: number;
            nested: { flag: boolean };
          }
          const store = new ProjectIsolationStore<Payload>();
          const shared: Payload = { count: 1, nested: { flag: false } };

          store.viewFor("proj-a").set("k", shared);
          store.viewFor("proj-b").set("k", shared);

          // Mutate the ORIGINAL object (including a nested field) after
          // both projects have already stored it.
          shared.count = 999;
          shared.nested.flag = true;

          const storedA = store.viewFor("proj-a").get("k");
          const storedB = store.viewFor("proj-b").get("k");
          expect(storedA).toEqual({ count: 1, nested: { flag: false } });
          expect(storedB).toEqual({ count: 1, nested: { flag: false } });
        }
      );

      it("mutating a value RETURNED by get() cannot reach the store's own authoritative copy or leak into another project", () => {
        interface Payload {
          items: string[];
        }
        const store = new ProjectIsolationStore<Payload>();
        store.viewFor("proj-a").set("k", { items: ["only-for-a"] });

        const returned = store.viewFor("proj-a").get("k")!;
        expect(() => {
          (returned as { items: string[] }).items.push("smuggled");
        }).toThrow(TypeError); // deep-frozen: even the nested array rejects mutation
        expect(() => {
          (returned as unknown as { items: unknown }).items = [];
        }).toThrow(TypeError);

        // Reading again returns the same, still-untouched authoritative data.
        expect(store.viewFor("proj-a").get("k")).toEqual({ items: ["only-for-a"] });
        expect(store.viewFor("proj-b").get("k")).toBeUndefined();
      });

      it("two independent set() calls with the SAME input object produce two independently mutable-safe stored copies, not a shared reference", () => {
        const store = new ProjectIsolationStore<{ n: number }>();
        const original = { n: 1 };

        store.viewFor("proj-a").set("k", original);
        original.n = 2;
        store.viewFor("proj-b").set("k", original); // stores the object as it is NOW (n=2)
        original.n = 3; // mutate again after both sets

        expect(store.viewFor("proj-a").get("k")).toEqual({ n: 1 }); // captured at A's set() time
        expect(store.viewFor("proj-b").get("k")).toEqual({ n: 2 }); // captured at B's set() time, unaffected by the later n=3
      });
    }
  );

  describe(
    "P2 fix (37th independent review round, finding 9, 'mutable collections escaping the trust boundary'): " +
      "Object.freeze() does not block Map.set()/Set.add() — a Map/Set value returned by get() must not let a " +
      "caller mutate this store's own authoritative bucket entry",
    () => {
      it(
        "BLOCKER regression, exact reproduction: mutating a Map returned by get() does not change what a " +
          "subsequent get() call for the SAME key on the SAME project returns",
        () => {
          const store = new ProjectIsolationStore<Map<string, string>>();
          store.viewFor("proj-a").set("k", new Map([["x", "original"]]));

          const returned = store.viewFor("proj-a").get("k")!;
          // Object.freeze() cannot block Map.set() — this line does NOT throw,
          // it silently succeeds. Before the fix, this reached back into the
          // store's own authoritative bucket entry because get() returned the
          // exact same stored reference.
          returned.set("x", "smuggled-mutation");
          returned.set("y", "smuggled-new-entry");

          const again = store.viewFor("proj-a").get("k")!;
          expect(again.get("x")).toBe("original");
          expect(again.has("y")).toBe(false);
        }
      );

      it("mutating a Set returned by get() does not change what a subsequent get() call returns", () => {
        const store = new ProjectIsolationStore<Set<string>>();
        store.viewFor("proj-a").set("k", new Set(["only-original"]));

        const returned = store.viewFor("proj-a").get("k")!;
        returned.add("smuggled");
        returned.delete("only-original");

        const again = store.viewFor("proj-a").get("k")!;
        expect(again.has("only-original")).toBe(true);
        expect(again.has("smuggled")).toBe(false);
      });

      it("mutating a Map returned by get() for one project never leaks into another project's stored data", () => {
        const store = new ProjectIsolationStore<Map<string, string>>();
        store.viewFor("proj-a").set("k", new Map([["x", "a-value"]]));
        store.viewFor("proj-b").set("k", new Map([["x", "b-value"]]));

        const returnedA = store.viewFor("proj-a").get("k")!;
        returnedA.set("x", "smuggled-from-a");

        expect(store.viewFor("proj-a").get("k")!.get("x")).toBe("a-value");
        expect(store.viewFor("proj-b").get("k")!.get("x")).toBe("b-value");
      });

      it("no-regression: two separate get() calls for a Map value return independently mutable-safe clones, not the same reference", () => {
        const store = new ProjectIsolationStore<Map<string, string>>();
        store.viewFor("proj-a").set("k", new Map([["x", "original"]]));

        const first = store.viewFor("proj-a").get("k")!;
        const second = store.viewFor("proj-a").get("k")!;
        expect(first).not.toBe(second);
        expect(first).toEqual(second);
      });

      it("no-regression: plain-object values are still deep-frozen (throw on mutation attempts) exactly as before", () => {
        const store = new ProjectIsolationStore<{ items: string[] }>();
        store.viewFor("proj-a").set("k", { items: ["only-for-a"] });

        const returned = store.viewFor("proj-a").get("k")!;
        expect(() => {
          returned.items.push("smuggled");
        }).toThrow(TypeError);
      });
    }
  );

  describe(
    "P1 targeted-audit fix (26th independent review round, same root class as finding 2, 'cost ledger state must " +
      "be runtime-private'): the internal data Map now uses a genuine ECMAScript #private field, not TypeScript's " +
      "compile-time-only `private`",
    () => {
      it("the internal data Map is not reachable as an ordinary JS property", () => {
        const store = new ProjectIsolationStore<string>();
        store.viewFor("proj-a").set("k", "v");

        expect((store as unknown as Record<string, unknown>).data).toBeUndefined();
        expect((store as unknown as Record<string, unknown>)["data"]).toBeUndefined();
      });

      it("no reflection API (Object.getOwnPropertyNames / Reflect.ownKeys) exposes the private data Map", () => {
        const store = new ProjectIsolationStore<string>();
        store.viewFor("proj-a").set("k", "v");

        expect(Object.getOwnPropertyNames(store)).not.toContain("data");
        expect(Reflect.ownKeys(store).map(String)).not.toContain("data");
      });

      it("REGRESSION: a plain JS consumer holding the STORE (not a view) cannot reach another project's bucket via property access, defeating default deny", () => {
        const store = new ProjectIsolationStore<string>();
        store.viewFor("proj-a").set("secret", "only for proj-a");

        const forged = (store as unknown as Record<string, unknown>).data as
          | Map<string, Map<string, string>>
          | undefined;
        expect(forged).toBeUndefined(); // there is nothing to reach in and read another project's bucket from

        const spread: Record<string, unknown> = { ...store };
        expect(spread.data).toBeUndefined();

        // proj-a's data is still reachable ONLY through its own view.
        expect(store.viewFor("proj-a").get("secret")).toBe("only for proj-a");
        expect(store.viewFor("proj-b").get("secret")).toBeUndefined();
      });
    }
  );
});
