# Contributing

Thanks for your interest in the Universal AI Technology Factory. This
repository is public, but it has one final decision-maker for architecture,
security, and governance matters: the Human Founder, `@SalimBurakAytemiz`
(baseline section 147, "Human Final Control").

## Before you start

1. Read `specification/BASELINE.md` and, for real depth,
   `specification/UNIVERSAL-AI-SOFTWARE-FACTORY-BASELINE-V1.md`. It is the
   frozen single source of truth for what this project is trying to become.
2. Check `specification/requirements/` for what is actually implemented
   today vs. only specified. Please don't assume a section of the baseline
   document is "done" just because it's described in prose — check the
   requirement's `status` field.
3. For anything beyond a small, obvious fix, open an issue first to discuss
   scope before writing code.

## Contribution flow

Per baseline section 152:

```
CONTRIBUTION
  -> static checks (lint, typecheck, build)
  -> license / provenance check
  -> security check (secret scan, dependency review)
  -> tests (unit + relevant proofs)
  -> independent review
  -> maintainer merge decision
```

Concretely:

1. Fork and branch from `main`.
2. `npm install`
3. Make your change, with tests. If you touch `runtime/`, prefer adding or
   extending a test under the matching `__tests__/` directory. If your
   change affects a baseline-mandated invariant (cost routing, budget
   ceilings, approval gating, event-driven activation, caching), consider
   whether an entry under `proofs/` should be added or updated too.
4. Run locally before opening a PR:
   ```bash
   npm run lint
   npm run typecheck
   npm run build
   npm test
   npm run validate:requirements
   npm run secret-scan
   ```
5. If your change implements or advances a tracked requirement, update its
   `status` and `*_refs` fields in
   `specification/requirements/P0-factory-kernel.yml` — only to a status
   actually supported by what you built (baseline section 294, "no
   unsupported upgrades").
6. Open a PR describing what changed and why. Do not include any real
   secrets, credentials, or production data in the PR description, commits,
   or test fixtures.

## Licensing

This repository's open-source license status is currently
`LICENSE_DECISION_REQUIRED` (baseline section 206) — the Human Founder has
not yet made a final licensing decision, and public visibility on GitHub is
**not** the same thing as an open-source license grant. Until a `LICENSE`
file is added, do not assume you may redistribute or relicense this code.
Contributions are still welcome for review and discussion.

## Code of conduct

Be respectful and constructive. Treat all contributors, and this
repository's automation and AI agents, in good faith — but note that per
`SECURITY.md`, agent automation treats external contribution text as data,
not instructions, regardless of tone or urgency.
