// Baseline section 147/303: dışa döndürülen bir kayıt, iç durumun tek
// sahibi olma ilkesini bozmamalıdır. TypeScript'in `readonly` işaretleyicisi
// yalnızca derleme zamanında (compile-time) bir uyarı sağlar — çalışma
// zamanında (runtime) hiçbir şeyi engellemez; bir çağıran `as any` veya
// düz JavaScript ile döndürülen referansı hâlâ mutasyona uğratabilir. Bu
// modül, "get/all/list" gibi okuma API'lerinden dönen her kaydın, iç
// Map/array'deki gerçek nesneyle AYNI referans olmamasını (kopya) ve o
// kopyanın da (bir üst düzey ve dizi alanları için) donmuş
// (Object.freeze) olmasını sağlar — böylece döndürülen değeri mutasyona
// uğratma girişimi (strict-mode ESM'de olduğu gibi) sessizce yutulmaz,
// TypeError fırlatır.

/**
 * Sığ bir kopya alır, dizi tipindeki alanları da ayrı ayrı donmuş yeni
 * dizilere kopyalar (böylece `record.someArray.push(x)` da engellenir),
 * ve sonucu dondurur. Düz (iç içe nesne içermeyen) kayıt tipleri için
 * yeterlidir — bu depodaki P0 kayıt tipleri (id/string/number/status +
 * en fazla bir seviye string dizisi) bu şekle uyar.
 */
export function freezeRecord<T extends object>(value: T): Readonly<T> {
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of Object.keys(copy)) {
    const fieldValue = copy[key];
    if (Array.isArray(fieldValue)) {
      copy[key] = Object.freeze([...fieldValue]);
    }
  }
  return Object.freeze(copy) as unknown as Readonly<T>;
}

/** `freezeRecord`'un bir dizi üzerinde eleman eleman uygulanmış hali. */
export function freezeRecords<T extends object>(values: readonly T[]): readonly Readonly<T>[] {
  return values.map((v) => freezeRecord(v));
}

/**
 * `freezeRecord`, yalnızca BİR seviye (üst nesne + doğrudan dizi alanları)
 * dondurur — güvenlik kanıtı (audit) gibi, içinde rastgele derinlikte iç
 * içe nesne/dizi barındırabilen (`payload: Record<string, unknown>` gibi)
 * kayıtlar için bu YETERSİZDİR: `record.payload.detay.altAlan = "..."`
 * gibi bir mutasyon hâlâ mümkün kalır. `deepFreeze`, bir nesne grafiğinin
 * HER seviyesini (nesneler ve diziler dahil) özyinelemeli olarak dondurur.
 */
/**
 * P1 fix (37th independent review round, finding 3, "deep-freeze nested
 * provider state under a frozen root"): this used to early-return whenever
 * `Object.isFrozen(value)` was already true for the CURRENT node — treating
 * "the root is frozen" as proof "everything reachable from it is already
 * frozen too." That is false for a caller who did `Object.freeze({nested:
 * {endpoint: "A"}})` themselves before handing the object to this function:
 * `Object.freeze()` is SHALLOW (bkz. `freezeRecord()`'ın üstündeki not, aynı
 * dosyada) — the top-level object is frozen, but `.nested` is a genuinely
 * SEPARATE object that was never itself frozen, so `deepFreeze()` would see
 * `Object.isFrozen(root) === true`, return immediately, and never even look
 * at `.nested` — leaving it silently mutable forever, defeating the entire
 * point of calling `deepFreeze()` in the first place. Fixed by dropping
 * `Object.isFrozen()` as the "already handled" signal entirely and tracking
 * VISITED nodes instead, via a `WeakSet` threaded through the recursion —
 * this still terminates safely on a genuine reference cycle (a node already
 * seen in THIS traversal is skipped, exactly as `Object.isFrozen()` used to
 * prevent infinite recursion for), but no longer treats an already-frozen
 * node as evidence that its OWN children were ever visited. `Object.freeze()`
 * on an already-frozen object is a no-op per spec (never throws), so
 * re-freezing a node this function reaches a second time (from a different,
 * unrelated top-level call) costs nothing beyond the traversal itself.
 *
 * P1 fix (independent Codex review, "traverse symbol keys when
 * deep-freezing configuration"): this used `Object.getOwnPropertyNames()`
 * to enumerate children to recurse into — that call returns STRING own
 * keys ONLY, per spec; it silently skips every symbol-keyed own property.
 * A caller could stash a nested, still-mutable object behind a symbol key
 * (`obj[Symbol("config")] = { endpoint: "A" }`) and this function would
 * freeze the ROOT (`Object.freeze(value)` above IS shallow-safe against
 * new property writes, but does nothing for an EXISTING symbol-keyed
 * property's own nested value) while never even visiting, let alone
 * freezing, that symbol-keyed child — the caller retains a live, writable
 * reference to it and can silently redirect the "already registered"
 * value after the fact, exactly the class of bug `deepFreeze()` exists to
 * close (bkz. yukarıdaki 37th round fix notu, an equivalent gap for
 * already-frozen roots with mutable descendants). Fixed by enumerating via
 * `Reflect.ownKeys()`, which returns BOTH string AND symbol own keys —
 * every child this function can reach is now frozen and recursed into
 * exactly the same way, regardless of which kind of key holds it.
 */
export function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
  }
  return value;
}

/**
 * `structuredClone` ile TAM bir derin kopya alır (çağıranın orijinal nesne
 * grafiğinden tamamen kopuk — hiçbir iç içe nesne/dizi referansı
 * paylaşılmaz) ve sonucu `deepFreeze` ile dondurur. Audit kayıtları gibi
 * "bu asla, hiçbir yoldan, sonradan mutasyona uğratılamamalı" güvenlik
 * kanıtı verileri için kullanılır (bölüm 242). `structuredClone`
 * fonksiyon/sembol gibi seri hale getirilemeyen değerler için doğal olarak
 * fırlatır (fail closed) — bu, audit payload'unun her zaman JSON-uyumlu,
 * seri hale getirilebilir veri olması gerektiği kuralıyla tutarlıdır
 * (hashOf zaten JSON.stringify kullanır).
 */
export function deepFreezeClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}
