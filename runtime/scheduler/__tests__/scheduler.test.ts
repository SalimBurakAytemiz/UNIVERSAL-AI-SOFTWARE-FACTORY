import { describe, expect, it } from "vitest";
import { WorkerRegistry } from "../../workers/registry.js";
import { NoSufficientWorkerError, ResourceAwareScheduler } from "../scheduler.js";

function setup() {
  const registry = new WorkerRegistry();
  registry.register({ id: "cpu-box", workerClass: "linux-general", capabilities: ["cpu"], costPerMinuteUsd: 0.01, status: "IDLE" });
  registry.register({ id: "gpu-box", workerClass: "gpu", capabilities: ["cpu", "gpu", "cuda"], costPerMinuteUsd: 0.75, status: "IDLE" });
  registry.register({ id: "busy-cpu-box", workerClass: "linux-general", capabilities: ["cpu"], costPerMinuteUsd: 0.005, status: "BUSY" });
  const scheduler = new ResourceAwareScheduler(registry);
  return { registry, scheduler };
}

describe("ResourceAwareScheduler", () => {
  it("Proof H: does not select a GPU worker for a CPU-only task when a cheaper CPU worker is IDLE", () => {
    const { scheduler } = setup();
    const worker = scheduler.selectWorker({ taskId: "lint-job", requiredCapabilities: ["cpu"] });
    expect(worker.id).toBe("cpu-box");
    expect(worker.workerClass).not.toBe("gpu");
  });

  it("selects the GPU worker only when the task actually requires GPU capability", () => {
    const { scheduler } = setup();
    const worker = scheduler.selectWorker({ taskId: "train-model", requiredCapabilities: ["gpu", "cuda"] });
    expect(worker.id).toBe("gpu-box");
  });

  it("never selects a BUSY worker", () => {
    const { scheduler } = setup();
    const worker = scheduler.selectWorker({ taskId: "lint-job", requiredCapabilities: ["cpu"] });
    expect(worker.id).not.toBe("busy-cpu-box");
  });

  it("throws NoSufficientWorkerError when no IDLE worker is capable", () => {
    const { scheduler } = setup();
    expect(() => scheduler.selectWorker({ taskId: "android-build", requiredCapabilities: ["android-sdk"] })).toThrow(
      NoSufficientWorkerError
    );
  });
});
