// Baseline section 59: MockProvider — ağ bağlantısı gerektirmeyen,
// ücretsiz, deterministik sağlayıcı. Çekirdek (P0) testlerinin ve
// kanıtların (proofs/) hiçbiri ücretli bir API'ye bağımlı olmamalıdır;
// bu sağlayıcı o gereksinimi karşılar.

import type { ModelInvocationRequest, ModelInvocationResponse, ModelProvider } from "../gateway.js";
import type { ModelRecord } from "../registry.js";

export interface MockProviderOptions {
  /** If set, every invocation reports this response instead of echoing the prompt. */
  readonly fixedOutput?: string;
}

export class MockProvider implements ModelProvider {
  readonly id = "mock";

  constructor(private readonly options: MockProviderOptions = {}) {}

  async invoke(model: ModelRecord, request: ModelInvocationRequest): Promise<ModelInvocationResponse> {
    const output = this.options.fixedOutput ?? `mock-response[${model.modelId}]: ${request.prompt}`;
    return {
      modelId: model.modelId,
      provider: this.id,
      costUsd: model.costPerCall,
      output
    };
  }
}
