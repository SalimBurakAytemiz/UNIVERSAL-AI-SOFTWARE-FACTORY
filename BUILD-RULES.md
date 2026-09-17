# Build Rules

## 1. One phase contract at a time

Do not implement future phases simply because their folders exist.

## 2. Milestone unit

Prefer a coherent milestone containing related implementation + tests + docs + evidence + Desktop visibility, not dozens of tiny AI prompts.

## 3. Build sequence

INSPECT RELEVANT STATE -> DESIGN DELTA -> IMPLEMENT -> TARGETED TEST -> REQUIRED REGRESSION -> LINT -> TYPECHECK -> BUILD -> SCHEMA/REGISTRY VALIDATION -> SECURITY/SECRET CHECK -> EVIDENCE -> TURKISH DOCS -> DESKTOP VISIBILITY -> `.ai` CHECKPOINT -> COMMIT.

## 4. Git discipline

- Git is source of truth.
- Keep the independent review target stable.
- Do not change the reviewed commit while Codex is reviewing it.
- Do not silently rewrite canonical history.
- Use branches/worktrees when concurrent work genuinely requires them.

## 5. Scope discipline

- Full repo scan is not default.
- Start from current `.ai` state, milestone, git diff, changed files and direct dependencies.
- New unrelated ideas go to backlog/future phase.
- Do not keep a milestone open for speculative hardening outside its contract.

## 6. No fake implementation

A directory, registry record or prompt is not implementation.
Runtime + tests + evidence are required for implemented status.

## 7. Desktop visibility

If a subsystem has operational state, failures, cost, approvals or Founder-relevant decisions, expose appropriate status through Control API/Desktop as soon as its phase requires it.

## 8. Turkish teaching standard

Canonical technical identifiers remain English. Non-trivial source logic includes useful Turkish comments, especially authority/security/cost/concurrency/persistence/evidence/retry/recovery. Founder-facing operational docs are Turkish.

## 9. Cost/context discipline

- Script first for deterministic tasks.
- No repeated full scans of unchanged commit.
- No giant master prompt repeated every session.
- Update checkpoint then start a fresh session when context grows.
- Codex is for independent judgment, not routine grep/lint/schema work.

## 10. Closure

Claude can mark implementation as READY_FOR_INDEPENDENT_REVIEW when required local checks pass.
Claude cannot author independent CLEAN evidence for itself.
