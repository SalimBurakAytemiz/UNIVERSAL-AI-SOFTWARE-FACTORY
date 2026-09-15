import { describe, expect, it } from "vitest";
import { composeOrganization, composeOrganizationFromGenome } from "../composer.js";
import { parseProjectGenome } from "../../project-genome/genome.js";

describe("composeOrganization", () => {
  it("composes only the minimum baseline teams for a simple CLI project with no special capabilities", () => {
    const composition = composeOrganization({ projectFamily: "cli", requiredCapabilities: [], risk: 1 });
    expect([...composition.teams].sort()).toEqual(["backend", "qa"]);
    expect(composition.teams).not.toContain("security");
    expect(composition.teams).not.toContain("game");
  });

  it("does not activate unrelated teams (e.g. game) for a web project", () => {
    const composition = composeOrganization({ projectFamily: "web", requiredCapabilities: [], risk: 0 });
    expect(composition.teams).not.toContain("game");
    expect(composition.teams).not.toContain("mobile");
  });

  it("activates the security team, with a recorded rationale, when payments is required", () => {
    const composition = composeOrganization({
      projectFamily: "ecommerce",
      requiredCapabilities: ["payments"],
      risk: 1
    });
    expect(composition.teams).toContain("security");
    expect(composition.rationale.security).toContain("Payments");
  });

  it("activates security for high risk even without a capability that would otherwise require it", () => {
    const composition = composeOrganization({ projectFamily: "backend", requiredCapabilities: [], risk: 5 });
    expect(composition.teams).toContain("security");
    expect(composition.rationale.security).toContain("Risk level 5");
  });

  it("every activated team has a recorded rationale", () => {
    const composition = composeOrganization({ projectFamily: "mmorpg", requiredCapabilities: ["anti-cheat"], risk: 3 });
    for (const team of composition.teams) {
      expect(composition.rationale[team]).toBeTruthy();
    }
  });

  describe("P2 fix (8th independent review round, 'prototype names crash schema-valid project families')", () => {
    it("a projectFamily of 'constructor' does not crash and uses the fallback teams", () => {
      const composition = composeOrganization({ projectFamily: "constructor", requiredCapabilities: [], risk: 1 });
      expect([...composition.teams].sort()).toEqual(["backend", "qa"]);
    });

    it("a projectFamily of 'toString' does not crash and uses the fallback teams", () => {
      const composition = composeOrganization({ projectFamily: "toString", requiredCapabilities: [], risk: 1 });
      expect([...composition.teams].sort()).toEqual(["backend", "qa"]);
    });

    it("a projectFamily of '__proto__' does not crash and uses the fallback teams", () => {
      const composition = composeOrganization({ projectFamily: "__proto__", requiredCapabilities: [], risk: 1 });
      expect([...composition.teams].sort()).toEqual(["backend", "qa"]);
    });

    it("a projectFamily of 'hasOwnProperty' does not crash and uses the fallback teams", () => {
      const composition = composeOrganization({ projectFamily: "hasOwnProperty", requiredCapabilities: [], risk: 1 });
      expect([...composition.teams].sort()).toEqual(["backend", "qa"]);
    });

    it("an unrecognized ordinary family string still gets the documented fallback teams", () => {
      const composition = composeOrganization({ projectFamily: "totally-unknown-family", requiredCapabilities: [], risk: 1 });
      expect([...composition.teams].sort()).toEqual(["backend", "qa"]);
    });

    it("known families still resolve their correct, specific teams (no regression from the Map conversion)", () => {
      expect([...composeOrganization({ projectFamily: "web", requiredCapabilities: [], risk: 0 }).teams].sort()).toEqual(
        ["backend", "qa", "web"]
      );
      expect([...composeOrganization({ projectFamily: "mobile", requiredCapabilities: [], risk: 0 }).teams].sort()).toEqual(
        ["backend", "mobile", "qa"]
      );
      expect([...composeOrganization({ projectFamily: "mmorpg", requiredCapabilities: [], risk: 0 }).teams].sort()).toEqual(
        ["backend", "game", "qa"]
      );
    });

    it("no prototype pollution occurs from processing a prototype-named family (a fresh object is unaffected)", () => {
      composeOrganization({ projectFamily: "__proto__", requiredCapabilities: [], risk: 1 });
      composeOrganization({ projectFamily: "constructor", requiredCapabilities: [], risk: 1 });
      const fresh: Record<string, unknown> = {};
      expect(Object.getPrototypeOf(fresh)).toBe(Object.prototype);
      expect((fresh as { polluted?: unknown }).polluted).toBeUndefined();
    });

    it("a prototype-named family combined with a capability requirement still adds the required team via the documented rule", () => {
      const composition = composeOrganization({ projectFamily: "constructor", requiredCapabilities: ["payments"], risk: 1 });
      expect(composition.teams).toContain("security");
      expect(composition.rationale.security).toContain("Payments");
    });

    it("bootstrap via composeOrganizationFromGenome completes according to the fallback contract for a prototype-named family", () => {
      const genome = parseProjectGenome({ project: { id: "proj-1", name: "Test", family: "constructor" } });
      const composition = composeOrganizationFromGenome(genome);
      expect([...composition.teams].sort()).toEqual(["backend", "qa"]);
    });
  });
});

describe("composeOrganizationFromGenome (Project Genome -> Organization Composer wiring)", () => {
  it("derives project family and required capabilities directly from a validated Project Genome", () => {
    const genome = parseProjectGenome({
      project: { id: "shop-1", name: "Online Shop", family: "ecommerce" },
      business: { capabilities: ["payments", "identity"] }
    });
    const composition = composeOrganizationFromGenome(genome);
    expect(composition.teams).toEqual(expect.arrayContaining(["web", "backend", "qa", "security"]));
    expect(composition.rationale.security).toContain("Payments");
  });

  it("defaults to an empty capability list when the genome declares none", () => {
    const genome = parseProjectGenome({ project: { id: "cli-1", name: "A CLI Tool", family: "cli" } });
    const composition = composeOrganizationFromGenome(genome);
    expect([...composition.teams].sort()).toEqual(["backend", "qa"]);
  });

  it("accepts an explicit risk override from the caller", () => {
    const genome = parseProjectGenome({ project: { id: "backend-1", name: "Internal API", family: "backend" } });
    const composition = composeOrganizationFromGenome(genome, 5);
    expect(composition.teams).toContain("security");
    expect(composition.rationale.security).toContain("Risk level 5");
  });
});
