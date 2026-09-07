# Baseline Status

| Field | Value |
|---|---|
| Name | Universal AI Technology Factory Architecture Baseline V1 |
| Document | [UNIVERSAL-AI-SOFTWARE-FACTORY-BASELINE-V1.md](./UNIVERSAL-AI-SOFTWARE-FACTORY-BASELINE-V1.md) |
| Status | **FROZEN** |
| Authority | `@SalimBurakAytemiz` (Human Founder) |
| Frozen at commit | see `git log --follow specification/BASELINE.md` |
| Annotated tag | `architecture-baseline-v1` |

## What "FROZEN" means here

The specification text is preserved verbatim and will not be silently edited,
weakened, or have requirements removed. Material changes after freeze must
follow the Architecture Change Governance process (baseline section 298):
Proposal → Research → ADR → Impact Analysis → Requirement/Security/QA Impact →
Migration Plan → Founder Decision. See `future-proposals/` for the intake point.

## What "FROZEN" does NOT mean

It does **not** mean the 323-section system described in the baseline is
implemented. The baseline is a specification of intent, not a completion
claim. Per the baseline's own constitutional rule (section 303, "NO CLAIM
WITHOUT EVIDENCE"), implementation status must always be checked against
`specification/requirements/` and the evidence recorded there (implementation
refs, test refs, proof refs) — never assumed from the specification's
existence.

## Implementation phasing (baseline section 304)

Implementation proceeds in phases and P0 must be genuinely green before
being declared complete:

- **P0 — Factory Kernel**: baseline preservation, requirement registry, CLI,
  schemas, Model Gateway + MockProvider + cheapest-capable-model routing,
  Cost Engine + budgets, Policy Engine, cache/reuse layer, durable state,
  Factory Doctor, baseline status reporting. *BLOCKED_PENDING_REVIEW — the
  twentieth independent (Codex) closure review's CLEAN result (commit
  `e1b440f`) is not currently authoritative. Independent reviews since
  then have found and this branch has fixed: a 21st-round P2 fail-open/
  liveness defect in `runtime/cache/file-lock.ts`'s stale-lock reclaim/
  acquisition-retry loop; a 22nd-round P2 defect in the same file's
  metadata-parsing path (malformed owner metadata misclassified as a
  confirmed-live owner); and, in a 23rd round, a fresh full-branch review
  found NINE further actionable findings (5 P1, 4 P2) fixed as one
  consolidated batch: a path-traversal risk in the same file's reclaim-
  token handling; unquoted secret assignments evading the secret
  scanner; persisted-state restore paths in the Assumption Register and
  Founder Decision Ledger bypassing their own domain invariants; a
  bootstrap flow recording fabricated model spend and reserving budget
  only after (not before) an irreversible filesystem mutation; an
  out-of-range PID accepted as a confirmed-live lock owner; a blank
  founder-confirmation identity accepted as valid; a schema/runtime
  contract mismatch for model records; and a missing REQUEST_CHANGES
  approval decision. All fixed and regression-tested on branch
  `claude/ai-factory-baseline-v1-seawq7`. P0 status remains
  BLOCKED_PENDING_REVIEW until an independent review confirms
  INDEPENDENT_REVIEW_RESULT: CLEAN. See `project-state/current.yml`'s
  `p0_closure_record` and `p0_status`/`blockers` narrative for the full,
  honest history of every prior round (the twentieth round's CLEAN
  result and this session's own direct re-verification of it are
  preserved there, not erased — only its finality is revoked) and
  `specification/requirements/` for the per-requirement status. This is
  a scope/evidence statement for P0 only; it does not imply main has
  been merged or that P1 has begun — see `project-state/current.yml` for
  current merge/P1 status.*
- **P1 — General software/business platform**: not started.
- **P2 — Digital production (games, 3D, AI/ML, data, GPU)**: not started.
- **P3 — Universal/advanced operations**: not started.

Run `factory baseline status` (once the CLI is built) for a machine-computed
coverage report rather than relying on prose claims.
