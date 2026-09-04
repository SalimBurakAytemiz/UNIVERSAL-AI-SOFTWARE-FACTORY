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

const SENSITIVE_KEY_FRAGMENTS = [
  "password",
  "apikey",
  "api_key",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "privatekey",
  "private_key",
  "secret",
  "token",
  "credential"
];

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
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
