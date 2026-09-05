// Baseline section 124 (Logging Everywhere Policy): önerilen alan kümesiyle
// yapılandırılmış (structured) log üretir ve şifre/API anahtarı/erişim
// jetonu gibi gizli alanları ASLA ham haliyle yazmaz (Public Proof E,
// bölüm 307). Bu redaksiyon, log çağrısına ne verilirse verilsin uygulanır
// — çağıran tarafın hatası bile olsa gizli veri dışarı sızmaz.

export interface LogFields {
  readonly environment?: string;
  readonly projectId?: string;
  readonly runId?: string;
  readonly taskId?: string;
  readonly agentId?: string;
  readonly workerId?: string;
  readonly serviceId?: string;
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly eventType: string;
  readonly duration?: number;
  readonly result?: string;
  readonly errorType?: string;
  readonly [extra: string]: unknown;
}

// P1 fix (6th independent review round, "authentication headers leak
// through logging"): the previous fragment list only covered
// application-style secret field names (apiKey, accessToken, ...), not
// standard HTTP/session credential-bearing header and cookie names.
// Substring matching means one fragment usually covers several real-world
// variants (e.g. "authorization" also matches "Proxy-Authorization",
// "cookie" also matches "Set-Cookie", "session" also matches
// "sessionId"/"sessionid") — but hyphen/underscore/no-separator forms of
// the SAME concept ("api-key" vs "api_key" vs "apikey") do NOT contain
// each other as substrings, so each separator variant needs its own entry.
const SENSITIVE_KEY_FRAGMENTS = [
  "password",
  "apikey",
  "api_key",
  "api-key", // also matches "x-api-key"
  "accesstoken",
  "access_token",
  "access-token",
  "refreshtoken",
  "refresh_token",
  "refresh-token",
  "privatekey",
  "private_key",
  "private-key",
  "secret",
  "token", // also matches "bearer token"/"bearerToken"-style field names
  "bearer",
  "credential",
  "authorization", // also matches "Proxy-Authorization" (case-insensitive substring)
  "cookie", // also matches "Set-Cookie"
  "session" // also matches "sessionId"/"sessionid"/"session-id"
];

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/**
 * P2 cross-cutting fix (6th independent review round targeted audit,
 * "prototype-sensitive dictionary keys" — same class as the FileCache
 * `__proto__` finding): `LogFields` is an arbitrary-string-keyed
 * dictionary (`[extra: string]: unknown`). Building `result` as a plain
 * `{}` and assigning via `result[key] = ...` uses `[[Set]]` semantics,
 * which — for a caller-supplied field literally named `__proto__` (e.g.
 * a raw JSON.parse'd request body being logged) — invokes
 * `Object.prototype`'s `__proto__` accessor instead of creating an
 * ordinary own property, silently dropping that field from the log
 * output. `Object.create(null)` has NO inherited accessors at all, so
 * every key (including `__proto__`, `constructor`, `prototype`) becomes
 * an ordinary own data property.
 */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = isSensitiveKey(key) ? "[REDACTED]" : redact(val);
    }
    return result;
  }
  return value;
}

export type LogSink = (line: string) => void;

export class Logger {
  constructor(private readonly sink: LogSink = (line) => console.log(line)) {}

  log(fields: LogFields): void {
    const redacted = redact({ ...fields }) as Record<string, unknown>;
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...redacted });
    this.sink(line);
  }
}
