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
 * P1 fix (28th independent review round, finding 5, "redact credentials
 * embedded inside string values"): everything above this point redacts
 * based ONLY on a field's KEY name (`isSensitiveKey()`) — a caller that
 * logs a perfectly innocuous-sounding field (`description`, `message`,
 * `debugInfo`, a raw HTTP request/response dump) whose STRING VALUE
 * happens to CONTAIN an `Authorization: Bearer ...` header, a bare bearer
 * token, a `user:password@host` URL, or a `password=...`/`api_key: ...`
 * style assignment sailed straight through to the sink completely
 * unredacted — the never-log-secrets guarantee (baseline section 124,
 * Public Proof E section 307) only ever covered the OUTER shape of a log
 * call, never text a caller happened to embed inside an otherwise-ordinary
 * string. Fixed: every STRING value (regardless of which key it lives
 * under, and at ANY nesting depth — `redact()` below routes every string
 * through this) is scanned for these specific secret-shaped patterns and
 * has ONLY the credential-bearing portion replaced with `[REDACTED]`,
 * preserving the surrounding, genuinely useful log text. A key ALREADY
 * flagged sensitive by `isSensitiveKey()` continues to redact its ENTIRE
 * value (the stronger guarantee) rather than being pattern-scanned — this
 * function exists for the field names that `isSensitiveKey()` cannot see
 * are dangerous because the danger lives inside ordinary prose, not the
 * key.
 */
const SECRET_ASSIGNMENT_PATTERN =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|secret|password|credential)(\s*[:=]\s*)(['"]?)([^\s'",;]+)\3/gi;
const URL_USERINFO_PATTERN = /(:\/\/[^/\s:@]+):([^/\s:@]+)@/g;
const AUTHORIZATION_HEADER_PATTERN = /\b(authorization\s*:\s*)(\S+(?:\s+\S+)?)/gi;
const COOKIE_HEADER_PATTERN = /\b(cookie\s*:\s*)(\S+)/gi;
const BARE_BEARER_TOKEN_PATTERN = /\bbearer\s+[A-Za-z0-9\-._~+/]+=*/gi;

function redactSecretsInString(text: string): string {
  return text
    // "Authorization: <scheme> <value...>" — redacts the ENTIRE credential
    // portion after the header name, whatever scheme/format it uses,
    // BEFORE the narrower bare-Bearer pattern below runs (so it is never
    // double-matched/left partially redacted).
    .replace(AUTHORIZATION_HEADER_PATTERN, "$1[REDACTED]")
    // A bare "Bearer <token>" with no preceding "Authorization:" label —
    // e.g. copied directly from a header value into a log message.
    .replace(BARE_BEARER_TOKEN_PATTERN, "Bearer [REDACTED]")
    // "Cookie: <value>" headers (session identifiers, auth cookies).
    .replace(COOKIE_HEADER_PATTERN, "$1[REDACTED]")
    // Common "key = value" / "key: value" secret assignment forms embedded
    // anywhere in a larger string (e.g. inside a logged command line, a
    // dumped config snippet, or a raw request body excerpt).
    .replace(SECRET_ASSIGNMENT_PATTERN, (_match, label: string, sep: string, quote: string) => `${label}${sep}${quote}[REDACTED]${quote}`)
    // Credentials embedded in a URL's userinfo section
    // (`https://user:hunter2@host/...`) — the username is left visible
    // (often not secret, e.g. a service account name), only the password
    // portion is redacted.
    .replace(URL_USERINFO_PATTERN, "$1:[REDACTED]@");
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
/**
 * P1 fix (8th independent review round, "logger serialization hooks
 * bypass credential redaction"): eskiden bir DEĞER fonksiyon ise (ör. bir
 * nesnenin kendi `toJSON()` metodu, own-enumerable bir alan olarak)
 * redact() bunu OLDUĞU GİBİ (dokunmadan) sonuca kopyalıyordu — "hassas bir
 * ANAHTAR değil" diye. Ancak `log()`, son adımda `JSON.stringify()`
 * çağırır; JSON.stringify, serileştirdiği HERHANGİ bir nesnede bir
 * `toJSON` metodu bulursa (own veya inherited, enumerable olsun olmasın —
 * hiç fark etmez), o metodu ÇAĞIRIR ve dönen değeri kullanır — redact()'in
 * ÇOKTAN üretmiş olduğu güvenli, redakte edilmiş temsili TAMAMEN görmezden
 * gelerek. Codex, `toJSON()`'ın taze, hiç redakte edilmemiş
 * `Authorization`/`Cookie` içeriği DÖNDÜRDÜĞÜNÜ ve bunun sink'e ulaştığını
 * gösterdi — redaksiyon SINIRI tamamlandıktan SONRA çalışan bir kanca
 * (hook), gizli veriyi yeniden ORTAYA ÇIKARABİLİYORDU. Fix: redact() artık
 * HER fonksiyon değerini (adı ne olursa olsun — `toJSON`, `toString`
 * override'ı vb.) tamamen ÇIKARIR, sonuca hiç kopyalamaz. Bu, redakte
 * edilmiş ağacın (ve onun her seviyesinin, çünkü her seviye burada
 * yeniden inşa edilir) ASLA çalıştırılabilir bir serileştirme kancası
 * TAŞIMAMASINI garanti eder — `JSON.stringify()`'ın sonradan çağıracağı
 * hiçbir şey kalmaz, redaksiyon NİHAİ yayılan temsilin kendisine uygulanmış
 * olur.
 */
function redact(value: unknown): unknown {
  if (typeof value === "function") {
    return "[FUNCTION_REMOVED]";
  }
  // P1 fix (28th independent review round, finding 5, "redact credentials
  // embedded inside string values"): every string, at any depth, is
  // scanned for the secret-shaped patterns above — see the fix note
  // above `redactSecretsInString()`. This runs BEFORE the key-based check
  // one level up (`isSensitiveKey(key) ? "[REDACTED]" : redact(val)`), so
  // a sensitive KEY's value still gets the stronger full-value redaction;
  // this only ever adds coverage for values under an innocuous-looking
  // key.
  if (typeof value === "string") {
    return redactSecretsInString(value);
  }
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
