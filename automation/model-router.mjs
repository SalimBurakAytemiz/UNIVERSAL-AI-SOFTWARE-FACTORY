import { ProviderError, Stop, Unavailable } from "./runtime.mjs";

export function validateConfig(cfg, registry) {
  if (cfg.policy.allowPaid !== false || cfg.policy.allowProduction !== false || cfg.policy.allowRisk5 !== false || cfg.policy.allowIrreversibleMigration !== false) throw new Stop("Founder approval required: forbidden authority configuration.");
  if (!Number.isInteger(cfg.review.maxCyclesPerMilestone) || cfg.review.maxCyclesPerMilestone < 1 || cfg.review.maxCyclesPerMilestone > 3) throw new Stop("Review limit must be 1..3.");
  if (!Number.isInteger(cfg.review.maxRemediationsPerMilestone) || cfg.review.maxRemediationsPerMilestone < 1 || cfg.review.maxRemediationsPerMilestone > 3) throw new Stop("Remediation limit must be 1..3.");
  for (const [key, value] of Object.entries({ ...cfg.health, ...cfg.execution, maxMilestonesPerRun: cfg.review.maxMilestonesPerRun })) if (!Number.isSafeInteger(value) || value < 1) throw new Stop(`Invalid numeric limit: ${key}`);
  for (const key of ["autoFetch", "autoPullFastForwardOnly", "autoPush", "verifyRemoteSha", "forbidForcePush", "forbidHardReset", "forbidRebase"]) if (cfg.git[key] !== true) throw new Stop(`Git protection missing: ${key}`);
  if (!/^[\w/-]+$/.test(cfg.git.workBranch) || !/^[\w/-]+$/.test(cfg.git.mainBranch) || !/^[\w-]+$/.test(cfg.git.remote)) throw new Stop("Unsafe Git configuration.");
  if (new Set(registry.models.map(m => m.id)).size !== registry.models.length) throw new Stop("Duplicate model ids.");
  for (const m of registry.models.filter(m => m.enabled)) {
    if (!m.family || m.family === "unknown") throw new Stop(`Unknown model family: ${m.id}`);
    if (!["existing-subscription", "free"].includes(m.cost)) throw new Stop(`Paid model forbidden: ${m.id}`);
    if (m.cost === "existing-subscription" && !["claude", "codex"].includes(m.adapter)) throw new Stop("Only primary native CLIs may use existing subscriptions.");
    if (m.adapter === "opencode" && (!m.model.startsWith("opencode/") || (!m.model.endsWith("-free") && m.model !== "opencode/union-alpha"))) throw new Stop("OpenCode must use an explicit free model.");
    if (m.adapter === "omniroute" && !["nvidia", "openrouter"].includes(m.provider)) throw new Stop("Unverified OmniRoute provider.");
    if (m.provider === "openrouter" && !m.model.endsWith(":free")) throw new Stop("OpenRouter requires :free.");
  }
}

export function independent(model, contributors) {
  return contributors.length > 0 && model.family !== "unknown" && contributors.every(c =>
    c.family && c.family !== "unknown" && c.family !== model.family && c.model !== model.model);
}

export class ModelRouter {
  constructor({ config, registry, state, save, adapter, now = Date.now }) {
    validateConfig(config, registry);
    Object.assign(this, { config, registry, state, save, adapter, now });
    state.providers ||= {};
    state.attempts ||= {};
    state.blockedTasks ||= {};
  }
  candidates(role, contributors = []) {
    return this.registry.models.filter(m => m.enabled && m.roles.includes(role) &&
      (role !== "reviewer" || independent(m, contributors))).sort((a, b) => a.priority - b.priority);
  }
  async failure(model, error) {
    const prev = this.state.providers[model.id] || {};
    const failures = (prev.failures || 0) + 1;
    const base = ["AUTH", "CONFIG", "QUOTA", "UNAVAILABLE"].includes(error.kind) ? this.config.health.unavailableCooldownMs : this.config.health.cooldownMs;
    const retryAt = this.now() + Math.max(error.retryAfterMs || 0, Math.min(base * 2 ** Math.min(failures - 1, 6), this.config.health.maxCooldownMs));
    this.state.providers[model.id] = { ...prev, registration: "REGISTERED", availability: error.kind === "NO_CREDENTIAL" ? "INACTIVE" : "QUARANTINED", failures, lastFailure: error.kind || "TRANSIENT", retryAt, checkedAt: this.now(), quota: error.kind === "QUOTA" ? "EXHAUSTED" : error.kind === "RATE_LIMIT" ? "RATE_LIMITED" : "UNKNOWN" };
    await this.save();
  }
  async probe(model, force = false) {
    const prev = this.state.providers[model.id];
    if (prev?.retryAt > this.now()) return false;
    if (!force && prev?.availability === "HEALTHY" && this.now() - prev.checkedAt < this.config.health.ttlMs) return true;
    try {
      const evidence = await this.adapter.probe(model);
      this.state.providers[model.id] = { ...prev, registration: "REGISTERED", availability: "HEALTHY", failures: 0, retryAt: null, checkedAt: this.now(), quota: "AVAILABLE", quotaRemaining: null, evidence };
      await this.save(); return true;
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      await this.failure(model, error); return false;
    }
  }
  async healthCheck() {
    for (const model of this.registry.models) {
      if (model.enabled) await this.probe(model);
      else this.state.providers[model.id] = { registration: "REGISTERED", availability: "INACTIVE", reason: model.reason, quota: "UNKNOWN" };
    }
    await this.save();
  }
  async execute({ role, taskKey, contributors = [], request, accept }) {
    if (this.state.blockedTasks[taskKey]) throw new Stop(this.state.blockedTasks[taskKey]);
    const candidates = this.candidates(role, contributors);
    if (!candidates.length) throw new Stop(`No independent/eligible ${role} model. Unknown families are never accepted.`);
    for (const model of candidates) {
      const key = `${taskKey}:${role}:${model.id}`;
      const attempt = this.state.attempts[key];
      if (attempt?.status === "SUCCESS" && attempt.response?.status === "NEED_CONTEXT") return { output: attempt.response, model };
      // Türkçe: Aynı model/görev tekrarını yalnız cooldown + yeni health başarısı haklı çıkarır.
      if (attempt?.status === "SUCCESS" || attempt?.permanent || (attempt?.count || 0) >= this.config.health.maxAttemptsPerTask) continue;
      if (!(await this.probe(model, Boolean(attempt)))) continue;
      this.state.attempts[key] = { count: (attempt?.count || 0) + 1, status: "RUNNING", startedAt: this.now() };
      await this.save();
      try {
        const output = await this.adapter.invoke(model, request);
        if (output.status === "FOUNDER_APPROVAL_REQUIRED" || (output.status === "BLOCKED" && role !== "reviewer")) {
          const reason = output.status === "FOUNDER_APPROVAL_REQUIRED" ? "Founder approval required by model; no fallback or restart may bypass it." : `Task blocked by ${model.id}; no availability fallback for a task blocker.`;
          this.state.blockedTasks[taskKey] = reason;
          await this.save(); throw new Stop(reason);
        }
        const accepted = await accept(output, model);
        this.state.attempts[key].status = "SUCCESS";
        if (accepted.status === "NEED_CONTEXT") this.state.attempts[key].response = accepted;
        this.state.providers[model.id] = { ...this.state.providers[model.id], availability: "HEALTHY", quota: "AVAILABLE", lastSuccessAt: this.now(), failures: 0 };
        await this.save();
        return { output: accepted, model };
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        this.state.attempts[key].status = "FAILED";
        this.state.attempts[key].permanent = ["INVALID_RESPONSE", "MODEL_MISMATCH", "OUTPUT_LIMIT"].includes(error.kind);
        await this.failure(model, error);
      }
    }
    const retryTimes = candidates.filter(m => {
      const a = this.state.attempts[`${taskKey}:${role}:${m.id}`];
      return !a?.permanent && a?.status !== "SUCCESS" && (a?.count || 0) < this.config.health.maxAttemptsPerTask;
    }).map(m => this.state.providers[m.id]?.retryAt).filter(t => t > this.now());
    if (!retryTimes.length) throw new Stop(`All ${role} candidates exhausted for this task/commit.`);
    throw new Unavailable(`All ${role} candidates are quarantined or unavailable.`, Math.min(...retryTimes));
  }
}
