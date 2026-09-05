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

export const RISK_5_APPROVAL_RULE_NAME = "risk-5-requires-approval";

export class PolicyEngine {
  private readonly rules: PolicyRule[] = [];

  constructor(private readonly auditLog: AuditLog = new AuditLog()) {}

  addRule(rule: PolicyRule): void {
    this.rules.push(rule);
  }

  get auditTrail(): AuditLog {
    return this.auditLog;
  }

  evaluate(action: PolicyAction): PolicyEvaluationResult {
    const ordered = [...this.rules].sort((a, b) => b.priority - a.priority);

    // P1 fix (7th independent review round, "higher-priority ALLOW bypasses
    // matching DENY"): the previous loop `break`-ed at the FIRST rule that
    // returned a non-null decision, in priority order. That meant a
    // lower-priority DENY rule was never even EVALUATED once a
    // higher-priority ALLOW rule matched the same action — silently
    // violating "DENY ALWAYS WINS" (bölüm 147/241, "güvenlik/yasal
    // engelleyiciler" en yüksek önceliğe sahiptir, rule.priority sıralaması
    // buna aykırı bir sonuç ÜRETEMEZ). Fix: her uygulanabilir kural
    // (early-break OLMADAN) değerlendirilir; en yüksek öncelikli DENY
    // eşleşmesi ile en yüksek öncelikli DENY-DIŞI eşleşme ayrı ayrı
    // izlenir. Herhangi bir öncelikte bir DENY eşleşmesi varsa, hangi
    // kuralın önceliği daha yüksek olursa olsun, DENY her zaman kazanır.
    // `Array.prototype.sort` kararlı (stable, ES2019) olduğundan, her
    // kategori içinde bulunan İLK eşleşme yine en yüksek öncelikli olandır
    // (eşitlikte kayıt sırası korunur) — çakışmayan (non-conflicting) ALLOW
    // durumları için önceki determinist davranış aynen korunur.
    let denyMatch: { readonly rule: string } | null = null;
    let bestNonDeny: { readonly decision: PolicyDecision; readonly rule: string } | null = null;

    for (const rule of ordered) {
      const result = rule.evaluate(action);
      if (result === null) continue;
      if (result === "DENY") {
        if (denyMatch === null) denyMatch = { rule: rule.name };
      } else if (bestNonDeny === null) {
        bestNonDeny = { decision: result, rule: rule.name };
      }
    }

    let decision: PolicyDecision;
    let matchedRule: string;
    if (denyMatch !== null) {
      decision = "DENY";
      matchedRule = denyMatch.rule;
    } else if (bestNonDeny !== null) {
      decision = bestNonDeny.decision;
      matchedRule = bestNonDeny.rule;
    } else {
      decision = "DENY"; // default deny (baseline section 147)
      matchedRule = "default-deny";
    }

    // Risk-5 eylemler (üretime dağıtım, yıkıcı DB işlemleri, gizli anahtar
    // değişikliği vb.) hiçbir zaman doğrudan ALLOW alamaz — bölüm 146, 147
    // gereği en az APPROVAL_REQUIRED döner. AMA bu, "aksi halde YASAK olan
    // bir eylemi onaylanabilir hale getiren" bir mekanizma DEĞİLDİR: bu
    // yükseltme yalnızca kararın zaten DENY olmadığı durumlarda uygulanır.
    // Açık bir DENY kuralı — önceliği ne olursa olsun — HER ZAMAN kazanır;
    // risk-5 kontrolü bunun üzerine bindirilen ek bir kısıtlamadır, bir
    // geçersiz kılma değil (bölüm 241, DENY en yüksek önceliğe sahiptir).
    const explicitDeny = denyMatch !== null;
    if (action.risk >= 5 && decision !== "APPROVAL_REQUIRED" && !explicitDeny) {
      decision = "APPROVAL_REQUIRED";
      matchedRule = RISK_5_APPROVAL_RULE_NAME;
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
