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
import { CapabilityGateway, type ApprovalReference } from "../capability-gateway/gateway.js";
import { ApprovalWorkflow } from "../policy-engine/approval.js";
import { assertFilesystemConfinement } from "../sandbox/sandbox.js";
import type { PolicyEngine, RiskLevel } from "../policy-engine/policy-engine.js";
import type { ModelRegistry } from "../models/registry.js";
import { CheapestCapableModelRouter, type RoutingDecision } from "../models/router.js";
import { ModelGateway, type ModelInvocationResponse } from "../models/gateway.js";
import { MockProvider } from "../models/providers/mock-provider.js";
import { CostEngine } from "../cost/cost-engine.js";
import { assertValidBudgetLimits, BudgetGuard, type BudgetLimits } from "../budget/budget.js";
import { FileStateStore, type StateStore } from "../state/file-store.js";
import type { TraceabilityIssue } from "../requirements-traceability/traceability.js";
import { freezeRecord } from "../util/immutable.js";

/**
 * The default `ModelGateway` used when a caller doesn't inject their own
 * (mirrors the existing `callerCostEngine ?? new CostEngine()`/
 * `callerStateStore ?? new FileStateStore()` sensible-default pattern) —
 * registers the dependency-free, network-free `MockProvider` so P0's
 * default registry (whose records all use `provider: "mock"`) can be
 * invoked without requiring any real, paid provider to be configured. A
 * caller with real provider adapters registered on the model registry
 * should inject their own `ModelGateway` (with those providers
 * registered) via `BootstrapProjectInput.modelGateway`.
 */
function defaultBootstrapModelGateway(): ModelGateway {
  const gateway = new ModelGateway();
  gateway.registerProvider(new MockProvider());
  return gateway;
}

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
  /**
   * The `ModelGateway` used for the bootstrap's own model invocation
   * (policy + budget reservation + provider call + accounting — see
   * `ModelGateway.invoke()`). Defaults to a fresh gateway with
   * `MockProvider` registered (see `defaultBootstrapModelGateway()`
   * above), matching the default registry's `provider: "mock"` records. A
   * caller using a real, paid provider registry must inject their own
   * `ModelGateway` with that provider registered.
   */
  readonly modelGateway?: ModelGateway;
  /** Both the Organization Composer's team-activation threshold and the Capability Gateway action's risk level. Defaults to 1 (low). */
  readonly risk?: RiskLevel;
  /** Factory'nin kendi gereksinim kayıt defterindeki izlenebilirlik sorunları (varsa) — boş olmayan bir liste bootstrap'i durdurur. */
  readonly preflightTraceabilityIssues?: readonly TraceabilityIssue[];
  /**
   * P1 fix (27th independent review round, finding 10, "provide a real
   * approval path for risk-5 bootstrap"): the `CapabilityGateway` this
   * function builds internally used to be constructed with NO approvals
   * argument at all (`new CapabilityGateway(policy)`), which defaults to a
   * brand-new, empty `ApprovalWorkflow()` — a store LOCAL to this single
   * function call that no caller anywhere could ever reach to record a
   * genuine reviewer decision in. A risk-5 (or any APPROVAL_REQUIRED)
   * scaffold was therefore UNCONDITIONALLY impossible to bootstrap,
   * regardless of whether a real Founder had genuinely approved it —
   * there was structurally no path for approval evidence to reach this
   * function at all, the exact opposite failure mode from "approval can
   * be forged" (round 25's finding 1 for `CapabilityGateway` itself), but
   * just as much a defect: a real capability the baseline requires
   * (approved risky actions may proceed) was simply unreachable here.
   * `approvals`, where supplied, is the CALLER's own authoritative
   * `ApprovalWorkflow` — the SAME organization-wide store a reviewer
   * would have called `requestFor()`/`approve()` on BEFORE ever invoking
   * `bootstrapProject()` — wired into the internal `CapabilityGateway`
   * at construction time (the same trusted-at-wiring-time pattern
   * `CapabilityGateway`'s own constructor already establishes). Omitted,
   * this function falls back to the OLD, safe default: a fresh, empty
   * workflow that can never authorize anything above ALLOW — default
   * deny is preserved for any caller that does not explicitly wire in a
   * real approval store.
   */
  readonly approvals?: ApprovalWorkflow;
  /**
   * The id of an existing, `APPROVED` request in `approvals` that covers
   * this EXACT scaffold action (bkz. `CapabilityGateway.authorize()`'s
   * `isBoundToExactAction()` — actionType/description/risk/projectId must
   * all match what `approvals.requestFor()` recorded). Required for a
   * risk-5 scaffold to ever proceed; ignored (harmlessly) for a lower-risk
   * action that policy already ALLOWs outright.
   */
  readonly approvalId?: string;
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
  const {
    genomeCandidate,
    baseDir,
    policy,
    modelRegistry,
    budgetLimits,
    costEngine: callerCostEngine,
    stateStore: callerStateStore,
    modelGateway: callerModelGateway,
    approvals: callerApprovals,
    approvalId
  } = input;
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
  // (a pure computation — no side effects, no policy dependency) runs
  // BEFORE `scaffoldProjectOs()` — a registry with no
  // "summarization"-capable model (NoCapableModelError) rejects the whole
  // bootstrap before wasting a scaffold.
  //
  // P1 fix (23rd independent review round, findings 4 & 5 — "bootstrap
  // must not record synthetic model spend without a real invocation" +
  // "reserve bootstrap budget before filesystem mutation"): Codex found
  // TWO compounding defects in what used to sit here: (1) this function
  // recorded `modelDecision.model.costPerCall` via `budget.spend()` even
  // though NO model was ever actually invoked — `selectModel()` is a pure
  // selection, never a provider call — so an unknown/misconfigured
  // provider could still yield a "successful" bootstrap, and the
  // persisted state claimed a model produced a result that never
  // executed; (2) the ONLY budget check before the scaffold's real
  // filesystem mutation was `assertWithinBudget()`, a READ-ONLY precheck
  // with no reservation — two concurrent bootstraps sharing one
  // `CostEngine` could BOTH pass that precheck, BOTH scaffold, and only
  // afterward would one `spend()` call fail, leaving the rejected
  // bootstrap's real project directory behind despite the budget ceiling
  // supposedly preventing execution in the first place. Required
  // invariant: NO model cost may be recorded without a genuine, guarded
  // model invocation, and that invocation's budget RESERVATION must
  // complete (atomically, on the shared ledger — bkz.
  // runtime/cost/cost-engine.ts'in 16th round fix notu) before any
  // irreversible filesystem mutation. Fixed by routing this task's model
  // call through the SAME guarded `ModelGateway.invoke()` every other P0
  // model invocation already uses (runtime/models/gateway.ts) — its own
  // internal sequence is ALREADY exactly "policy authorize -> budget
  // RESERVE (atomic, before any provider call) -> provider call -> budget
  // COMMIT (real cost) / RELEASE (on failure)" — placed BEFORE the
  // scaffold: a policy DENY or a budget ceiling too tight for the real
  // model's cost now rejects the ENTIRE bootstrap via this real,
  // reserved-then-committed invocation, before `scaffoldProjectOs()` ever
  // runs, and two concurrent bootstraps sharing one `CostEngine` can no
  // longer both scaffold on the strength of a check that reserved
  // nothing — `budget.reserve()`'s own atomicity (bkz. budget.ts'in 10th/
  // 16th round fix notları) ensures only one concurrent invocation can
  // ever pass. The old, separate `budget.assertWithinBudget()` precheck
  // is removed entirely — it is now fully superseded by this real
  // reservation, which happens earlier and is authoritative rather than
  // advisory.
  // P1 fix (24th independent review round, "authorize scaffold before paid
  // model work"): Codex reproduced that this function's ONLY authorization
  // check for `project.scaffold` used to sit AFTER the model invocation
  // below — so a bootstrap that was never going to be allowed to scaffold
  // (an explicit DENY, or an unresolved APPROVAL_REQUIRED) still incurred
  // a REAL, paid model call and its cost first, only to then throw and
  // discard the whole scaffold.
  //
  // P1 fix (25th independent review round, "do not reauthorize after paid
  // bootstrap work"): the 24th round's own fix above introduced a NEW,
  // narrower instance of the exact same class it was closing: it called
  // `gateway.authorize(scaffoldAction, ...)` TWICE — once as a no-op
  // pre-check here, and again (unchanged) around the real
  // `scaffoldProjectOs()` call below, with the paid `modelGateway.invoke()`
  // call sitting BETWEEN them. Each `authorize()` call runs its OWN,
  // independent `policy.evaluate(scaffoldAction)` — if that policy is
  // stateful (e.g. a rate-limit/quota rule whose decision can legitimately
  // change between two calls made moments apart), the FIRST call could
  // return ALLOW, the paid model call could genuinely execute and commit
  // real cost, and the SECOND call could then return DENY — money already
  // spent, but the bootstrap still throws and no scaffold is ever created.
  // Required invariant (this round's finding): exactly ONE authoritative
  // authorization decision, made BEFORE any paid work or filesystem
  // mutation, and never re-evaluated afterward. Fixed by collapsing the
  // two separate `authorize()` calls into a SINGLE one whose `execute`
  // callback contains BOTH the paid model invocation AND the scaffold
  // filesystem mutation — there is now only one `policy.evaluate(scaffoldAction)`
  // call in this whole function, so a stateful rule's answer cannot
  // possibly differ between "may I start" and "may I actually mutate the
  // filesystem": they are the SAME decision, checked once.
  // P1 fix (27th independent review round, finding 10, "provide a real
  // approval path for risk-5 bootstrap"): `callerApprovals`, where
  // supplied, is the CALLER's own authoritative `ApprovalWorkflow` (bkz.
  // `BootstrapProjectInput.approvals`'ın üstündeki fix notu) — wired into
  // this gateway at construction, exactly the trusted-at-wiring-time
  // pattern `CapabilityGateway`'s own constructor already requires.
  // Omitted, `new ApprovalWorkflow()` (the existing default parameter)
  // preserves the prior, safe default: an empty store that can never
  // authorize anything above ALLOW.
  const gateway = new CapabilityGateway(policy, callerApprovals ?? new ApprovalWorkflow());
  const scaffoldAction = {
    actionType: "project.scaffold",
    risk,
    description: `Scaffold Project OS for '${genome.project.id}'`,
    projectId: genome.project.id
  };
  const approvalReference: ApprovalReference | undefined = approvalId !== undefined ? { approvalId } : undefined;

  const router = new CheapestCapableModelRouter(modelRegistry);
  const modelDecision = router.selectModel({
    taskId: `bootstrap:${genome.project.id}`,
    risk: 0,
    requiredCapabilities: ["summarization"]
  });
  const costEngine = callerCostEngine ?? new CostEngine();
  const budget = new BudgetGuard(costEngine, budgetGuardLimits);
  const modelGateway = callerModelGateway ?? defaultBootstrapModelGateway();

  // Yalnızca `gateway.authorize()`'ın kendi `execute` geri çağırması
  // İÇİNDE atanır — bu, hem ücretli model çağrısının HEM DE gerçek dosya
  // sistemi mutasyonunun, TEK bir yetkilendirme kararının ARDINDAN
  // gerçekleştiğini garanti eder (bkz. yukarıdaki fix notu).
  let invocationResponse!: ModelInvocationResponse;
  const scaffold = await gateway.authorize(scaffoldAction, async () => {
    invocationResponse = await modelGateway.invoke(
      modelDecision.model,
      {
        prompt: `Summarize the initial bootstrap for project '${genome.project.id}'.`,
        taskType: "bootstrap-summary"
      },
      {
        policy,
        budget,
        risk: 0,
        taskId: `bootstrap:${genome.project.id}`,
        projectId: genome.project.id,
        description: `Bootstrap summary for project '${genome.project.id}'`
      }
    );
    return scaffoldProjectOs(baseDir, genome.project.id);
  }, approvalReference);

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
      // P1 fix (23rd independent review round): the ACTUAL cost the real,
      // guarded invocation incurred (`invocationResponse.costUsd`) — never
      // the model's merely nominal per-call price — since this field now
      // documents a genuine invocation that really happened.
      costUsd: invocationResponse.costUsd
    },
    totalCostUsd
  });

  return { genome, organization, scaffold, modelDecision, statePath, totalCostUsd };
}
