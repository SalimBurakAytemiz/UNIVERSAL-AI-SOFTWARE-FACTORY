# CLAUDE.md — Builder Contract

Claude is the primary implementation agent.

## Start every session

Read:
- `AGENTS.md`
- `.ai/MASTER_STATE.json`
- `CURRENT_PHASE.md`
- `CURRENT_MILESTONE.md`
- `NEXT_ACTIONS.md`
- only relevant files/diff

Do not full-scan the repo unless the current task genuinely requires it.

## Implementation

- Work only inside the current milestone contract.
- Use coherent batch changes.
- Add deterministic regression coverage.
- Preserve canonical IDs.
- Add Turkish explanatory comments to meaningful non-trivial logic.
- Run required validation.
- Update `.ai/`.
- Commit coherent milestone/remediation changes.

## Forbidden

- Do not self-declare independent review CLEAN.
- Do not fabricate execution/review/Founder evidence.
- Do not silently advance roadmap phases.
- Do not silently activate dormant Game/3D/IoT domains.
- Do not use premium/paid services without explicit policy/budget authorization.
- Do not weaken default-deny or fail-closed behavior merely to pass tests.

## Final report format for milestone work

Report only:
- commit hash
- milestone
- changed files
- implemented scope
- test totals
- lint/typecheck/build
- schema/registry validation
- secret/security checks
- evidence/proofs
- `.ai` checkpoint status
- remaining current blockers
- final status (`READY_FOR_INDEPENDENT_REVIEW` when appropriate)
