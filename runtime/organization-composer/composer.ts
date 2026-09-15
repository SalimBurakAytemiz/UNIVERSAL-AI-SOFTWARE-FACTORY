// Baseline section 34 (Project Organization Composer): Proje Genome +
// gereksinimler + risk + iş yetenekleri girdisinden "minimum justified
// project organization" üretir. Kritik kural: her etkinleştirilen bileşen
// için NEDEN etkinleştirildiği kaydedilir (rationale) — hiçbir takım
// "çünkü olabilir" diye eklenmez (bölüm 9, "register everything, activate
// only what is needed"; bölüm 34, "record why every component was
// activated").

import type { ProjectGenome } from "../project-genome/genome.js";

export interface OrganizationCompositionInput {
  readonly projectFamily: string;
  readonly requiredCapabilities: readonly string[];
  readonly risk: number; // 0-5, mirrors PolicyAction.risk
}

export interface OrganizationComposition {
  readonly teams: readonly string[];
  readonly rationale: Readonly<Record<string, string>>;
}

// P2 fix (8th independent review round, "prototype names crash schema-valid
// project families"): eskiden bu bir DÜZ nesne (`Record<string, ...>`) idi
// ve `BASE_TEAMS_BY_FAMILY[input.projectFamily]` ile erişiliyordu. Şema,
// `project.family`'nin herhangi bir string OLMASINI sağlar — "constructor",
// "toString", "__proto__" gibi Object.prototype üzerinde ZATEN VAR OLAN
// isimler de şema-geçerli değerlerdir. Codex, `BASE_TEAMS_BY_FAMILY
// ["constructor"]`'ın (bu anahtar hiç TANIMLANMAMIŞ olsa bile) MİRAS ALINAN
// `Object` fonksiyonunu DÖNDÜRDÜĞÜNÜ, bunun `?? DEFAULT_BASE_TEAMS` ile asla
// yakalanmadığını (çünkü truthy bir değerdir, `undefined`/`null` değil) ve
// `new Set(inheritedFunctionValue)`'nin (fonksiyonlar yinelenebilir/
// iterable DEĞİLDİR) bootstrap sırasında bir TypeError ile ÇÖKTÜĞÜNÜ
// gösterdi — aynı sınıf "__proto__" (Object.prototype'ın kendisi, yine
// iterable değil) ve "toString" için de geçerlidir. Fixed: arama artık bir
// `Map` üzerinden yapılır — `Map.get()`/`.has()` YALNIZCA kendi dahili
// hash tablosuna bakar, ASLA JavaScript prototip zincirinden okumaz; bu
// yüzden "constructor"/"toString"/"__proto__"/"prototype" dahil HERHANGİ
// bir string anahtar, tanımlı değilse her zaman `undefined` döner (ve
// dokümante edilmiş yedek davranış — DEFAULT_BASE_TEAMS — devreye girer),
// asla mirasa özgü bir değer değil.
const BASE_TEAMS_BY_FAMILY: ReadonlyMap<string, readonly string[]> = new Map([
  ["web", ["web", "backend", "qa"]],
  ["backend", ["backend", "qa"]],
  ["api", ["backend", "qa"]],
  ["saas", ["web", "backend", "qa"]],
  ["ecommerce", ["web", "backend", "qa"]],
  ["mobile", ["mobile", "backend", "qa"]],
  ["desktop", ["desktop", "qa"]],
  ["game", ["game", "qa"]],
  ["multiplayer_game", ["game", "backend", "qa"]],
  ["mmorpg", ["game", "backend", "qa"]],
  ["cli", ["backend", "qa"]],
  ["library", ["backend", "qa"]]
]);

const DEFAULT_BASE_TEAMS: readonly string[] = ["backend", "qa"];

// Belirli iş yetenekleri, spesifik takımların etkinleştirilmesini zorunlu
// kılar (örn. ödeme -> güvenlik ekibi). Bu eşleme, "her bileşenin neden
// etkinleştirildiği" sorusuna somut bir cevap verir.
const CAPABILITY_REQUIRES_TEAM: ReadonlyArray<{ capability: string; team: string; reason: string }> = [
  { capability: "payments", team: "security", reason: "Payments capability requires Security team involvement" },
  { capability: "anti-cheat", team: "security", reason: "Anti-cheat capability requires Security team involvement" },
  { capability: "identity", team: "security", reason: "Identity/authentication requires Security team review" }
];

export function composeOrganization(input: OrganizationCompositionInput): OrganizationComposition {
  const teams = new Set<string>(BASE_TEAMS_BY_FAMILY.get(input.projectFamily) ?? DEFAULT_BASE_TEAMS);
  const rationale: Record<string, string> = {};

  for (const team of teams) {
    rationale[team] = `Baseline team for project family '${input.projectFamily}'`;
  }

  for (const capability of input.requiredCapabilities) {
    const rule = CAPABILITY_REQUIRES_TEAM.find((r) => r.capability === capability);
    if (rule && !teams.has(rule.team)) {
      teams.add(rule.team);
      rationale[rule.team] = rule.reason;
    }
  }

  // Yüksek risk (>=4), açıkça bir sebep gerektirse de, Security ekibinin
  // sürece dahil olmasını zorunlu kılar (bölüm 115, "Security Everywhere").
  if (input.risk >= 4 && !teams.has("security")) {
    teams.add("security");
    rationale.security = `Risk level ${input.risk} (>=4) requires Security team involvement`;
  }

  return { teams: [...teams], rationale };
}

/**
 * Project Genome'u (bölüm 27) doğrudan Organization Composer'a bağlar.
 * Genome'un `business.capabilities` alanı gerekli yetenekler olarak,
 * `project.family` proje ailesi olarak kullanılır. `risk` Genome'un bir
 * parçası değildir (şema bunu henüz modellemiyor) — çağıran taraf ayrı
 * bir risk sınıflandırmasından (ör. Discovery/Policy) geçirebilir;
 * verilmezse muhafazakar bir varsayılan (1) kullanılır.
 */
export function composeOrganizationFromGenome(genome: ProjectGenome, risk = 1): OrganizationComposition {
  return composeOrganization({
    projectFamily: genome.project.family,
    requiredCapabilities: genome.business?.capabilities ?? [],
    risk
  });
}
