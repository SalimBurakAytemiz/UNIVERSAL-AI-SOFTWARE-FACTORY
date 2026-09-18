import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson, readJson, Stop, digest } from './runtime.mjs';
import { Supervisor, validateReview } from './factory-supervisor.mjs';
import { Repository } from './repository.mjs';
import { createAdapters } from './adapters.mjs';
import { independent } from './model-router.mjs';

export function recoveryRegistry(registry, contributors) {
  // Önce bağımsız Codex, sonra ücretsiz Nemotron; katkı veren aileler asla aday değildir.
  const rank = m => m.id === 'codex-primary' ? 0 : m.id === 'opencode-nemotron' ? 1 : 2;
  const models = registry.models.filter(m => m.enabled && m.roles.includes('reviewer') && independent(m, contributors) &&
    (m.cost === 'free' || (m.id === 'codex-primary' && m.adapter === 'codex' && m.cost === 'existing-subscription')))
    .sort((a, b) => rank(a) - rank(b) || a.priority - b.priority)
    .map((m, priority) => ({ ...m, priority }));
  return { ...registry, models };
}

// Yerel operatörün açık isteğidir; kriptografik Founder kimlik doğrulaması değildir.
export async function recoverReview(supervisor, { head, authorized, source = 'explicit-local-cli' }) {
  const { state, repo, registry, root } = supervisor;
  if (!authorized || !/^[a-f0-9]{40}$/.test(head || '')) throw new Stop('Explicit Founder authorization and full target SHA required.');
  if (state.reviewCycle !== 3 || state.pendingApply) throw new Stop('Recovery requires three preserved cycles and no interrupted transaction.');
  if (state.status !== 'FOUNDER_ATTENTION_REQUIRED') throw new Stop('Recovery requires Founder attention state.');
  await repo.clean();
  if (await repo.head() !== head || await repo.remoteSha(supervisor.config.git.workBranch) !== head) throw new Stop('Recovery target does not match local and remote HEAD.');
  state.reviewRecoveries ||= {};
  if (state.currentReviewedCommit === head || state.reviews[head] || state.reviewRecoveries[head]) throw new Stop('Target already reviewed or recovery already consumed; no replay.');
  const record = { id: randomUUID(), head, authorizationSource: source, authorizedAt: new Date().toISOString(),
    automaticCyclesPreserved: 3, remediationCountPreserved: state.remediationCount,
    previousReviewedCommit: state.currentReviewedCommit, contributors: structuredClone(state.contributors), status: 'STARTED' };
  state.reviewRecoveries[head] = record;
  const audit = () => atomicJson(path.join(root, '.ai/automation/recoveries', head + '.json'), record);
  await supervisor.save(); await audit();
  try {
    supervisor.router.registry = recoveryRegistry(registry, record.contributors);
    record.eligibleReviewers = supervisor.router.registry.models.map(m => ({ id: m.id, model: m.model, family: m.family }));
    if (!record.eligibleReviewers.length) throw new Stop('No independent recovery reviewer available.');
    await audit();
    state.status = 'FOUNDER_AUTHORIZED_REVIEW';
    state.expectedHead = head;
    // Eski commit'e ait test çıktısı yeni HEAD'in kanıtı olarak sunulmaz.
    state.validation = null;
    await supervisor.save();
    await supervisor.request('reviewer', 'Founder-authorized fresh independent recovery review of exact commit ' + head + '. Review the complete current milestone contract; automatic cycles remain 3.');
    const review = state.reviews[head];
    if (!review) throw new Stop('Missing exact-HEAD review artifact.');
    validateReview(review.result, head);
    const reviewer = registry.models.find(m => m.id === review.reviewerId);
    if (!reviewer || !record.eligibleReviewers.some(m => m.id === reviewer.id) || !independent(reviewer, record.contributors)) throw new Stop('Recovery reviewer is not independent.');
    const artifact = await readJson(path.join(root, '.ai/automation/reviews', head + '.json'));
    if (digest(JSON.stringify(artifact)) !== review.artifactDigest) throw new Stop('Recovery artifact integrity mismatch.');
    validateReview(artifact.result, head);
    if (artifact.reviewedCommit !== head || artifact.reviewerId !== review.reviewerId || JSON.stringify(artifact.result) !== JSON.stringify(review.result)) throw new Stop('Recovery artifact binding mismatch.');
    const health = state.providers[reviewer.id];
    if (artifact.family !== reviewer.family || artifact.model !== reviewer.model || health?.availability !== 'HEALTHY' || health.evidence?.probe !== 'authenticated-inference' || health.evidence.model !== reviewer.model) throw new Stop('Recovery reviewer provenance or health mismatch.');
    if (JSON.stringify(state.contributors) !== JSON.stringify(record.contributors)) throw new Stop('Recovery contributor history changed.');
    await repo.clean();
    if (await repo.head() !== head || await repo.remoteSha(supervisor.config.git.workBranch) !== head) throw new Stop('Recovery target changed.');
    if (state.reviewCycle !== 3 || state.remediationCount !== record.remediationCountPreserved) throw new Stop('Recovery changed automatic counters.');
    record.status = review.result.status;
    record.reviewArtifactDigest = review.artifactDigest;
    record.reviewerId = review.reviewerId;
    record.reviewerFamily = reviewer.family;
    record.reviewerModel = reviewer.model;
    record.reviewerHealth = structuredClone(health);
    state.status = record.status === 'CLEAN' ? 'RECOVERY_CLEAN' : 'FOUNDER_ATTENTION_REQUIRED';
    state.founderAttentionRequired = record.status !== 'CLEAN';
    state.stopReason = record.status === 'CLEAN' ? null : 'Recovery review BLOCKED; automatic cycles remain exhausted.';
    state.step = record.status === 'CLEAN' ? 'ADVANCE' : 'REMEDIATE';
  } catch (error) {
    record.status = 'FAILED'; record.reason = error.message;
    state.status = 'FOUNDER_ATTENTION_REQUIRED'; state.founderAttentionRequired = true;
    state.stopReason = error.message; state.step = 'REMEDIATE';
    throw error;
  } finally {
    if (supervisor.router) supervisor.router.registry = registry;
    record.finishedAt = new Date().toISOString();
    await supervisor.save(); await audit();
  }
  return record;
}

export async function runRecovery({ root, config, registry, state, save, head, authorized }) {
  if (!authorized || !/^[a-f0-9]{40}$/.test(head || '')) throw new Stop('Use --recover-review <full SHA> --founder-authorized.');
  const original = new Repository(root, config);
  const assertTarget = async () => {
    if (await original.head() !== head || await original.git('branch', '--show-current') !== config.git.workBranch || await original.remoteSha(config.git.workBranch) !== head) throw new Stop('Recovery requires exact current branch/local/remote target.');
  };
  await assertTarget();
  // Kod değişiklikleri hedef SHA'ya karışmaz; yalnız committed snapshot incelenir.
  const snapshot = path.join(root, '.ai/automation', 'review-snapshot-' + randomUUID());
  await original.git('worktree', 'add', '--detach', snapshot, head);
  try {
    const repo = new Repository(snapshot, config);
    const clean = repo.clean.bind(repo);
    repo.clean = async () => { await clean(); await assertTarget(); };
    const supervisor = new Supervisor({ root, config, registry, state, save, repo, adapter: createAdapters(config, { root: snapshot }) });
    return await recoverReview(supervisor, { head, authorized });
  } finally {
    // --force kullanılmaz; beklenmeyen değişiklik varsa snapshot korunur.
    await original.git('worktree', 'remove', snapshot);
  }
}
