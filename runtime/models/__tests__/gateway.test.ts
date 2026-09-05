import { describe, expect, it } from "vitest";
import { ModelGateway, UnknownProviderError } from "../gateway.js";
import { createDefaultModelRegistry } from "../registry.js";
import { MockProvider } from "../providers/mock-provider.js";

describe("ModelGateway + MockProvider", () => {
  it("invokes the registered provider for a model and returns a deterministic response", async () => {
    const gateway = new ModelGateway();
    gateway.registerProvider(new MockProvider());
    const registry = createDefaultModelRegistry();
    const model = registry.all()[0]!;

    const response = await gateway.invoke(model, { prompt: "hello" });
    expect(response.provider).toBe("mock");
    expect(response.modelId).toBe(model.modelId);
    expect(response.output).toContain("hello");
    expect(response.costUsd).toBe(model.costPerCall);
  });

  it("throws UnknownProviderError when no provider is registered for the model's provider id", async () => {
    const gateway = new ModelGateway();
    const registry = createDefaultModelRegistry();
    const model = registry.all()[0]!;
    await expect(gateway.invoke(model, { prompt: "hello" })).rejects.toThrow(UnknownProviderError);
  });

  it("core kernel tests never require a paid API — MockProvider is entirely offline and free", async () => {
    const gateway = new ModelGateway();
    gateway.registerProvider(new MockProvider());
    const registry = createDefaultModelRegistry();
    const freeModel = registry.all().find((m) => m.tier === "MOCK")!;
    const response = await gateway.invoke(freeModel, { prompt: "no network needed" });
    expect(response.costUsd).toBe(0);
  });
});
