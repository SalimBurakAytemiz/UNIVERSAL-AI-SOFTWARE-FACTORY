# Next Actions

1. Milestone 1.1 implementation proposed: requirement registry, invariant registry, policy registry, ADR log, traceability matrix, baseline version and Implementation Reality Matrix under `specification/`, plus `specification/validate-registries.mjs` for deterministic cross-reference validation.
2. Run `npm run validate:specification` together with the existing lint/typecheck/test/build checks to confirm the registries are internally consistent before requesting independent review.
3. Keep requirement/invariant traceability current as later phases add or change requirements/invariants.
4. Intervene only if state becomes `FOUNDER_ATTENTION_REQUIRED`.
