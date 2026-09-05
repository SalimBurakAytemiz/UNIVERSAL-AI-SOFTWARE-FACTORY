// Baseline section 69 (Cost Engine): her görev/ajan/model/sağlayıcı
// çağrısının maliyeti izlenir. "Sessiz harcama yok" ilkesi (bölüm 147)
// burada başlar — bir tutar bu motora kaydedilmeden harcanmış sayılmaz.

import { freezeRecord } from "../util/immutable.js";

export class InvalidMonetaryAmountError extends Error {
  constructor(context: string, amount: number) {
    super(
      `Invalid monetary amount in ${context}: ${amount}. Amounts must be finite and ` +
        `non-negative — NaN, Infinity, -Infinity, and negative values are all rejected. ` +
        `A negative amount is not a discount or refund; those require an explicitly ` +
        `modeled refund/credit operation, never a negative amountUsd.`
    );
    this.name = "InvalidMonetaryAmountError";
  }
}

/**
 * Para tutarlarının HER yerde (CostEngine.record, BudgetGuard) aynı
 * kuralla doğrulanması için tek kaynak: sonlu (finite) ve negatif olmayan
 * olmalıdır. NaN bir kez sızarsa toplamlar kalıcı olarak "zehirlenir"
 * (NaN + x = NaN) ve bütçe karşılaştırmaları (`NaN > limit` HER ZAMAN
 * false döner) sessizce geçer — bu yüzden hiçbir duruma dokunulmadan ÖNCE
 * reddedilir (fail closed).
 */
export function assertValidMonetaryAmount(amount: number, context: string): void {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new InvalidMonetaryAmountError(context, amount);
  }
}

/**
 * P2 fix (8th independent review round, "floating-point comparisons reject
 * exact budget spend"): Codex, `0.10` sonra `0.20` harcanıp $0.30'luk bir
 * tavana karşı kontrol edildiğinde, JavaScript'in ikili kayan noktalı
 * toplamasının `0.30000000000000004` ÜRETTİĞİNİ ve bu değerin `0.3`'ten
 * BÜYÜK olduğu için (`projected > limit`) TAM TAVAN harcamasının YANLIŞLIKLA
 * REDDEDİLDİĞİNİ gösterdi — bu, dört bütçe tavanının (perTaskUsd, perRunUsd,
 * dailyUsd, monthlyUsd) TAMAMINDA tekrarlanan aynı hatadır (runtime/budget/
 * budget.ts). Fix, RASGELE/dağınık bir epsilon DEĞİL — TEK, merkezi,
 * belgelenen bir hassasiyet POLİTİKASI kullanır: her tutar, karşılaştırmadan
 * ÖNCE `MONETARY_PRECISION_SCALE` (mikro-dolar, $0.000001 — hem sıradan
 * sent-düzeyi harcamayı GÜVENLE kapsar hem de token-başına milyonda birkaç
 * dolarlık model fiyatlandırması gibi daha ince taneli P0 fiyatlarını
 * bozmaz) ile TAM SAYI birimlere yuvarlanır (`Math.round`), ve karşılaştırma
 * bu İKİ TAM SAYI üzerinde yapılır — tam sayı karşılaştırması, kayan
 * noktalı birikim gürültüsünden (`0.1 + 0.2 !== 0.3` sınıfı) yapısal olarak
 * ETKİLENMEZ. Bu fonksiyon, dört bütçe tavanının HEPSİ için (ve gelecekte
 * eklenecek her kümülatif parasal karşılaştırma için) TEK kaynak olarak
 * kullanılmalıdır — her karşılaştırma noktasında ayrı ayrı icat edilen bir
 * epsilon/tolerans DEĞİL.
 */
export const MONETARY_PRECISION_SCALE = 1_000_000;

function toMonetaryUnits(amountUsd: number): number {
  return Math.round(amountUsd * MONETARY_PRECISION_SCALE);
}

/**
 * `a`'nın, Factory'nin sabit parasal hassasiyetinde (bkz.
 * `MONETARY_PRECISION_SCALE`) `b`'yi GERÇEKTEN aşıp aşmadığını döndürür —
 * TAM tavan harcaması (`a === b` niyetiyle) ikili kayan nokta gürültüsü
 * yüzünden asla yanlışlıkla `true` dönmez.
 */
export function exceedsMonetaryAmount(a: number, b: number): boolean {
  return toMonetaryUnits(a) > toMonetaryUnits(b);
}

export interface CostEntry {
  readonly taskId: string;
  readonly agentId?: string;
  readonly projectId?: string;
  readonly provider: string;
  readonly modelId: string;
  readonly amountUsd: number;
  readonly timestamp: string;
}

export interface CostScope {
  readonly taskId?: string;
  readonly agentId?: string;
  readonly projectId?: string;
}

export class CostEngine {
  private readonly entries: CostEntry[] = [];

  /**
   * `now` enjekte edilebilir bir saat fonksiyonudur — varsayılan olarak
   * gerçek zamanı kullanır, ancak testler (özellikle günlük/aylık bütçe
   * sıfırlanma senaryoları) belirli bir ana "sabitlenmiş" kayıtlar
   * üretebilmek için bunu değiştirebilir (bkz. runtime/budget/budget.ts).
   */
  constructor(private readonly now: () => Date = () => new Date()) {}

  record(entry: Omit<CostEntry, "timestamp">): CostEntry {
    // Doğrudan record() çağrıları da (BudgetGuard'ı atlayan çağrılar dahil)
    // korunur — bozuk bir tutarın toplamlara sızmasına asla izin verilmez.
    assertValidMonetaryAmount(entry.amountUsd, `CostEngine.record(taskId=${entry.taskId})`);
    const full: CostEntry = { ...entry, timestamp: this.now().toISOString() };
    // İç diziye eklenen nesne İLE dışarı döndürülen nesne KASITLI OLARAK
    // aynı referans DEĞİLDİR: çağıran döndürülen kaydı (ör. amountUsd'yi
    // NaN'a) mutasyona uğratsa bile, iç toplamlar (total/totalFor/
    // totalInWindow) her zaman motorun kendi, asla dışarı sızmamış
    // kopyasını okur. Object.freeze, bu ayrımın atlanamamasını (örn.
    // "as any" ile alan ataması) TypeError'a çevirerek garanti eder.
    this.entries.push(full);
    return freezeRecord(full);
  }

  all(): readonly CostEntry[] {
    return this.entries.map((e) => freezeRecord(e));
  }

  /** Belirli bir kapsam (görev/ajan/proje) için toplam maliyeti hesaplar. */
  totalFor(scope: CostScope): number {
    return this.entries.filter((e) => matchesScope(e, scope)).reduce((sum, e) => sum + e.amountUsd, 0);
  }

  total(): number {
    return this.entries.reduce((sum, e) => sum + e.amountUsd, 0);
  }

  /**
   * Belirli bir kapsam VE zaman penceresi (sinceIso'dan itibaren) için
   * toplam maliyeti hesaplar. Günlük/aylık bütçe tavanlarının (bölüm 70-72)
   * gerçekten "dönemsel" olabilmesi için gereken temel sorgu budur — ISO
   * 8601 zaman damgaları sözlüksel (string) karşılaştırmayla doğru sırada
   * olduğundan basit bir string karşılaştırması yeterlidir.
   */
  totalInWindow(scope: CostScope, sinceIso: string): number {
    return this.entries
      .filter((e) => matchesScope(e, scope) && e.timestamp >= sinceIso)
      .reduce((sum, e) => sum + e.amountUsd, 0);
  }
}

function matchesScope(entry: CostEntry, scope: CostScope): boolean {
  return (
    (scope.taskId === undefined || entry.taskId === scope.taskId) &&
    (scope.agentId === undefined || entry.agentId === scope.agentId) &&
    (scope.projectId === undefined || entry.projectId === scope.projectId)
  );
}
