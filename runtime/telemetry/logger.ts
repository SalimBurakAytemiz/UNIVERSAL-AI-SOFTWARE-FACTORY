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
/**
 * P1 fix (32nd independent review round, finding 2, "redact quoted secrets
 * containing delimiters"): the previous pattern captured the value as a
 * single group `(['"]?)([^\s'",;]+)\3` — an OPTIONAL opening quote followed
 * by a value that itself EXCLUDES whitespace/quote/comma/semicolon, then
 * required the SAME captured quote (`\3`, empty when none was captured) to
 * appear immediately after. For a genuinely quoted value that legitimately
 * CONTAINS one of those excluded characters — `password="two words"`,
 * `API_KEY="abc,def"`, `token="abc;def"`, `secret='value with spaces'` —
 * this could never match at all: the value group cannot consume the
 * delimiter, so it stops short of the closing quote, and the backreference
 * then fails to find that quote immediately following; backtracking to the
 * "no opening quote" alternative fails equally, since the literal quote
 * character sitting right after `=`/`:` is ALSO excluded from the value
 * class. With no possible match, `redactSecretsInString()` leaves the
 * ENTIRE assignment — quotes and secret value both — completely
 * unredacted, exactly the scenario baseline section 124/307 ("never log
 * secrets") forbids. Fixed by giving quoted and unquoted values genuinely
 * SEPARATE alternatives instead of forcing one class to serve both: the
 * quoted branch (`(["'])((?:(?!\3)[^\\]|\\.)*)\3`) matches EVERY character
 * up to — but not including — the matching closing quote of the SAME kind
 * that opened it (so a double-quoted value may freely contain an
 * unescaped `'`, and vice versa; a backslash-escaped quote inside the
 * value is also honored via `\\.`), never stopping early at whitespace/
 * comma/semicolon; the unquoted branch (`[^\s'",;]+`) is preserved
 * VERBATIM for the pre-existing, already-tested unquoted case. `token`
 * (bare, not just `access_token`/`refresh_token`) is also added to the
 * label alternation — the finding's own reproduction scenario names it
 * directly, and it was otherwise the one common credential-shaped label
 * this pattern's alternation did not yet recognize at all.
 */
const SECRET_ASSIGNMENT_PATTERN =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|token|secret|password|credential)(\s*[:=]\s*)(?:(["'])((?:(?!\3)[^\\]|\\.)*)\3|([^\s'",;]+))/gi;
const URL_USERINFO_PATTERN = /(:\/\/[^/\s:@]+):([^/\s:@]+)@/g;
/**
 * P1 fix (29th independent review round, finding 4, "redact complete
 * credential-bearing header values"): this used to be
 * `/\b(authorization\s*:\s*)(\S+(?:\s+\S+)?)/gi` — bounded to AT MOST two
 * whitespace-separated tokens after the header name (a deliberate 28th-
 * round fix for a DIFFERENT problem: the ORIGINAL unbounded
 * `(?:\s+\S+)*` swallowed trailing, unrelated log text sharing the same
 * line, e.g. a URL after `curl -H 'Authorization: Bearer xyz' https://...`).
 * That two-token cap broke multi-component auth schemes Codex reproduced:
 * `Authorization: Digest username="alice", realm="example.com",
 * nonce="xyz", response="..."` and `Authorization: AWS4-HMAC-SHA256
 * Credential=AKIA.../20220830/us-east-1/s3/aws4_request,
 * SignedHeaders=host;x-amz-date, Signature=abcd1234` both have their
 * REAL credential material (the nonce/response/Signature fields) sitting
 * past the second token — completely unredacted. Fixed (29th round): the
 * captured value ran to the first single-quote or newline (or end of
 * string) instead of a fixed token count — `[^'\n]+`.
 *
 * P1 fix (30th independent review round, finding 9, "redact complete
 * header values containing apostrophes"): the 29th round's `[^'\n]+`
 * treated EVERY apostrophe as a hard boundary, on the theory that none of
 * Digest/AWS/NTLM's OWN syntax uses a literal `'` and the only place one
 * could appear was the closing quote of a `curl -H '...'`-style shell
 * invocation. Codex correctly showed this is false whenever the
 * CREDENTIAL VALUE ITSELF legitimately contains an apostrophe — a
 * `Digest username="O'Connor", ..., response="SECRET"` header, or a
 * `Cookie: note=O'Connor; sessionid=SECRET` header, both stopped
 * redacting at the apostrophe INSIDE "O'Connor", leaving the real secret
 * (`response="SECRET"` / `sessionid=SECRET`) sitting in the clear right
 * after it. An apostrophe inside a value is never followed immediately
 * by whitespace/end-of-string/another-quote the way a shell's CLOSING
 * quote always is — in "O'Connor" the `'` sits directly between two
 * letters, whereas the 28th round's `curl -H '...'` case has the closing
 * `'` immediately followed by a space (then unrelated trailing log text).
 * Fixed: the captured value now consumes an apostrophe as ordinary value
 * content whenever it is immediately followed by a letter or digit (the
 * contraction/possessive shape — "O'Connor", "it's", "don't" — never a
 * quote boundary), and still stops at any apostrophe that is NOT
 * followed by a letter/digit (a real closing quote: followed by
 * whitespace, punctuation, or end of string) or at a newline — so both
 * the new apostrophe-in-value case and the 28th/29th rounds' own
 * BLOCKER regressions (shell-quoted curl invocation; multi-component
 * Digest/AWS/Cookie values) continue to pass unchanged.
 */
const AUTHORIZATION_HEADER_PATTERN = /\b(authorization\s*:\s*)((?:[^'\n]|'(?=[A-Za-z0-9]))+)/gi;
/**
 * P1 fix (29th independent review round, finding 4): same fix as
 * `AUTHORIZATION_HEADER_PATTERN` above, for the identical reason — the
 * old `(\S+)` stopped at the FIRST whitespace, so `Cookie: a=abc;
 * sessionid=SECRET` (a real cookie header's own "; "-separated pairs)
 * only ever redacted `a=abc;`, leaving `sessionid=SECRET` — the actual
 * secret — completely in the clear. `\bcookie\b` already matches
 * `Set-Cookie:` too (the character before "Cookie" is a non-word `-`, a
 * genuine word boundary), so this single pattern covers both.
 *
 * P1 fix (30th independent review round, finding 9): same apostrophe-
 * aware boundary fix as `AUTHORIZATION_HEADER_PATTERN` above, for the
 * identical reason (`Cookie: note=O'Connor; sessionid=SECRET`).
 */
const COOKIE_HEADER_PATTERN = /\b(cookie\s*:\s*)((?:[^'\n]|'(?=[A-Za-z0-9]))+)/gi;
const BARE_BEARER_TOKEN_PATTERN = /\bbearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
/**
 * P1 fix (37th independent review round, finding 7, "redact bare,
 * unlabeled provider credential signatures"): every pattern above this
 * point only redacts a credential that is LABELED — preceded by
 * `Authorization:`/`Cookie:`/`Bearer `/`api_key=`/etc., or sitting in a
 * URL's userinfo section. A caller who logs a bare, unlabeled provider
 * credential embedded in otherwise-ordinary prose — an error message
 * ("provider call failed for key sk-proj-abc123..."), a raw result field,
 * a copy-pasted URL/command-output fragment, or a stack trace that
 * happens to include the offending value — has NO label for any existing
 * pattern to anchor on, so the credential sailed straight through
 * completely unredacted despite being immediately, unambiguously
 * recognizable as a real provider secret BY ITS OWN SHAPE alone (an
 * OpenAI/Anthropic `sk-...` key, a GitHub `ghp_.../github_pat_...` token,
 * a Slack `xoxb-...` token, an AWS `AKIA.../ASIA...` access key id). This
 * is the exact same recognizable-format class this repository's OWN
 * `scripts/secret-scan.mjs` already trusts to flag a committed file as a
 * real secret — see its "AWS Access Key ID"/"GitHub token"/"Slack
 * token"/"OpenAI API key"/"Anthropic API key" patterns, mirrored here
 * (assignment- and JSON-shaped variants of these are already covered by
 * `SECRET_ASSIGNMENT_PATTERN` above and by `isSensitiveKey()`'s key-based
 * check — this pattern exists specifically for the BARE, no-label case
 * those two cannot see). `(?<![A-Za-z0-9])` anchors each alternative so
 * it can never match as the tail of a longer, unrelated alphanumeric
 * token (mirrors secret-scan.mjs's own "sk-" boundary fix, which avoids
 * false-triggering on ordinary prose like "...ri`sk-5`-never-weakens...").
 * Runs as an independent extra pass alongside (not instead of) every
 * existing pattern — additive only, nothing previously redacted stops
 * being redacted.
 */
const BARE_PROVIDER_CREDENTIAL_PATTERN =
  /(?<![A-Za-z0-9])(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-(?!ant-)[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16})/g;

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
    // dumped config snippet, or a raw request body excerpt). `quote` is
    // only defined when the QUOTED branch matched (bkz. `SECRET_ASSIGNMENT_PATTERN`'in
    // üstündeki fix notu) — the unquoted branch has no quote characters to
    // preserve around `[REDACTED]`.
    .replace(
      SECRET_ASSIGNMENT_PATTERN,
      (_match, label: string, sep: string, quote: string | undefined) =>
        quote !== undefined ? `${label}${sep}${quote}[REDACTED]${quote}` : `${label}${sep}[REDACTED]`
    )
    // Credentials embedded in a URL's userinfo section
    // (`https://user:hunter2@host/...`) — the username is left visible
    // (often not secret, e.g. a service account name), only the password
    // portion is redacted.
    .replace(URL_USERINFO_PATTERN, "$1:[REDACTED]@")
    // Bare, unlabeled provider credentials recognizable by their own
    // format alone (sk-proj-.../sk-ant-.../ghp_.../github_pat_.../xoxb-.../
    // AKIA.../ASIA...) — see BARE_PROVIDER_CREDENTIAL_PATTERN's fix note.
    .replace(BARE_PROVIDER_CREDENTIAL_PATTERN, "[REDACTED]");
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
    // P2 fix (34th independent review round, finding 8, "preserve logger-
    // generated timestamps"): `timestamp` used to be spread FIRST, then
    // `...redacted` — a caller-supplied `fields.timestamp` (LogFields'
    // `[extra: string]: unknown` index signature accepts any field name,
    // "timestamp" included) would silently OVERWRITE the logger's own
    // authoritative value, since a later object-spread key always wins.
    // This let a caller forge the recorded chronology of its own log line
    // (`logger.log({ timestamp: "1970-01-01T00:00:00.000Z", ... })`)
    // completely undetected. Fixed by reordering: `...redacted` now comes
    // FIRST, and the logger-generated `timestamp` is assigned LAST — any
    // caller-supplied `timestamp` field is unconditionally overwritten by
    // the genuine current time, never the other way around.
    const line = JSON.stringify({ ...redacted, timestamp: new Date().toISOString() });
    this.sink(line);
  }
}
