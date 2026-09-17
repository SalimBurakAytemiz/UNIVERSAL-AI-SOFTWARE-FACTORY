# Automated Review Orchestrator

## Purpose

Remove manual copy/paste between Claude and Codex while preserving independent review, stable Git commits, bounded cost and Human Founder control.

The orchestrator coordinates:

CLAUDE BUILDER
→ DETERMINISTIC VALIDATION
→ STABLE COMMIT
→ CODEX INDEPENDENT REVIEW
→ STRUCTURED FINDINGS
→ CLAUDE REMEDIATION
→ NEW COMMIT
→ CODEX REVIEW
→ CLEAN / FOUNDER ATTENTION

Claude and Codex do not establish trust by chatting with each other. Git commits, structured findings, attestations, policy and the orchestrator form the control boundary.

## Core state machine

IMPLEMENTING
→ LOCAL_VALIDATION
→ READY_FOR_REVIEW
→ REVIEWING

If CLEAN:
REVIEWING
→ CLOSURE_VALIDATION
→ MILESTONE_READY_TO_CLOSE

If BLOCKED:
REVIEWING
→ REMEDIATION_REQUIRED
→ REMEDIATING
→ LOCAL_VALIDATION
→ NEW COMMIT
→ READY_FOR_REVIEW

If automation guard trips:
→ FOUNDER_ATTENTION_REQUIRED

## Required guarantees

- Review target commit is frozen and explicit.
- Claude does not modify the commit while Codex reviews it.
- An unchanged blocked commit is not automatically reviewed again.
- Remediation creates a new commit.
- Codex reviews the new commit, not stale work.
- Structured findings are preserved and auditable.
- Independent review evidence cannot be authored by the builder.
- Maximum automatic review cycles are bounded.
- Token/cost budgets are bounded.
- Critical authority/security/production transitions can require Founder approval.
- Full-repository scan is not default.
- Findings are deduplicated across cycles.

## Default review context

CURRENT MILESTONE
+
REVIEWED COMMIT
+
GIT DIFF
+
CHANGED FILES
+
DIRECT DEPENDENCIES
+
RELATED REQUIREMENTS
+
RELATED INVARIANTS
+
RELATED TESTS / EVIDENCE

Expand only when dependency or risk justifies it.

## Default remediation context

CURRENT REVIEW FINDINGS
+
AFFECTED FILES
+
RELATED TESTS
+
RELATED REQUIREMENTS / INVARIANTS

Do not resend the whole repository or giant master prompt.

## Structured review result

Example:

```json
{
  "reviewedCommit": "83f61ac",
  "result": "BLOCKED",
  "findings": [
    {
      "id": "REV-0001",
      "severity": "P1",
      "file": "runtime/policy-engine/approval.ts",
      "requirement": "UASF-REQ-0020",
      "summary": "Founder authority provenance can be bypassed",
      "reproduction": "...",
      "blocking": true
    }
  ]
}
```

CLEAN example:

```json
{
  "reviewedCommit": "83f61ac",
  "result": "CLEAN",
  "findings": []
}
```

## Cycle guard

Canonical initial default:

MAX_AUTOMATED_REVIEW_CYCLES = 3

After the limit:

AUTO LOOP STOPPED
→ FOUNDER_ATTENTION_REQUIRED

The Desktop must explain:
- current cycle
- reviewed commit
- remaining blockers
- accumulated review cost
- reason automation stopped

## Automation modes

### AUTOMATIC

Claude build
→ deterministic validation
→ Codex review
→ Claude remediation when blocked
→ Codex review of new commit

Low-risk development milestones may use this mode.

### SEMI_AUTOMATIC

System prepares the next transition but waits for Human Founder confirmation before starting review/remediation.

Recommended for:
- critical architecture
- security-sensitive boundaries
- expensive review packages

### MANUAL

No transition occurs automatically.

### Mandatory Founder approval

Automation never bypasses Founder authority for:
- Risk-5
- production destructive action
- critical spending
- irreversible migration
- critical security authority decision
- global kill switch controls

## Desktop representation

Desktop should expose:

AUTOMATED REVIEW LOOP
- Builder
- Reviewer
- Mode
- Current cycle / max cycles
- Current reviewed commit
- Status
- Current blockers
- Token/cost budget
- Pause
- Stop
- Require manual approval

## Suggested repository structure

```text
review-orchestrator/
├── controller/
├── builder/
│   └── claude-adapter/
├── reviewer/
│   └── codex-adapter/
├── validation/
├── review-context/
│   ├── git-diff/
│   ├── requirements/
│   ├── invariants/
│   └── tests/
├── findings/
│   ├── schema/
│   ├── parser/
│   ├── deduplication/
│   └── blocker-classifier/
├── remediation/
│   ├── prompt-builder/
│   └── task-builder/
├── cycles/
│   ├── limits/
│   ├── budget/
│   └── loop-guard/
├── attestations/
├── state/
└── audit/
```

## Roadmap placement

The architecture is specified from the beginning.

The first real implementation belongs inside **Phase 6 — Evidence, Provenance & Attestation Kernel**, after Control API, realtime events and early Desktop foundation exist.

Phase 6 therefore includes:
- trusted execution evidence
- trusted independent review attestation
- reviewed-commit binding
- review cycle state
- Codex reviewer adapter boundary
- Claude remediation adapter boundary
- bounded automated review loop
- structured findings
- loop/cost guards

Full Desktop review controls are expanded later with the Control Tower.

## Principle

The Human Founder should not be used as a copy/paste transport layer between AI systems.
Automation may transport work.
It may not transport authority.
