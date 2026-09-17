# AI Session & Token/Context Rules

## Source of truth

Repository + Git + `.ai/` state. Not chat history.

## Session boot order

1. `AGENTS.md`
2. model-specific file (`CLAUDE.md` or `CODEX.md`)
3. `.ai/MASTER_STATE.json`
4. `CURRENT_PHASE.md`
5. `CURRENT_MILESTONE.md`
6. `NEXT_ACTIONS.md`
7. only relevant specification/code/tests/diff

## Internal context checklist

Before asking a model to read broadly:

- Bu işi en az context ile nasıl yaptırırım?
- Aynı şeyi ikinci kez okutuyor muyuz?
- Script ile yapılabilecek şeyi modele mi yaptırıyoruz?
- Full repo scan gerçekten gerekli mi?
- Codex gerçekten gerekli mi?
- Görevler tek batch'te birleştirilebilir mi?
- Checkpoint güncel mi?
- Context şiştiyse yeni session açılmalı mı?

## Claude

Primary builder.
Can inspect, implement, test, document and update checkpoint.
Should use narrow context and coherent milestone batches.
Must not fabricate independent review evidence.

## Codex

Independent reviewer at milestone/phase boundaries or critical authority/security boundaries.
Start from reviewed commit + milestone contract + diff + related requirements/invariants.
Do not modify files during independent review unless explicitly switched to implementation mode.
Report reproducible current blockers only.

## ChatGPT

Architecture/control/roadmap/prompt orchestration and review interpretation.

## Deterministic tools

Lint, typecheck, build, schema validation, registry validation, test execution, secret scanning and similar deterministic checks should be scripts/CI where possible.

## Repeated review rule

Do not re-review an unchanged commit merely to rediscover already-confirmed blockers.
Fix confirmed blockers, create new commit, then review the new commit once.

## Context reset

When a session becomes large:
CHECKPOINT -> COMMIT/STATE UPDATE -> NEW SESSION -> READ CHECKPOINT -> CONTINUE.
