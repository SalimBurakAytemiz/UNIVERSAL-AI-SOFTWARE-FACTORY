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
