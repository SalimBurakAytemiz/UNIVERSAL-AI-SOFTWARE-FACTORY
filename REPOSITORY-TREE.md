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
