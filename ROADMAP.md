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
