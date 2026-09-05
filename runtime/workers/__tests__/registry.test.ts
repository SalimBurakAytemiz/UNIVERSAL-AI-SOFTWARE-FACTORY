import { describe, expect, it } from "vitest";
import { WorkerRegistry } from "../registry.js";
import { InvalidMonetaryAmountError } from "../../cost/cost-engine.js";

describe("WorkerRegistry", () => {
  it("excludes quarantined workers from capable candidates", () => {
    const registry = new WorkerRegistry();
    registry.register({ id: "w1", workerClass: "linux-general", capabilities: ["cpu"], costPerMinuteUsd: 0.01, status: "QUARANTINED" });
    expect(registry.findCapable(["cpu"])).toHaveLength(0);
  });

  it("finds workers that satisfy every required capability", () => {
    const registry = new WorkerRegistry();
    registry.register({ id: "w1", workerClass: "linux-general", capabilities: ["cpu"], costPerMinuteUsd: 0.01, status: "IDLE" });
    registry.register({ id: "w2", workerClass: "gpu", capabilities: ["cpu", "gpu", "cuda"], costPerMinuteUsd: 0.5, status: "IDLE" });
    expect(registry.findCapable(["gpu"])).toHaveLength(1);
    expect(registry.findCapable(["cpu"])).toHaveLength(2);
  });

  describe("P1 cross-cutting fix: a leaked reference cannot un-quarantine a worker or forge a capability", () => {
    it("mutating status on an object returned by all() cannot un-quarantine a worker", () => {
      const registry = new WorkerRegistry();
      registry.register({ id: "w1", workerClass: "linux-general", capabilities: ["cpu"], costPerMinuteUsd: 0.01, status: "QUARANTINED" });

      const [worker] = registry.all();
      expect(() => {
        (worker as { status: string }).status = "IDLE";
      }).toThrow(TypeError);

      expect(registry.findCapable(["cpu"])).toHaveLength(0); // still quarantined
    });

    it("mutating capabilities on a returned object cannot forge a capability the worker doesn't have", () => {
      const registry = new WorkerRegistry();
      registry.register({ id: "w1", workerClass: "linux-general", capabilities: ["cpu"], costPerMinuteUsd: 0.01, status: "IDLE" });

      const [worker] = registry.all();
      expect(() => {
        (worker.capabilities as string[]).push("gpu");
      }).toThrow(TypeError);

      expect(registry.findCapable(["gpu"])).toHaveLength(0);
    });

    it("mutating the object passed into register() after registration does not affect internal state", () => {
      const registry = new WorkerRegistry();
      const worker: { id: string; workerClass: "linux-general"; capabilities: string[]; costPerMinuteUsd: number; status: "IDLE" | "QUARANTINED" } = {
        id: "w1",
        workerClass: "linux-general",
        capabilities: ["cpu"],
        costPerMinuteUsd: 0.01,
        status: "IDLE"
      };
      registry.register(worker);
      worker.status = "QUARANTINED";
      worker.capabilities.push("gpu");

      expect(registry.findCapable(["cpu"])).toHaveLength(1); // registry's own copy is unaffected
      expect(registry.findCapable(["gpu"])).toHaveLength(0);
    });
  });

  describe("P2 targeted-audit fix (7th independent review round, same class as 'invalid model prices corrupt cheapest-capable routing')", () => {
    it("rejects a NaN costPerMinuteUsd before the record reaches the registry", () => {
      const registry = new WorkerRegistry();
      expect(() =>
        registry.register({ id: "w1", workerClass: "linux-general", capabilities: ["cpu"], costPerMinuteUsd: Number.NaN, status: "IDLE" })
      ).toThrow(InvalidMonetaryAmountError);
      expect(registry.all()).toHaveLength(0);
    });

    it("rejects a negative costPerMinuteUsd", () => {
      const registry = new WorkerRegistry();
      expect(() =>
        registry.register({ id: "w1", workerClass: "linux-general", capabilities: ["cpu"], costPerMinuteUsd: -1, status: "IDLE" })
      ).toThrow(InvalidMonetaryAmountError);
      expect(registry.all()).toHaveLength(0);
    });

    it("rejects +Infinity/-Infinity costPerMinuteUsd", () => {
      const registry = new WorkerRegistry();
      expect(() =>
        registry.register({ id: "w1", workerClass: "linux-general", capabilities: ["cpu"], costPerMinuteUsd: Number.POSITIVE_INFINITY, status: "IDLE" })
      ).toThrow(InvalidMonetaryAmountError);
      expect(() =>
        registry.register({ id: "w2", workerClass: "linux-general", capabilities: ["cpu"], costPerMinuteUsd: Number.NEGATIVE_INFINITY, status: "IDLE" })
      ).toThrow(InvalidMonetaryAmountError);
      expect(registry.all()).toHaveLength(0);
    });

    it("accepts a zero costPerMinuteUsd (free workers must remain valid)", () => {
      const registry = new WorkerRegistry();
      expect(() =>
        registry.register({ id: "w1", workerClass: "linux-general", capabilities: ["cpu"], costPerMinuteUsd: 0, status: "IDLE" })
      ).not.toThrow();
      expect(registry.all()).toHaveLength(1);
    });

    it("REGRESSION: a poisoned NaN-priced worker registered first can no longer corrupt scheduler.ts's cheapest-of reduce, because registration itself fails closed", () => {
      const registry = new WorkerRegistry();
      expect(() =>
        registry.register({ id: "poisoned", workerClass: "gpu", capabilities: ["gpu"], costPerMinuteUsd: Number.NaN, status: "IDLE" })
      ).toThrow(InvalidMonetaryAmountError);
      registry.register({ id: "genuinely-cheap", workerClass: "gpu", capabilities: ["gpu"], costPerMinuteUsd: 0.01, status: "IDLE" });

      const capable = registry.findCapable(["gpu"]);
      expect(capable).toHaveLength(1);
      expect(capable[0]!.id).toBe("genuinely-cheap");
    });
  });
});
