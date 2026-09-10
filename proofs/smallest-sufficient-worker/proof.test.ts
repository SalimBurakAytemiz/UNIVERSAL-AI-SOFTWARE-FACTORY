// Proof H (baseline section 306): "GPU workers are not selected for
// CPU-only tasks."
import { describe, expect, it } from "vitest";
import { WorkerRegistry } from "../../runtime/workers/registry.js";
import { ResourceAwareScheduler } from "../../runtime/scheduler/scheduler.js";

describe("Proof: Smallest sufficient worker", () => {
  it("a lint/format task never lands on the GPU worker even though the GPU worker could technically run it", () => {
    const registry = new WorkerRegistry();
    registry.register({ id: "cpu-1", workerClass: "linux-general", capabilities: ["cpu"], costPerMinuteUsd: 0.008, status: "IDLE" });
    registry.register({ id: "gpu-1", workerClass: "gpu", capabilities: ["cpu", "gpu"], costPerMinuteUsd: 0.9, status: "IDLE" });

    const scheduler = new ResourceAwareScheduler(registry);
    const worker = scheduler.selectWorker({ taskId: "eslint-run", requiredCapabilities: ["cpu"] });

    expect(worker.workerClass).toBe("linux-general");
    expect(worker.id).not.toBe("gpu-1");
  });
});
