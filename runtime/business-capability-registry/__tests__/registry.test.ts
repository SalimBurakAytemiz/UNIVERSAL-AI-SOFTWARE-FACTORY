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
});
