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

  describe("P1 fix (8th independent review round, 'caller mutation changes project identity during bootstrap')", () => {
    it("mutating the original candidate's nested project.id AFTER parseProjectGenome() does not change the returned genome", () => {
      const candidate = { project: { id: "proj-A", name: "Test", family: "web" } };
      const genome = parseProjectGenome(candidate);

      candidate.project.id = "proj-B";

      expect(genome.project.id).toBe("proj-A");
    });

    it("mutating the original candidate's nested project.family AFTER parseProjectGenome() does not change the returned genome", () => {
      const candidate = { project: { id: "proj-1", name: "Test", family: "web" } };
      const genome = parseProjectGenome(candidate);

      candidate.project.family = "ecommerce";

      expect(genome.project.family).toBe("web");
    });

    it("the returned genome is a genuinely detached object, not the same reference as the candidate", () => {
      const candidate = { project: { id: "proj-1", name: "Test", family: "web" } };
      const genome = parseProjectGenome(candidate);

      expect(genome).not.toBe(candidate);
      expect(genome.project).not.toBe(candidate.project);
    });

    it("the returned genome is deeply frozen — mutation attempts throw instead of silently succeeding", () => {
      const genome = parseProjectGenome({ project: { id: "proj-1", name: "Test", family: "web" } });

      expect(() => {
        (genome.project as { id: string }).id = "proj-B";
      }).toThrow(TypeError);
    });

    it("mutating a nested array field (business.capabilities) on the original candidate does not affect the returned genome", () => {
      const candidate = {
        project: { id: "proj-1", name: "Test", family: "ecommerce" },
        business: { capabilities: ["payments"] }
      };
      const genome = parseProjectGenome(candidate);

      candidate.business.capabilities.push("identity");

      expect(genome.business?.capabilities).toEqual(["payments"]);
    });

    it("invalid genome still fails before any detachment side effect leaks (fails closed)", () => {
      const candidate = { project: { id: "" } };
      expect(() => parseProjectGenome(candidate)).toThrow(InvalidProjectGenomeError);
      // The original candidate is never mutated by the failed attempt either.
      expect(candidate.project.id).toBe("");
    });

    it("two separate parseProjectGenome() calls on the same shape never share the same authoritative object", () => {
      const candidateA = { project: { id: "proj-A", name: "A", family: "web" } };
      const candidateB = { project: { id: "proj-A", name: "A", family: "web" } };
      const genomeA = parseProjectGenome(candidateA);
      const genomeB = parseProjectGenome(candidateB);

      expect(genomeA).not.toBe(genomeB);
      expect(genomeA.project).not.toBe(genomeB.project);
    });
  });
});
