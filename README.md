# Universal AI Technology Factory

An in-progress attempt at a cost-optimized "AI technology factory" operating
system: take a founder's idea (or an existing codebase) through discovery,
requirements, architecture, implementation, QA, security, and operations —
with the Human Founder (`@SalimBurakAytemiz`) as final authority throughout.

**This is early-stage.** The full vision is described in
[`specification/UNIVERSAL-AI-SOFTWARE-FACTORY-BASELINE-V1.md`](specification/UNIVERSAL-AI-SOFTWARE-FACTORY-BASELINE-V1.md)
(the frozen Architecture Baseline V1). What actually exists today is a much
smaller **P0 Factory Kernel** — see [Status](#status) below. Please read
that distinction literally: the specification describes intent, not
completion.

## What's implemented today (P0 Factory Kernel)

- **Model routing that prefers the cheapest capable model** and refuses to
  auto-escalate to a premium model without explicit authorization
  (`runtime/models/`).
- **Budget ceilings** that block spending *before* it happens, stopping
  runaway loops (`runtime/budget/`).
- **A policy engine** where every action resolves to `ALLOW` / `DENY` /
  `APPROVAL_REQUIRED`, with risk-5 actions (e.g. production deploys)
  structurally unable to reach `EXECUTED` without an explicit human
  `APPROVE` (`runtime/policy-engine/`).
- **Event-driven activation**: agents/workflows only run when their event
  fires, not on a poll loop (`runtime/event-bus/`).
- **A cache/reuse layer** so identical valid work isn't recomputed
  (`runtime/cache/`).
- **A resource-aware scheduler** that picks the smallest sufficient worker,
  not the biggest available one (`runtime/scheduler/`, `runtime/workers/`).
- **An append-only, hash-chained audit log** for policy decisions
  (`runtime/audit/`).
- **Structured logging that redacts secret-shaped fields** at any nesting
  depth (`runtime/telemetry/`).
- **A machine-readable requirement registry** validated against a JSON
  Schema, plus a CLI that computes baseline status from that data instead of
  asserting it in prose (`specification/requirements/`, `runtime/cli/`).
- **Requirements traceability**: `factory trace requirement` flags any
  requirement whose claimed status (e.g. "unit tested") has zero backing
  evidence — checked against this repo's own registry in CI
  (`runtime/requirements-traceability/`).
- **Project foundations**: Project OS scaffolding, a schema-validated
  Project Genome, a Founder Decision Ledger, an Assumption Register (a
  HIGH-impact assumption can't be accepted without explicit Founder
  confirmation), Technology and Business Capability registries, an
  Organization Composer, an Artifact registry, and a Service/Integration
  catalog (flags services with no recorded owner).
- **A capability gateway and sandbox**: a single enforcement point that
  never runs an action except on an ALLOW from the policy engine, plus
  path-traversal confinement and a promise timeout helper.
- **Project isolation**: a default-deny store so one project's data is
  never reachable from another project's code.
- **An integrated P0 pipeline** (`runtime/project-lifecycle/orchestrator.ts`):
  a real requirement-traceability check gates a validated Project Genome,
  which drives the Organization Composer, whose output is persisted
  alongside a Capability-Gateway-authorized Project OS scaffold, cheapest-
  capable model routing, and durable state — all readable back after a
  simulated process restart. See `proofs/p0-integrated-flow/`.
- **Durable persistence**: a small `StateStore` interface
  (`runtime/state/file-store.ts`) with a JSON-file implementation, used by
  the Decision Ledger, Assumption Register, and the bootstrap pipeline —
  data survives a process restart, not just in-memory.
- **A public-repository secret scanner** with no external dependency,
  wired into CI (`scripts/secret-scan.mjs`).
- **Governance mechanisms** (`runtime/invariants/`, `runtime/governance/`):
  a Central Invariant Guard that new governance actions must pass before
  taking effect; a Scope Lock + Backlog Router giving each phase a
  machine-readable OPEN / LOCKED_FOR_CLOSURE / CLOSED state instead of
  free-text status prose, with every transition recorded in the Founder
  Decision Ledger; a Phase Closure Manifest that structurally rejects
  "tests passed" as sufficient grounds for closure, requiring real
  evidence, a clean invariant report, zero unresolved BLOCKED
  requirements, and an independent review result of exactly `CLEAN`; and
  an Implementation Reality Matrix distinguishing a requirement's claimed
  status from what its evidence actually supports.

All of the above is backed by automated tests — see [Verifying it
yourself](#verifying-it-yourself). None of the P1/P2/P3 phases (general
business platform, games/3D/AI-ML studios, advanced operations) are built
yet.

## Status

Run `npm run build && node dist/runtime/cli/index.js baseline status` for a
live, computed answer. As of this writing:

- 46 P0-scope requirements are tracked, all with real evidence (no bare
  `DEFINED`-only items remain); see
  `specification/requirements/P0-factory-kernel.yml` for exact IDs and
  evidence (`implementation_refs` / `test_refs` / `proof_refs`).
- The full 323-section baseline has **not** been decomposed into individual
  tracked requirements yet — only the P0 phase has. See
  `specification/requirements/README.md`.

## Quick start

**Node.js 24.x (LTS) is this repository's canonical, CI-tested runtime** —
that's what CI (`.github/workflows/ci.yml`) and this session's development
environment run. The locked test AND lint toolchain (Vitest 5, the
`@typescript-eslint` chain) also genuinely supports Node 22.13+ and Node
26+; the exact accepted range is declared in `package.json`'s
`engines.node` and validated automatically (not just presence-checked, and
not just against Vitest — the COMPLETE locked toolchain) by
`node dist/runtime/cli/index.js doctor` below — that check fails closed
(non-zero exit) if your Node version falls outside the declared range or
outside any individual locked dependency's own requirement, so it can't
silently drift from what's documented here.

```bash
npm install
npm run build
node dist/runtime/cli/index.js doctor
node dist/runtime/cli/index.js baseline status
node dist/runtime/cli/index.js routing explain
node dist/runtime/cli/index.js trace requirement
```

## Verifying it yourself

```bash
npm run lint              # ESLint
npm run typecheck         # tsc --noEmit
npm test                  # vitest: unit tests + proofs/
npm run validate:requirements  # schema-validate the requirement registry
npm run secret-scan       # public-repository secret hygiene check
```

`proofs/` contains scenario-level tests for the specific cost/security
invariants the baseline calls out by name (cheapest-capable routing,
premium-fallback blocking, budget ceilings, event-driven activation, cache
reuse, smallest-sufficient-worker selection, human-approval gating, and an
end-to-end P0 scenario combining several of these).

## Repository map

See [`docs/beginner/repository-map-tr.md`](docs/beginner/repository-map-tr.md)
(Turkish) for a plain-language guide to what lives where, per the Human
Founder's requirement that this repository stay understandable without deep
programming background.

## Documentation

- [`specification/BASELINE.md`](specification/BASELINE.md) — baseline
  freeze status and phasing.
- [`specification/requirements/README.md`](specification/requirements/README.md)
  — requirement registry scope and how to read it.
- [`SECURITY.md`](SECURITY.md) — vulnerability reporting and secret hygiene.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — contribution flow and licensing
  status (currently `LICENSE_DECISION_REQUIRED` — see baseline section 206).
- [`CLAUDE.md`](CLAUDE.md) / [`AGENTS.md`](AGENTS.md) — guidance for AI
  coding agents working in this repository.

## License

Not yet decided. See `CONTRIBUTING.md` → Licensing.
