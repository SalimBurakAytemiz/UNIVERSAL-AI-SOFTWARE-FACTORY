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
