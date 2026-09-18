import path from "node:path";
import { runRecovery } from "./review-recovery.mjs";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { atomicJson, readJson, lock, digest, Stop, ProviderError, Unavailable } from "./runtime.mjs";
import { ModelRouter, validateConfig, independent } from "./model-router.mjs";
import { createAdapters } from "./adapters.mjs";
import { Repository, hasSecret } from "./repository.mjs";

export function validateReview(output, head) {
  if (output.reviewedCommit !== head || !["CLEAN", "BLOCKED"].includes(output.status) || !Array.isArray(output.findings)) throw new ProviderError("INVALID_RESPONSE");
  if ((output.status === "CLEAN" && output.findings.length) || (output.status === "BLOCKED" && !output.findings.length)) throw new ProviderError("INVALID_RESPONSE");
  for (const finding of output.findings) if (!["severity", "file", "reproduction", "requirement", "reason"].every(k => typeof finding[k] === "string" && finding[k].length)) throw new ProviderError("INVALID_RESPONSE");
  return output;
}

export class Supervisor {
  constructor({ root, config, registry, state, save, repo, adapter, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    Object.assign(this, { root, config, registry, state, save, repo, now, sleep });
    this.router = new ModelRouter({ config, registry, state, save, adapter, now });
    state.contributors ||= [];
    state.reviews ||= {};
    state.step ||= "BUILD";
    state.reviewCycle ||= 0;
    state.remediationCount ||= 0;
  }
  async transition(step, patch = {}) { Object.assign(this.state, patch, { step, updatedAt: new Date(this.now()).toISOString() }); await this.save(); }
  milestoneCount(counter, baseline) {
    const value = this.state[counter], base = this.state[baseline] || 0;
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(base) || base < 0 || base > value) throw new Stop('Invalid historical milestone counter.');
    return value - base;
  }
  async request(role, task) {
    const head = await this.repo.head();
    const extraPaths = [];
    for (let round = 0; round < this.config.execution.maxContextRounds; round++) {
      const context = await this.repo.context(extraPaths, this.state.baseCommit);
      const instruction = await readFile(path.join(this.root, "prompts", role === "reviewer" ? "AUTO-REVIEW.md" : role === "planner" ? "AUTO-NEXT.md" : "AUTO-BUILDER.md"), "utf8");
      const taskId = digest(JSON.stringify({ role, task, head, context }));
      const request = JSON.stringify({ instruction, taskId, role, task, baseCommit: head, reviewedCommit: role === "reviewer" ? head : undefined,
        context, validation: this.state.validation || null, findings: this.state.lastFindings || [], scope: "local-repository-development-only" });
      const result = await this.router.execute({ role, taskKey: taskId, contributors: this.state.contributors, request,
        accept: async (output, model) => {
          if (output.taskId !== taskId) throw new ProviderError("INVALID_RESPONSE");
          await this.repo.clean();
          if (await this.repo.head() !== head) throw new Stop("HEAD changed during model execution.");
          if (output.status === "NEED_CONTEXT") {
            if (!Array.isArray(output.readPaths) || !output.readPaths.length || output.readPaths.length > 20 || output.files?.length) throw new ProviderError("INVALID_RESPONSE");
            return output;
          }
          if (role === "reviewer") {
            validateReview(output, head);
            if (await this.repo.remoteSha(this.config.git.workBranch) !== head) throw new Stop("Remote review target changed.");
            const review = { reviewedCommit: head, model: model.model, family: model.family, reviewerId: model.id, contextDigest: digest(request), timestamp: new Date(this.now()).toISOString(), result: output };
            await atomicJson(path.join(this.root, ".ai", "automation", "reviews", `${head}.json`), review);
            this.state.reviews[head] = { ...review, artifactDigest: digest(JSON.stringify(review)) };
            await this.transition(output.status === "CLEAN" ? "ADVANCE" : "REMEDIATE", { lastReviewResult: output.status, lastFindings: output.findings, currentReviewedCommit: head });
            return output;
          }
          if (output.status !== "READY") throw new ProviderError("INVALID_RESPONSE");
          const contributor = { id: model.id, model: model.model, family: model.family };
          const commit = await this.repo.apply(output, role, head, this.state, this.save);
          if (!this.state.contributors.some(c => c.id === model.id)) this.state.contributors.push(contributor);
          await this.transition(role === "planner" ? "ADVANCED" : "VALIDATE", { lastBuilderCommit: commit, expectedHead: commit, activeBuilder: model.id });
          return output;
        } });
      if (result.output.status !== "NEED_CONTEXT") return result;
      for (const name of result.output.readPaths) if (!extraPaths.includes(name)) extraPaths.push(name);
    }
    throw new Stop("Context round limit reached; no incomplete review accepted.");
  }
  async step() {
    if (this.state.pendingApply) throw new Stop("Interrupted file transaction; inspect pendingApply before resuming.");
    if (this.state.expectedHead && await this.repo.head() !== this.state.expectedHead) throw new Stop("Repository changed outside the persisted automation task.");
    if (this.state.step === "BUILD") {
      await this.repo.sync();
      if (!this.state.baseCommit) await this.transition("BUILD", { baseCommit: await this.repo.head(), expectedHead: await this.repo.head() });
      return this.request("builder", "Implement only the current canonical milestone.");
    }
    if (this.state.step === "VALIDATE") {
      const validation = await this.repo.validation();
      validation.output = hasSecret(validation.output) ? "[REDACTED: potential secret in validation output]" : validation.output.slice(-80000);
      await this.transition(validation.passed ? "PUSH" : "REMEDIATE", { validation, expectedHead: await this.repo.head() }); return;
    }
    if (this.state.step === "PUSH") {
      const head = await this.repo.push();
      await this.transition("REVIEW", { expectedHead: head, git: { ...this.state.git, lastPushedSha: head, lastVerifiedRemoteSha: head } }); return;
    }
    if (this.state.step === "REVIEW") {
      if (this.milestoneCount('reviewCycle', 'milestoneReviewCycleBase') >= this.config.review.maxCyclesPerMilestone) throw new Stop("Maximum three automatic review cycles reached.");
      const head = await this.repo.head();
      if (this.state.reviews[head]) throw new Stop("The same commit already has a review; create a new remediation commit.");
      await this.transition("REVIEW_PENDING", { reviewCycle: this.state.reviewCycle + 1, currentReviewedCommit: head });
    }
    if (this.state.step === "REVIEW_PENDING") return this.request("reviewer", "Independently review this exact commit and current milestone contract.");
    if (this.state.step === "REMEDIATE") {
      if (this.milestoneCount('reviewCycle', 'milestoneReviewCycleBase') >= this.config.review.maxCyclesPerMilestone || this.milestoneCount('remediationCount', 'milestoneRemediationBase') >= this.config.review.maxRemediationsPerMilestone) throw new Stop("Review/remediation cycle limit reached.");
      await this.transition("REMEDIATE_PENDING", { remediationCount: this.state.remediationCount + 1 });
    }
    if (this.state.step === "REMEDIATE_PENDING") return this.request("builder", "Remediate only the supplied deterministic validation failures and confirmed current review findings.");
    if (this.state.step === "ADVANCE") {
      if (this.state.lastReviewResult !== "CLEAN" || this.state.currentReviewedCommit !== await this.repo.head()) throw new Stop("Milestone transition requires CLEAN for the exact current commit.");
      const record = this.state.reviews[this.state.currentReviewedCommit];
      if (!record) throw new Stop("CLEAN has no persisted review artifact.");
      const artifact = await readJson(path.join(this.root, ".ai/automation/reviews", `${this.state.currentReviewedCommit}.json`));
      const reviewer = this.registry.models.find(m => m.id === artifact.reviewerId);
      validateReview(artifact.result, this.state.currentReviewedCommit);
      if (digest(JSON.stringify(artifact)) !== record.artifactDigest || artifact.result.status !== "CLEAN" || artifact.reviewedCommit !== this.state.currentReviewedCommit || !reviewer || !independent(reviewer, this.state.contributors)) throw new Stop("Review artifact integrity or independence check failed.");
      return this.request("planner", "Advance the canonical checkpoint to the next coherent milestone only; do not claim implementation or review of the next milestone.");
    }
    if (this.state.step === "ADVANCED") {
      const advancedHead = await this.repo.push();
      const completed = (this.state.completedMilestonesThisRun || 0) + 1;
      // Geçmiş sayaçlar ve contributor listesi silinmez; yeni milestone yalnız kendi bütçe başlangıcını alır.
      this.state.milestoneHistory ||= {};
      const reviewed = this.state.currentReviewedCommit;
      if (this.state.milestoneHistory[reviewed]) throw new Stop('Milestone advancement already recorded.');
      this.state.milestoneHistory[reviewed] = { milestone: this.state.currentMilestone || null, reviewedHead: reviewed, checkpointHead: advancedHead,
        reviewCycle: this.state.reviewCycle, remediationCount: this.state.remediationCount, contributors: structuredClone(this.state.contributors),
        reviewArtifactDigest: this.state.reviews[reviewed]?.artifactDigest, timestamp: new Date(this.now()).toISOString() };
      const checkpoint = await readJson(path.join(this.root, '.ai/MASTER_STATE.json'), {});
      await this.transition("BUILD", { completedMilestonesThisRun: completed, milestoneReviewCycleBase: this.state.reviewCycle, milestoneRemediationBase: this.state.remediationCount,
        currentMilestone: checkpoint.currentMilestone || this.state.currentMilestone, baseCommit: advancedHead, expectedHead: advancedHead, lastFindings: [], validation: null, lastReviewResult: null,
        git: { ...this.state.git, lastPushedSha: advancedHead, lastVerifiedRemoteSha: advancedHead } }); return;
    }
    if (!["BUILD", "VALIDATE", "PUSH", "REVIEW", "REVIEW_PENDING", "REMEDIATE", "REMEDIATE_PENDING", "ADVANCE", "ADVANCED"].includes(this.state.step)) throw new Stop("Unknown persisted step.");
  }
  async start() {
    await this.repo.prepare();
    let waitingSince = null;
    while ((this.state.completedMilestonesThisRun || 0) < this.config.review.maxMilestonesPerRun) {
      try {
        this.state.status = "RUNNING";
        this.state.updatedAt = new Date(this.now()).toISOString();
        await this.save();
        console.log('[Factory] ' + this.state.step + ' | review ' + this.state.reviewCycle + '/3');
        await this.step(); waitingSince = null;
        this.state.status = "RUNNING"; this.state.founderAttentionRequired = false; this.state.stopReason = null;
        await this.save();
      } catch (error) {
        if (!(error instanceof Unavailable)) throw error;
        waitingSince ??= this.now();
        if (this.now() - waitingSince >= this.config.health.maxRecoveryWaitMs) throw new Stop("Recovery wait ceiling reached; resume later with the same checkpoint.");
        Object.assign(this.state, { status: "WAITING_FOR_PROVIDER", nextRecoveryAt: error.retryAt, stopReason: error.message });
        await this.save();
        await this.sleep(Math.max(1, Math.min(30000, error.retryAt - this.now())));
      }
    }
    this.state.status = "RUN_LIMIT_REACHED"; await this.save();
  }
}

export async function main(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), mode = process.argv[2]) {
  const config = await readJson(path.join(root, "automation/config.json"));
  const registry = await readJson(path.join(root, "automation/providers.json"));
  validateConfig(config, registry);
  const runtime = path.join(root, ".ai/automation");
  const release = await lock(path.join(runtime, "supervisor.lock"));
  const stateFile = path.join(runtime, "state.json");
  let state;
  try {
    const legacy = await readJson(path.join(root, ".ai/AUTOMATION_STATE.json"), {});
    state = await readJson(stateFile, { ...legacy, schemaVersion: "2.0.0", runId: randomUUID(), step: "BUILD" });
    const save = () => atomicJson(stateFile, state);
    const supervisor = new Supervisor({ root, config, registry, state, save, repo: new Repository(root, config), adapter: createAdapters(config, { root }) });
    if (mode === "--recover-review") {
      const retryIndex = process.argv.indexOf("--retry-recovery");
      if (retryIndex >= 0 && !/^[a-f0-9-]{36}$/.test(process.argv[retryIndex + 1] || '')) throw new Stop('Explicit previous recovery attempt UUID required.');
      const result = await runRecovery({ root, config, registry, state, save, head: process.argv[3], authorized: process.argv.includes("--founder-authorized"), retryPreviousAttempt: retryIndex >= 0 ? process.argv[retryIndex + 1] : null });
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== "CLEAN") process.exitCode = 2;
    } else if (mode === "--check") {
      await supervisor.router.healthCheck();
      console.log(JSON.stringify({ providers: state.providers, note: "Missing credentials stay inactive and do not block other providers." }, null, 2));
    } else {
      if (state.status === "RUN_LIMIT_REACHED") { state.completedMilestonesThisRun = 0; await save(); }
      await supervisor.start();
    }
  } catch (error) {
    if (state) {
      Object.assign(state, { status: "FOUNDER_ATTENTION_REQUIRED", founderAttentionRequired: true, stopReason: error.message });
      await atomicJson(stateFile, state);
    }
    console.error(error.message); process.exitCode = 2;
  } finally { await release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => { console.error(error.message); process.exitCode = 2; });
}
