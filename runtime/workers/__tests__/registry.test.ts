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
});
