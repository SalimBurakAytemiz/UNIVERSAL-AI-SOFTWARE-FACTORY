import { describe, expect, it } from "vitest";
import { ArtifactRegistry, DuplicateArtifactError } from "../artifact-registry.js";

describe("ArtifactRegistry", () => {
  it("registers and retrieves an artifact", () => {
    const registry = new ArtifactRegistry();
    const record = registry.register({ id: "a1", artifactClass: "tests", path: "coverage/report.html", projectId: "proj-1" });
    expect(registry.get("a1")).toEqual(record);
  });

  it("refuses to silently overwrite an existing artifact id", () => {
    const registry = new ArtifactRegistry();
    registry.register({ id: "a1", artifactClass: "docs", path: "README.md", projectId: "proj-1" });
    expect(() => registry.register({ id: "a1", artifactClass: "docs", path: "OTHER.md", projectId: "proj-1" })).toThrow(
      DuplicateArtifactError
    );
  });

  it("scopes artifacts by project", () => {
    const registry = new ArtifactRegistry();
    registry.register({ id: "a1", artifactClass: "code", path: "src/x.ts", projectId: "proj-1" });
    registry.register({ id: "a2", artifactClass: "code", path: "src/y.ts", projectId: "proj-2" });
    expect(registry.allFor("proj-1")).toHaveLength(1);
  });

  it("filters by artifact class", () => {
    const registry = new ArtifactRegistry();
    registry.register({ id: "a1", artifactClass: "screenshots", path: "shot.png", projectId: "proj-1" });
    registry.register({ id: "a2", artifactClass: "code", path: "x.ts", projectId: "proj-1" });
    expect(registry.findByClass("screenshots")).toHaveLength(1);
  });

  describe("P1 fix (targeted ownership audit): registered evidence cannot be swapped via a leaked reference", () => {
    it("mutating the object returned by register() cannot change the recorded path/checksum", () => {
      const registry = new ArtifactRegistry();
      const record = registry.register({ id: "a1", artifactClass: "tests", path: "coverage/report.html", projectId: "proj-1" });

      expect(() => {
        (record as { path: string }).path = "coverage/forged.html";
      }).toThrow(TypeError);

      expect(registry.get("a1")!.path).toBe("coverage/report.html");
    });

    it("mutating a record returned by get()/allFor()/findByClass() cannot change the recorded evidence", () => {
      const registry = new ArtifactRegistry();
      registry.register({ id: "a1", artifactClass: "tests", path: "coverage/report.html", projectId: "proj-1", checksum: "abc123" });

      const got = registry.get("a1")!;
      expect(() => {
        (got as { checksum: string }).checksum = "forged";
      }).toThrow(TypeError);

      expect(registry.get("a1")!.checksum).toBe("abc123");
      expect(registry.allFor("proj-1")[0]!.checksum).toBe("abc123");
      expect(registry.findByClass("tests")[0]!.checksum).toBe("abc123");
    });
  });
});
