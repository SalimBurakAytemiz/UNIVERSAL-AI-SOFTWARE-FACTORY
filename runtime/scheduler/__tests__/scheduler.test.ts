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

  describe("P1 fix (24th independent review round, 'worker sufficiency must rank before price')", () => {
    it("never selects a cheaper GPU worker over a sufficient CPU-only worker for a CPU-only task", () => {
      const registry = new WorkerRegistry();
      // Deliberately the OPPOSITE of every other test in this file: the GPU
      // worker is now the CHEAPER of the two. A pure cheapest-first rule
      // would pick it; smallest-sufficient-worker must not.
      registry.register({ id: "cpu-expensive", workerClass: "linux-general", capabilities: ["cpu"], costPerMinuteUsd: 0.5, status: "IDLE" });
      registry.register({ id: "gpu-cheap", workerClass: "gpu", capabilities: ["cpu", "gpu"], costPerMinuteUsd: 0.01, status: "IDLE" });
      const scheduler = new ResourceAwareScheduler(registry);

      const worker = scheduler.selectWorker({ taskId: "lint-job", requiredCapabilities: ["cpu"] });

      expect(worker.id).toBe("cpu-expensive");
      expect(worker.workerClass).not.toBe("gpu");
    });

    it("never selects a cheaper high-memory worker over a sufficient linux-container worker", () => {
      const registry = new WorkerRegistry();
      registry.register({ id: "container-box", workerClass: "linux-container", capabilities: ["cpu"], costPerMinuteUsd: 0.2, status: "IDLE" });
      registry.register({ id: "high-mem-box", workerClass: "high-memory", capabilities: ["cpu"], costPerMinuteUsd: 0.02, status: "IDLE" });
      const scheduler = new ResourceAwareScheduler(registry);

      const worker = scheduler.selectWorker({ taskId: "build-job", requiredCapabilities: ["cpu"] });

      expect(worker.id).toBe("container-box");
    });

    it("cost still breaks ties among workers with the same resource-excess weight", () => {
      const registry = new WorkerRegistry();
      registry.register({ id: "cpu-cheap", workerClass: "linux-general", capabilities: ["cpu"], costPerMinuteUsd: 0.01, status: "IDLE" });
      registry.register({ id: "cpu-pricey", workerClass: "linux-general", capabilities: ["cpu"], costPerMinuteUsd: 0.9, status: "IDLE" });
      registry.register({ id: "mac-cheap", workerClass: "macos", capabilities: ["cpu"], costPerMinuteUsd: 0.05, status: "IDLE" });
      const scheduler = new ResourceAwareScheduler(registry);

      const worker = scheduler.selectWorker({ taskId: "lint-job", requiredCapabilities: ["cpu"] });

      expect(worker.id).toBe("cpu-cheap"); // same weight tier as mac-cheap, but strictly cheaper
    });
  });

  describe(
    "P1 fix (28th independent review round, root-class B sweep, 'TypeScript private used for authoritative " +
      "mutable state'): ResourceAwareScheduler's registry is also a genuine #private field now",
    () => {
      it("registry is not reachable as an ordinary JS property, and a forged replacement cannot substitute the authoritative worker pool", () => {
        const realRegistry = new WorkerRegistry();
        realRegistry.register({ id: "w1", workerClass: "linux-general", capabilities: ["cpu"], costPerMinuteUsd: 0.01, status: "IDLE" });
        const scheduler = new ResourceAwareScheduler(realRegistry);

        const asRecord = scheduler as unknown as Record<string, unknown>;
        expect(asRecord.registry).toBeUndefined();

        const forgedRegistry = { findCapable: () => [{ id: "hijacked", workerClass: "gpu", capabilities: ["cpu"], costPerMinuteUsd: 0, status: "IDLE" }] };
        asRecord.registry = forgedRegistry;
        const spread: Record<string, unknown> = { ...scheduler };
        expect(spread.registry).toBe(forgedRegistry); // an inert stray property, nothing more

        // selectWorker() still consults the REAL registry, not the forged one.
        const worker = scheduler.selectWorker({ taskId: "t1", requiredCapabilities: ["cpu"] });
        expect(worker.id).toBe("w1");
      });
    }
  );
});
