import { describe, expect, it } from "vitest";
import { InvalidProjectGenomeError, parseProjectGenome, validateProjectGenome } from "../genome.js";

describe("Project Genome validation", () => {
  it("accepts a minimal valid genome", () => {
    const result = validateProjectGenome({ project: { id: "proj-1", name: "Test Project", family: "web" } });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects a genome missing the required project.family field", () => {
    const result = validateProjectGenome({ project: { id: "proj-1", name: "Test Project" } });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects a genome with no project field at all", () => {
    const result = validateProjectGenome({ requirements: [] });
    expect(result.valid).toBe(false);
  });

  it("parseProjectGenome throws InvalidProjectGenomeError for invalid input instead of silently accepting it", () => {
    expect(() => parseProjectGenome({ project: {} })).toThrow(InvalidProjectGenomeError);
  });

  it("parseProjectGenome returns a typed genome for valid input", () => {
    const genome = parseProjectGenome({
      project: { id: "proj-1", name: "Test", family: "ecommerce" },
      business: { capabilities: ["payments"] }
    });
    expect(genome.project.family).toBe("ecommerce");
  });
});
