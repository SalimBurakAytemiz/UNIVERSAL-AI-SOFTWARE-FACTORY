import { describe, expect, it } from "vitest";
import { BusinessCapabilityRegistry, createDefaultBusinessCapabilityRegistry } from "../registry.js";

describe("BusinessCapabilityRegistry", () => {
  it("finds capabilities applicable to a given project family", () => {
    const registry = createDefaultBusinessCapabilityRegistry();
    const forGame = registry.findApplicable("game");
    expect(forGame.map((c) => c.id)).toContain("anti-cheat");
    expect(forGame.map((c) => c.id)).not.toContain("payments");
  });

  it("finds capabilities applicable to ecommerce", () => {
    const registry = createDefaultBusinessCapabilityRegistry();
    const forEcommerce = registry.findApplicable("ecommerce");
    expect(forEcommerce.map((c) => c.id)).toEqual(expect.arrayContaining(["identity", "payments", "notifications"]));
  });

  it("register()/get() round-trips a custom capability", () => {
    const registry = new BusinessCapabilityRegistry();
    registry.register({
      id: "loyalty",
      purpose: "Customer loyalty points",
      projectFamilies: ["ecommerce"],
      dependencies: ["identity"],
      deliveryOptions: ["DEFER"]
    });
    expect(registry.get("loyalty")?.deliveryOptions).toEqual(["DEFER"]);
  });

  describe("P1 fix (targeted ownership audit): registered/returned capabilities cannot be mutated via a leaked reference", () => {
    it("mutating the object passed into register() after registration does not affect internal state", () => {
      const registry = new BusinessCapabilityRegistry();
      const capability: { id: string; purpose: string; projectFamilies: string[]; dependencies: string[]; deliveryOptions: ("DEFER" | "BUILD")[] } = {
        id: "loyalty",
        purpose: "Customer loyalty points",
        projectFamilies: ["ecommerce"],
        dependencies: [],
        deliveryOptions: ["DEFER"]
      };
      registry.register(capability);
      capability.projectFamilies.push("game");

      expect(registry.findApplicable("game")).toHaveLength(0);
    });

    it("mutating a record returned by get()/all() throws and does not affect internal state", () => {
      const registry = new BusinessCapabilityRegistry();
      registry.register({
        id: "loyalty",
        purpose: "Customer loyalty points",
        projectFamilies: ["ecommerce"],
        dependencies: [],
        deliveryOptions: ["DEFER"]
      });

      const got = registry.get("loyalty")!;
      expect(() => {
        (got.projectFamilies as string[]).push("game");
      }).toThrow(TypeError);

      expect(registry.findApplicable("game")).toHaveLength(0);
    });
  });

  describe(
    "P1 fix (28th independent review round, root-class B sweep, 'TypeScript private used for authoritative " +
      "mutable state'): BusinessCapabilityRegistry's capabilities Map is also a genuine #private field now",
    () => {
      it("capabilities is not reachable as an ordinary JS property", () => {
        const registry = new BusinessCapabilityRegistry();
        registry.register({ id: "identity", purpose: "p", projectFamilies: ["web"], dependencies: [], deliveryOptions: ["BUILD"] });

        expect((registry as unknown as Record<string, unknown>).capabilities).toBeUndefined();
        expect(Object.getOwnPropertyNames(registry)).not.toContain("capabilities");
      });
    }
  );
});
