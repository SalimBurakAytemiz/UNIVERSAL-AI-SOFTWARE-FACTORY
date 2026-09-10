# Baseline Requirement Registry

Machine-readable requirements traced back to
[`UNIVERSAL-AI-SOFTWARE-FACTORY-BASELINE-V1.md`](../UNIVERSAL-AI-SOFTWARE-FACTORY-BASELINE-V1.md),
per baseline section 293. Every record is validated against
[`schemas/requirement.schema.json`](../../schemas/requirement.schema.json) in CI
(`npm run validate:requirements`).

## Scope of this initial batch

The baseline document contains 323 sections describing an enormous system
(business capability registries, game/3D/robotics studios, full FinOps,
compliance packs, and so on). Decomposing every section into an individually
tracked `UASF-REQ-####` is real work that has **not** been completed in this
pass — doing so honestly (with correct dependencies, categories, and without
duplicate/renumbered IDs) is itself a P0-adjacent task for a follow-up
session.

What **is** here: every requirement listed under baseline section 304's
**P0 — Factory Kernel** phase, which is the phase the baseline itself says
must be genuinely working before anything else is attempted. See
[`P0-factory-kernel.yml`](./P0-factory-kernel.yml).

Requirements for P1/P2/P3 sections remain defined only in prose, inside the
baseline document itself, until a future session assigns them stable IDs.
Do not treat their absence here as deletion or weakening of the baseline —
per section 303 ("no claim without evidence") the correct reading is
"not yet decomposed", not "not required".

## Files

- `P0-factory-kernel.yml` — array of requirement records for the P0 phase.

## Updating status

A requirement's `status` may only move forward when the referenced
`implementation_refs` / `test_refs` / `proof_refs` actually exist in the
repository at the commit where the change is made. CI's
`scripts/validate-requirements.mjs` enforces schema shape; it does not (yet)
verify that referenced paths exist — that check is future work
(see baseline section 297, Baseline Drift Detection).
