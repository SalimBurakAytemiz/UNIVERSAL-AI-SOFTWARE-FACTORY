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
});
