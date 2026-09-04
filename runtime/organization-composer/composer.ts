// Baseline section 34 (Project Organization Composer): Proje Genome +
// gereksinimler + risk + iş yetenekleri girdisinden "minimum justified
// project organization" üretir. Kritik kural: her etkinleştirilen bileşen
// için NEDEN etkinleştirildiği kaydedilir (rationale) — hiçbir takım
// "çünkü olabilir" diye eklenmez (bölüm 9, "register everything, activate
// only what is needed"; bölüm 34, "record why every component was
// activated").

export interface OrganizationCompositionInput {
  readonly projectFamily: string;
  readonly requiredCapabilities: readonly string[];
  readonly risk: number; // 0-5, mirrors PolicyAction.risk
}

export interface OrganizationComposition {
  readonly teams: readonly string[];
  readonly rationale: Readonly<Record<string, string>>;
}

const BASE_TEAMS_BY_FAMILY: Readonly<Record<string, readonly string[]>> = {
  web: ["web", "backend", "qa"],
  backend: ["backend", "qa"],
  api: ["backend", "qa"],
  saas: ["web", "backend", "qa"],
  ecommerce: ["web", "backend", "qa"],
  mobile: ["mobile", "backend", "qa"],
  desktop: ["desktop", "qa"],
  game: ["game", "qa"],
  multiplayer_game: ["game", "backend", "qa"],
  mmorpg: ["game", "backend", "qa"],
  cli: ["backend", "qa"],
  library: ["backend", "qa"]
};

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
  const teams = new Set<string>(BASE_TEAMS_BY_FAMILY[input.projectFamily] ?? DEFAULT_BASE_TEAMS);
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
