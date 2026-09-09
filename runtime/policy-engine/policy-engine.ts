// Baseline section 148 (Policy Engine) + 241 (Policy Conflict Resolver).
// Bu modül, Factory içindeki her eylemi ALLOW / DENY / APPROVAL_REQUIRED
// olarak sınıflandıran merkezi karar noktasıdır. Öncelik sırası bölüm 241'de
// tanımlıdır: güvenlik/yasal engelleyiciler > üretim bütünlüğü > kurucunun
// onayladığı iş politikası > maliyet optimizasyonu > kullanım kolaylığı.
// Politika motoru olmadan hiçbir riskli eylem doğrudan yürütülemez
// (bölüm 147, "capability gateway" bu motorun önüne geçemez).

import { AuditLog } from "../audit/audit-log.js";
import { freezeRecord } from "../util/immutable.js";

export type PolicyDecision = "ALLOW" | "DENY" | "APPROVAL_REQUIRED";

export type RiskLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface PolicyAction {
  readonly actionType: string;
  readonly risk: RiskLevel;
  readonly description: string;
  readonly costUsd?: number;
  /**
   * P1 fix (25th independent review round, "approval must be bound to
   * complete action identity"): project/scope and actor/caller identity,
   * where present, are now first-class parts of an action's identity —
   * `CapabilityGateway.authorize()`'s approval-binding check compares
   * these (bkz. gateway.ts) so an approval scoped to one project/actor can
   * never authorize a materially different action just because
   * `actionType`/`description`/`risk`/`costUsd` happen to match.
   */
  readonly projectId?: string;
  readonly actorId?: string;
  /**
   * P1 fix (34th independent review round, findings 3 & 4, "approval
   * evidence not bound to immutable exact action identity"): `actionType`/
   * `risk`/`description`/`costUsd`/`projectId`/`actorId` are the FULL
   * identity `CapabilityGateway.authorize()`'s approval-binding check
   * (`isBoundToExactAction()`, bkz. capability-gateway/gateway.ts) is able
   * to compare — but several call sites need MORE dimensions bound into
   * that identity than this shared interface should hardcode by name
   * (e.g. `models/gateway.ts`'s `model.invoke` needs taskId/runId/agentId/
   * provider/modelId/prompt all bound; its `model.provider.replace` needs
   * the CANDIDATE implementation's own identity bound). Rather than
   * growing `PolicyAction` with an ever-longer list of action-type-specific
   * named fields (most of which would be meaningless for most OTHER action
   * types), this single opaque field lets a caller fold EVERY extra
   * dimension its own action type cares about into one caller-computed
   * digest (a stable hash over exactly those authoritative, already-
   * snapshotted values — bkz. `models/gateway.ts`'s `identityDigestOf()`)
   * — compared for EXACT equality by `isBoundToExactAction()` exactly like
   * every other field here. An approval requested for one digest can never
   * satisfy a materially different one, however similar the generic
   * `description` two such actions might otherwise share.
   */
  readonly identityDigest?: string;
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

/**
 * P1 fix (26th independent review round, finding 4, "reject invalid risk
 * values before policy evaluation"): `PolicyAction.risk`'s TypeScript type
 * (`RiskLevel = 0|1|2|3|4|5`) only constrains code the compiler can see —
 * it does nothing for a `PolicyAction` built from runtime/deserialized
 * input (a JSON-parsed request body, a persisted-then-restored action, or
 * any `as PolicyAction` type assertion), where `risk` can legally be ANY
 * JS value at runtime. Codex reproduced: `risk: -1` satisfies
 * `lowRiskAllowRule`'s `action.risk <= maxRisk` comparison (`-1 <= 2` is
 * `true`) and receives ALLOW — an action whose risk was never actually a
 * valid level slipping through the CHEAPEST, least-scrutinized rule in the
 * system. The SAME class of bug affects every OTHER rule a caller might
 * register: a `NaN`/`Infinity`/fractional/out-of-range/non-numeric `risk`
 * makes numeric comparisons behave unpredictably (`NaN <= x` is always
 * `false`, silently defeating a LOW-risk allow rule but NOT restoring the
 * risk-5-requires-approval floor below, since `authoritativeAction.risk >=
 * 5` is ALSO `false` for `NaN`) — no rule can be trusted to reason
 * correctly about a value that was never actually validated to be a real
 * risk level in the first place. Fixed: `risk` is validated to be a genuine
 * integer 0-5 inclusive BEFORE the authoritative action snapshot is even
 * built, so NO rule — not even the very first one evaluated — ever
 * observes an invalid `risk`. Fail closed (baseline section 147): an
 * invalid `risk` throws immediately rather than being coerced, clamped, or
 * silently treated as any particular decision.
 */
export class InvalidRiskLevelError extends Error {
  constructor(risk: unknown) {
    super(
      `Invalid risk level: ${typeof risk === "number" ? risk : JSON.stringify(risk)} (typeof ${typeof risk}). ` +
        `A PolicyAction's risk must be an integer 0-5 inclusive (baseline section 148, "Policy Engine") — ` +
        `negative numbers, values above 5, fractions, NaN, Infinity, strings, null, undefined, and any other ` +
        `non-integer value are all rejected BEFORE any policy rule runs, so no rule can be tricked into ` +
        `misjudging an action whose risk was never actually valid.`
    );
    this.name = "InvalidRiskLevelError";
  }
}

function assertValidRiskLevel(risk: unknown): asserts risk is RiskLevel {
  if (typeof risk !== "number" || !Number.isInteger(risk) || risk < 0 || risk > 5) {
    throw new InvalidRiskLevelError(risk);
  }
}

const VALID_POLICY_DECISIONS: ReadonlySet<string> = new Set<PolicyDecision>(["ALLOW", "DENY", "APPROVAL_REQUIRED"]);

/**
 * P1 fix (28th independent review round, finding 2, "reject invalid
 * policy-rule decisions"): `PolicyRule.evaluate()`'s TypeScript return type
 * (`PolicyDecision | null`) only constrains code the compiler can see — a
 * `PolicyRule` is arbitrary, caller-registered code (`addRule()`, possibly
 * loaded from a plugin or deserialized configuration), and nothing at
 * runtime stops its `evaluate()` from returning a typo'd string (`"ALOW"`),
 * an unrelated string, an object, a number, or any other malformed value.
 * Before this fix, `evaluate()`'s loop treated ANY non-null, non-`"DENY"`
 * result as `bestNonDeny` — including a value that is not a genuine
 * `PolicyDecision` at all — and returned it verbatim as
 * `PolicyEvaluationResult.decision`. Codex reproduced the real
 * consequence: `CapabilityGateway.authorize()` only branches on
 * `result.decision === "DENY"` and `=== "APPROVAL_REQUIRED"`; a decision of
 * `"ALOW"` (or any other malformed value) matches NEITHER branch and falls
 * through to unconditionally calling `execute()` — a single typo or
 * malformed plugin result in a rule silently ALLOWS an action that was
 * never genuinely decided ALLOW by anything, the exact opposite of
 * default-deny (baseline section 147). Fixed: every non-null rule result is
 * validated against the authoritative `PolicyDecision` enum THE MOMENT the
 * rule returns it — before it can influence `denyMatch`/`bestNonDeny` at
 * all — and an invalid result throws `InvalidPolicyDecisionError`
 * immediately, fail closed, naming the offending rule so the caller can
 * find and fix it.
 */
export class InvalidPolicyDecisionError extends Error {
  constructor(ruleName: string, decision: unknown) {
    super(
      `Policy rule '${ruleName}' returned an invalid decision: ${
        typeof decision === "string" ? JSON.stringify(decision) : String(decision)
      } (typeof ${typeof decision}). A PolicyRule.evaluate() must return exactly "ALLOW", "DENY", ` +
        `"APPROVAL_REQUIRED", or null (baseline section 148, "Policy Engine") — any other value is rejected ` +
        `BEFORE it can influence any authorization decision, so a typo'd or malformed plugin result can never ` +
        `silently fall through to an unintended ALLOW.`
    );
    this.name = "InvalidPolicyDecisionError";
  }
}

function assertValidPolicyDecision(ruleName: string, decision: unknown): asserts decision is PolicyDecision {
  if (typeof decision !== "string" || !VALID_POLICY_DECISIONS.has(decision)) {
    throw new InvalidPolicyDecisionError(ruleName, decision);
  }
}

export class PolicyEngine {
  /**
   * P1 targeted-audit fix (26th independent review round, same root class
   * as finding 2, "cost ledger state must be runtime-private"): this array
   * used to be declared with TypeScript's compile-time-only `private` — in
   * the emitted JS it is an ordinary, enumerable instance property. Since
   * `rules` IS the entire default-deny enforcement surface (bölüm 147:
   * "Politika motoru olmadan hiçbir riskli eylem doğrudan yürütülemez"),
   * `(engine as any).rules.length = 0` or `.push(alwaysAllowRule)` from any
   * caller holding a `PolicyEngine` reference would silently strip every
   * registered DENY rule or inject a rule that always wins — defeating the
   * single most important P0 guarantee with no trace in `evaluate()`
   * itself. A genuine ECMAScript private field (`#rules`) closes this the
   * same way `approval.ts`'s `#requests` already does for approval state.
   */
  #rules: PolicyRule[] = [];

  /**
   * P1 targeted-audit fix (28th independent review round, root-class B
   * sweep, "TypeScript private used for authoritative mutable state" —
   * same class as `#rules` above): still declared with TypeScript's
   * compile-time-only `private` — `(engine as any).auditLog = fakeAuditLog`
   * from any caller holding a `PolicyEngine` reference would silently
   * swap out the ENTIRE audit trail this engine records every evaluation
   * into (bkz. `evaluate()`'s `this.auditLog.append(...)` below and the
   * `auditTrail` getter), letting every subsequent policy decision go
   * completely unrecorded with no trace of the swap — directly undermining
   * "no claim without evidence" (bölüm 303) for the single most important
   * P0 decision surface. Fixed the same way `#rules` already is.
   */
  #auditLog: AuditLog;

  constructor(auditLog: AuditLog = new AuditLog()) {
    this.#auditLog = auditLog;
  }

  /**
   * P1 fix (27th independent review round, finding 2, "detach registered
   * policy rules"): `addRule()` used to push the caller's OWN `PolicyRule`
   * object reference directly into `#rules`. Even with `#rules` itself now
   * genuinely runtime-private (26th round), the individual rule OBJECTS
   * inside it remained the exact same objects the caller still held a
   * reference to — `rule.priority = Number.MAX_SAFE_INTEGER` after
   * registration would retroactively promote a rule to always sort first
   * (`ordered = [...this.#rules].sort(...)` re-reads `priority` on every
   * `evaluate()` call, never a value captured at registration time), and
   * `rule.evaluate = () => "ALLOW"` would silently replace a registered
   * DENY rule's entire decision logic with an always-ALLOW after the fact
   * — defeating default-deny (bölüm 147) without ever calling `addRule()`
   * again. Fixed: `addRule()` now stores `freezeRecord({ ...rule })` — an
   * independent, frozen copy — so the caller's original `rule` object is
   * never the one consulted; mutating `priority` or `evaluate` on the
   * caller's own reference after registration has no effect on the
   * engine's behavior. `evaluate` itself is a function VALUE (like `name`
   * or `priority`, an ordinary copied property) — freezing the copy
   * prevents REPLACING which function is called, though the underlying
   * function object's own closed-over behavior is unrelated, caller-
   * authored logic outside this engine's control either way.
   */
  addRule(rule: PolicyRule): void {
    this.#rules.push(freezeRecord({ ...rule }));
  }

  get auditTrail(): AuditLog {
    return this.#auditLog;
  }

  /**
   * P1 fix (25th independent review round, "policy actions must be
   * snapshotted before rule evaluation"): `action` used to be passed
   * DIRECTLY (the caller's own, mutable object reference) to EVERY
   * `rule.evaluate(action)` call in the loop below. A `PolicyRule` is
   * arbitrary, caller-registered code (`addRule()`) — nothing stops one
   * rule's `evaluate()` from mutating `action.actionType`/`.risk`/
   * `.description`/`.costUsd` as a SIDE EFFECT of running (whether
   * maliciously, or just a careless implementation that "normalizes" the
   * action in place) before a LATER, higher-priority-ORDERED-but-still-
   * evaluated `DENY` rule runs — since this loop deliberately never
   * `break`s early (bkz. bu dosyanın "higher-priority ALLOW bypasses
   * matching DENY" fix notu), an EARLIER-registered ALLOW rule mutating
   * `action.actionType` from `"secret-mutation"` to `"read-file"` BEFORE
   * a DENY rule that specifically matches `"secret-mutation"` runs would
   * make that DENY rule silently evaluate the WRONG (mutated) action and
   * never match at all — DENY's supposed-to-be-absolute precedence
   * (bölüm 241) defeated not by priority ordering (already fixed) but by
   * the shared mutable object every rule receives. Fixed: `action` is
   * copied into a frozen, detached `authoritativeAction` (`freezeRecord`)
   * as the VERY FIRST thing `evaluate()` does — before ANY rule runs —
   * and `authoritativeAction` (never the original `action` parameter) is
   * what every rule receives, what is audited, and what is returned in
   * `PolicyEvaluationResult.action`. A rule attempting
   * `action.actionType = "x"` on the object IT was handed now throws
   * `TypeError` (frozen) instead of silently succeeding; even a rule that
   * mutates the ORIGINAL caller-owned `action` object it somehow still
   * holds a separate reference to (e.g. closed over it beforehand) cannot
   * reach `authoritativeAction`, since it is an independent copy, not a
   * reference to the same object.
   */
  evaluate(action: PolicyAction): PolicyEvaluationResult {
    // P1 fix (27th independent review round, finding 1, "snapshot risk
    // before validating it"): the previous order was `assertValidRiskLevel
    // (action.risk)` FIRST, then `freezeRecord({ ...action })` SECOND — two
    // SEPARATE reads of `action`'s properties (including `risk`). If
    // `action` is a Proxy or has a `risk` getter, nothing requires it to
    // return the SAME value both times: it could return a valid `0` for
    // the validation read, then an invalid (or merely DIFFERENT) value for
    // the snapshot read one line later — validation would pass against a
    // value that never actually ends up in `authoritativeAction`, while
    // the REAL value baked into the snapshot every rule below evaluates
    // against was never validated at all. Fixed: the object spread — which
    // reads every one of `action`'s own enumerable properties exactly
    // ONCE via `[[Get]]`, copying each into a genuine, static data
    // property on a NEW plain object — now runs FIRST, producing
    // `authoritativeAction` BEFORE any validation. `assertValidRiskLevel`
    // then runs against `authoritativeAction.risk`, a value that is no
    // longer a getter/Proxy trap at all (it is a real, frozen own
    // property), so every subsequent read anywhere in this method sees the
    // exact SAME value that was validated — there is no second read left
    // for a hostile getter to answer differently. `action` itself (the
    // caller's original, possibly getter-backed object) is never read
    // again after this one spread.
    const authoritativeAction: PolicyAction = freezeRecord({ ...action });
    assertValidRiskLevel(authoritativeAction.risk);
    const ordered = [...this.#rules].sort((a, b) => b.priority - a.priority);

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
      const result: unknown = rule.evaluate(authoritativeAction);
      if (result === null) continue;
      assertValidPolicyDecision(rule.name, result);
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
    if (authoritativeAction.risk >= 5 && decision !== "APPROVAL_REQUIRED" && !explicitDeny) {
      decision = "APPROVAL_REQUIRED";
      matchedRule = RISK_5_APPROVAL_RULE_NAME;
    }

    this.#auditLog.append({
      type: "POLICY_DECISION",
      actor: "policy-engine",
      payload: { action: authoritativeAction, decision, matchedRule },
      timestamp: new Date().toISOString()
    });

    return { decision, matchedRule, action: authoritativeAction };
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
