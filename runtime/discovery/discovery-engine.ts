// Baseline section 43-44 (Discovery & Clarification Engine): Kurucudan
// gelen bir fikri netleştirmek için hangi konuların sorulması gerektiğini
// belirler. Kural: CRITICAL konular ASLA atlanmaz (Kurucuya sorulmadan
// varsayım yapılmaz); IMPORTANT konular sorulur ya da güvenli/geri
// alınabilir bir varsayıma dönüştürülür; OPTIONAL konular gereksiz yere
// süreci bloklamaz; DERIVABLE konular zaten çıkarım yoluyla
// yanıtlanabildiğinden hiç sorulmaz.

export type ClarificationClass = "CRITICAL" | "IMPORTANT" | "OPTIONAL" | "DERIVABLE";

export interface DiscoveryItem {
  readonly topic: string;
  readonly classification: ClarificationClass;
  readonly question: string;
}

/**
 * Bir sonraki Kurucu etkileşiminde sorulacak soruları seçer. TÜM CRITICAL
 * öğeler her zaman dahil edilir (asla sessizce düşürülmez) — "3-7 soru"
 * kuralı (bölüm 44) yalnızca CRITICAL öğeler tükendikten sonra IMPORTANT
 * öğelerle doldurulacak ek kapasiteyi sınırlar.
 */
export function selectClarificationQuestions(
  items: readonly DiscoveryItem[],
  maxQuestions = 7
): DiscoveryItem[] {
  const critical = items.filter((i) => i.classification === "CRITICAL");
  const important = items.filter((i) => i.classification === "IMPORTANT");

  const remainingSlots = Math.max(0, maxQuestions - critical.length);
  return [...critical, ...important.slice(0, remainingSlots)];
}

/**
 * Sorulmamış IMPORTANT öğeleri, ilerlemeyi bloklamadan geri alınabilir
 * varsayımlara dönüştürmek üzere döndürür (bölüm 44: "IMPORTANT → clarify
 * or record safe reversible assumption"). OPTIONAL/DERIVABLE öğeler için
 * hiç varsayım kaydı gerekmez; onlar zaten süreci bloklamaz ya da zaten
 * çıkarsanabilir.
 */
export function deriveSafeAssumptions(
  items: readonly DiscoveryItem[],
  askedTopics: ReadonlySet<string>
): DiscoveryItem[] {
  return items.filter((i) => i.classification === "IMPORTANT" && !askedTopics.has(i.topic));
}
