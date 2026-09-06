import { describe, expect, it } from "vitest";
import { WorkerRegistry, DuplicateWorkerIdError, WorkerNotFoundError } from "../registry.js";
import { InvalidMonetaryAmountError } from "../../cost/cost-engine.js";
import { ResourceAwareScheduler, NoSufficientWorkerError } from "../../scheduler/scheduler.js";

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

  describe("P2 fix (9th independent review round, 'duplicate worker identities break authoritative status')", () => {
    it("first registration of a worker id succeeds", () => {
      const registry = new WorkerRegistry();
      expect(() =>
        registry.register({ id: "w1", workerClass: "linux-general", capabilities: ["cpu"], costPerMinuteUsd: 0.01, status: "IDLE" })
      ).not.toThrow();
      expect(registry.all()).toHaveLength(1);
    });

    it("a duplicate worker id registration is rejected", () => {
      const registry = new WorkerRegistry();
      registry.register({ id: "w1", workerClass: "linux-general", capabilities: ["cpu"], costPerMinuteUsd: 0.01, status: "IDLE" });
      expect(() =>
        registry.register({ id: "w1", workerClass: "linux-general", capabilities: ["cpu"], costPerMinuteUsd: 0.02, status: "QUARANTINED" })
      ).toThrow(DuplicateWorkerIdError);
    });

    it("the original record remains completely unchanged after a rejected duplicate registration", () => {
      const registry = new WorkerRegistry();
      registry.register({ id: "w1", workerClass: "linux-general", capabilities: ["cpu"], costPerMinuteUsd: 0.01, status: "IDLE" });
      expect(() =>
        registry.register({ id: "w1", workerClass: "gpu", capabilities: ["gpu"], costPerMinuteUsd: 99, status: "QUARANTINED" })
      ).toThrow(DuplicateWorkerIdError);

      const [worker] = registry.all();
      expect(worker!.status).toBe("IDLE");
      expect(worker!.workerClass).toBe("linux-general");
      expect(worker!.costPerMinuteUsd).toBe(0.01);
      expect(registry.all()).toHaveLength(1); // no stale/duplicate record was created
    });

    it("an explicit status transition IDLE -> QUARANTINED works via updateStatus()", () => {
      const registry = new WorkerRegistry();
      registry.register({ id: "w1", workerClass: "linux-general", capabilities: ["cpu"], costPerMinuteUsd: 0.01, status: "IDLE" });
      const updated = registry.updateStatus("w1", "QUARANTINED");
      expect(updated.status).toBe("QUARANTINED");
      expect(registry.all()).toHaveLength(1); // still exactly one authoritative record
    });

    it("BLOCKER regression (10th independent review round, test item 10): the record returned by updateStatus() is a frozen, detached snapshot — ownership boundaries are preserved on this new path too", () => {
      const registry = new WorkerRegistry();
      registry.register({ id: "w1", workerClass: "linux-general", capabilities: ["cpu"], costPerMinuteUsd: 0.01, status: "IDLE" });
      const updated = registry.updateStatus("w1", "QUARANTINED");

      expect(() => {
        (updated as { status: string }).status = "IDLE";
      }).toThrow(TypeError);
      expect(() => {
        (updated.capabilities as string[]).push("gpu");
      }).toThrow(TypeError);

      // Mutation attempts on the returned snapshot never reach the authoritative record.
      expect(registry.all()[0]!.status).toBe("QUARANTINED");
      expect(registry.findCapable(["cpu"])).toHaveLength(0);
      // updateStatus() never hands back the SAME reference stored internally either.
      expect(updated).not.toBe(registry.all()[0]);
    });

    it("BLOCKER regression: a quarantined worker (via updateStatus) is never returned by findCapable() — no stale IDLE record survives", () => {
      const registry = new WorkerRegistry();
      registry.register({ id: "w1", workerClass: "linux-general", capabilities: ["cpu"], costPerMinuteUsd: 0.01, status: "IDLE" });
      registry.updateStatus("w1", "QUARANTINED");

      expect(registry.findCapable(["cpu"])).toHaveLength(0);
      expect(registry.all()).toHaveLength(1);
    });

    it("BLOCKER regression: the scheduler never selects a worker quarantined via updateStatus()", () => {
      const registry = new WorkerRegistry();
      registry.register({ id: "w1", workerClass: "linux-general", capabilities: ["cpu"], costPerMinuteUsd: 0.01, status: "IDLE" });
      registry.updateStatus("w1", "QUARANTINED");
      const scheduler = new ResourceAwareScheduler(registry);

      expect(() => scheduler.selectWorker({ taskId: "t1", requiredCapabilities: ["cpu"] })).toThrow(
        NoSufficientWorkerError
      );
    });

    it("a BUSY worker is excluded from scheduler selection per the existing IDLE-only contract", () => {
      const registry = new WorkerRegistry();
      registry.register({ id: "w1", workerClass: "linux-general", capabilities: ["cpu"], costPerMinuteUsd: 0.01, status: "IDLE" });
      registry.updateStatus("w1", "BUSY");
      const scheduler = new ResourceAwareScheduler(registry);

      expect(() => scheduler.selectWorker({ taskId: "t1", requiredCapabilities: ["cpu"] })).toThrow(
        NoSufficientWorkerError
      );
      // findCapable() itself still lists it (only QUARANTINED is excluded there) — the
      // IDLE-only restriction is the scheduler's own, separate contract.
      expect(registry.findCapable(["cpu"])).toHaveLength(1);
    });

    it("a worker returns to an allowed (IDLE) state only through an explicit updateStatus() transition, and is then selectable again", () => {
      const registry = new WorkerRegistry();
      registry.register({ id: "w1", workerClass: "linux-general", capabilities: ["cpu"], costPerMinuteUsd: 0.01, status: "IDLE" });
      registry.updateStatus("w1", "QUARANTINED");
      expect(registry.findCapable(["cpu"])).toHaveLength(0);

      registry.updateStatus("w1", "IDLE");
      const scheduler = new ResourceAwareScheduler(registry);
      expect(scheduler.selectWorker({ taskId: "t1", requiredCapabilities: ["cpu"] }).id).toBe("w1");
      expect(registry.all()).toHaveLength(1); // still exactly one record throughout
    });

    it("updateStatus() on an unregistered id fails closed instead of silently creating a record", () => {
      const registry = new WorkerRegistry();
      expect(() => registry.updateStatus("never-registered", "QUARANTINED")).toThrow(WorkerNotFoundError);
      expect(registry.all()).toHaveLength(0);
    });

    it("no stale duplicate worker record remains after repeated register/reject/updateStatus cycles", () => {
      const registry = new WorkerRegistry();
      registry.register({ id: "w1", workerClass: "linux-general", capabilities: ["cpu"], costPerMinuteUsd: 0.01, status: "IDLE" });
      expect(() =>
        registry.register({ id: "w1", workerClass: "linux-general", capabilities: ["cpu"], costPerMinuteUsd: 0.01, status: "IDLE" })
      ).toThrow(DuplicateWorkerIdError);
      registry.updateStatus("w1", "BUSY");
      registry.updateStatus("w1", "IDLE");
      expect(registry.all()).toHaveLength(1);
    });
  });
});
