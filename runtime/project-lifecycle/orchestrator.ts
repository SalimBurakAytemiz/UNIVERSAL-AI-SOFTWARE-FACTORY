// P0 uçtan uca akış (bölüm 304, 305): Gereksinim İzlenebilirliği ->
// Project Genome -> Organization Composer -> Project OS -> Politika/
// Capability Gateway -> Maliyet/Model Yönlendirme -> Kalıcı Durum. Bu
// modül, ayrı ayrı test edilmiş P0 parçalarının GERÇEKTEN birlikte,
// tutarlı bir şekilde çalıştığının kanıtıdır — her adım bir öncekinin
// çıktısını kullanır, hiçbiri bağımsız/kopuk değildir.
//
// Sıra ve neden:
//   1. Ön koşul: Factory'nin KENDİ gereksinim kayıt defteri kanıtsız bir
//      iddia içeriyorsa (bölüm 303), yeni bir proje başlatılmaz —
//      "kanıtsız iddia" zemininde yeni iş üretmek, sorunu büyütür.
//   2. Project Genome doğrulanır (fail closed, bölüm 280) — geçersiz bir
//      Genome ile hiçbir aşağı akış adımı çalıştırılmaz.
//   3. Organization Composer, Genome'dan minimum gerekli takımları çıkarır.
//   4. Project OS iskeletinin oluşturulması, Capability Gateway'den
//      (dolayısıyla Policy Engine'den) geçmeden ASLA çalışmaz — riskli/
//      izinsiz bir dosya sistemi eylemi sessizce gerçekleşemez.
//   5. Bu yeni proje için ilk görev (özet çıkarma), en ucuz yeterli model
//      ile yönlendirilir ve maliyeti bütçe kontrolünden geçirilerek
//      kaydedilir — "sessiz harcama yok" (bölüm 147).
//   6. Tüm sonuç (Genome, Organizasyon, model kararı, maliyet) kalıcı
//      duruma yazılır; süreç yeniden başlasa bile kaybolmaz (bölüm 277).

import { join } from "node:path";
import { parseProjectGenome, type ProjectGenome } from "../project-genome/genome.js";
import { composeOrganizationFromGenome, type OrganizationComposition } from "../organization-composer/composer.js";
import { scaffoldProjectOs, type ScaffoldResult } from "../project-os/scaffold.js";
import { CapabilityGateway } from "../capability-gateway/gateway.js";
import { assertFilesystemConfinement } from "../sandbox/sandbox.js";
import type { PolicyEngine, RiskLevel } from "../policy-engine/policy-engine.js";
import type { ModelRegistry } from "../models/registry.js";
import { CheapestCapableModelRouter, type RoutingDecision } from "../models/router.js";
import { CostEngine } from "../cost/cost-engine.js";
import { assertValidBudgetLimits, BudgetGuard, type BudgetLimits } from "../budget/budget.js";
import { FileStateStore, type StateStore } from "../state/file-store.js";
import type { TraceabilityIssue } from "../requirements-traceability/traceability.js";
import { freezeRecord } from "../util/immutable.js";

export class PreflightTraceabilityFailedError extends Error {
  constructor(issues: readonly TraceabilityIssue[]) {
    super(
      `Refusing to bootstrap a new project: the Factory's own requirement registry has ` +
        `${issues.length} unresolved traceability issue(s). Run \`factory trace requirement\` and fix them first.`
    );
    this.name = "PreflightTraceabilityFailedError";
  }
}

export interface BootstrapProjectInput {
  readonly genomeCandidate: unknown;
  readonly baseDir: string;
  readonly policy: PolicyEngine;
  readonly modelRegistry: ModelRegistry;
  readonly budgetLimits?: BudgetLimits;
  readonly costEngine?: CostEngine;
  readonly stateStore?: StateStore;
  /** Both the Organization Composer's team-activation threshold and the Capability Gateway action's risk level. Defaults to 1 (low). */
  readonly risk?: RiskLevel;
  /** Factory'nin kendi gereksinim kayıt defterindeki izlenebilirlik sorunları (varsa) — boş olmayan bir liste bootstrap'i durdurur. */
  readonly preflightTraceabilityIssues?: readonly TraceabilityIssue[];
}

export interface BootstrapProjectResult {
  readonly genome: ProjectGenome;
  readonly organization: OrganizationComposition;
  readonly scaffold: ScaffoldResult;
  readonly modelDecision: RoutingDecision;
  readonly statePath: string;
  readonly totalCostUsd: number;
}

/**
 * P1 fix (11th independent review round targeted audit, same class as
 * "caller context mutation can change cost ownership during invocation" —
 * runtime/models/gateway.ts): `bootstrapProject()` awaits
 * `gateway.authorize(...)` (line below) before reading
 * `input.modelRegistry`/`input.costEngine`/`input.budgetLimits`/
 * `input.stateStore` — even though the wrapped `scaffoldProjectOs()` call
 * itself is synchronous, an `await` on an async function's result ALWAYS
 * yields at least one microtask tick (JS semantics), during which a
 * caller who still holds a reference to the SAME `input` object (and has
 * scheduled a mutation via another microtask, e.g. `Promise.resolve().
 * then(() => { input.costEngine = attackerControlledCostEngine })`) could
 * redirect this bootstrap's accounting to an entirely different,
 * uncontrolled CostEngine/BudgetGuard/ModelRegistry/StateStore — the
 * SAME "reread caller-owned mutable execution context after async work
 * begins" bug class Codex found in gateway.ts, just with `bootstrapProject`'s
 * own `input` playing the role `context` played there. Fixed the same
 * way: every field this function needs is captured into local `const`s
 * BEFORE the function's own first `await`, and `input.xxx` is never read
 * again afterward — capturing an object REFERENCE (registry/costEngine/
 * stateStore are class instances) is sufficient, since a later
 * `input.costEngine = ...` reassignment cannot change what an
 * already-captured local variable points to.
 *
 * P1 fix (12th independent review round, "bootstrap retains mutable
 * budget configuration across await"): Codex reproduced a further,
 * subtler instance of the SAME class the 11th round's fix above missed:
 * `budgetLimits` is a PLAIN DATA object (`{ perTaskUsd?, perRunUsd?, ... }`),
 * not a class instance like `costEngine`/`modelRegistry`/`stateStore` —
 * capturing its REFERENCE into a local `const` (as the 11th round's fix
 * did) is NOT sufficient, because the reference still points at the
 * SAME caller-owned object, and `new BudgetGuard(costEngine, budgetLimits
 * ?? {})` (which reads its FIELDS, not just checks the reference) only
 * runs AFTER this function's first `await`. A caller mutating
 * `budgetLimits.perTaskUsd` (e.g. $0 -> $1) while `gateway.authorize(...)`
 * was pending would have the BudgetGuard constructed from the MUTATED
 * ceiling, silently bypassing the ORIGINALLY intended $0 limit. Fixed:
 * `budgetLimits` is now copied into a frozen, detached snapshot
 * (`freezeRecord`) at the SAME point every other field is captured —
 * before the first `await` — and `budgetGuardLimits` (never the original
 * `budgetLimits` reference) is what `BudgetGuard` is constructed from.
 */
export async function bootstrapProject(input: BootstrapProjectInput): Promise<BootstrapProjectResult> {
  if (input.preflightTraceabilityIssues && input.preflightTraceabilityIssues.length > 0) {
    throw new PreflightTraceabilityFailedError(input.preflightTraceabilityIssues);
  }

  // Herhangi bir `await`den ÖNCE: bu çağrının kullanacağı HER alan yerel
  // `const`'lara yakalanır — bkz. yukarıdaki fix notu. Bundan sonra
  // `input.xxx` bir daha ASLA okunmaz. `budgetLimits` düz bir veri
  // nesnesi olduğundan (bir sınıf örneği değil), yalnızca REFERANSINI
  // değil, ALANLARININ KENDİSİNİ de donmuş bir kopyaya alır (bkz.
  // yukarıdaki fix notu).
  const { genomeCandidate, baseDir, policy, modelRegistry, budgetLimits, costEngine: callerCostEngine, stateStore: callerStateStore } =
    input;
  const risk = input.risk ?? 1;
  const budgetGuardLimits: BudgetLimits = budgetLimits ? freezeRecord({ ...budgetLimits }) : {};

  // P2 fix (13th independent review round, "bootstrap validates budget
  // limits after filesystem mutation"): Codex reproduced
  // `perTaskUsd: NaN` ultimately being rejected (InvalidBudgetLimitError)
  // — but only once `new BudgetGuard(costEngine, budgetGuardLimits)` ran,
  // by which point `scaffoldProjectOs()` (below) had ALREADY created 24
  // real directories on disk. Invalid security/cost configuration must
  // fail BEFORE any external side effect (filesystem writes included),
  // not merely before the first SPEND — discovering the ceiling is
  // malformed after mutating the filesystem is itself a "no claim without
  // evidence"/fail-closed violation, independent of whether any money was
  // ever actually spent. Fixed: `budgetGuardLimits` is validated via the
  // SAME rule `BudgetGuard`'s own constructor uses
  // (`assertValidBudgetLimits`, exported from runtime/budget/budget.ts
  // for exactly this purpose) immediately after it is captured — still
  // before `parseProjectGenome()`/`assertFilesystemConfinement()`/
  // `gateway.authorize(() => scaffoldProjectOs(...))`, i.e. before this
  // function's FIRST filesystem mutation of any kind.
  assertValidBudgetLimits(budgetGuardLimits);

  // PROJECT ID -> VALIDATE (parseProjectGenome, assertValidProjectId içinde
  // çağrılır) -> RESOLVE BASE DIRECTORY -> RESOLVE PROJECT DESTINATION ->
  // VERIFY DESTINATION IS INSIDE BASE -> POLICY / CAPABILITY CHECK -> ONLY
  // THEN FILESYSTEM MUTATION (bölüm 87). Bu doğrulama, Capability
  // Gateway/Policy Engine'e ulaşmadan ÖNCE yapılır — bir path-escape
  // girişimi, hiçbir politika kararı gerektirmeden en baştan reddedilir.
  // assertFilesystemConfinement (sözdizimsel DEĞİL, gerçek dosya sistemi
  // farkındalıklı) kullanılır çünkü `baseDir` içine yerleştirilmiş,
  // `baseDir` dışına işaret eden bir symlink de aynı şekilde reddedilmelidir
  // (4th independent review round fix).
  const genome = parseProjectGenome(genomeCandidate);
  assertFilesystemConfinement(baseDir, genome.project.id);
  const organization = composeOrganizationFromGenome(genome, risk);

  // P2 fix (13th independent review round targeted audit, same class as
  // the budgetGuardLimits validation-ordering fix above): `selectModel()`
  // (a pure computation — no side effects, no policy dependency) and a
  // non-mutating `assertWithinBudget()` pre-check both used to run AFTER
  // `scaffoldProjectOs()` had already created real directories on disk —
  // a registry with no "summarization"-capable model (NoCapableModelError)
  // or a budget too tight for that specific model's real cost
  // (BudgetExceededError) would still reject the WHOLE bootstrap, but only
  // after wasting the scaffold. Neither check depends on the scaffold's
  // own output, so both now run BEFORE it. The AUTHORITATIVE `budget.spend()`
  // call deliberately stays AFTER the policy-gated scaffold (bkz. aşağıda)
  // — this pre-check is a non-mutating, fail-fast OPTIMIZATION only; it
  // does not reserve anything, so it does not change (and cannot weaken)
  // the existing "a policy DENY blocks spend too" property that the real
  // `spend()` call's position already provides.
  const router = new CheapestCapableModelRouter(modelRegistry);
  const modelDecision = router.selectModel({
    taskId: `bootstrap:${genome.project.id}`,
    risk: 0,
    requiredCapabilities: ["summarization"]
  });
  const costEngine = callerCostEngine ?? new CostEngine();
  const budget = new BudgetGuard(costEngine, budgetGuardLimits);
  budget.assertWithinBudget(
    { taskId: `bootstrap:${genome.project.id}`, projectId: genome.project.id },
    modelDecision.model.costPerCall
  );

  const gateway = new CapabilityGateway(policy);
  const scaffold = await gateway.authorize(
    {
      actionType: "project.scaffold",
      risk,
      description: `Scaffold Project OS for '${genome.project.id}'`
    },
    () => scaffoldProjectOs(baseDir, genome.project.id)
  );

  budget.spend({
    taskId: `bootstrap:${genome.project.id}`,
    projectId: genome.project.id,
    provider: modelDecision.model.provider,
    modelId: modelDecision.model.modelId,
    amountUsd: modelDecision.model.costPerCall
  });

  // P1 fix (5th independent review round, "final-destination / dangling
  // symlink escape"): eskiden bu dosya yolları düz `join()` ile
  // oluşturuluyordu — scaffoldProjectOs() klasörleri onaylasa bile, bu
  // klasörlerin İÇİNDEKİ NİHAİ dosya adı (ör. "genome.json") daha önce
  // (veya scaffold ile yazma arasında) saldırgan tarafından dışarıya
  // işaret eden bir symlink (sarkan/dangling olsun olmasın) olarak
  // yerleştirilmiş olabilirdi — `writeFileSync` böyle bir symlink'i takip
  // eder ve dosyayı GERÇEKTEN symlink'in işaret ettiği (baseDir dışı)
  // konumda oluşturur. Artık her nihai dosya yolu, gerçek yazmadan HEMEN
  // önce assertFilesystemConfinement() ile ayrıca doğrulanır.
  const stateStore = callerStateStore ?? new FileStateStore();
  stateStore.write(
    assertFilesystemConfinement(scaffold.projectRoot, join("project-genome", "genome.json")),
    genome
  );
  stateStore.write(
    assertFilesystemConfinement(scaffold.projectRoot, join("organization", "organization.json")),
    organization
  );

  const statePath = assertFilesystemConfinement(scaffold.projectRoot, join("state", "bootstrap.json"));
  const totalCostUsd = costEngine.totalFor({ projectId: genome.project.id });
  stateStore.write(statePath, {
    bootstrappedAt: new Date().toISOString(),
    projectId: genome.project.id,
    organizationTeams: organization.teams,
    // Bu noktaya ulaşıldıysa gateway.authorize() zaten ALLOW vermiştir —
    // aksi halde yukarıda fırlatırdı (bkz. capability-gateway/gateway.ts).
    policyDecision: "ALLOW",
    selectedModel: {
      modelId: modelDecision.model.modelId,
      tier: modelDecision.model.tier,
      costUsd: modelDecision.model.costPerCall
    },
    totalCostUsd
  });

  return { genome, organization, scaffold, modelDecision, statePath, totalCostUsd };
}
