// Baseline section 59: Model Gateway — sağlayıcı soyutlaması. Çekirdek
// testler asla ücretli bir API gerektirmemelidir; bu yüzden gateway,
// sağlayıcıları isimle kayıt altına alan basit bir arayüzdür ve
// MockProvider (providers/mock-provider.ts) varsayılan/test sağlayıcısıdır.

import type { ModelRecord } from "./registry.js";

export interface ModelInvocationRequest {
  readonly prompt: string;
  readonly taskType?: string;
}

export interface ModelInvocationResponse {
  readonly modelId: string;
  readonly provider: string;
  readonly costUsd: number;
  readonly output: string;
}

export interface ModelProvider {
  readonly id: string;
  invoke(model: ModelRecord, request: ModelInvocationRequest): Promise<ModelInvocationResponse>;
}

export class UnknownProviderError extends Error {
  constructor(provider: string) {
    super(`No provider registered for '${provider}'. Register it via ModelGateway.registerProvider().`);
    this.name = "UnknownProviderError";
  }
}

export class ModelGateway {
  private readonly providers = new Map<string, ModelProvider>();

  registerProvider(provider: ModelProvider): void {
    this.providers.set(provider.id, provider);
  }

  hasProvider(id: string): boolean {
    return this.providers.has(id);
  }

  async invoke(model: ModelRecord, request: ModelInvocationRequest): Promise<ModelInvocationResponse> {
    const provider = this.providers.get(model.provider);
    if (!provider) throw new UnknownProviderError(model.provider);
    return provider.invoke(model, request);
  }
}
