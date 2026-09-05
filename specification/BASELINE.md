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
  Factory Doctor, baseline status reporting. *In progress — see CHANGELOG.md
  and `specification/requirements/` for current, honestly-scoped status.*
- **P1 — General software/business platform**: not started.
- **P2 — Digital production (games, 3D, AI/ML, data, GPU)**: not started.
- **P3 — Universal/advanced operations**: not started.

Run `factory baseline status` (once the CLI is built) for a machine-computed
coverage report rather than relying on prose claims.
