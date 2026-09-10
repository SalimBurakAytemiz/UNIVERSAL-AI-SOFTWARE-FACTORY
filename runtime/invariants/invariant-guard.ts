// Baseline section 147/294/303/317 (Constitutional rules) hardening,
// 35th independent review round governance mechanism (1 of 4): a Central
// Invariant Guard. Across 34 prior independent review rounds this Factory's
// own P0 kernel has been hardened to uphold a specific, growing set of
// invariants (default-deny, no claim without evidence, ...). Until now
// every NEW governance action (locking a phase for closure, closing it,
// overriding a status) would have had to reinvent its own ad hoc "is this
// safe?" check. This module is a single, central place those invariants
// are declared ONCE, as machine-checkable predicates, so every governance
// mechanism added this round (Scope Lock, Phase Closure Manifest) is
// REQUIRED to run the same gate rather than trusting a bare "tests passed"
// claim.
//
// This is deliberately NOT a duplicate test suite or a duplicate evidence
// subsystem (baseline section 303's own "no claim without evidence" would
// forbid exactly that): every invariant defined by `createDefaultInvariantGuard()`
// below reuses the EXISTING authoritative requirement loader
// (`runtime/cli/commands/baseline-status.ts`'s `loadRequirementsFromDir()`)
// and traceability module (`runtime/requirements-traceability/traceability.ts`'s
// `detectTraceabilityIssues()`) as its evidence source, and exercises the
// REAL exported `PolicyEngine` class for the default-deny check — it never
// re-derives "is the registry clean?" or "does default-deny hold?"
// independently.

import { PolicyEngine } from "../policy-engine/policy-engine.js";
import { loadRequirementsFromDir, type RequirementRecord } from "../cli/commands/baseline-status.js";
import { adaptRequirementRecord, detectTraceabilityIssues } from "../requirements-traceability/traceability.js";
import { deepFreezeClone, freezeRecord } from "../util/immutable.js";

export type InvariantSeverity = "BLOCKING" | "WARNING";

export interface InvariantCheckResult {
  readonly satisfied: boolean;
  readonly detail: string;
}

export interface InvariantDefinition {
  readonly id: string;
  readonly description: string;
  readonly severity: InvariantSeverity;
  check(): InvariantCheckResult;
}

export interface InvariantViolation {
  readonly invariantId: string;
  readonly description: string;
  readonly severity: InvariantSeverity;
  readonly detail: string;
}

export interface InvariantGuardReport {
  readonly allBlockingSatisfied: boolean;
  readonly evaluatedAt: string;
  readonly violations: readonly InvariantViolation[];
}

export class DuplicateInvariantIdError extends Error {
  constructor(id: string) {
    super(
      `Invariant id '${id}' is already registered. Each invariant must have a permanent, unique identity so a ` +
        `violation report can always be traced back to exactly one declared rule.`
    );
    this.name = "DuplicateInvariantIdError";
  }
}

export class InvariantGuard {
  /**
   * Genuine ECMAScript private field, not TypeScript's compile-time-only
   * `private` — same reasoning this codebase has applied consistently
   * since the 25th/26th independent review rounds (bkz. `policy-engine.ts`'s
   * `#rules`, `decisions/decision-ledger.ts`'s `#decisions`): a governance
   * gate's OWN registered rule set is exactly the kind of authoritative
   * state that must never be reachable for silent mutation by a caller
   * holding a reference to this guard (`(guard as any).invariants.clear()`
   * would otherwise let a caller strip every registered check with no
   * trace, defeating the entire point of a CENTRAL guard).
   */
  #invariants = new Map<string, InvariantDefinition>();

  /**
   * P1 fix (independent Codex review, "preserve prototype invariant checks
   * during registration"): `freezeRecord({ ...def })` below (this method's
   * own prior "detach the caller's own definition object" fix) copies only
   * `def`'s OWN ENUMERABLE properties — a CLASS-based `InvariantDefinition`
   * (`class SomeInvariant implements InvariantDefinition { check() { ... }
   * }`) defines `check` on `SomeInvariant.prototype`, never as an own
   * instance property, so `{ ...def }.check` is `undefined` and the frozen
   * copy actually stored has NO checker at all — `runAll()` below would
   * throw `TypeError: definition.check is not a function` the moment this
   * invariant runs, silently breaking every legitimate class-based
   * `InvariantDefinition` (the SAME root cause `policy-engine.ts`'s
   * `addRule()` had for class-based `PolicyRule`s — bkz. o dosyanın fix
   * notu). Fixed the identical way: `id`/`description`/`severity` are read
   * explicitly (still detached from later caller mutation), and `check` is
   * captured via `def.check.bind(def)` — an own, callable, bound value that
   * survives being copied into a plain object and keeps working correctly
   * if the checker legitimately reads its own `this` state.
   */
  register(def: InvariantDefinition): void {
    if (this.#invariants.has(def.id)) {
      throw new DuplicateInvariantIdError(def.id);
    }
    this.#invariants.set(
      def.id,
      freezeRecord({
        id: def.id,
        description: def.description,
        severity: def.severity,
        check: def.check.bind(def)
      })
    );
  }

  list(): readonly InvariantDefinition[] {
    return [...this.#invariants.values()];
  }

  /**
   * Runs every registered invariant and returns a single report. A
   * `BLOCKING` violation means `allBlockingSatisfied` is false — callers
   * (Scope Lock's `lock()`/Phase Closure Manifest's `attemptPhaseClosure()`)
   * treat that exactly like `PolicyDecision === "DENY"`: the governance
   * action does not proceed. A `WARNING` violation is recorded but never
   * blocks anything on its own.
   */
  runAll(): InvariantGuardReport {
    const violations: InvariantViolation[] = [];
    for (const def of this.#invariants.values()) {
      const result = def.check();
      if (!result.satisfied) {
        violations.push({
          invariantId: def.id,
          description: def.description,
          severity: def.severity,
          detail: result.detail
        });
      }
    }
    // `violations` is an array of nested objects (not plain strings), so
    // freezeRecord's shallow, array-only freeze (bkz. immutable.ts'in kendi
    // notu — bu tam olarak bu turun 1. ve 10. düzeltmelerinin kök nedeniydi)
    // would freeze the array but leave each violation object itself
    // mutable. deepFreezeClone is used here instead, same precedent as
    // audit-log.ts's own append()/all() (bkz. o dosyanın notu).
    return deepFreezeClone({
      allBlockingSatisfied: !violations.some((v) => v.severity === "BLOCKING"),
      evaluatedAt: new Date().toISOString(),
      violations
    });
  }
}

/**
 * The default, narrow set of invariants this round wires up. Each one
 * reuses an EXISTING authoritative primitive rather than re-implementing
 * its own notion of "clean" — see this module's own top-of-file note.
 */
export function createDefaultInvariantGuard(requirementsDir: string, rootDir: string): InvariantGuard {
  const guard = new InvariantGuard();

  guard.register({
    id: "requirement-registry-loads-cleanly",
    description:
      "The authoritative requirement registry must load without schema, structural, or duplicate-id errors " +
      "before any governance action relies on it (baseline section 280, 303).",
    severity: "BLOCKING",
    check(): InvariantCheckResult {
      try {
        loadRequirementsFromDir(requirementsDir);
        return { satisfied: true, detail: "registry loaded and schema-valid" };
      } catch (err) {
        return { satisfied: false, detail: err instanceof Error ? err.message : String(err) };
      }
    }
  });

  guard.register({
    id: "no-unsupported-evidence-claims",
    description:
      "Every requirement claiming progress must be backed by real, resolvable evidence — no orphan status " +
      "claims (baseline section 294, 'no unsupported upgrades', and 303, 'no claim without evidence').",
    severity: "BLOCKING",
    check(): InvariantCheckResult {
      let records: RequirementRecord[];
      try {
        records = loadRequirementsFromDir(requirementsDir);
      } catch (err) {
        return {
          satisfied: false,
          detail: `cannot evaluate — registry failed to load: ${err instanceof Error ? err.message : String(err)}`
        };
      }
      const traceable = records.map((record) =>
        adaptRequirementRecord(
          record as unknown as {
            readonly id: string;
            readonly status: string;
            readonly implementation_refs?: readonly string[];
            readonly test_refs?: readonly string[];
            readonly proof_refs?: readonly string[];
          }
        )
      );
      const issues = detectTraceabilityIssues(traceable, rootDir);
      if (issues.length === 0) {
        return { satisfied: true, detail: `${records.length} requirement(s) checked, no unsupported evidence claims` };
      }
      return {
        satisfied: false,
        detail:
          `${issues.length} unsupported evidence claim(s): ` +
          issues.map((i) => `${i.requirementId} (${i.status}): ${i.issue}`).join("; ")
      };
    }
  });

  guard.register({
    id: "policy-engine-default-deny",
    description:
      "A PolicyEngine with no matching rule must deny an action outright, never silently allow it (baseline " +
      "section 147, 'default deny'). Exercises the REAL exported PolicyEngine class, not a re-derived check.",
    severity: "BLOCKING",
    check(): InvariantCheckResult {
      const engine = new PolicyEngine();
      const result = engine.evaluate({ actionType: "invariant-guard-probe", risk: 0, description: "probe" });
      if (result.decision === "DENY" && result.matchedRule === "default-deny") {
        return { satisfied: true, detail: "unmatched action correctly denied by default" };
      }
      return {
        satisfied: false,
        detail: `expected default-deny for an unmatched action, got decision='${result.decision}' matchedRule='${result.matchedRule}'`
      };
    }
  });

  return guard;
}
