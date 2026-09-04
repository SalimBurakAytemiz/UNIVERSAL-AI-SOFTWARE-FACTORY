// Baseline section 148 (Policy Engine) + 241 (Policy Conflict Resolver).
// Bu modül, Factory içindeki her eylemi ALLOW / DENY / APPROVAL_REQUIRED
// olarak sınıflandıran merkezi karar noktasıdır. Öncelik sırası bölüm 241'de
// tanımlıdır: güvenlik/yasal engelleyiciler > üretim bütünlüğü > kurucunun
// onayladığı iş politikası > maliyet optimizasyonu > kullanım kolaylığı.
// Politika motoru olmadan hiçbir riskli eylem doğrudan yürütülemez
// (bölüm 147, "capability gateway" bu motorun önüne geçemez).

import { AuditLog } from "../audit/audit-log.js";

export type PolicyDecision = "ALLOW" | "DENY" | "APPROVAL_REQUIRED";

export type RiskLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface PolicyAction {
  readonly actionType: string;
  readonly risk: RiskLevel;
  readonly description: string;
  readonly costUsd?: number;
}

export interface PolicyRule {
  readonly name: string;
  /** Higher priority evaluated first. Ties broken by registration order. */
  readonly priority: number;
  evaluate(action: PolicyAction): PolicyDecision | null;
}

export interface PolicyEvaluationResult {
  readonly decision: PolicyDecision;
  readonly matchedRule: string;
  readonly action: PolicyAction;
}

/**
 * Risk-5 eylemler (üretime dağıtım, yıkıcı DB işlemleri, gizli anahtar
 * değişikliği, bütçe dışı premium model kullanımı vb.) hiçbir zaman
 * doğrudan ALLOW alamaz — bölüm 146, 147 gereği en az APPROVAL_REQUIRED
 * döner. Bu, motor içine gömülü, override edilemeyen bir kuraldır.
 */
const RISK_5_NEVER_AUTO_ALLOW: PolicyRule = {
  name: "risk-5-requires-approval",
  priority: Number.MAX_SAFE_INTEGER,
  evaluate(action) {
    if (action.risk >= 5) return "APPROVAL_REQUIRED";
    return null;
  }
};

export class PolicyEngine {
  private readonly rules: PolicyRule[] = [RISK_5_NEVER_AUTO_ALLOW];

  constructor(private readonly auditLog: AuditLog = new AuditLog()) {}

  addRule(rule: PolicyRule): void {
    this.rules.push(rule);
  }

  get auditTrail(): AuditLog {
    return this.auditLog;
  }

  evaluate(action: PolicyAction): PolicyEvaluationResult {
    const ordered = [...this.rules].sort((a, b) => b.priority - a.priority);

    let decision: PolicyDecision = "DENY"; // default deny (baseline section 147)
    let matchedRule = "default-deny";

    for (const rule of ordered) {
      const result = rule.evaluate(action);
      if (result !== null) {
        decision = result;
        matchedRule = rule.name;
        break;
      }
    }

    this.auditLog.append({
      type: "POLICY_DECISION",
      actor: "policy-engine",
      payload: { action, decision, matchedRule },
      timestamp: new Date().toISOString()
    });

    return { decision, matchedRule, action };
  }
}

/** Default-allow rule for low-risk, non-destructive actions (opt-in, explicit). */
export function lowRiskAllowRule(maxRisk: RiskLevel = 2): PolicyRule {
  return {
    name: `allow-risk-at-or-below-${maxRisk}`,
    priority: 1,
    evaluate(action) {
      if (action.risk <= maxRisk) return "ALLOW";
      return null;
    }
  };
}
