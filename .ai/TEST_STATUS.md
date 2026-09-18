# Test Status

Not executed yet. Phase 0 will establish and run the initial test toolchain.

## Day-zero supervisor extension — 2026-09-17

Automation-only deterministic checks: 44 tests PASS, including real temporary local
Git push/SHA verification/ff-only/divergence tests and mocked complete milestone flow.
JavaScript syntax and JSON/policy validation: PASS.
Live tool-free health probes: Claude, OpenCode Union Alpha Free, MiMo V2.5 Free,
Nemotron 3 Ultra Free, and Codex gpt-5.6-sol responded successfully.
NVIDIA NIM/OpenRouter remain REGISTERED / INACTIVE / NO_CREDENTIAL.
Final real entry-point check: Claude, Codex, MiMo and Nemotron HEALTHY;
Union Alpha timed out on the later probe and was correctly QUARANTINED with retryAt.
No milestone implementation, GitHub push, independent code CLEAN or phase closure
was performed by these checks. Current phase/milestone remains unchanged.

## Recovery mechanism — 2026-09-18

Executed on the local working tree based on 232d7ff585ae8b9e92ee2c0868239bf576a25f88:
- node scripts/validate-automation.mjs: PASS, 54 deterministic tests plus syntax/config/policy/JSON checks.
- npm run validate:specification: PASS.
- npm run lint: PASS.
- npm run typecheck: PASS.
- npm test: PASS, 14 registry tests + 1 foundation test.
- npm run build: PASS.

Initial sandbox test process failed to spawn (EPERM); authorized execution outside the sandbox passed. These results are local execution observations, not independent review attestations. Runtime counters and previous audit were not modified.

## Independent HEALTHY fallback — 2026-09-18

Executed locally before the fallback commit:
- node scripts/validate-automation.mjs: PASS, 65 deterministic tests, syntax/config/policy/JSON validation.
- npm run validate:specification: PASS.
- npm run lint: PASS.
- npm run typecheck: PASS.
- npm test: PASS, 14 registry tests and 1 foundation test.
- npm run build: PASS.
- Repository.scanSecrets(): PASS.

Tests cover independent Codex, OpenAI exclusion, preferred Nemotron, healthy alternative after Nemotron failure, cross-provider family exclusion, unavailable candidates, BLOCKED, provenance tampering, replay rejection and preserved 3/3 counters. Mock review results are tests only; live review remains separate.

Live recovery follow-up: PASS read-only regression on a copy of actual runtime proves unchanged contributors, prior recovery records, review records and 3/3 counters. Full-auto stops at the exhausted-cycle guard without writes or model calls. Live review did not complete; see REVIEW_STATUS.md.

## Infrastructure-only retry and NVIDIA NIM — 2026-09-18

Executed on the pre-commit working tree:
- node scripts/validate-automation.mjs: PASS, 75 deterministic tests plus syntax/config/policy/JSON validation.
- npm run validate:specification: PASS.
- npm run lint: PASS.
- npm run typecheck: PASS.
- npm test: PASS, 14 registry + 1 foundation test.
- npm run build: PASS.
- Repository.scanSecrets(): PASS.
- Actual pinned OmniRoute NVIDIA Nemotron health inference: PASS; model nvidia/nemotron-3-super-120b-a12b. This is availability evidence only.

Tests cover immutable previous-attempt audit, explicit retry authorization, one retry maximum, CLEAN/BLOCKED/STARTED denial, legacy no-invocation gate, decision receipt before acceptance, NIM free-tier opt-in, credential isolation, exact/wildcard alias protection and preserved lifetime counters after milestone advancement.

## NIM JSON response regression — 2026-09-18
Automation tests: 76 PASS. Registry validation and 14 registry tests: PASS. Foundation test: 1 PASS. Lint, typecheck, build and secret scan: PASS. Actual NIM JSON-mode nonce health: PASS. Malformed JSON and incorrect nonce remain rejected. Prior recovery and retry audits were not modified.

