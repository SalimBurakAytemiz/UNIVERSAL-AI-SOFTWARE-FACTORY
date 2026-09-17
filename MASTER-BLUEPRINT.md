# UNIVERSAL AI SOFTWARE FACTORY — MASTER BLUEPRINT v4


---

# FILE: VERSION.md

# Startup Pack Version

Canonical startup package:

`v4-FULL-AUTO-GIT`

This package supersedes all earlier UASF startup ZIPs.

Key addition:
- Day-zero Claude → Codex → Claude automation
- automatic safe Git fetch / ff-only sync / commit verification / push / remote SHA verification
- automatic development branch creation
- automatic first baseline push to `main`
- no force-push / hard-reset / rebase automation
- automatic stop on local/remote divergence


---

# FILE: START-HERE.md

# START HERE — Tek Kullanılacak Paket

Bu paket `v4-FULL-AUTO-GIT` sürümüdür ve önceki startup ZIP'lerinin yerine geçer.

## Hedef

İlk günden itibaren rutin akış:

Claude
→ test/lint/typecheck/build
→ commit
→ GitHub'a otomatik push + SHA doğrulama
→ Codex review
→ blocker varsa Claude fix
→ yeni commit
→ GitHub push
→ Codex review
→ CLEAN
→ sonraki milestone

Sen arada çıktı taşımayacaksın ve rutin `git fetch / pull / push` yapmayacaksın.

## Bir kez yapacağın hazırlık

1. GitHub'da tamamen boş bir repository oluştur.
2. Repository'yi bilgisayarına clone et.
3. Bu ZIP'in **içeriğini doğrudan clone edilmiş repository köküne** çıkar.
4. Node.js, Git, Claude Code CLI ve Codex CLI'nin kurulu olduğundan emin ol.
5. Claude Code ve Codex CLI'da bir kez giriş yap.
6. Repository kökünde PowerShell aç.
7. Tek komut çalıştır:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-full-auto.ps1
```

## Script ilk çalışmada ne yapar?

Yeni boş repo ise:

- canonical startup dosyalarını `main` üzerinde ilk commit yapar
- `origin/main`'e push eder
- `factory/development` branch'ini oluşturur
- GitHub'a push eder
- development branch'ine geçer
- Phase 0 / Milestone 0.1'i Claude'a başlatır

Sonra otomatik döngü devam eder.

## Otomasyon hangi durumda seni çağırır?

- Founder approval gerekiyorsa
- 3 review turunda blocker kapanmadıysa
- local/remote Git diverged ise
- GitHub push doğrulanamıyorsa
- CLI authentication yoksa
- deterministik validation düzelmiyorsa
- kritik güvenlik/authority kararı gerekiyorsa

Durum:

`.ai/AUTOMATION_STATE.json`

Review kayıtları:

`.ai/reviews/`

Git kayıtları:

`.ai/git/`

## Çok önemli

Normal development commitleri `factory/development` branch'ine otomatik gider.

`main` stabil canonical baseline olarak tutulur.
Güvenilir phase-closure/main-promotion sistemi daha sonraki governance fazlarında eklenir.

Rutin development için senden GitHub'a elle push beklenmez.


---

# FILE: SETUP-ONCE-WINDOWS.md

# Windows — Bir Kez Kurulum

## Gerekli araçlar

- Git
- Node.js 18+
- npm
- Claude Code CLI
- Codex CLI

Claude Code resmi CLI non-interactive çalışmayı `claude -p` ile destekler.
Codex non-interactive shell akışı `codex exec` ile çalışır.

## Kurulu değilse

Claude Code:

```powershell
npm install -g @anthropic-ai/claude-code
```

Codex:

```powershell
npm install -g @openai/codex
```

## Authentication

Claude Code:

```powershell
claude
```

İlk çalıştırmada hesabınla giriş akışını tamamla ve çık.

Codex:

```powershell
codex --login
```

Giriş akışını tamamla.

## Kontrol

```powershell
claude --version
codex --version
git --version
node --version
npm --version
```

## GitHub

GitHub'da boş repository oluştur ve clone et.

Örnek:

```powershell
git clone <YENI_REPO_URL>
cd <REPO_KLASORU>
```

ZIP içeriğini bu klasöre çıkar.

Sonra yalnız:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-full-auto.ps1
```


---

# FILE: GIT-AUTOMATION.md

# Git & GitHub Automation Contract

## Goal

The Human Founder must not manually perform routine:

- `git fetch`
- `git pull`
- `git add`
- `git commit`
- `git push`
- remote SHA verification

during the automated Factory build/review loop.

## Branch model

Canonical baseline branch:

`main`

Automated working branch:

`factory/development`

Day-zero behavior for a newly cloned empty GitHub repository:

1. Detect repository has no commit.
2. Create the initial canonical startup-pack commit on `main`.
3. Push `main` to `origin`.
4. Create `factory/development` from that exact baseline.
5. Push and track `origin/factory/development`.
6. Continue all automated implementation on `factory/development`.

## Safe sync before work

Before each automated milestone:

1. working tree must be clean
2. `git fetch --prune origin`
3. compare local working branch with `origin/factory/development`

Allowed outcomes:

- equal → continue
- remote ahead only → `git pull --ff-only`
- local ahead only → safe push + verify
- diverged → STOP and require Founder attention

## Safe push after every generated commit

After Claude creates a milestone/remediation commit:

1. verify working tree clean
2. verify HEAD changed when a new commit was expected
3. `git push -u origin factory/development`
4. obtain remote SHA with `git ls-remote`
5. require remote SHA == local HEAD
6. only then allow Codex review

This means Codex always reviews a commit that is already durably present on GitHub.

## Forbidden automated Git actions

The supervisor MUST NOT perform:

- `git push --force`
- `git push --force-with-lease`
- `git reset --hard`
- history rewrite
- automatic rebase
- automatic conflict resolution that changes authoritative history
- silent branch deletion

If safe fast-forward synchronization is impossible:

`FOUNDER_ATTENTION_REQUIRED`

## Main branch policy

Routine work is NOT pushed directly to `main`.

`main` is the canonical stable baseline.

The startup supervisor automatically pushes implementation to `factory/development`.

Later Factory phases add phase-closure/main-promotion automation through governance gates and independent CLEAN evidence. Until that trusted gate exists, the supervisor does not silently overwrite `main`.

This still means the Founder never manually fetches/pulls/pushes routine development work.

## Remote authentication

Git authentication is delegated to the user's normal Git credential mechanism (for example Git Credential Manager / SSH).

The supervisor never stores GitHub passwords or tokens in repository files.


---

# FILE: BOOTSTRAP-AUTOMATION.md

# Day-Zero Full Automation

Automation starts before Phase 0.

After the one-time local prerequisites are installed/authenticated, the Founder runs a single command:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-full-auto.ps1
```

The supervisor then performs:

SAFE GIT INITIALIZATION / SYNC
→ CLAUDE BUILD
→ LOCAL DETERMINISTIC VALIDATION
→ GIT PUSH + REMOTE SHA VERIFY
→ CODEX INDEPENDENT REVIEW
→ CLEAN or BLOCKED

If BLOCKED:

CODEX FINDINGS
→ CLAUDE REMEDIATION
→ LOCAL VALIDATION
→ NEW COMMIT
→ GIT PUSH + VERIFY
→ CODEX REVIEW

If CLEAN:

CHECKPOINT
→ NEXT MILESTONE
→ repeat

## Automation stops only when necessary

Examples:

- Founder approval is required
- 3 review cycles are exhausted
- Claude/Codex CLI is unavailable
- Git remote is missing
- Git local/remote history diverged
- validation cannot be repaired
- safe push verification fails
- a critical authority/security boundary requires manual approval
- configured max milestone count is reached

State:

`.ai/AUTOMATION_STATE.json`

Logs:

`.ai/automation/`

Review outputs:

`.ai/reviews/`

Git automation audit:

`.ai/git/`

## Security boundary

The day-zero supervisor is intentionally limited to:

- this repository
- local Git operations
- safe push to the configured development branch
- Claude Code CLI
- Codex CLI
- local deterministic validation

It must not:
- deploy production
- purchase cloud resources
- perform Risk-5 actions
- access unrelated repositories
- force-push or rewrite history
- invent Founder approval
- invent independent review evidence

Later trusted Factory phases absorb this bootstrap supervisor into the first-class Control Plane.


---

# FILE: AUTOMATED-REVIEW-ORCHESTRATOR.md

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


---

# FILE: TECH-STACK.md

# Canonical Initial Technology Stack

This is the default clean-slate implementation stack. Changes require an ADR when they affect architecture materially.

## Core

- Language: TypeScript
- Runtime: Node.js
- Package management / monorepo: npm workspaces
- Test: Vitest
- Lint: ESLint
- Schema: JSON Schema
- Source control: Git + GitHub
- CI: GitHub Actions
- Canonical technical language: English
- Founder-facing explanations: Turkish

## Desktop

- Electron
- React
- TypeScript

The Desktop is the Human Founder control surface. It is introduced early, not after the Factory is complete.

## Control API

- Fastify
- TypeScript
- REST where appropriate
- WebSocket for live state
- SSE fallback where appropriate

Desktop must not directly mutate authoritative runtime files or databases.

## Runtime data

- Git/YAML/JSON: canonical specifications, registries and reviewable configuration
- SQLite: initial local operational runtime state
- PostgreSQL: future central/multi-node operational state when required

Do not store runtime concurrency-sensitive state in loose JSON files merely because it is convenient.

## Observability

- Structured JSON logging
- OpenTelemetry-compatible traces/metrics/log correlation

## Execution topology

Initial:
- Windows local
- Docker where required

Architecture must support:
- LOCAL
- REMOTE
- HYBRID
- SSH/VDS
- GPU workers
- Cloud workers

## Security

- Default deny
- OS secure storage for local Founder/private credential material where applicable
- Secrets Broker for agent/service access
- No real secret in Git


---

# FILE: ARCHITECTURE-CONSTITUTION.md

# UNIVERSAL AI SOFTWARE FACTORY — Architecture Constitution

**Status:** Canonical clean-slate baseline

## 1. Mission and Founder model

The Human Founder provides ideas, goals, constraints, business intent and critical decisions.
The Factory discovers missing requirements and systems instead of expecting the Founder to enumerate every technical subsystem.
The Human Founder is the final authority for Risk-5, critical spending, destructive production actions, irreversible architecture deletion, critical security/financial/legal decisions and global kill switch actions.

## 2. Immutable trust constitution

DEFAULT DENY.
LEAST PRIVILEGE.
EXPLICIT CAPABILITIES.
SEPARATION OF DUTIES.
HUMAN FINAL CONTROL.
AUDIT EVERYTHING.
NO CLAIM WITHOUT EVIDENCE.
NO SILENT SPENDING.
NO SILENT PRODUCTION ACTION.
NO SILENT ARCHITECTURAL DELETION.
NO SILENT AUTHORITY ESCALATION.
NO SELF-ASSERTED TRUST.
NO SELF-ASSERTED EXECUTION EVIDENCE.
NO SELF-ASSERTED INDEPENDENT REVIEW.
NO FAKE SUCCESS.
SELF-LEARNING != SELF-TRUSTING.
REGISTER EVERYTHING. ACTIVATE ONLY WHAT THE PROJECT NEEDS.

## 3. Source of truth

Git and repository state are canonical. Chat history is not canonical project memory.
Persistent state lives in canonical specifications, registries, evidence, tests, decisions and `.ai/` checkpoints.
A new AI session must be able to resume from repository state without rereading a giant conversation.

## 4. Specification, implementation and evidence

Always distinguish SPECIFICATION, IMPLEMENTATION, TEST, EVIDENCE, RUNTIME VERIFICATION and PRODUCTION VERIFICATION.
A folder, registry row, prompt, test source file or documentation statement does not prove implementation.
Implementation claims require runtime implementation plus appropriate tests/evidence.

## 5. Requirements and invariants

Requirements use stable IDs such as `UASF-REQ-0001`; IDs are never reused.
Canonical requirement statuses:
DEFINED, PLANNED, IMPLEMENTATION_IN_PROGRESS, IMPLEMENTED, UNIT_TESTED,
INTEGRATION_TESTED, PROOF_VERIFIED, PRODUCTION_VERIFIED, BLOCKED,
DEPRECATED, SUPERSEDED.
Critical rules use stable invariant IDs. Invariants should be machine-checkable when possible and map to tests/proofs.

## 6. Founder authority provenance

Caller-controlled strings such as `approvedBy`, `decidedBy`, `reviewerIdentity`, `owner` never prove authority.
Risk-5 fails closed if authoritative Founder identity/provenance cannot be verified.

## 7. Evidence and attestation

EVIDENCE != CLAIM.
PASS, CLEAN, Founder approved or review complete cannot become true merely because a caller writes those strings into JSON/YAML.
Execution evidence should include trustworthy provenance such as commit SHA, run ID, command, runner identity, time, artifact digest and result.
A test source file proves only that test source exists.
Independent review evidence must prove reviewer provenance, independence, reviewed commit and integrity.

## 8. Review lifecycle

Use a two-snapshot model:
REVIEWED_CODE_COMMIT -> independent review -> immutable review attestation -> optional later evidence/closure commit -> closure validation.
Do not require the review artifact to be in the same commit that it claims to review.
No unreviewed source changes may appear after the reviewed code snapshot for closure-critical paths.

## 9. State, persistence and concurrency

Concurrent agents must not corrupt authoritative state.
Use worktrees/branches, task leases, locks, optimistic concurrency, compare-and-swap, version checks, atomic writes, transaction manifests, recovery journals or merge queues as appropriate.
For a logical multi-file state transition, partial success must never masquerade as SUCCESS.
MIXED GENERATION + SUCCESS is forbidden.

## 10. Project isolation and sandbox

Each project has isolated context, state, credentials, workspace, budget, execution history, artifacts, evidence, logs and agent activation.
Cross-project access is denied by default.
Sandbox controls filesystem, commands, network, environment, secrets, processes, timeouts and resource ceilings.

## 11. Secrets and public repository security

No real secret is committed. `.env.example` contains placeholders only.
Historical secret exposure requires revoke/rotate/replace.
Secrets Broker should provide scoped, temporary or least-privilege credentials where possible.
External issues, PRs, docs, webpages, repositories and community text are untrusted input.

## 12. Agent model

363 AI roles are registered in General Factory V1; Human Founder is not an agent.
Registered does not mean active. Inactive agents remain STOPPED/DORMANT.
Agent = base role + skills + project context + domain pack + skill overlay + experience + tools + permissions + policies + model policy + cost policy + quality gates + risk ceiling + learning/research/certification policy.

## 13. Agent lifecycle

CANDIDATE -> REGISTERED -> TRAINING -> EVALUATION -> CERTIFIED -> ACTIVE -> MONITORED -> RESTRICTED -> RECERTIFICATION -> ACTIVE or RETIRED.
Uncertified or restricted agents do not silently gain permissions.

## 14. Project Genome and discovery

Founder idea -> intent/goals/constraints -> domain discovery -> completeness/ambiguity analysis -> focused Founder questions -> Project Genome.
Normally ask 3–7 useful questions per clarification batch.
Assumptions are explicit and have lifecycle: PROPOSED, ACCEPTED, REJECTED, VALIDATED, SUPERSEDED.

## 15. Capability discovery

The Founder should not need to list every subsystem. The Factory derives required capabilities/business systems.
Classify capabilities as REQUIRED, RECOMMENDED, OPTIONAL, NOT_REQUIRED, UNKNOWN.
Classify completeness as PRESENT, PARTIAL, MISSING, NOT_REQUIRED, DEFERRED.
Adjacent capabilities are evaluated by value, risk, cost, complexity, dependencies and confidence; do not auto-bloat projects.

## 16. Autonomous learning

UNKNOWN -> RESEARCH -> LEARN -> STRUCTURE -> VALIDATE -> TEST -> CERTIFY -> REGISTER -> REUSE.
Research content is untrusted. External content cannot change Factory policy, grant permissions, request secrets, run commands or override Founder authority.
Knowledge, Capability and Experience are separate concepts.

## 17. Knowledge lifecycle and sources

Knowledge lifecycle:
UNKNOWN -> DISCOVERED -> RESEARCHING -> RESEARCHED -> CORROBORATED -> VALIDATED -> CERTIFIED -> ACTIVE -> MONITORED -> STALE -> RESEARCH_REQUIRED.
REJECTED, DEPRECATED and SUPERSEDED are valid alternatives.
Source hierarchy: official/standards/regulators first, then established engineering/academic/OSS, then quality technical publications, then community signals, then unverified sources.

## 18. Domain packs and expert guilds

First-class domains: SaaS, Commerce, Marketplace, FinTech, Capital Markets, Streaming/Media, PropTech, Automotive Services.
Domain Pack is structured knowledge. Expert Agent/Guild is reasoning/research/review capability. Do not confuse the two.
Unknown domains may be learned and registered.

## 19. Business OS

The Factory evaluates both CAN WE BUILD IT? and SHOULD WE BUILD IT?
Business OS covers strategy, business model, market/competitive intelligence, opportunity, pricing, monetization, unit economics, revenue, sales, partnerships, customer intelligence, churn/LTV, operations, process mining, procurement/vendor, finance/FP&A/treasury/risk and legal/regulatory intelligence.
Analysis != recommendation != execution. External execution still requires permission/risk/budget/approval/evidence.

## 20. Technology decisions

Technology is selected by requirements, scale, security, cost, performance, maintainability, operations, ecosystem, team capability and vendor lock-in, not fashion.
Lifecycle: EXPERIMENTAL, APPROVED, PREFERRED, SUPPORTED, DEPRECATED, FORBIDDEN.
Use feasibility spikes under uncertainty.

## 21. Model gateway and cost

Use adapters rather than hard-wiring application code to one model vendor.
Tiers: 0 MOCK, 1 LOCAL/FREE, 2 VERY LOW COST, 3 STANDARD, 4 PREMIUM, 5 CRITICAL REVIEW.
CHEAPEST CAPABLE MODEL FIRST.
AUTO_PREMIUM_FALLBACK = FALSE.
Meaningful cost must be attributable to project/run/task/agent/provider/model/worker/cloud/storage where applicable.
NO SILENT SPENDING.

## 22. Workers and topology

Worker classes may include linux-general, linux-container, windows-general, windows-game, macos, android, gpu, high-memory and edge.
Execution may be local, Docker, SSH, VM, VDS or cloud.
Scheduler is resource-aware, capability-aware, cost-aware and project-isolated.
Desktop remains the control center across LOCAL, REMOTE and HYBRID topology.

## 23. Desktop-first control architecture

Normal Founder operation is through Factory Desktop.
Desktop -> Factory Control API -> Control Plane -> Execution Plane.
Desktop must not directly mutate authoritative state.
Desktop provides overview, projects, agents, tasks/runs, workers, problems/incidents, decisions/approvals, cost, security, QA, evidence, learning, knowledge, logs/traces and global kill switch.
Every major screen should support WHAT/WHY/HOW and related files/agents/requirements/logs.

## 24. Realtime events and Problem Center

Live Factory activity flows through an event bus/realtime stream.
Problem Center groups/deduplicates failures and shows severity, project, service, agent, task/run, commit, logs, trace, probable root cause, confidence, Turkish explanation, suggested remediation, risk, required approval and runbook.
Do not flood the Founder with thousands of duplicate errors.

## 25. Preflight and dry-run

For risky execution use:
PLAN -> IMPACT -> COST -> RISK -> DEPENDENCIES -> DRY RUN -> ROLLBACK ANALYSIS -> APPROVAL -> EXECUTION.
Founder should see expected impact before critical operations.

## 26. QA and security everywhere

QA is not a final phase; it participates from requirements through production.
Security participates in requirements, architecture, coding, dependencies, CI, deployment, runtime and incident response.
Supply-chain provenance and SBOM are first-class.

## 27. Observability and debugging

Six primary event/log classes: APPLICATION, AGENT EXECUTION, AUDIT, SECURITY, INFRASTRUCTURE, BUSINESS/WORKFLOW.
Preferred diagnostic chain:
ERROR -> PROJECT -> RUN -> TASK -> AGENT -> TOOL -> SERVICE -> TRACE -> COMMIT -> ROOT CAUSE -> INCIDENT -> RESPONSIBLE TEAM -> RUNBOOK -> RECOVERY.
Secret redaction covers structured data, nested data, arrays, serialized JSON and common text forms including Authorization/Cookie.

## 28. Turkish operability

Canonical technical identifiers/files/schemas remain English.
Founder-facing explanations and teaching documentation are Turkish with Turkish characters.
Meaningful source files include Turkish explanatory comments around non-trivial logic, especially authority, security, budget, finance, concurrency, persistence, evidence, retry/fallback/recovery, deployment and rollback.
Generated projects contain Turkish operational docs under `docs/tr/`.

## 29. AI context economy

Full repository scans are not default.
Start with `.ai` checkpoint + current milestone + git diff + changed files + affected requirements/invariants/tests.
Use deterministic scripts before model reasoning when possible.
Batch related findings.
Do not reread unchanged code or rerun independent review on an unchanged commit merely to rediscover known findings.
If context grows, checkpoint and start a fresh session.

## 30. Implementation/review responsibility

Claude = primary implementer.
Codex = independent milestone/phase reviewer.
ChatGPT = architecture, roadmap, orchestration and interpretation.
CI/scripts = deterministic validation.
Claude must never fabricate independent CLEAN evidence. Codex review target must remain stable while reviewed.

## 31. Definition of implementation

Never call an agent/capability/learning/observability/game system implemented merely because a folder or registry exists.
Runtime + tests + evidence are required for implementation claims.
Maintain an Implementation Reality Matrix mapping requirements/capabilities to implementation/tests/proofs/evidence/blockers/last verified commit.

## 32. Operations, backup and migration

Factory itself requires backup/restore, not only generated projects.
Back up authoritative project state, decisions, evidence, knowledge, registries, domain packs, configuration and audit history.
A backup never restore-tested is not proven.
Factory upgrade flow:
VERSION DETECT -> BACKUP -> MIGRATION PLAN -> DRY RUN -> MIGRATE -> VALIDATE -> ROLLBACK IF REQUIRED.

## 33. Game Studio sequencing

Game Studio remains in final scope but is activated only after General Factory is operational, validated with real projects and independently reviewed clean.
363 is the General Factory V1 baseline. During Game Studio first build game capability/domain/guild/org models, then perform permanent-role gap analysis before adding stable new agent IDs.

## 34. FinTech invariants

NO MONEY CREATION.
NO MONEY LOSS.
NO DUPLICATE TRANSACTION.
NO UNAUTHORIZED TRANSFER.
NO SILENT BALANCE MUTATION.
FULL AUDITABILITY.
FULL RECONCILIATION.
IDEMPOTENCY.
EXACT FINANCIAL PRECISION.

## 35. MMORPG authority invariants

NO ITEM DUPLICATION.
NO SILENT ITEM LOSS.
NO SILENT CURRENCY LOSS.
NO UNAUTHORIZED ECONOMIC MUTATION.
NO MIXED CHARACTER STATE.
Authoritative player/inventory/economy/world state receives special protection.


## Automated review orchestration

Claude-to-Codex-to-Claude handoff should be automatable through Git commits, structured findings and bounded orchestration.
The Human Founder must not be used as a manual copy/paste transport layer.
Automation may transport work, but it may never transport or invent authority.
Review loops require stable reviewed commits, new commits after remediation, cost/context ceilings, duplicate finding suppression and a maximum automatic cycle count.
Risk-5 and other critical actions still require Founder authority.


## Day-zero automation principle

Claude → deterministic validation → Codex → Claude remediation handoff is automated from the first implementation milestone by a narrow bootstrap supervisor shipped with the startup pack.

The bootstrap supervisor is not trusted to perform production or Risk-5 actions. Its authority is restricted to local Factory repository development, Git coordination and local validation until the full governance/evidence runtime is implemented.

The Founder is not a manual copy/paste transport layer between builder and reviewer.


## Git automation safety

Routine repository transport is automated from day zero:
safe fetch, fast-forward-only synchronization, local commit verification, push and remote SHA verification.

Automation may not use force push, hard reset, automatic rebase or silent history rewrite.
Local/remote divergence must fail closed and require Founder attention.
Codex reviews only a stable commit that has been pushed and whose remote SHA matches local HEAD.

## Ultimate principle



THE FACTORY SHOULD DISCOVER WHAT IS NEEDED, EXPLAIN WHY, ESTIMATE COST/RISK, BUILD, TEST, SECURE, OBSERVE, DOCUMENT AND LEARN. AUTONOMY MUST NEVER BECOME UNCONTROLLED AUTHORITY.


---

# FILE: ROADMAP.md

# UNIVERSAL AI SOFTWARE FACTORY — Final Canonical Roadmap

**Mode:** Desktop-first + Control-plane-first + clean-slate


## Day-Zero Bootstrap Supervisor

Automation exists before Phase 0 implementation. The startup pack ships a narrow Bootstrap Supervisor that coordinates Claude Code CLI and Codex CLI from the first milestone.

It is deliberately restricted to local repository development, Git and deterministic validation.

Phase 6 does NOT introduce automation for the first time. Phase 6 **hardens and absorbs** the bootstrap loop into the trusted Evidence / Provenance / Attestation / Review Orchestrator runtime.



## Day-Zero Git Automation

Before Phase 0 implementation, the startup supervisor establishes the canonical Git baseline, creates/pushes `main`, creates/pushes `factory/development`, performs safe fetch/ff-only synchronization, and automatically pushes/verifies every Claude milestone/remediation commit before Codex reviews it.

Force push, hard reset, automatic rebase and silent history rewrite are forbidden.


## Global build rule

SPECIFY -> IMPLEMENT -> TEST -> VERIFY -> EVIDENCE -> DESKTOP VISIBILITY -> CHECKPOINT -> COMMIT -> MILESTONE REVIEW

Independent full-repository review is not run after every tiny edit. Related work is batched into coherent milestones.

# PERIOD A — Factory Foundation

## Phase 0 — Clean Repository Foundation

**Goal / Scope:** TypeScript/Node/Vitest/ESLint/npm workspaces, GitHub CI, canonical folders, `.ai` state and secret scan.

**Exit status:** `FOUNDATION_READY`

## Phase 1 — Canonical Specification & Architecture Constitution

**Goal / Scope:** Requirement/invariant/policy registries, ADR, traceability, baseline versioning and Implementation Reality Matrix.

**Exit status:** `SPECIFICATION_KERNEL_READY`

## Phase 2 — Trust, Founder Authority & Governance Kernel

**Goal / Scope:** Default deny, Founder identity/authority, Risk-5, approvals, decisions, audit, scope lock, policy/invariant guards, kill switch.

**Exit status:** `TRUST_KERNEL_READY`

## Phase 3 — Factory Control API

**Goal / Scope:** Controlled API between Desktop and Factory; status/control actions pass authority, policy, risk and audit.

**Exit status:** `CONTROL_API_READY`

## Phase 4 — Realtime Event Stream

**Goal / Scope:** Event bus plus WebSocket/SSE live stream with reconnect and correlation.

**Exit status:** `REALTIME_CONTROL_READY`

## Phase 5 — Early Factory Desktop Shell

**Goal / Scope:** Dashboard, phase/milestone, projects, agents, tasks/runs, errors, logs, costs and approvals with Turkish explainability.

**Exit status:** `DESKTOP_FOUNDATION_READY`

## Phase 6 — Evidence, Provenance & Attestation Kernel

**Goal / Scope:** Harden the already-running Day-Zero Claude → Codex → Claude supervisor into the trusted first-class Evidence / Provenance / Attestation / Review Orchestrator runtime with authoritative reviewed-commit binding, structured findings, attestations, loop guards and cost/context limits.

**Exit status:** `EVIDENCE_KERNEL_READY`

## Phase 7 — State, Persistence, Transactions & Concurrency

**Goal / Scope:** Atomic/versioned state, locks, leases, CAS, recovery journal, crash-safe transitions.

**Exit status:** `STATE_KERNEL_READY`

## Phase 8 — Project Isolation, Sandbox & Secrets Broker

**Goal / Scope:** Project/workspace/environment/credential isolation, constrained execution and auditable scoped credentials.

**Exit status:** `ISOLATION_AND_SECRETS_READY`

## Phase 9 — Data Governance & Information Classification

**Goal / Scope:** PUBLIC/INTERNAL/CONFIDENTIAL/RESTRICTED/PII/FINANCIAL/SECRET classification, masking, retention, deletion and lineage.

**Exit status:** `DATA_GOVERNANCE_READY`

## Phase 10 — Model Gateway, Context & Cost Kernel

**Goal / Scope:** Provider adapters, model tiers, budget/token/context accounting, cheapest-capable routing and no silent premium fallback.

**Exit status:** `MODEL_COST_KERNEL_READY`

## Phase 11 — Worker Fabric + Local/Remote/Hybrid Topology

**Goal / Scope:** Local/Docker/SSH/VDS/cloud workers, health/capability registry, scheduler, leases, quarantine and idle suspension.

**Exit status:** `WORKER_FABRIC_READY`

# PERIOD B — General AI Software Factory

## Phase 12 — Canonical 363-Agent Registry

**Goal / Scope:** Register 363 stable General Factory roles and complete agent contracts; registered != active.

**Exit status:** `AGENT_REGISTRY_READY`

## Phase 13 — Agent Runtime & Organization Composer

**Goal / Scope:** Lifecycle, certification, activation, permissions/tools/context, team and organization composition.

**Exit status:** `AGENT_RUNTIME_READY`

## Phase 14 — Agent & Model Evaluation Harness

**Goal / Scope:** Benchmarks for correctness, tool use, policy compliance, hallucination, security, cost, latency and regression.

**Exit status:** `AGENT_EVALUATION_READY`

## Phase 15 — Capability Fabric

**Goal / Scope:** Machine-readable web/backend/mobile/admin/CMS/data/IAM/realtime/platform/observability capabilities and dependencies.

**Exit status:** `CAPABILITY_FABRIC_READY`

## Phase 16 — Business Systems Fabric

**Goal / Scope:** CMS/DAM/CRM/OMS/PIM/ERP/WMS/payments/billing/etc with BUILD/INTEGRATE/REUSE/BUY/DEFER decisions.

**Exit status:** `BUSINESS_SYSTEMS_READY`

## Phase 17 — Project Genome & Idea Intake

**Goal / Scope:** Founder idea to structured project genome with focused clarification and explicit assumptions.

**Exit status:** `PROJECT_GENOME_READY`

## Phase 18 — Capability Discovery & Missing System Detector

**Goal / Scope:** Required/missing/adjacent capabilities, dependency inference and completeness matrix.

**Exit status:** `DISCOVERY_INTELLIGENCE_READY`

## Phase 19 — Architecture Synthesis

**Goal / Scope:** Architecture generator, pattern/topology/technology selection, tradeoffs, what-if and feasibility spikes.

**Exit status:** `ARCHITECTURE_ENGINE_READY`

## Phase 20 — Preflight / Dry-Run / Impact Simulation

**Goal / Scope:** Plan, impact, cost, risk, dependencies, dry run, rollback analysis, approval and execution.

**Exit status:** `PREFLIGHT_ENGINE_READY`

## Phase 21 — Autonomous Research & Learning

**Goal / Scope:** Knowledge gaps, trusted-source research, untrusted-content sandbox, validation/certification/freshness.

**Exit status:** `AUTONOMOUS_LEARNING_READY`

## Phase 22 — Knowledge Graph & Experience Memory

**Goal / Scope:** Separate knowledge/capability/experience; reusable graph plus evidence-driven outcome learning.

**Exit status:** `KNOWLEDGE_SYSTEM_READY`

## Phase 23 — Domain Packs & Expert Guilds

**Goal / Scope:** SaaS, Commerce, Marketplace, FinTech, Capital Markets, Streaming, PropTech, Automotive Services plus learned domains.

**Exit status:** `DOMAIN_INTELLIGENCE_READY`

## Phase 24 — Business OS

**Goal / Scope:** Strategy, market, opportunity, pricing, unit economics, revenue, sales, partnerships, customer intelligence, operations, finance and legal/regulatory.

**Exit status:** `BUSINESS_OS_READY`

## Phase 25 — Project OS & Generated Project Factory

**Goal / Scope:** Generate separate product repos with genome, architecture, org, capabilities, security, QA, operations, evidence and Turkish docs.

**Exit status:** `PROJECT_FACTORY_READY`

## Phase 26 — Extension / Plugin SDK

**Goal / Scope:** Validated extension lifecycle for tools, models, connectors, workers, capabilities, domain packs, guilds and UI modules.

**Exit status:** `EXTENSION_PLATFORM_READY`

## Phase 27 — Integration Factory

**Goal / Scope:** Research/licensing, adapter, mock, contract/integration/security tests, retry/timeout/idempotency/circuit breaker/webhook/telemetry.

**Exit status:** `INTEGRATION_FACTORY_READY`

## Phase 28 — Quality Engineering Factory

**Goal / Scope:** Activate the 65-role QA organization across manual/automation/web/mobile/API/db/realtime/visual/a11y/perf/security/chaos/production verification.

**Exit status:** `QUALITY_FACTORY_READY`

## Phase 29 — Security, Supply Chain, License & IP Factory

**Goal / Scope:** AppSec/IAM/cloud/secrets/threat/SBOM/supply-chain/AI security/red-team plus code/asset/license provenance.

**Exit status:** `SECURITY_FACTORY_READY`

## Phase 30 — Observability + Problem Center

**Goal / Scope:** Structured logs/metrics/traces, anomaly/root-cause, duplicate grouping and Turkish actionable incident view.

**Exit status:** `OBSERVABILITY_AND_PROBLEM_CENTER_READY`

## Phase 31 — Human Decision Inbox + Notification Center

**Goal / Scope:** Central Founder decisions, Risk-5, budget, release, migration and critical alerts.

**Exit status:** `HUMAN_CONTROL_CENTER_READY`

## Phase 32 — Operations, Factory Backup, Migration & Recovery

**Goal / Scope:** SRE/SecOps/FinOps/DataOps/ReleaseOps, runbooks, restore-tested backups, DR and version migration engine.

**Exit status:** `OPERATIONS_AND_RECOVERY_READY`

# PERIOD C — Control Tower & Real-World Validation

## Phase 33 — Full Factory Desktop Control Tower

**Goal / Scope:** Expand Desktop across portfolio/projects/agents/workers/models/capabilities/knowledge/business/QA/security/evidence/operations/kill switch.

**Exit status:** `CONTROL_TOWER_READY`

## Phase 34 — Factory Doctor & Production Readiness

**Goal / Scope:** Authoritative PASS/WARNING/BLOCKED readiness across all major systems; no fake success.

**Exit status:** `FACTORY_READY_FOR_VALIDATION`

## Phase 35 — Representative Real Project Validation

**Goal / Scope:** Validate full pipeline on representative web/backend/mobile/admin/SaaS/commerce/business/fintech/capital-markets/streaming projects.

**Exit status:** `GENERAL_FACTORY_PROVEN`

## Phase 36 — General Factory Independent Review

**Goal / Scope:** Architecture/governance/evidence/security/agents/learning/business/QA/cost/concurrency/observability/operations/Desktop review -> remediation -> CLEAN.

**Exit status:** `GENERAL_FACTORY_REVIEW_CLEAN`

# PERIOD D — Game Technology Factory

## Phase 37 — Game Studio Foundation

**Goal / Scope:** Game Project Genome, game capability fabric, domain packs, guilds, org templates and permanent-role gap analysis.

**Exit status:** `GAME_FACTORY_FOUNDATION_READY`

## Phase 38 — Game Design & Production Factory

**Goal / Scope:** Core loop, gameplay/combat/progression/quests/items/crafting/PvE/PvP/balance/endgame and production stages.

**Exit status:** `GAME_DESIGN_FACTORY_READY`

## Phase 39 — World, Level & Narrative Factory

**Goal / Scope:** Open world/zones/levels/dungeons/POIs/biomes/navigation/spawns/streaming plus lore/story/characters/factions/dialogue/continuity.

**Exit status:** `WORLD_NARRATIVE_FACTORY_READY`

## Phase 40 — Game Engine & Tools Factory

**Goal / Scope:** Unreal/Unity/Godot knowledge, rendering/physics/animation/AI/streaming/profiling and game editor tooling.

**Exit status:** `GAME_ENGINE_FACTORY_READY`

## Phase 41 — Asset Factory

**Goal / Scope:** 3D, technical art, texture/material, rigging, animation, VFX, audio, procedural generation, optimization and provenance.

**Exit status:** `ASSET_FACTORY_READY`

## Phase 42 — Game Data, Persistence & Backend

**Goal / Scope:** Player/character/inventory/world/quest/economy data, save/migration/recovery and game backend services.

**Exit status:** `GAME_BACKEND_READY`

## Phase 43 — Multiplayer Factory

**Goal / Scope:** Authoritative server, prediction/reconciliation, replication, sessions/lobby/party/matchmaking/presence/voice/chat/crossplay.

**Exit status:** `MULTIPLAYER_FACTORY_READY`

## Phase 44 — Game QA, Simulation & Performance

**Goal / Scope:** Gameplay/network/economy/dupe/soak/patch QA, bot/load simulations and CPU/GPU/RAM/network/server budgets.

**Exit status:** `GAME_QUALITY_READY`

## Phase 45 — LiveOps, Economy, Anti-Cheat, Trust & Publishing

**Goal / Scope:** Events/seasons/economy/anti-cheat/moderation, publishing, monetization and game legal/platform rules.

**Exit status:** `GAME_PLATFORM_READY`

# PERIOD E — MMORPG & Final Factory

## Phase 46 — MMORPG Factory

**Goal / Scope:** Login/gateway/world/zone/social/guild/auction/economy servers, sharding/instances/persistence/massive concurrency and economic invariants.

**Exit status:** `MMORPG_FACTORY_READY`

## Phase 47 — Full Factory Integration

**Goal / Scope:** Verify Desktop, API, events, governance, evidence, agents, workers, models, capabilities, learning, business, QA/security/ops and Game/MMORPG together.

**Exit status:** `FULL_FACTORY_INTEGRATED`

## Phase 48 — Final Comprehensive Independent Review

**Goal / Scope:** Whole-Factory independent review -> consolidated remediation -> full regression -> final CLEAN.

**Exit status:** `FINAL_REVIEW_CLEAN`

## Phase 49 — Universal AI Software Factory V1 Release

**Goal / Scope:** Create canonical tags, SBOM, evidence and architecture/agent/capability/domain/knowledge/Doctor/security/QA/operations snapshots.

**Exit status:** `UNIVERSAL_AI_SOFTWARE_FACTORY_V1_RELEASED`

## Post-V1

REAL PROJECT -> EXPERIENCE -> OBSERVATION -> RESEARCH -> PROPOSAL -> ADR -> IMPACT ANALYSIS -> FOUNDER DECISION -> IMPLEMENTATION -> TEST -> REVIEW -> RELEASE

Version line: V1 -> V1.1 -> V1.2 -> ... -> V2.


---

# FILE: REPOSITORY-TREE.md

# Canonical Repository Tree

This is the target architecture. Not every directory means implemented runtime. Runtime + tests + evidence determine implementation reality.

```text
UNIVERSAL-AI-SOFTWARE-FACTORY/
├── README.md
├── START-HERE.md
├── REPOSITORY-TREE.md
├── ARCHITECTURE-CONSTITUTION.md
├── ROADMAP.md
├── AGENT-CATALOG.md
├── TECH-STACK.md
├── BUILD-RULES.md
├── DEFINITION-OF-DONE.md
├── AI-SESSION-RULES.md
├── AGENTS.md
├── CLAUDE.md
├── CODEX.md
├── SECURITY.md
├── CONTRIBUTING.md
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── eslint.config.js
├── .env.example
│
├── .github/
│   ├── CODEOWNERS
│   ├── ISSUE_TEMPLATE/
│   └── workflows/
│       ├── ci.yml
│       ├── lint.yml
│       ├── typecheck.yml
│       ├── test.yml
│       ├── integration-tests.yml
│       ├── security.yml
│       ├── secret-scan.yml
│       ├── schema-validation.yml
│       ├── registry-validation.yml
│       ├── baseline-drift.yml
│       ├── proofs.yml
│       ├── sbom.yml
│       └── release.yml
│
├── .ai/
│   ├── MASTER_STATE.json
│   ├── CURRENT_PHASE.md
│   ├── CURRENT_MILESTONE.md
│   ├── NEXT_ACTIONS.md
│   ├── DECISIONS.md
│   ├── KNOWN_ISSUES.md
│   ├── TEST_STATUS.md
│   ├── REVIEW_STATUS.md
│   ├── CONTEXT_BUDGET.md
│   ├── checkpoints/
│   ├── milestones/
│   ├── sessions/
│   ├── handoffs/
│   └── context-packs/
│
├── specification/
│   ├── baseline/
│   ├── requirements/{business,product,functional,non-functional,security,performance,accessibility,compliance,operational}/
│   ├── invariants/
│   ├── policies/
│   ├── architecture/
│   ├── ADR/
│   ├── traceability/
│   ├── schemas/
│   ├── diagrams/
│   ├── migrations/
│   └── history/
│
├── constitution/
├── founder/
├── governance/
│   ├── decision-ledger/
│   ├── approvals/
│   ├── evidence-gate/
│   ├── scope-lock/
│   ├── backlog-router/
│   ├── phase-closure/
│   ├── milestone-closure/
│   ├── implementation-reality/
│   ├── invariant-guard/
│   ├── risk-management/
│   ├── change-management/
│   ├── authority/
│   ├── provenance/
│   └── audit/
│
├── desktop/
│   ├── shell/
│   ├── dashboard/
│   ├── projects/
│   ├── agents/
│   ├── tasks/
│   ├── runs/
│   ├── workers/
│   ├── problems/
│   ├── incidents/
│   ├── approvals/
│   ├── decision-inbox/
│   ├── notifications/
│   ├── logs/
│   ├── traces/
│   ├── costs/
│   ├── learning/
│   ├── knowledge/
│   ├── qa/
│   ├── security/
│   ├── operations/
│   ├── evidence/
│   ├── settings/
│   └── explain/
│
├── control-api/
│   ├── factory/
│   ├── projects/
│   ├── agents/
│   ├── tasks/
│   ├── workers/
│   ├── approvals/
│   ├── problems/
│   ├── incidents/
│   ├── costs/
│   ├── evidence/
│   └── system-control/
│
├── events/
│   ├── event-bus/
│   ├── realtime-stream/
│   ├── schemas/
│   ├── subscriptions/
│   └── persistence/
│
├── runtime/
│   ├── founder-control/
│   ├── governance/
│   ├── discovery/
│   ├── requirements/
│   ├── assumptions/
│   ├── decisions/
│   ├── project-genome/
│   ├── organization-composer/
│   ├── capability-engine/
│   ├── domain-pack-engine/
│   ├── expert-guild-engine/
│   ├── skill-overlay-engine/
│   ├── blueprint-engine/
│   ├── intelligence/
│   ├── learning/
│   ├── knowledge/
│   ├── agents/
│   ├── models/
│   ├── workers/
│   ├── scheduler/
│   ├── event-bus/
│   ├── workflow/
│   ├── project-isolation/
│   ├── sandbox/
│   ├── policy-engine/
│   ├── invariants/
│   ├── approvals/
│   ├── budget/
│   ├── cost/
│   ├── cache/
│   ├── state/
│   ├── persistence/
│   ├── concurrency/
│   ├── locks/
│   ├── leases/
│   ├── transactions/
│   ├── audit/
│   ├── evidence/
│   ├── attestations/
│   ├── provenance/
│   ├── telemetry/
│   ├── security/
│   ├── secrets/
│   ├── integrations/
│   ├── release/
│   ├── recovery/
│   ├── artifact-registry/
│   ├── cli/
│   └── utilities/
│
├── bootstrap-supervisor/
│   ├── factory-supervisor.mjs
│   ├── config.json
│   └── day-zero-state/
├── bootstrap-supervisor/
│   ├── controller/
│   ├── git-automation/
│   ├── claude-adapter/
│   ├── codex-adapter/
│   ├── validation/
│   ├── state/
│   └── audit/
├── git-automation/
│   ├── safe-sync/
│   ├── safe-push/
│   ├── remote-verification/
│   ├── branch-policy/
│   └── divergence-guard/
├── review-orchestrator/
│   ├── controller/
│   ├── builder/claude-adapter/
│   ├── reviewer/codex-adapter/
│   ├── validation/
│   ├── review-context/{git-diff,requirements,invariants,tests}/
│   ├── findings/{schema,parser,deduplication,blocker-classifier}/
│   ├── remediation/{prompt-builder,task-builder}/
│   ├── cycles/{limits,budget,loop-guard}/
│   ├── attestations/
│   ├── state/
│   └── audit/
├── problem-center/{detection,grouping,deduplication,correlation,root-cause,remediation,explanation}/
├── decision-inbox/{founder-decisions,approvals,risk-5,budget,architecture,production}/
├── preflight/{impact-analysis,dry-run,risk-analysis,cost-estimation,rollback-analysis,simulation}/
├── secrets-broker/{providers,scoped-access,temporary-credentials,rotation,audit}/
├── data-governance/{classification,pii,masking,retention,deletion,lineage}/
├── notifications/{center,routing,preferences,adapters}/
├── evaluations/{agents,models,prompts,policies,benchmarks,regressions}/
├── extensions/{sdk,tools,models,connectors,workers,capabilities,domain-packs,ui-modules}/
├── factory-backup/{backup,restore,verification,disaster-recovery}/
├── factory-migrations/{versions,planner,dry-run,executor,validation,rollback}/
│
├── intelligence/
│   ├── intent-and-goal-engine/
│   ├── project-genome/
│   ├── capability-discovery/
│   ├── architecture-synthesis/
│   ├── organization-composer/
│   └── project-readiness-doctor/
├── learning-system/
│   ├── knowledge-gap-detector/
│   ├── autonomous-research/
│   ├── research-sandbox/
│   ├── source-validation/
│   ├── knowledge-extraction/
│   ├── domain-learning/
│   ├── capability-learning/
│   ├── technology-learning/
│   ├── architecture-learning/
│   ├── security-learning/
│   ├── compliance-learning/
│   ├── qa-learning/
│   ├── business-learning/
│   ├── agent-learning/
│   ├── certification/
│   ├── experience-learning/
│   ├── self-improvement/
│   └── recertification/
├── knowledge-graph/{domains,subdomains,capabilities,business-systems,technologies,standards,regulations,integrations,architecture-patterns,security-patterns,compliance-patterns,qa-patterns,failure-modes,incidents,business-patterns,project-outcomes,technology-outcomes,architecture-outcomes,relationships}/
├── capabilities/
│   ├── delivery-surfaces/
│   ├── identity-access/
│   ├── backend/
│   ├── data/
│   ├── communication/
│   ├── storage-media/
│   ├── platform/
│   └── business-systems/
├── domain-packs/{_template,saas,commerce,marketplace,fintech,capital-markets,streaming-media,proptech,automotive-services,learned-domains}/
├── expert-guilds/{fintech,capital-markets,streaming-media,commerce,saas-enterprise,proptech,automotive-services,learned-guilds}/
├── skill-overlays/{core,web,backend,mobile,desktop,admin-panel,cms,database,security,qa,devops,saas,commerce,fintech,capital-markets,streaming-media,proptech,automotive-services,gaming,learned}/
├── business-os/{corporate-strategy,business-model,market-intelligence,competitive-intelligence,opportunity-discovery,industry-intelligence,revenue,monetization,pricing,unit-economics,forecasting,sales,partnerships,customer-intelligence,customer-success,churn,lifetime-value,business-operations,process-intelligence,process-mining,procurement,vendor-management,sla-management,finance,fp-and-a,treasury,financial-risk,business-continuity,legal,regulatory-intelligence}/
├── project-os/{project-definition,founder-intent,project-genome,business,requirements,assumptions,decisions,architecture,organization,activated-agents,capabilities,domain-packs,expert-guilds,skill-overlays,services,databases,integrations,data,security,qa,operations,observability,runbooks,incidents,backlog,technical-debt,cost,evidence,artifacts,state}/
├── project-blueprints/{web-application,backend-service,admin-panel,mobile-application,desktop-application,web-mobile-admin,cms-platform,saas-platform,ecommerce-platform,marketplace-platform,fintech-platform,fintech-analytics,capital-markets-analytics,trading-platform,streaming-vod,streaming-live,proptech-platform,automotive-services-platform,game-project,mmorpg-project}/
├── organization-templates/{minimal,startup,saas,commerce,enterprise,fintech,capital-markets,streaming,game-studio,mmorpg-studio}/
│
├── agents/
│   ├── 01-executive-governance/
│   ├── 02-product-discovery/
│   ├── 03-architecture-core-engineering/
│   ├── 04-web-engineering/
│   ├── 05-backend-api-engineering/
│   ├── 06-data-database/
│   ├── 07-mobile-engineering/
│   ├── 08-desktop-engineering/
│   ├── 09-ux-ui-design/
│   ├── 10-quality-engineering-factory/
│   ├── 11-cybersecurity/
│   ├── 12-platform-devops-sre/
│   ├── 13-ai-model-operations/
│   ├── 14-integration-factory/
│   ├── 15-business-systems/
│   ├── 16-sales-crm/
│   ├── 17-marketing-growth/
│   ├── 18-customer-support-success/
│   ├── 19-finance-finops/
│   ├── 20-legal-privacy-compliance/
│   ├── 21-research-knowledge-documentation/
│   ├── 22-game-development-studio/
│   ├── 23-3d-media-asset-studio/
│   ├── 24-embedded-iot-robotics-xr/
│   ├── 25-operations-release-liveops/
│   ├── 26-control-tower/
│   ├── 27-shared-company-platform/
│   ├── 28-intelligence-autonomous-learning/
│   ├── 29-fintech-expert-guild/
│   ├── 30-capital-markets-expert-guild/
│   ├── 31-streaming-media-expert-guild/
│   ├── 32-commerce-marketplace-expert-guild/
│   ├── 33-saas-enterprise-expert-guild/
│   ├── 34-business-strategy-intelligence/
│   ├── 35-revenue-monetization/
│   ├── 36-sales-partnerships/
│   ├── 37-customer-market-intelligence/
│   ├── 38-business-operations/
│   ├── 39-finance-corporate-control/
│   └── 40-legal-regulatory-intelligence/
├── agent-templates/standard-agent/
├── registries/
├── models/{gateway,routing,fallback,benchmark,evaluation,cost-routing,adapters}/
├── workers/{linux-general,linux-container,windows-general,windows-game,macos,android,gpu,high-memory,edge}/
├── integrations/
├── technology/
├── security/
├── quality/
├── observability/
├── operations/
├── control-tower/
├── generated-project-registry/
├── schemas/
├── evidence/
├── proofs/
├── tests/
├── scripts/
├── templates/
├── docs/{architecture,governance,agents,intelligence,learning,knowledge-graph,capabilities,domain-packs,expert-guilds,business-os,project-os,security,quality,observability,operations,control-tower,game-studio,tr,beginner}/
│
├── game-studio/
│   ├── game-project-genome/
│   ├── game-design/
│   ├── production/
│   ├── world-design/
│   ├── narrative/
│   ├── game-ui-ux/
│   ├── engines/
│   ├── engine-systems/
│   ├── tools-engineering/
│   ├── game-data/
│   ├── persistence/
│   ├── multiplayer/
│   ├── game-backend/
│   ├── platform-services/
│   ├── game-ai/
│   ├── liveops/
│   ├── game-economy/
│   ├── anti-cheat/
│   ├── trust-safety/
│   ├── telemetry/
│   ├── simulation-testing/
│   ├── performance/
│   ├── localization/
│   ├── accessibility/
│   ├── publishing/
│   ├── game-business/
│   ├── game-legal/
│   ├── build-patch-launcher/
│   ├── disaster-recovery/
│   └── content-factory/
├── asset-factory/
├── mmorpg-factory/
└── future-proposals/
```


---

# FILE: AGENT-CATALOG.md

# UNIVERSAL AI SOFTWARE FACTORY — Canonical 363-Agent Catalog

**Owner / Human Founder:** `@SalimBurakAytemiz`

Human Founder is not counted as an agent.

Core rule:

> REGISTER EVERYTHING. ACTIVATE ONLY WHAT THE PROJECT NEEDS.

363 roles are the General Factory V1 registered workforce. Dormant domains, especially Game Studio and 3D/Asset roles, remain registered but are not activated until their roadmap phase.

## 01 Executive & Governance

- 001 Executive Operations
- 002 Founder Decision Coordinator
- 003 AI Workflow Coordinator
- 004 Portfolio Management
- 005 Program & Milestone Governance
- 006 Decision Ledger
- 007 Risk & Approval Coordinator

## 02 Product & Discovery

- 008 Product Strategy
- 009 Product Manager
- 010 Business Analyst
- 011 Requirements Engineering
- 012 Market Research
- 013 Competitive Intelligence
- 014 Problem Validation
- 015 User Research
- 016 Product Analytics
- 017 Pricing Strategy

## 03 Architecture & Core Engineering

- 018 Solution Architect
- 019 Software Architect
- 020 Domain Architect
- 021 Core Platform Engineer
- 022 Distributed Systems Engineer
- 023 API Contract Architect
- 024 Realtime Systems Engineer
- 025 Async & Queue Systems Engineer
- 026 Identity & Access Architecture
- 027 Multi-Tenancy Architecture
- 028 Migration & Modernization
- 029 Senior Code Review

## 04 Web Engineering

- 030 Web Frontend Engineer
- 031 React & Next.js Engineer
- 032 Frontend Design System Engineer
- 033 Web Performance Engineer
- 034 Web Accessibility Engineer

## 05 Backend & API Engineering

- 035 Backend Service Engineer
- 036 REST API Engineer
- 037 GraphQL Engineer
- 038 Event-Driven Backend Engineer
- 039 Workflow Engine Engineer
- 040 Notification Service Engineer
- 041 File & Object Storage Engineer
- 042 Background Jobs & Scheduler Engineer

## 06 Data & Database

- 043 Database Architect
- 044 SQL & Data Modeling
- 045 Data Engineer
- 046 Analytics Engineer
- 047 ETL/ELT Pipeline
- 048 Search Index & Data
- 049 Data Quality & Governance

## 07 Mobile Engineering

- 050 Mobile Architect
- 051 Android Engineer
- 052 iOS Engineer
- 053 Flutter Engineer
- 054 React Native Engineer
- 055 Firebase & Mobile Integration
- 056 Mobile Release & Store

## 08 Desktop Engineering

- 057 Desktop Application Architect
- 058 Electron & Tauri Engineer
- 059 Native Desktop Integration

## 09 UX/UI & Design

- 060 UX Architect
- 061 UI Designer
- 062 Design System
- 063 UX Research
- 064 Accessibility Design
- 065 Content Design
- 066 Localization & Internationalization

## 10 Quality Engineering Factory

- 067 Test Planning
- 068 Happy Path Test Case
- 069 Edge & Negative Case
- 070 Regression Coverage
- 071 Test Documentation & Checklist
- 072 Exploratory QA
- 073 Product Flow Test
- 074 Feature Validation
- 075 CMS & Content Administration Test
- 076 Admin Panel Process Test
- 077 Cross-Platform Synchronization
- 078 Usability & Heuristic Review
- 079 Localization & Internationalization QA
- 080 Web Design & Pixel-Perfect
- 081 Mobile & Responsive Design
- 082 iOS UI Design Review
- 083 Android UI Design Review
- 084 Visual Regression
- 085 Accessibility Test
- 086 Advanced Accessibility & Assistive Tech
- 087 Browser / Device / OS Compatibility
- 088 Web Functional Test
- 089 iOS Mobile App Test
- 090 Android Mobile App Test
- 091 Notification & Messaging Test
- 092 Firebase Event & Analytics Validation
- 093 Offline / Low Network / Recovery QA
- 094 Feature Flag & Experiment QA
- 095 Data Pipeline / BI / Reporting Validation
- 096 API Test
- 097 Backend Integration Test
- 098 Socket & Realtime Test
- 099 Database Validation & Data Integrity
- 100 Test Data Management
- 101 Test Environment & System Health
- 102 Log Monitoring & Root Cause Analysis
- 103 Background Jobs / Queue / Scheduler QA
- 104 Third-Party Integration & Contract QA
- 105 Migration & Backward Compatibility
- 106 Security & Vulnerability Scanning
- 107 Role / Permission / Session Security
- 108 Performance & Load Test
- 109 Privacy / Consent / Compliance QA
- 110 Frontend Performance & Core Web Vitals
- 111 Chaos / Resilience / Failure Injection
- 112 Web Automation
- 113 Mobile Automation
- 114 Backend Developer in Test
- 115 Android Development in Test
- 116 iOS Development in Test
- 117 Testability & Code Review
- 118 Test Automation Framework Architect
- 119 CI/CD Quality Gate
- 120 Flaky Test Detection & Stabilization
- 121 Service Virtualization & Mocking
- 122 Automation Observability & Suite Health
- 123 Defect Triage
- 124 Jira / Trello Work Tracking
- 125 Daily Quality Report
- 126 Weekly Quality Summary
- 127 Monthly Quality Risk Trend
- 128 Release Readiness
- 129 Test Coverage Gap & Risk Analysis
- 130 Production Smoke & Canary Verification
- 131 Synthetic Monitoring & Live Journey

## 11 Cybersecurity

- 132 Security Architect
- 133 Application Security
- 134 Cloud Security
- 135 Identity Security
- 136 Secrets & Key Management
- 137 Software Supply Chain Security
- 138 Dependency & SBOM Security
- 139 Threat Modeling
- 140 AI Red Team
- 141 SecOps & Security Incident

## 12 Platform / DevOps / SRE

- 142 Platform Engineering
- 143 DevOps
- 144 Cloud Infrastructure
- 145 Infrastructure as Code
- 146 Container & Kubernetes
- 147 CI/CD Engineering
- 148 SRE
- 149 Observability
- 150 Capacity Planning
- 151 Backup & Disaster Recovery

## 13 AI / Model Operations

- 152 Model Router
- 153 Model Operations
- 154 Model Benchmark
- 155 Model Quality Evaluation
- 156 Prompt Engineering
- 157 Prompt Evaluation
- 158 Model Cost Optimization
- 159 Model Availability & Fallback

## 14 Integration Factory

- 160 Integration Architect
- 161 Connector & Adapter Engineer
- 162 Webhook & Contract Integration
- 163 BaaS Integration
- 164 External API Drift Monitoring

## 15 Business Systems

- 165 CRM Systems
- 166 ERP Systems
- 167 Order Management Systems
- 168 Warehouse & Inventory Systems
- 169 PIM & Catalog Systems
- 170 CMS & DAM Systems
- 171 Payments & Billing Systems
- 172 Accounting & Reconciliation Systems

## 16 Sales & CRM

- 173 Lead Generation
- 174 Lead Qualification
- 175 Sales
- 176 Proposal & Quotation
- 177 CRM Operations
- 178 Customer Onboarding

## 17 Marketing & Growth

- 179 Growth Strategy
- 180 Performance Marketing
- 181 SEO
- 182 Content Marketing
- 183 Social Media
- 184 Email & Lifecycle Marketing
- 185 Campaign / Experiment Analytics

## 18 Support & Success

- 186 Customer Support
- 187 Ticket Triage
- 188 Support Routing
- 189 Knowledge Base
- 190 Customer Success & Renewal

## 19 Finance & FinOps

- 191 Finance Operations
- 192 Accounting
- 193 FinOps
- 194 Budget Guard
- 195 Cost Controller
- 196 Cash Flow Forecasting
- 197 ROI & Profitability

## 20 Legal / Privacy / Compliance

- 198 Privacy / KVKK / GDPR
- 199 Compliance
- 200 Consent & Data Retention
- 201 License & Intellectual Property
- 202 Contract & Regulatory Risk

## 21 Research / Knowledge / Documentation

- 203 Technical Research
- 204 Documentation Engineer
- 205 Knowledge Management
- 206 Architecture Decision / ADR
- 207 Repository & Tool Evaluation

## 22 Game Development Studio (DORMANT until Game phase)

- 208 Game Systems Architect
- 209 Gameplay Engineer
- 210 Unreal Engine
- 211 Unity Engine
- 212 Godot Engine
- 213 Multiplayer & Network
- 214 Game Backend
- 215 Game Economy
- 216 LiveOps
- 217 Anti-Cheat
- 218 Game Trust & Safety
- 219 Game Build / Patcher / Release

## 23 3D / Media / Asset Studio (DORMANT until Game phase)

- 220 3D Technical Art
- 221 3D Modeling
- 222 Texture & Material
- 223 Rigging & Animation
- 224 VFX
- 225 Audio Production
- 226 Asset Pipeline & Provenance

## 24 Embedded / IoT / Robotics / XR (DORMANT by default)

- 227 Embedded Systems
- 228 Firmware Engineer
- 229 IoT Platform
- 230 OTA & Device Management
- 231 Edge AI
- 232 Robotics Engineer
- 233 XR / AR / VR
- 234 Hardware-in-the-Loop Integration

## 25 Operations / Release / LiveOps

- 235 Incident Management
- 236 Release Manager
- 237 Environment Management
- 238 Runbook Operations
- 239 Business Process Operations
- 240 LiveOps / GameOps Coordinator

## 26 Control Tower

- 241 Control Tower
- 242 Approval Center
- 243 Global Kill Switch Controller
- 244 Portfolio Health
- 245 Cost & Revenue Monitoring
- 246 Agent Activity Monitoring
- 247 Security & Incident Monitoring

## 27 Shared Company Platform

- 248 Company Event Bus
- 249 Notification Orchestration
- 250 Automation & Workflow
- 251 Internal Marketplace & Capability Registry
- 252 Template & Industry Pack Manager

## 28 Intelligence / Autonomous Learning

- 253 Chief Knowledge Architect
- 254 Knowledge Gap Detection
- 255 Autonomous Research Planner
- 256 Official Source Research
- 257 Technical Literature Research
- 258 Open Source Intelligence
- 259 Source Reliability
- 260 Knowledge Extraction
- 261 Knowledge Conflict Detection
- 262 Knowledge Validation
- 263 Domain Discovery
- 264 Capability Discovery
- 265 Domain Pack Builder
- 266 Skill Overlay Builder
- 267 Knowledge Freshness
- 268 Experience Learning
- 269 Architecture Outcome Learning
- 270 Self-Improvement Evaluation

## 29 FinTech Expert Guild

- 271 FinTech Domain Architect
- 272 Financial Ledger Specialist
- 273 Payments Architecture Specialist
- 274 Wallet & Transaction Specialist
- 275 Settlement Specialist
- 276 Reconciliation Specialist
- 277 KYC/KYB Specialist
- 278 AML/Sanctions Specialist
- 279 Financial Fraud & Risk
- 280 Financial Precision & Accounting Integrity
- 281 FinTech Regulatory Intelligence
- 282 FinTech QA & Failure Mode Specialist

## 30 Capital Markets Expert Guild

- 283 Capital Markets Domain Architect
- 284 Market Data Specialist
- 285 Instrument & Reference Data Specialist
- 286 Trading OMS Specialist
- 287 Execution Management Specialist
- 288 Portfolio & Position Specialist
- 289 Pre-Trade Risk Specialist
- 290 Post-Trade Risk Specialist
- 291 Pricing & P&L Specialist
- 292 FIX Protocol & Trading Integration
- 293 Market Surveillance Specialist
- 294 Clearing & Settlement Specialist

## 31 Streaming / Media Expert Guild

- 295 Streaming Platform Architect
- 296 Media Ingest Specialist
- 297 Video Encoding / Transcoding Specialist
- 298 Adaptive Streaming Specialist
- 299 CDN Architecture Specialist
- 300 Playback Engineering Specialist
- 301 DRM & Content Protection
- 302 Live Streaming Specialist
- 303 Content Rights & Entitlement
- 304 Streaming QoE Specialist

## 32 Commerce / Marketplace Expert Guild

- 305 Commerce Domain Architect
- 306 Catalog & Product Commerce Specialist
- 307 Commerce OMS Specialist
- 308 Inventory & Fulfillment Specialist
- 309 Marketplace Architecture Specialist
- 310 Seller & Commission Specialist
- 311 Promotion & Pricing Specialist
- 312 Commerce Fraud & Dispute Specialist

## 33 SaaS / Enterprise Expert Guild

- 313 SaaS Domain Architect
- 314 Multi-Tenant SaaS Specialist
- 315 Subscription Lifecycle Specialist
- 316 Enterprise Identity / SSO Specialist
- 317 SaaS Metering & Billing Specialist
- 318 Enterprise Integration Specialist

## 34 Business Strategy & Intelligence

- 319 Corporate Strategy
- 320 Business Model Architect
- 321 Business Opportunity Discovery
- 322 Industry Intelligence
- 323 Business Intelligence
- 324 Competitive Strategy
- 325 Business Scenario Planning
- 326 Business Performance

## 35 Revenue & Monetization

- 327 Revenue Strategy
- 328 Monetization Optimization
- 329 Unit Economics
- 330 Pricing Intelligence
- 331 Revenue Forecasting
- 332 Revenue Leakage Detection

## 36 Sales & Partnerships

- 333 Enterprise Sales Strategy
- 334 Partnership Development
- 335 Channel Partnership
- 336 Strategic Account
- 337 Sales Operations
- 338 Deal Desk
- 339 Partnership Integration

## 37 Customer & Market Intelligence

- 340 Voice of Customer
- 341 Customer Segmentation
- 342 Churn Intelligence
- 343 Customer Lifetime Value
- 344 Customer Experience Strategy

## 38 Business Operations

- 345 Business Process Architect
- 346 Operational Excellence
- 347 Process Mining
- 348 Vendor Management
- 349 Procurement Intelligence
- 350 SLA Management
- 351 Business Continuity

## 39 Finance & Corporate Control

- 352 Financial Planning & Analysis
- 353 Treasury Management
- 354 Financial Risk
- 355 Management Reporting
- 356 Cost Allocation
- 357 Investment Evaluation
- 358 Financial Scenario Modeling

## 40 Legal & Regulatory Intelligence

- 359 Regulatory Intelligence
- 360 Contract Intelligence
- 361 Data Governance Legal
- 362 Digital Commerce Legal
- 363 Regulatory Change Impact


---

# FILE: BUILD-RULES.md

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


---

# FILE: DEFINITION-OF-DONE.md

# Definition of Done

A milestone is not done because code was written.

For an applicable milestone, completion requires:

- Scope implemented
- No known unresolved blocker inside milestone contract
- Targeted tests pass
- Required regression/full tests pass
- Lint passes
- Typecheck passes
- Build passes
- Relevant schemas validate
- Relevant registries validate
- Secret scan passes
- Required security checks pass
- Requirement/invariant traceability updated
- Evidence generated by authoritative path
- Turkish source explanations/docs updated
- Desktop/Control API visibility verified when applicable
- `.ai/MASTER_STATE.json` updated
- `CURRENT_PHASE.md` / `CURRENT_MILESTONE.md` updated
- `NEXT_ACTIONS.md` updated
- `TEST_STATUS.md` updated
- `REVIEW_STATUS.md` updated
- One coherent commit created

If independent review is required:
- Reviewed commit remains unchanged during review
- Current blockers are remediated in a new commit
- A new review targets the new commit
- Closure requires authentic independent CLEAN, not Claude self-assertion

Statuses such as `CLOSED`, `CLEAN`, `PRODUCTION_VERIFIED` must never be invented without their required evidence.


---

# FILE: AI-SESSION-RULES.md

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


---

# FILE: CONTROL-TOWER-SPEC.md

# Factory Desktop Control Tower — Founder UX Contract

The Desktop is the normal Human Founder control surface.

Architecture:

HUMAN FOUNDER
-> FACTORY DESKTOP
-> FACTORY CONTROL API
-> GOVERNANCE / INTELLIGENCE / AGENT RUNTIME / BUSINESS OS / QA / SECURITY / OBSERVABILITY / OPERATIONS
-> WORKERS / GENERATED PROJECTS

## Early MVP

- Factory status
- Current phase
- Current milestone
- Projects
- Active agents
- Tasks/runs
- Problems/errors
- Logs
- Cost/token use
- Pending approvals

## Full Control Tower

- Portfolio
- Projects
- Teams/agents
- Tasks/runs
- Workers
- Models
- Capabilities
- Domains
- Knowledge
- Learning
- Business OS
- QA
- Security
- Problems/incidents
- Logs/traces/root cause
- Costs
- Decisions/approvals
- Evidence/reviews
- Deployments
- Backup/migration
- Notifications
- Settings
- Global Kill Switch

## Explainability

Important screens expose:
- Ne?
- Neden?
- Nasıl çalışıyor?
- İlgili dosyalar
- İlgili agent'lar
- İlgili requirement/invariant'lar
- İlgili log/trace
- Founder müdahalesi gerekiyor mu?

Founder-facing explanations are Turkish.

## Automated Review Loop

Desktop exposes:
- Builder: Claude
- Reviewer: Codex
- Mode: Automatic / Semi-Automatic / Manual
- Current review cycle
- Maximum review cycles
- Reviewed commit
- Current blockers
- Review token/cost budget
- Pause / Stop / Require Manual Approval

Founder approval remains mandatory for Risk-5 and other constitution-defined critical actions.


---

# FILE: ERROR-AND-PROBLEM-STANDARD.md

# Error / Problem / Incident Standard

A raw exception is not enough for the Founder.

Each actionable Problem should carry where applicable:

- problemId
- errorCode
- severity
- timestamp
- projectId
- runId
- taskId
- agentId
- service
- environment
- workerId
- commitSha
- correlationId
- traceId
- concise technical message
- Turkish explanation
- probable root cause
- root cause confidence
- related logs/traces
- affected capability
- affected requirement/invariant
- suggested remediation
- remediation risk
- approval requirement
- runbook
- incidentId

Problem Center must support:
- grouping
- deduplication
- correlation
- status lifecycle
- retry/recovery tracking

Preferred diagnostic chain:

ERROR -> PROJECT -> RUN -> TASK -> AGENT -> TOOL -> SERVICE -> TRACE -> COMMIT -> ROOT CAUSE -> INCIDENT -> TEAM -> RUNBOOK -> RECOVERY
