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
- **A public-repository secret scanner** with no external dependency,
  wired into CI (`scripts/secret-scan.mjs`).

All of the above is backed by automated tests — see [Verifying it
yourself](#verifying-it-yourself). None of the P1/P2/P3 phases (general
business platform, games/3D/AI-ML studios, advanced operations) are built
yet.

## Status

Run `npm run build && node dist/runtime/cli/index.js baseline status` for a
live, computed answer. As of this writing:

- 42 P0-scope requirements are tracked; see
  `specification/requirements/P0-factory-kernel.yml` for exact IDs and
  evidence (`implementation_refs` / `test_refs` / `proof_refs`).
- The full 323-section baseline has **not** been decomposed into individual
  tracked requirements yet — only the P0 phase has. See
  `specification/requirements/README.md`.

## Quick start

```bash
npm install
npm run build
node dist/runtime/cli/index.js doctor
node dist/runtime/cli/index.js baseline status
node dist/runtime/cli/index.js routing explain
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
