import { describe, expect, it } from "vitest";
import { TechnologyRegistry } from "../registry.js";

describe("TechnologyRegistry", () => {
  it("excludes FORBIDDEN and DEPRECATED technologies from recommendations", () => {
    const registry = new TechnologyRegistry();
    registry.register({ id: "typescript", category: "language", lifecycle: "PREFERRED" });
    registry.register({ id: "flash", category: "framework", lifecycle: "FORBIDDEN" });
    registry.register({ id: "jquery", category: "framework", lifecycle: "DEPRECATED" });

    const recommendable = registry.recommendable();
    expect(recommendable.map((t) => t.id)).toEqual(["typescript"]);
  });

  it("filters recommendations by category", () => {
    const registry = new TechnologyRegistry();
    registry.register({ id: "typescript", category: "language", lifecycle: "PREFERRED" });
    registry.register({ id: "postgresql", category: "database", lifecycle: "PREFERRED" });
    expect(registry.recommendable("database")).toHaveLength(1);
    expect(registry.recommendable("database")[0]!.id).toBe("postgresql");
  });

  it("findByCategory returns all technologies in that category regardless of lifecycle", () => {
    const registry = new TechnologyRegistry();
    registry.register({ id: "flash", category: "framework", lifecycle: "FORBIDDEN" });
    expect(registry.findByCategory("framework")).toHaveLength(1);
  });

  describe("P1 fix (targeted ownership audit): FORBIDDEN/DEPRECATED cannot be bypassed via a leaked reference", () => {
    it("mutating the object passed into register() after registration cannot un-forbid a technology", () => {
      const registry = new TechnologyRegistry();
      const tech: { id: string; category: "framework"; lifecycle: "FORBIDDEN" | "PREFERRED" } = {
        id: "flash",
        category: "framework",
        lifecycle: "FORBIDDEN"
      };
      registry.register(tech);
      tech.lifecycle = "PREFERRED"; // caller mutates their own object after the fact

      expect(registry.recommendable().map((t) => t.id)).not.toContain("flash");
    });

    it("mutating a record returned by all() cannot un-forbid a technology", () => {
      const registry = new TechnologyRegistry();
      registry.register({ id: "flash", category: "framework", lifecycle: "FORBIDDEN" });

      const [tech] = registry.all();
      expect(() => {
        (tech as { lifecycle: string }).lifecycle = "PREFERRED";
      }).toThrow(TypeError);

      expect(registry.recommendable().map((t) => t.id)).not.toContain("flash");
    });
  });
});
