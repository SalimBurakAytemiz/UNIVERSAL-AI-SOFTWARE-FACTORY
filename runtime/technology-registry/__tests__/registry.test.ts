import { describe, expect, it } from "vitest";
import {
  DuplicateTechnologyIdError,
  InvalidTechnologyLifecycleTransitionError,
  MissingTechnologyTransitionReasonError,
  TechnologyNotFoundError,
  TechnologyRegistry
} from "../registry.js";
import { AuditLog } from "../../audit/audit-log.js";

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

  describe("P1 fix (24th independent review round, 'technology registry must reject uncontrolled overwrites')", () => {
    it(
      "REGRESSION, exact reproduction: registering the same id again cannot silently replace a FORBIDDEN " +
        "technology with PREFERRED",
      () => {
        const registry = new TechnologyRegistry();
        registry.register({ id: "flash", category: "framework", lifecycle: "FORBIDDEN" });

        expect(() => registry.register({ id: "flash", category: "framework", lifecycle: "PREFERRED" })).toThrow(
          DuplicateTechnologyIdError
        );

        expect(registry.recommendable().map((t) => t.id)).not.toContain("flash");
        expect(registry.findByCategory("framework")[0]!.lifecycle).toBe("FORBIDDEN");
      }
    );

    it("rejects registering ANY duplicate id, regardless of the target lifecycle", () => {
      const registry = new TechnologyRegistry();
      registry.register({ id: "typescript", category: "language", lifecycle: "PREFERRED" });
      expect(() => registry.register({ id: "typescript", category: "language", lifecycle: "APPROVED" })).toThrow(
        DuplicateTechnologyIdError
      );
    });

    it("transitionLifecycle() allows a normal forward progression (EXPERIMENTAL -> APPROVED -> PREFERRED)", () => {
      const registry = new TechnologyRegistry();
      registry.register({ id: "rust", category: "language", lifecycle: "EXPERIMENTAL" });

      registry.transitionLifecycle("rust", "APPROVED", "passed internal security review");
      expect(registry.all()[0]!.lifecycle).toBe("APPROVED");

      registry.transitionLifecycle("rust", "PREFERRED", "adopted as the default systems language");
      expect(registry.all()[0]!.lifecycle).toBe("PREFERRED");
    });

    it("transitionLifecycle() allows moving INTO FORBIDDEN from any prior lifecycle", () => {
      const registry = new TechnologyRegistry();
      registry.register({ id: "flash-2", category: "framework", lifecycle: "PREFERRED" });
      const updated = registry.transitionLifecycle("flash-2", "FORBIDDEN", "known critical CVE, no patch available");
      expect(updated.lifecycle).toBe("FORBIDDEN");
      expect(registry.recommendable().map((t) => t.id)).not.toContain("flash-2");
    });

    it("transitionLifecycle() rejects walking FORBIDDEN back to a recommendable lifecycle", () => {
      const registry = new TechnologyRegistry();
      registry.register({ id: "flash-3", category: "framework", lifecycle: "FORBIDDEN" });
      expect(() => registry.transitionLifecycle("flash-3", "PREFERRED", "vendor says it's fixed now")).toThrow(
        InvalidTechnologyLifecycleTransitionError
      );
      expect(registry.recommendable().map((t) => t.id)).not.toContain("flash-3");
    });

    it("transitionLifecycle() rejects walking DEPRECATED back to a recommendable lifecycle", () => {
      const registry = new TechnologyRegistry();
      registry.register({ id: "jquery-2", category: "framework", lifecycle: "DEPRECATED" });
      expect(() => registry.transitionLifecycle("jquery-2", "SUPPORTED", "still used in one legacy project")).toThrow(
        InvalidTechnologyLifecycleTransitionError
      );
    });

    it("transitionLifecycle() throws TechnologyNotFoundError for an unknown id", () => {
      const registry = new TechnologyRegistry();
      expect(() => registry.transitionLifecycle("nonexistent", "APPROVED", "reason")).toThrow(TechnologyNotFoundError);
    });

    it("transitionLifecycle() rejects a blank/whitespace-only reason", () => {
      const registry = new TechnologyRegistry();
      registry.register({ id: "go", category: "language", lifecycle: "EXPERIMENTAL" });
      expect(() => registry.transitionLifecycle("go", "APPROVED", "   ")).toThrow(MissingTechnologyTransitionReasonError);
      expect(registry.all()[0]!.lifecycle).toBe("EXPERIMENTAL"); // unchanged
    });

    it("transitionLifecycle() records an audited lifecycle-transition event with the from/to/reason", () => {
      const auditLog = new AuditLog();
      const registry = new TechnologyRegistry(auditLog);
      registry.register({ id: "kotlin", category: "language", lifecycle: "APPROVED" });
      registry.transitionLifecycle("kotlin", "PREFERRED", "strong Android ecosystem adoption");

      const events = auditLog.all().filter((e) => e.type === "TECHNOLOGY_LIFECYCLE_TRANSITIONED");
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({ id: "kotlin", from: "APPROVED", to: "PREFERRED" });
    });
  });
});
