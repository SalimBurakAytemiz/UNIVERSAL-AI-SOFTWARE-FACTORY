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
