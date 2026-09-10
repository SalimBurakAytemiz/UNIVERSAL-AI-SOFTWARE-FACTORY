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
/**
 * P2 fix (independent Codex review, "FileStateStore must validate and
 * serialize ONE captured snapshot", finding 9): the PREVIOUS design
 * (`assertNoLossySerialization()`, superseded, kept only in history/
 * comments above) validated the CALLER-OWNED `data` argument by reading
 * its properties directly — a SEPARATE, LATER read from the ALSO-separate
 * `JSON.stringify(data, ...)` call `write()` used to serialize it.
 * Codex reproduced the resulting defect directly: a getter that returns a
 * DIFFERENT value on each access (`first read → NaN, second read → 1`)
 * lets `JSON.stringify()` observe the FIRST (invalid, non-finite) read
 * while `assertNoLossySerialization()`'s later, independent walk observes
 * the SECOND (valid) read — validation and the bytes actually persisted
 * disagreed about which value was ever written: `write()` "succeeded",
 * but the durable file silently contained `null` (JSON's coercion of the
 * NaN `JSON.stringify()` actually saw) for a value validation itself
 * judged perfectly fine. This is a durable-state-integrity violation
 * (baseline section 277, "no claim without evidence" extended to what
 * validation actually proves) even though NEITHER individual check was
 * wrong in isolation — the defect is TWO READS of a value that need not
 * agree, not a bug in either read itself.
 *
 * Fixed by making this the ONE AND ONLY place `data`'s properties/
 * getters are ever read: it walks `value` EXACTLY ONCE, per property,
 * REJECTING (fail closed) anything that cannot be safely captured
 * (non-finite numbers, `undefined` with no safe 'omit' equivalent,
 * functions/symbols/bigint, a non-plain-object instance, a genuine
 * circular reference — bkz. `ancestors` aşağıda) WHILE building a
 * detached, plain-data COPY from those SAME single reads. `write()` below
 * then both "validates" and "serializes" by operating ENTIRELY on this
 * returned snapshot — never on the original, potentially getter-backed
 * `data` again — so there is no longer a SECOND read anywhere in the path
 * that could possibly disagree with the first.
 */
/**
 * `captureSnapshot()`'ın kendi tespit ettiği (dışarıdan yakalanmış GERÇEK
 * bir hata olmayan) her reddetme için — bir senkron `new Error(detail)`
 * her zaman `cause` olarak iliştirilir, böylece `UnserializableStateError`
 * hâlâ "bir temel nedeni korur" sözleşmesini tutar (bkz. bu dosyanın kendi
 * testi, "preserves the underlying cause for a thrown serialization
 * failure") — artık bu neden `JSON.stringify()`'ın kendi native hatası
 * değil, bu fonksiyonun kendi, aynı derecede gerçek doğrulama hatasıdır.
 */
function rejectUnserializable(statePath: string, detail: string): never {
  throw new UnserializableStateError(statePath, new Error(detail), detail);
}

function captureSnapshot(value: unknown, jsonPath: string, statePath: string, canOmit: boolean, ancestors: Set<object>): unknown {
  if (value === null) return null;
  if (value === undefined) {
    if (canOmit) return undefined;
    rejectUnserializable(
      statePath,
      `'${jsonPath}' is undefined in a position with no safe 'omit' equivalent (an array element, or the ` +
        `top-level value itself) — serializing this would silently produce null or lose it, a DIFFERENT value ` +
        `from what was actually captured`
    );
  }
  const type = typeof value;
  if (type === "number") {
    if (!Number.isFinite(value as number)) {
      rejectUnserializable(
        statePath,
        `'${jsonPath}' is a non-finite number (${String(value)}) — serializing this would silently coerce it ` +
          `to null, a DIFFERENT value from what was actually captured`
      );
    }
    return value;
  }
  if (type === "string" || type === "boolean") return value;
  if (type === "object") {
    const objectValue = value as object;
    // P2 fix (finding 9): the OLD design relied on a PRIOR, separate
    // `JSON.stringify(data, ...)` call to already have proven the object
    // graph acyclic before this walk ever ran — that separate call is
    // GONE now (this function is the only pass), so cycle detection must
    // live HERE. `ancestors` tracks the current recursion path (removed
    // on the way back out via `finally`), never every object ever visited
    // — a value legitimately referenced from two DIFFERENT, non-cyclic
    // places (e.g. two array elements pointing at the same shared object)
    // is not a cycle and must not be rejected.
    if (ancestors.has(objectValue)) {
      rejectUnserializable(statePath, `'${jsonPath}' contains a circular reference`);
    }
    if (Array.isArray(objectValue)) {
      ancestors.add(objectValue);
      try {
        // P2 fix (independent review, "reject sparse arrays before
        // persistence", finding 2): `Array.prototype.map()` SKIPS a hole
        // (an index with no own property, e.g. `Array(1)` or
        // `[1, , 3]`) — its callback never runs for that index, so a hole
        // used to pass through this walk WITHOUT ever being read or
        // validated. `JSON.stringify()`, by contrast, always visits every
        // index from 0 to `length - 1` and treats a missing one exactly
        // like an `undefined` array element: silently coerced to the JSON
        // literal `null`. The result was a value that changed shape
        // between validation and the bytes actually written — a hole
        // (`1 in Array(1)` is `false`) becoming a stored `null`
        // (`1 in [null]` is `true`) on the very next `read()`/restart,
        // the same "validation and serialization must observe the SAME
        // captured snapshot" violation this function exists to close.
        // Fixed: iterate every index explicitly and reject (fail closed)
        // the instant a hole is found, rather than silently letting
        // `.map()` step over it.
        const length = objectValue.length;
        const result: unknown[] = new Array(length);
        for (let index = 0; index < length; index++) {
          if (!Object.prototype.hasOwnProperty.call(objectValue, index)) {
            rejectUnserializable(
              statePath,
              `'${jsonPath}[${index}]' is a sparse array hole (no own value at this index) — ` +
                `JSON.stringify() would silently coerce this position to null, a DIFFERENT value from what ` +
                `was actually captured, and there is no genuine value here to validate or persist`
            );
          }
          result[index] = captureSnapshot(objectValue[index], `${jsonPath}[${index}]`, statePath, false, ancestors);
        }
        return result;
      } finally {
        ancestors.delete(objectValue);
      }
    }
    const proto = Object.getPrototypeOf(objectValue);
    if (proto !== Object.prototype && proto !== null) {
      rejectUnserializable(
        statePath,
        `'${jsonPath}' is an instance of '${Object.prototype.toString.call(objectValue)}' rather than a plain ` +
          `object — it cannot be captured faithfully`
      );
    }
    ancestors.add(objectValue);
    try {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(objectValue as Record<string, unknown>)) {
        // Exactly ONE read of this property — whatever it returns (even a
        // getter/Proxy-backed value) is what both validation AND the
        // eventual serialized bytes are based on, permanently.
        const capturedValue = captureSnapshot(
          (objectValue as Record<string, unknown>)[key],
          `${jsonPath}.${key}`,
          statePath,
          true,
          ancestors
        );
        // An omitted (`undefined`) property is left OUT of the snapshot
        // entirely — matching `JSON.stringify({a: undefined})`'s own
        // "{}" behavior (property absence, not a stored null).
        if (capturedValue !== undefined) {
          // P1 fix (independent review, "preserve own __proto__ fields in
          // state snapshots", finding 1): JSON-derived state can
          // legitimately carry an OWN property literally named
          // `"__proto__"` — `Object.keys()` above sees it as an ordinary
          // string key. But `result[key] = capturedValue` for THAT
          // specific key is not an ordinary property write: `result` is a
          // plain object (`Object.prototype` in its chain, no own
          // `"__proto__"` of its own yet), so bracket/dot assignment to
          // `"__proto__"` invokes `Object.prototype`'s legacy `__proto__`
          // ACCESSOR instead of creating an own data property — silently
          // changing `result`'s actual [[Prototype]] (or being ignored
          // entirely, for a value the accessor's setter rejects) rather
          // than storing the value at all. The snapshot returned would
          // then be missing the very property the caller supplied — a
          // durable-state-integrity violation (bölüm 277) identical in
          // shape to the one `runtime/audit/audit-log.ts`'s
          // `canonicalizeAuditValue()` already closed (36th independent
          // review round, finding 9) for the exact same reason.
          // `Object.defineProperty()` always creates/redefines a genuine
          // OWN data property under the exact key given, never consulting
          // any inherited accessor of that name — reused here verbatim
          // rather than inventing a second, differently-scoped rule.
          Object.defineProperty(result, key, {
            value: capturedValue,
            writable: true,
            enumerable: true,
            configurable: true
          });
        }
      }
      return result;
    } finally {
      ancestors.delete(objectValue);
    }
  }
  rejectUnserializable(statePath, `'${jsonPath}' is of unsupported type '${type}'`);
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
    // P2 fix (independent Codex review, "FileStateStore must validate and
    // serialize ONE captured snapshot", finding 9): `data` is read EXACTLY
    // ONCE, here, by `captureSnapshot()` — bkz. onun üstündeki fix notu
    // for the full rationale. Everything below (the round-trip check, the
    // actual bytes written to disk) operates on `snapshot` — a detached,
    // plain-data copy — never on `data` again, so a getter/Proxy-backed
    // value that could answer differently on a second read never gets the
    // chance to.
    const snapshot = captureSnapshot(data, "$", path, false, new Set());

    let serialized: string;
    try {
      const result = JSON.stringify(snapshot, null, 2);
      if (typeof result !== "string") {
        // Unreachable in practice — `captureSnapshot()` already rejects
        // every value `JSON.stringify()` could otherwise silently drop
        // (undefined, functions, symbols) — kept as defense in depth.
        throw new UnserializableStateError(path);
      }
      serialized = result;
    } catch (err) {
      if (err instanceof UnserializableStateError) throw err;
      throw new UnserializableStateError(path, err);
    }

    // Savunma derinliği (defense in depth): `snapshot` is already known-
    // JSON-safe by construction, but this round-trip check remains a
    // cheap, independent proof that the bytes about to be written parse
    // back to valid JSON.
    try {
      JSON.parse(serialized);
    } catch (err) {
      throw new UnserializableStateError(path, err);
    }

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
