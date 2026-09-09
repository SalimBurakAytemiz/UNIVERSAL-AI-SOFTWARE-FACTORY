// Baseline section 275 (State Store): "Interface-first. Initial candidate:
// SQLite. Future: PostgreSQL." P0 aşamasında ek bir native bağımlılık
// (SQLite derleme gereksinimi vb.) eklemeden gerçek bir kalıcılık
// sağlamak için, bu arayüzün ilk somut uygulaması düz JSON dosyalarıdır.
// StateStore arayüzü sabit kaldığı sürece, ileride bu sınıf SQLite/
// PostgreSQL tabanlı bir uygulamayla DEĞİŞTİRİLEBİLİR — çağıran kodun
// (ör. runtime/project-lifecycle) hiçbir satırı değişmez.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

export interface StateStore {
  write(path: string, data: unknown): void;
  read<T>(path: string): T | undefined;
  exists(path: string): boolean;
}

/**
 * P2 fix (14th independent review round, "reject unserializable state
 * before replacing valid durable state"): Codex reproduced
 * `JSON.stringify(data, null, 2)` returning `undefined` (WITHOUT
 * throwing) for `data === undefined` itself, a function, a symbol, or an
 * object whose own `toJSON()` returns `undefined` — the old code
 * interpolated that `undefined` return value directly into a template
 * literal (`` `${JSON.stringify(...)}\n` ``), which JS silently coerces
 * to the FOUR-CHARACTER TEXT STRING `"undefined"`. That text is not
 * valid JSON, but the old code wrote it to the temp file and
 * `renameSync`'d it over the destination anyway — atomically replacing a
 * previously VALID durable state file with unparseable garbage. A
 * subsequent `read()` then throws a `SyntaxError` with NO way to recover
 * the prior state, a direct violation of "invalid new state must never
 * destroy previously valid durable state" (bölüm 277).
 */
export class UnserializableStateError extends Error {
  constructor(path: string, cause?: unknown, detail?: string) {
    super(
      `Refusing to write state to '${path}': the provided value does not serialize to valid JSON` +
        (detail
          ? ` (${detail})`
          : ` (this happens for 'undefined' itself, a function, a symbol, an object whose toJSON() returns ` +
            `undefined, a circular reference, or a value JSON cannot represent such as a BigInt)`) +
        `. The previous durable state at this path, if any, was left completely untouched — nothing was ever ` +
        `written or renamed.`,
      { cause }
    );
    this.name = "UnserializableStateError";
  }
}

/**
 * P2 fix (35th independent review round, finding 9, "reject lossy state
 * serialization"): the checks above only ever caught the cases where
 * `JSON.stringify()` either THROWS (circular reference, BigInt) or
 * silently returns the non-string value `undefined` for the value being
 * serialized AS A WHOLE (the top-level value is `undefined`/a function/a
 * `toJSON()` returning `undefined`). Codex reproduced a materially
 * different, quieter class of the same underlying defect: `JSON.stringify`
 * neither throws NOR returns `undefined` for a value NESTED somewhere
 * inside an otherwise-normal object/array that contains `NaN`/`Infinity`/
 * `-Infinity` (silently coerced to the JSON literal `null`) or an
 * `undefined` ARRAY ELEMENT (also silently coerced to `null`) — both
 * writes SUCCEED, but the durable state that lands on disk is NOT the
 * same value the caller thought it was persisting: a reservation amount
 * of `NaN` (a genuine, already-rejected-elsewhere invalid value, bkz.
 * `cost/cost-engine.ts`'in kendi doğrulamaları) or a legitimate `Infinity`
 * ceiling could silently become `null` on disk, and a subsequent
 * `read()`/restart would observe a DIFFERENT value than was ever
 * genuinely written — `deserialize(serialize(value))` no longer equals
 * `value`, the exact "no claim without evidence"/durable-state-integrity
 * violation baseline section 277/303 forbids, just for state read BACK
 * rather than state overwritten. Fixed: after confirming the value
 * serializes AT ALL (the existing checks above, unchanged — a genuinely
 * circular reference is caught there FIRST, so this walk below never
 * needs its own cycle detection: `JSON.stringify` succeeding already
 * proves `data`'s object graph is acyclic), `assertNoLossySerialization()`
 * recursively re-walks the SAME original `data` and rejects any node
 * whose `JSON.stringify` representation would NOT be semantically
 * equivalent to the original: a non-finite number anywhere, an `undefined`
 * ARRAY element (no safe "omit" equivalent — unlike an object property,
 * every array index must hold SOME value, and `null` is already a
 * legitimate, DIFFERENT value an array can genuinely contain), a function/
 * symbol/bigint anywhere, or an instance of anything other than a plain
 * object (`Map`/`Set`/`Date`/`RegExp`/a class instance — none of which
 * `JSON.stringify()` represents faithfully; the SAME "only a genuine plain
 * object, recursively" contract `runtime/audit/audit-log.ts`'s own
 * `canonicalizeAuditValue()` already established for exactly this reason,
 * reused here rather than inventing a second, differently-scoped rule).
 * An `undefined` OBJECT PROPERTY value is deliberately the ONE exception,
 * left un-rejected: `JSON.stringify({a: undefined})` produces `"{}"` (the
 * key is OMITTED, not coerced to `null`), and `JSON.parse("{}").a` is ALSO
 * `undefined` (via ordinary property absence) — the round trip is
 * genuinely lossless from the caller's observable point of view
 * (`value.a === undefined` both before and after), unlike the array/
 * top-level cases above. This exception matters in practice: several
 * existing, legitimate P0 durable-state shapes (e.g.
 * `runtime/cost/cost-engine.ts`'s persisted `CostEntry`/reservation scope
 * objects, whose optional `agentId`/`projectId`/`runId` fields are
 * assigned directly from a caller-supplied value that is often genuinely
 * `undefined`) already rely on exactly this "an unset optional field is an
 * `undefined`-valued own property" convention — rejecting it outright
 * would fail closed for a case that is not actually lossy, breaking
 * ordinary, already-correct persistence for no integrity benefit (the same
 * reasoning `audit-log.ts`'s own 33rd-round fix note documents for its
 * identical design choice).
 */
function assertNoLossySerialization(value: unknown, jsonPath: string, statePath: string, canOmit: boolean): void {
  if (value === null) return;
  if (value === undefined) {
    if (canOmit) return;
    throw new UnserializableStateError(
      statePath,
      undefined,
      `'${jsonPath}' is undefined in a position with no safe 'omit' equivalent (an array element, or the ` +
        `top-level value itself) — JSON.stringify() would silently turn this into null, a DIFFERENT value ` +
        `from what was actually written`
    );
  }
  const type = typeof value;
  if (type === "number") {
    if (!Number.isFinite(value as number)) {
      throw new UnserializableStateError(
        statePath,
        undefined,
        `'${jsonPath}' is a non-finite number (${String(value)}) — JSON.stringify() would silently coerce it ` +
          `to null, a DIFFERENT value from what was actually written`
      );
    }
    return;
  }
  if (type === "string" || type === "boolean") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoLossySerialization(item, `${jsonPath}[${index}]`, statePath, false));
    return;
  }
  if (type === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new UnserializableStateError(
        statePath,
        undefined,
        `'${jsonPath}' is an instance of '${Object.prototype.toString.call(value)}' rather than a plain ` +
          `object — JSON.stringify() does not represent it faithfully`
      );
    }
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      assertNoLossySerialization(nested, `${jsonPath}.${key}`, statePath, true);
    }
    return;
  }
  throw new UnserializableStateError(statePath, undefined, `'${jsonPath}' is of unsupported type '${type}'`);
}

/**
 * JSON dosyalarına yazan basit, senkron, bağımlılıksız bir StateStore
 * uygulaması. Sadece in-memory tutmanın aksine, süreç yeniden başlasa
 * bile veri kaybolmaz (bölüm 277, "Durable State / Resume").
 *
 * P2 fix (8th independent review round, "failed state writes destroy
 * previous recoverable state"): eskiden `write()` DOĞRUDAN hedef dosyaya
 * yazıyordu (`writeFileSync(path, ...)`). Codex, gerçek bir yazma
 * hatasıyla (ör. EFBIG/dosya-boyutu sınırı) şunu gösterdi: geçerli bir
 * durum dosyası ZATEN varken, yazma YARIDA kesilirse, önceki geçerli dosya
 * KISMİ/BOZUK bir JSON ile YER DEĞİŞTİRİR — bir sonraki süreç `read()`
 * çağırdığında `JSON.parse` bir SyntaxError fırlatır ve DURUM TAMAMEN
 * KURTARILAMAZ hale gelir. Bu, "kalıcı durum" (bölüm 277) sözleşmesinin
 * doğrudan ihlalidir: BAŞARISIZ bir yazma, bilinen-son-iyi durumu ASLA yok
 * etmemelidir. Fixed: klasik atomik-yazma deseni — (1) tam içerik önce
 * AYNI dizindeki GEÇİCİ bir kardeş (sibling) dosyaya yazılır (yeniden
 * adlandırmanın atomik olabilmesi için AYNI dosya sistemi/dizinde
 * olmalıdır — çapraz-dosya-sistemi rename varsayımından kaçınılır), (2)
 * yalnızca bu yazma TAMAMEN başarılı olursa `renameSync` ile hedefin
 * ÜZERİNE atomik olarak taşınır (POSIX rename() bir tek syscall'dır — okuyan
 * bir süreç ASLA yarı-yazılmış bir dosya GÖRMEZ, ya eski içeriği ya da
 * tamamen yeni içeriği görür), (3) geçici dosyaya yazma BAŞARISIZ olursa,
 * hedef dosyaya HİÇ DOKUNULMAZ (eski, geçerli içerik olduğu gibi kalır) ve
 * yarım kalan geçici dosya best-effort temizlenir (temizleme kendisi
 * başarısız olsa bile orijinal hata olduğu gibi fırlatılmaya devam eder —
 * temizleme hatası asıl yazma hatasını ASLA gizlemez).
 */
export class FileStateStore implements StateStore {
  write(path: string, data: unknown): void {
    // Herhangi bir dosya sistemi eylemi (dizin oluşturma dahil) başlamadan
    // ÖNCE: yeni durumun GERÇEKTEN geçerli JSON'a serileştirilebildiği
    // doğrulanır — bkz. `UnserializableStateError`'ın üstündeki fix notu.
    // `JSON.stringify` fırlatabilir (döngüsel referans, BigInt) VEYA
    // sessizce `undefined` DÖNDÜREBİLİR (fırlatmadan) — ikisi de burada
    // AYNI, tipli hataya sarılır ve hedef dosyaya HİÇ dokunulmadan
    // fırlatılır.
    let serialized: string;
    try {
      const result = JSON.stringify(data, null, 2);
      if (typeof result !== "string") {
        throw new UnserializableStateError(path);
      }
      serialized = result;
    } catch (err) {
      if (err instanceof UnserializableStateError) throw err;
      throw new UnserializableStateError(path, err);
    }

    // Savunma derinliği (defense in depth): bir replacer/reviver
    // KULLANILMADIĞI için `JSON.stringify`'ın bir dize DÖNDÜRMESİ zaten
    // dil düzeyinde "bu dize geçerli JSON'dur" garantisidir — ama
    // gelecekte bir replacer eklenirse bile bu round-trip doğrulaması
    // koruma sağlar, ve maliyeti ihmal edilebilir düzeydedir.
    try {
      JSON.parse(serialized);
    } catch (err) {
      throw new UnserializableStateError(path, err);
    }

    // P2 fix (35th independent review round, finding 9, "reject lossy
    // state serialization"): bkz. `assertNoLossySerialization()`'ın
    // üstündeki fix notu. Runs over the ORIGINAL `data` (never the
    // already-produced `serialized` text, which by definition cannot
    // distinguish "a genuine null" from "a NaN silently coerced to
    // null") — safe from infinite recursion on a circular reference
    // because `JSON.stringify()` above already succeeded, which is only
    // possible for an acyclic object graph.
    assertNoLossySerialization(data, "$", path, true);

    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    const tempPath = join(dir, `.${basename(path)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
    try {
      writeFileSync(tempPath, `${serialized}\n`, "utf8");
      renameSync(tempPath, path);
    } catch (err) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup only — a leftover temp file is harmless
        // (never read as authoritative state), and its cleanup failing
        // must never mask the original write error below.
      }
      throw err;
    }
  }

  read<T>(path: string): T | undefined {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  }

  exists(path: string): boolean {
    return existsSync(path);
  }
}
