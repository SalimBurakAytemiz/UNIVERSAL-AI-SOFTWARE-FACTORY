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
});
