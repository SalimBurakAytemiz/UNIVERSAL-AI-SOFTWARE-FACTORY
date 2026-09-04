// Baseline section 147 (Constitution): risk taşıyan hiçbir eylem, politika
// motorunun önüne geçemez ("capability gateway'in policy engine'i atlayan
// bir yolu olmamalı"). Bu modül o tek geçiş noktasını uygular: `authorize`
// çağrılmadan bir eylemin gerçek fonksiyonu (execute) hiçbir zaman
// çalıştırılmaz.

import type { PolicyAction, PolicyEngine } from "../policy-engine/policy-engine.js";

export class CapabilityDeniedError extends Error {
  constructor(action: PolicyAction) {
    super(`Action '${action.actionType}' was DENIED by policy: ${action.description}`);
    this.name = "CapabilityDeniedError";
  }
}

export class CapabilityApprovalRequiredError extends Error {
  constructor(action: PolicyAction) {
    super(
      `Action '${action.actionType}' requires human approval before it can execute: ${action.description}. ` +
        `Use runtime/policy-engine/approval.ts to request and record that approval first.`
    );
    this.name = "CapabilityApprovalRequiredError";
  }
}

export class CapabilityGateway {
  constructor(private readonly policy: PolicyEngine) {}

  /**
   * Bir eylemi çalıştırmadan ÖNCE politika motorundan geçirir. ALLOW
   * dışında hiçbir sonuç, `execute` fonksiyonunu tetiklemez — bu, riskli
   * bir eylemin "yanlışlıkla" veya bir hata sonucu politika kontrolünü
   * atlayarak çalışmasını yapısal olarak imkânsız kılar.
   */
  async authorize<T>(action: PolicyAction, execute: () => Promise<T> | T): Promise<T> {
    const result = this.policy.evaluate(action);

    if (result.decision === "DENY") {
      throw new CapabilityDeniedError(action);
    }
    if (result.decision === "APPROVAL_REQUIRED") {
      throw new CapabilityApprovalRequiredError(action);
    }

    return execute();
  }
}
