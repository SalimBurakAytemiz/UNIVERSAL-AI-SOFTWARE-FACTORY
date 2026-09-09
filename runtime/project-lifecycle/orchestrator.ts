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

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProjectGenome, type ProjectGenome } from "../project-genome/genome.js";
import { composeOrganizationFromGenome, type OrganizationComposition } from "../organization-composer/composer.js";
import { scaffoldProjectOs, PROJECT_OS_SUBDIRECTORIES, type ScaffoldResult } from "../project-os/scaffold.js";
import { CapabilityGateway, type ApprovalReference } from "../capability-gateway/gateway.js";
import { ApprovalWorkflow } from "../policy-engine/approval.js";
import { assertFilesystemConfinement } from "../sandbox/sandbox.js";
import type { PolicyDecision, PolicyEngine, RiskLevel } from "../policy-engine/policy-engine.js";
import type { ModelRegistry } from "../models/registry.js";
import { CheapestCapableModelRouter, type RoutingDecision } from "../models/router.js";
import { ModelGateway, type ModelInvocationResponse } from "../models/gateway.js";
import { MockProvider } from "../models/providers/mock-provider.js";
import { CostEngine } from "../cost/cost-engine.js";
import { assertValidBudgetLimits, BudgetGuard, type BudgetLimits } from "../budget/budget.js";
import { FileStateStore, type StateStore } from "../state/file-store.js";
import { traceRequirements } from "../cli/commands/trace-requirement.js";
import type { TraceabilityIssue } from "../requirements-traceability/traceability.js";
import { freezeRecord } from "../util/immutable.js";

/**
 * P1 fix (30th independent review round, finding 8, "preflight
 * traceability must come from a trusted source"): mirrors
 * `runtime/cli/index.ts`'s own `findRepoRoot()` — walks up from this
 * module's own location looking for `package.json`, so `bootstrapProject()`
 * can locate the Factory's OWN requirement registry without any caller
 * having to tell it where it is (and, more importantly, without trusting
 * anything a caller claims about what that registry contains).
 */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error(`Could not locate repository root from ${startDir}`);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = findRepoRoot(__dirname);
const DEFAULT_REQUIREMENTS_DIR = join(DEFAULT_REPO_ROOT, "specification", "requirements");

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
  /**
   * P1 fix (30th independent review round, finding 8, "preflight
   * traceability must come from a trusted source"): this field used to be
   * `preflightTraceabilityIssues?: readonly TraceabilityIssue[]` — a
   * caller-supplied CLAIM about what the traceability check already
   * found, trusted verbatim. `bootstrapProject()`'s own gate was `if
   * (input.preflightTraceabilityIssues && ...length > 0) throw ...` — an
   * ordinary caller who simply OMITTED the field, or passed `[]`, sailed
   * straight through with NO traceability check ever actually having run,
   * regardless of the Factory's REAL registry's real state. A result a
   * caller can fabricate is not evidence. Fixed: `bootstrapProject()` now
   * computes the check itself, unconditionally, every call, via
   * `traceRequirements()` against a real, on-disk registry — `requirementsRegistry`
   * only ever says WHERE to look (defaulting to this Factory's own
   * installation, auto-discovered — bkz. `DEFAULT_REQUIREMENTS_DIR`), never
   * WHAT was found there. A caller can point the check at a different
   * registry location (useful for tests exercising the refusal path with a
   * genuine, deliberately-broken fixture registry) but can never skip the
   * check itself or fabricate its result.
   */
  /**
   * P1 fix (35th independent review round, finding 6, "always preflight
   * the Factory authoritative requirement registry"): this field used to
   * be the ONLY location `bootstrapProject()` ever actually checked — `const
   * { requirementsDir, rootDir } = input.requirementsRegistry ?? {
   * DEFAULT_REQUIREMENTS_DIR, DEFAULT_REPO_ROOT }`. A caller (or a
   * production bootstrap path constructed/misconfigured to always pass
   * this field) could supply an arbitrary, entirely CLEAN registry
   * location and `bootstrapProject()` would evaluate ONLY that one —
   * never the Factory's own real, on-disk registry — even if the real
   * registry had genuine, unresolved traceability blockers. That is
   * exactly the "a result a caller can fabricate is not evidence"
   * defect the 30th round's own fix note above already named, just one
   * level up: the LOCATION being checked, not the RESULT, was the
   * caller-substitutable input. Fixed: the Factory's own authoritative
   * registry (`DEFAULT_REQUIREMENTS_DIR`/`DEFAULT_REPO_ROOT`, located
   * ONCE at module load via `findRepoRoot()` — never influenced by
   * anything in `input`) is now ALWAYS checked, unconditionally, on every
   * call, regardless of whether this field is supplied. This field, where
   * supplied, now names an ADDITIONAL location whose traceability issues
   * ALSO block the bootstrap — never a REPLACEMENT for the authoritative
   * check. This preserves its original, legitimate test-only purpose
   * (exercising the refusal path against a deliberately-broken FIXTURE
   * registry, without needing to corrupt the Factory's own real
   * specification directory to do so) while closing the bypass: a normal
   * caller supplying a clean override can no longer mask a genuinely
   * broken authoritative registry, since the authoritative registry is
   * evaluated independently and unconditionally either way.
   */
  readonly requirementsRegistry?: { readonly requirementsDir: string; readonly rootDir: string };
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
  // P1 fix (30th independent review round, finding 8, "preflight
  // traceability must come from a trusted source"): this check now
  // ALWAYS genuinely runs `traceRequirements()` against a real, on-disk
  // registry — this Factory's own installation, located ONCE at module
  // load via `findRepoRoot()`. There is no code path left by which
  // omitting a field, or passing an empty array, could mean "the registry
  // is clean" without the registry actually having been read and
  // evaluated.
  //
  // P1 fix (35th independent review round, finding 6, "always preflight
  // the Factory authoritative requirement registry"): this authoritative
  // check now ALWAYS runs against `DEFAULT_REQUIREMENTS_DIR`/
  // `DEFAULT_REPO_ROOT` UNCONDITIONALLY — never against
  // `input.requirementsRegistry` instead of it. Bkz.
  // `BootstrapProjectInput.requirementsRegistry`'in fix notu: that field,
  // where supplied, is now an ADDITIONAL check below, never a substitute
  // for this one.
  const authoritativeIssues = traceRequirements(DEFAULT_REQUIREMENTS_DIR, DEFAULT_REPO_ROOT);
  if (authoritativeIssues.length > 0) {
    throw new PreflightTraceabilityFailedError(authoritativeIssues);
  }
  if (input.requirementsRegistry) {
    const { requirementsDir, rootDir } = input.requirementsRegistry;
    const additionalIssues = traceRequirements(requirementsDir, rootDir);
    if (additionalIssues.length > 0) {
      throw new PreflightTraceabilityFailedError(additionalIssues);
    }
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
  const projectRoot = assertFilesystemConfinement(baseDir, genome.project.id);
  // P1 fix (35th independent review round, finding 8, "validate all
  // scaffold destinations before paid model invocation"): only
  // `projectRoot` itself used to be validated here — `scaffoldProjectOs()`'s
  // own per-subdirectory `assertFilesystemConfinement()` calls (bkz.
  // project-os/scaffold.ts) and the individual final-file confinement
  // checks for genome.json/organization.json/bootstrap.json all ran ONLY
  // later, INSIDE `gateway.authorize()`'s `execute` callback, AFTER
  // `modelGateway.invoke()` (the paid provider call) already ran and
  // committed real cost. A symlink planted at any one of those 24
  // subdirectory names, or at either intermediate directory the three
  // final files land in, pointing outside `projectRoot` would therefore
  // still incur a genuine, billed model invocation before the bootstrap
  // ultimately failed — a real, unrecoverable spend for a request that was
  // never going to be allowed to scaffold anyway, exactly the "no silent
  // spending" violation baseline section 147 forbids. Fixed: EVERY
  // destination `scaffoldProjectOs()`/the write calls below will ever
  // touch is derived and validated HERE, in this function's own
  // synchronous prefix, before `gateway.authorize()` is even called (let
  // alone before its `execute` callback's paid model invocation runs) —
  // `assertFilesystemConfinement()` is the same real-filesystem-aware
  // (symlink-following, canonicalizing) check used everywhere else in this
  // codebase, so a traversal attempt, a symlink escape, or any other
  // unsafe/invalid target is rejected before any paid work — or any
  // filesystem mutation at all — occurs. `scaffoldProjectOs()`'s own
  // per-subdirectory validation immediately before each `mkdirSync()` (and
  // the write-site validations below, immediately before each
  // `stateStore.write()`) remain in place unchanged — this preflight adds
  // an EARLIER, additional check; it does not replace the defense-in-depth
  // re-validation each mutation site already performs immediately before
  // its own mutation.
  for (const sub of PROJECT_OS_SUBDIRECTORIES) {
    assertFilesystemConfinement(projectRoot, sub);
  }
  assertFilesystemConfinement(projectRoot, join("project-genome", "genome.json"));
  assertFilesystemConfinement(projectRoot, join("organization", "organization.json"));
  assertFilesystemConfinement(projectRoot, join("state", "bootstrap.json"));
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
  // P1 fix (30th independent review round, finding 4, "do not use an
  // ephemeral ledger for paid default bootstraps"): `costEngine` used to
  // default to a bare `new CostEngine()` — genuinely, unconditionally
  // in-memory-only — regardless of whether the model THIS bootstrap is
  // about to invoke (`modelDecision.model`, already selected above) can
  // cost real money. Since this function's own per-call `costEngine` (when
  // the caller doesn't supply one) is NEVER exposed back to the caller —
  // bkz. `BootstrapProjectResult`, it has no `costEngine` field — the ONLY
  // spend it will EVER see is this one, single, already-selected
  // invocation, so `modelDecision.model.costPerCall > 0` is a precise,
  // sufficient signal for "this call is about to spend real money," not
  // merely "the caller happened to supply their own `ModelGateway`" (a
  // caller can supply a custom gateway purely to register an ADDITIONAL
  // free/mock adapter, with no real cost at all — exactly the existing
  // 23rd-round regression fixture below, whose registry entry is
  // `costPerCall: 0`, demonstrates). Defaulting to durable persistence
  // ONLY when the selected model can genuinely cost something means: a
  // caller who wires in a real, priced model but forgets (or never thinks
  // to) wire in a MATCHING durable `costEngine` no longer has that real
  // spend silently vanish in memory the moment the process exits — never
  // durable, never enforced against `dailyUsd`/`monthlyUsd` on a
  // subsequent run, exactly the "no silent spending" violation baseline
  // section 147 forbids — while every $0 mock/test path (the default
  // registry, or any caller-supplied registry whose selected model is
  // still free) keeps the EXACT prior in-memory-only behavior, per this
  // finding's own explicit allowance ("mock/free test paths may explicitly
  // use in-memory accounting when appropriate"). Persisted via
  // `stateStore` (the SAME store — caller-supplied or the default
  // `FileStateStore` — this function already uses for its other durable
  // state) at a stable path anchored under `baseDir`, so repeated
  // `bootstrapProject()` calls against the same `baseDir` share ONE
  // authoritative, restart-surviving ledger — exactly what
  // `dailyUsd`/`monthlyUsd`/`perRunUsd` ceilings need to mean anything
  // across more than a single process lifetime.
  // P1 fix (37th independent review round, finding 5, "durably persist
  // real spend even when the ESTIMATE was zero"): the check above used
  // `modelDecision.model.costPerCall > 0` alone — the registry's STATIC
  // per-call ESTIMATE, known before the model is ever actually invoked.
  // Nothing stops a real `ModelProvider.invoke()` implementation from
  // reporting an ACTUAL `costUsd` in its response that is POSITIVE even
  // though its own registry entry advertises `costPerCall: 0` (a
  // mis-configured/miscategorized registry entry, a provider whose true
  // pricing the registry hasn't caught up with, or simply a provider
  // adapter bug) — `budget.commit()` (bkz. `gateway.invoke()`'in kendi
  // fix notu) records that ACTUAL amount into WHATEVER `costEngine`
  // instance this call already selected, unconditionally. If that engine
  // is the bare in-memory `new CostEngine()` this branch used to fall
  // back to for every `costPerCall === 0` model — real, unrelated tier
  // or not — the genuinely-incurred spend is recorded successfully in
  // THIS process's memory, then vanishes the moment it exits: never
  // durable, never enforced against `dailyUsd`/`monthlyUsd` on a
  // subsequent run, exactly the "no silent spending" violation baseline
  // section 147 forbids. Since the actual cost is not knowable before
  // invocation, this decision can only be made SAFELY by construction —
  // by narrowing "known to never cost anything" to the ONE combination
  // this codebase's own test suite already establishes as a genuinely
  // free, test-only path (bkz. the "$0 (mock/free) model keeps the exact
  // prior in-memory-only default" regression in orchestrator.test.ts):
  // tier `"MOCK"` (this codebase's OWN dedicated "not a real, billable
  // provider" marker — bkz. `models/registry.ts`'in `ModelTier`'ının
  // tanımı) AND an advertised `costPerCall` of EXACTLY zero. Any OTHER
  // model — including a real/provider-capable tier advertised as
  // currently free (`costPerCall: 0` but tier `STANDARD`/`VERY_LOW_COST`/
  // etc.) — now gets the SAME durable-backed `CostEngine` a genuinely
  // priced model already did, so a provider that ends up reporting a
  // surprise positive actual cost still has that cost durably recorded.
  // A `tier: "MOCK"` fixture with a NON-zero `costPerCall` (this
  // codebase's own established pattern for exercising the durable path
  // without a real registry entry — bkz. round 30's own regression
  // fixtures) is UNAFFECTED: it was already durable before this fix (its
  // estimate is not zero) and remains durable now.
  const stateStore = callerStateStore ?? new FileStateStore();
  const isKnownFreeModel = modelDecision.model.tier === "MOCK" && modelDecision.model.costPerCall === 0;
  const costEngine =
    callerCostEngine ??
    (isKnownFreeModel
      ? new CostEngine()
      : new CostEngine(() => new Date(), { store: stateStore, path: join(baseDir, "cost-ledger.json") }));
  const budget = new BudgetGuard(costEngine, budgetGuardLimits);
  const modelGateway = callerModelGateway ?? defaultBootstrapModelGateway();

  // Yalnızca `gateway.authorize()`'ın kendi `execute` geri çağırması
  // İÇİNDE atanır — bu, hem ücretli model çağrısının HEM DE gerçek dosya
  // sistemi mutasyonunun, TEK bir yetkilendirme kararının ARDINDAN
  // gerçekleştiğini garanti eder (bkz. yukarıdaki fix notu).
  //
  // P1 fix (31st independent review round, finding 3, "keep all bootstrap
  // writes inside the authorized execution"): the genome/organization/
  // bootstrap-state `stateStore.write()` calls used to run AFTER this
  // `gateway.authorize()` call returned — but `authorize()` (bkz.
  // capability-gateway/gateway.ts'in round-27 finding 5 fix notu) already
  // transitions a risk-5/APPROVAL_REQUIRED approval APPROVED -> EXECUTING
  // -> EXECUTED the MOMENT its own `execute` callback (which used to
  // contain ONLY the paid model invocation + `scaffoldProjectOs()`)
  // resolves successfully. Since these three writes happened OUTSIDE that
  // callback, a failure in ANY of them (a filesystem error, an
  // `assertFilesystemConfinement()` rejection, a serialization failure)
  // meant the approval record was ALREADY, PERMANENTLY marked EXECUTED —
  // durably claiming a successful execution — even though
  // `bootstrapProject()` itself still threw and the bootstrap never
  // genuinely completed (no genome.json, or no organization.json, or no
  // bootstrap.json, despite a real, billed model invocation and a real
  // scaffold having already happened). A reviewer inspecting the approval
  // record afterward would see EXECUTED with no way to tell the write
  // actually failed. Fixed: every protected write this function performs
  // now runs INSIDE the SAME `execute` callback, after `scaffoldProjectOs()`
  // — so a failure in ANY of them is caught by `authorize()`'s own
  // try/catch (bkz. gateway.ts), which calls `failExecution()` (an honest,
  // terminal EXECUTION_FAILED record) and RE-THROWS the genuine error,
  // never leaving the approval in a state that claims more success than
  // genuinely occurred. `statePath`/`totalCostUsd` are captured via `let`s
  // declared before the callback (mirroring `invocationResponse`'s
  // existing pattern immediately below) since this function's return value
  // still needs them afterward.
  let invocationResponse!: ModelInvocationResponse;
  let statePath!: string;
  let totalCostUsd!: number;
  // P1 fix (32nd independent review round, finding 8, "persist the actual
  // policy outcome"): captured from `gateway.authorize()`'s new
  // `onDecision` callback (bkz. capability-gateway/gateway.ts'in üstündeki
  // fix notu) — the SAME authoritative `PolicyEvaluationResult.decision`
  // `this.#policy.evaluate()` itself produced, never a value this function
  // GUESSES from "authorize() didn't throw." A risk-5 action that only
  // succeeds via a genuinely consumed approval evaluates to
  // `APPROVAL_REQUIRED`, not `ALLOW` — the durable record below must say
  // so truthfully.
  let evaluatedPolicyDecision!: PolicyDecision;
  const scaffold = await gateway.authorize(
    scaffoldAction,
    async () => {
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
    const scaffoldResult = scaffoldProjectOs(baseDir, genome.project.id);

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
    // `stateStore` artık YUKARIDA (costEngine'in kendi durable persistence
    // ihtiyacı için, bkz. o satırın üstündeki fix notu) çözülmüştür — burada
    // tekrar oluşturulmaz, aynı örnek kullanılmaya devam eder.
    stateStore.write(
      assertFilesystemConfinement(scaffoldResult.projectRoot, join("project-genome", "genome.json")),
      genome
    );
    stateStore.write(
      assertFilesystemConfinement(scaffoldResult.projectRoot, join("organization", "organization.json")),
      organization
    );

    statePath = assertFilesystemConfinement(scaffoldResult.projectRoot, join("state", "bootstrap.json"));
    totalCostUsd = costEngine.totalFor({ projectId: genome.project.id });
    stateStore.write(statePath, {
      bootstrappedAt: new Date().toISOString(),
      projectId: genome.project.id,
      organizationTeams: organization.teams,
      // P1 fix (32nd independent review round, finding 8, "persist the
      // actual policy outcome"): this field used to be unconditionally
      // hardcoded to `"ALLOW"`, reasoning "if gateway.authorize() didn't
      // throw, it must have been ALLOW" — but a risk-5 action that reaches
      // this point via a genuinely APPROVED approval ALSO doesn't throw,
      // despite the policy engine having actually decided
      // `APPROVAL_REQUIRED`. `evaluatedPolicyDecision` is the TRUE decision
      // `gateway.authorize()`'s own `onDecision` callback observed (bkz.
      // yukarıdaki fix notu ve capability-gateway/gateway.ts'in kendi fix
      // notu) — never rewritten into ALLOW merely because approval later
      // succeeded, so a reviewer reading this record sees the genuine
      // authorization history, not a falsified one.
      policyDecision: evaluatedPolicyDecision,
      // P1 fix (32nd independent review round, finding 8): approval
      // requirement/result/identity are now recorded SEPARATELY from the
      // policy decision itself, rather than being implied (or erased) by
      // it. `evaluatedPolicyDecision === "APPROVAL_REQUIRED"` is the ONLY
      // way this callback could still be running (bkz.
      // capability-gateway/gateway.ts'in `authorize()`'ı: a DENY, or an
      // APPROVAL_REQUIRED with no valid approval, throws BEFORE this
      // callback ever runs) — so reaching this line already proves a
      // genuine, matching, APPROVED approval was consumed.
      approval:
        evaluatedPolicyDecision === "APPROVAL_REQUIRED"
          ? { required: true, approvalId: approvalReference!.approvalId, consumed: true }
          : { required: false },
      // The write we are inside of only ever runs to completion on genuine
      // success — a thrown error anywhere above is caught by
      // `gateway.authorize()`'s own `failExecution()` path (bkz. round 31
      // finding 3's fix notu) and this record is never written at all.
      executionOutcome: "SUCCESS",
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

    return scaffoldResult;
    },
    approvalReference,
    (result) => {
      evaluatedPolicyDecision = result.decision;
    }
  );

  return { genome, organization, scaffold, modelDecision, statePath, totalCostUsd };
}
