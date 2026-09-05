import { describe, expect, it } from "vitest";
import { WorkerRegistry } from "../registry.js";

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
});
