import { describe, expect, it } from "vitest";
import { DuplicateServiceError, ServiceCatalog, ServiceNotFoundError } from "../service-catalog.js";

describe("ServiceCatalog", () => {
  it("registers and retrieves a service", () => {
    const catalog = new ServiceCatalog();
    catalog.register({ id: "svc-1", name: "Payments API", kind: "service", purpose: "process payments", owner: "team-payments", status: "HEALTHY" });
    expect(catalog.get("svc-1")?.status).toBe("HEALTHY");
  });

  it("refuses duplicate ids", () => {
    const catalog = new ServiceCatalog();
    catalog.register({ id: "svc-1", name: "A", kind: "service", purpose: "p", status: "HEALTHY" });
    expect(() => catalog.register({ id: "svc-1", name: "B", kind: "service", purpose: "p2", status: "HEALTHY" })).toThrow(
      DuplicateServiceError
    );
  });

  it("finds services with a given health status", () => {
    const catalog = new ServiceCatalog();
    catalog.register({ id: "svc-1", name: "A", kind: "service", purpose: "p", status: "HEALTHY" });
    catalog.register({ id: "svc-2", name: "B", kind: "integration", purpose: "p2", status: "DOWN" });
    expect(catalog.findByStatus("DOWN")).toHaveLength(1);
  });

  it("flags services with no recorded owner (baseline section 127)", () => {
    const catalog = new ServiceCatalog();
    catalog.register({ id: "svc-1", name: "Owned", kind: "service", purpose: "p", owner: "team-a", status: "HEALTHY" });
    catalog.register({ id: "svc-2", name: "Orphaned", kind: "service", purpose: "p", status: "HEALTHY" });
    const unowned = catalog.findUnowned();
    expect(unowned).toHaveLength(1);
    expect(unowned[0]!.id).toBe("svc-2");
  });

  it("updateStatus mutates health and throws for an unknown id", () => {
    const catalog = new ServiceCatalog();
    catalog.register({ id: "svc-1", name: "A", kind: "service", purpose: "p", status: "HEALTHY" });
    catalog.updateStatus("svc-1", "DEGRADED");
    expect(catalog.get("svc-1")?.status).toBe("DEGRADED");
    expect(() => catalog.updateStatus("missing", "DOWN")).toThrow(ServiceNotFoundError);
  });

  describe("P1 cross-cutting fix: status cannot be mutated via a leaked reference, bypassing updateStatus()", () => {
    it("mutating an object returned by get()/all() does not change internal state", () => {
      const catalog = new ServiceCatalog();
      catalog.register({ id: "svc-1", name: "A", kind: "service", purpose: "p", status: "HEALTHY" });

      const got = catalog.get("svc-1")!;
      expect(() => {
        (got as { status: string }).status = "DOWN";
      }).toThrow(TypeError);

      const [listed] = catalog.all();
      expect(() => {
        (listed as { status: string }).status = "DOWN";
      }).toThrow(TypeError);

      expect(catalog.get("svc-1")!.status).toBe("HEALTHY");
    });

    it("mutating the object passed into register() after registration does not affect internal state", () => {
      const catalog = new ServiceCatalog();
      const record: { id: string; name: string; kind: "service"; purpose: string; status: "HEALTHY" | "DOWN" } = {
        id: "svc-1",
        name: "A",
        kind: "service",
        purpose: "p",
        status: "HEALTHY"
      };
      catalog.register(record);
      record.status = "DOWN"; // caller mutates the object they originally passed in

      expect(catalog.get("svc-1")!.status).toBe("HEALTHY");
    });
  });

  describe(
    "P1 fix (28th independent review round, root-class B sweep, 'TypeScript private used for authoritative " +
      "mutable state'): ServiceCatalog's services Map is also a genuine #private field now",
    () => {
      it("services is not reachable as an ordinary JS property", () => {
        const catalog = new ServiceCatalog();
        catalog.register({ id: "svc-1", name: "A", kind: "service", purpose: "p", status: "HEALTHY" });

        expect((catalog as unknown as Record<string, unknown>).services).toBeUndefined();
        expect(Object.getOwnPropertyNames(catalog)).not.toContain("services");
      });
    }
  );

  describe(
    "P1 fix (28th independent review round, finding 12's root class, 'snapshot registry records before " +
      "validation/storage'): register() reads record.id exactly once, then the duplicate check and the Map key " +
      "both use that SAME snapshot",
    () => {
      it("BLOCKER regression, exact reproduction: a getter-backed id answering a NON-colliding value for the duplicate check and a DIFFERENT (colliding) value afterward must not corrupt the store", () => {
        const catalog = new ServiceCatalog();
        catalog.register({ id: "existing", name: "Existing", kind: "service", purpose: "p", status: "HEALTHY" });

        let reads = 0;
        const hostile = {
          get id() {
            reads += 1;
            return reads === 1 ? "new-one" : "existing";
          },
          name: "Hostile",
          kind: "service" as const,
          purpose: "p",
          status: "DOWN" as const
        };

        catalog.register(hostile);
        expect(reads).toBe(1); // id consulted exactly once
        expect(catalog.get("existing")!.status).toBe("HEALTHY"); // untouched
        expect(catalog.get("new-one")!.status).toBe("DOWN");
      });
    }
  );
});
