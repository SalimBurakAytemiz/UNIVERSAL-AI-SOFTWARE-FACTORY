# Next Actions

Milestone 1.1: FOUNDER_ATTENTION_REQUIRED. Milestone 1.2 is not active.

1. Restore authorized free reviewer access: opencode-nemotron returns provider HTTP 403 AUTH; other independent free candidates lack credentials. Do not bypass provider restrictions or enable paid routes.
2. Preserve contributors, reviewCycle=3, remediationCount=3 and both FAILED recovery records. Do not repeat review attempts for consumed targets.
3. After access is restored, verify the new local and remote HEAD match, then run:

```powershell
.\scripts\start-full-auto.ps1 -RecoverReview (git rev-parse HEAD) -FounderAuthorized
```

4. Only authentic independent exact-HEAD CLEAN with empty findings permits closure of 1.1 and transition to 1.2. Before full-auto resumes, checkpoint advancement must preserve historical contributor/cycle records; the legacy ADVANCED branch clears active counters/contributors and must not be used to erase this history. No full-auto readiness is claimed while recovery is FAILED.

Türkçe: Provider erişimi düzelmeden komutu çalıştırmak yeni hedefin tek recovery hakkını da tüketir. Mevcut engel varken normal full-auto devam edemez.
