// Baseline section 296 (Baseline Coverage Engine): "factory baseline
// status" durumu DÜZYAZI iddialardan değil, specification/requirements/
// altındaki makine-okunur kayıtlardan hesaplar (bölüm 303, "no claim
// without evidence"). Bu dosya, o hesaplamayı yapan saf mantığı içerir;
// dosya sistemi okuma kısmı ayrıca test edilebilsin diye yalın tutulmuştur.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

export interface RequirementRecord {
  readonly id: string;
  readonly category: string;
  readonly status: string;
  readonly [key: string]: unknown;
}

export interface BaselineStatusSummary {
  readonly total: number;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly byCategory: Readonly<Record<string, number>>;
}

export function loadRequirementsFromDir(dir: string): RequirementRecord[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  const all: RequirementRecord[] = [];
  for (const file of files) {
    const content = readFileSync(join(dir, file), "utf8");
    const parsed = yaml.load(content);
    if (Array.isArray(parsed)) {
      all.push(...(parsed as RequirementRecord[]));
    }
  }
  return all;
}

/**
 * P2 targeted-audit fix (8th independent review round, same class as
 * "prototype names crash schema-valid project families" —
 * organization-composer/composer.ts): eskiden `byStatus`/`byCategory` DÜZ
 * nesnelerdi (`Record<string, number> = {}`) ve `byStatus[req.status] =
 * (byStatus[req.status] ?? 0) + 1` ile dolduruluyordu. Bu fonksiyon,
 * `requirements` argümanını YALNIZCA `RequirementRecord[]` (status/category
 * herhangi bir string) olarak tipler — şema doğrulaması (schema.json'daki
 * kapalı enum) BAŞKA bir katmanda (validate-requirements.mjs) uygulanır,
 * BURADA değil; bu fonksiyon doğrudan çağrıldığında (ör. şema kontrolünden
 * geçmemiş bir YAML dosyası, gelecekte eklenecek bir çağıran, veya bir
 * test) `req.status === "constructor"` gibi bir değer, mirasa özgü
 * `Object.prototype.constructor` fonksiyonunu okur — bu `??` ile ASLA
 * yakalanmaz (truthy'dir) ve `fonksiyon + 1` sayısal toplama yerine
 * SESSİZCE string birleştirmeye döner, sayım verisini bozar (bölüm 296,
 * 303 — "no claim without evidence" aracının kendisi hatalı rapor
 * üretemez). Fixed: sayımlar bir `Map` üzerinde tutulur (ASLA prototip
 * zincirinden okumaz), yalnızca dönüş şeklini korumak için sonunda
 * `Object.fromEntries()` ile düz nesneye çevrilir — `Object.fromEntries`,
 * `[[DefineOwnProperty]]` kullanır (`[[Set]]` DEĞİL), bu yüzden
 * `"__proto__"` dahil HER anahtar için her zaman sıradan bir "own" veri
 * özelliği oluşturur, hiçbir accessor'ı tetiklemez.
 */
export function summarizeRequirements(requirements: readonly RequirementRecord[]): BaselineStatusSummary {
  const byStatus = new Map<string, number>();
  const byCategory = new Map<string, number>();

  for (const req of requirements) {
    byStatus.set(req.status, (byStatus.get(req.status) ?? 0) + 1);
    byCategory.set(req.category, (byCategory.get(req.category) ?? 0) + 1);
  }

  return {
    total: requirements.length,
    byStatus: Object.fromEntries(byStatus),
    byCategory: Object.fromEntries(byCategory)
  };
}

export function computeBaselineStatus(requirementsDir: string): BaselineStatusSummary {
  return summarizeRequirements(loadRequirementsFromDir(requirementsDir));
}
