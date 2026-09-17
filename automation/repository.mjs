import { readFile, writeFile, mkdir, rename, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { run, digest, Stop, ProviderError, atomicJson, readJson } from "./runtime.mjs";

export const canonical = ["AGENTS.md", "CODEX.md", "CLAUDE.md", "ARCHITECTURE-CONSTITUTION.md", "ROADMAP.md", "BUILD-RULES.md", "DEFINITION-OF-DONE.md", "AI-SESSION-RULES.md"];
export const checkpoints = [".ai/MASTER_STATE.json", ".ai/CURRENT_PHASE.md", ".ai/CURRENT_MILESTONE.md", ".ai/NEXT_ACTIONS.md", ".ai/TEST_STATUS.md", ".ai/REVIEW_STATUS.md"];
const forbidden = /(^|\/)(\.git|node_modules|\.env(?!\.example$)(?:\..*)?|credentials?|secrets?|\.ssh|\.aws|\.codex|\.claude|\.opencode)(\/|$)|\.(pem|key|p12|pfx)$/i;
const protectedWrite = /^(automation\/|scripts\/|prompts\/|\.ai\/automation\/|\.ai\/(AUTOMATION_STATE\.json|REVIEW_STATUS\.md|TEST_STATUS\.md)$|\.gitignore$|\.npmrc$)|(^|\/)(migrations?|deploy(?:ment)?|production|terraform|infrastructure)(\/|\.)/i;
export function validateProposalRisk(proposal) {
  if (proposal.requiresFounderApproval === true || (Number.isInteger(proposal.riskLevel) && proposal.riskLevel >= 5)) throw new Stop("Founder approval required: explicit approval flag or Risk-5 proposal.");
  if (proposal.requiresFounderApproval !== false || !Number.isInteger(proposal.riskLevel) || proposal.riskLevel < 0) throw new ProviderError("INVALID_RESPONSE");
}
export function safeName(name) {
  if (typeof name !== "string" || !name || name.includes("\\") || name.includes(":") || name.includes("\0") || path.posix.isAbsolute(name) || name.split("/").some(p => !p || p === "." || p === ".." || /[. ]$/.test(p) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p)) || forbidden.test(name)) throw new Stop("Unsafe/secret repository path.");
  return name;
}
export function hasSecret(text) {
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-(?:ant-|or-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|nvapi-[A-Za-z0-9_-]{20,})/.test(text);
}
export async function safeFile(root, name) {
  safeName(name);
  let current = root;
  for (const segment of name.split("/")) {
    current = path.join(current, segment);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Stop("Symlink/junction paths are forbidden."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const resolvedRoot = await realpath(root);
  if (!path.resolve(current).startsWith(path.resolve(resolvedRoot) + path.sep)) throw new Stop("Path outside repository.");
  return current;
}

export class Repository {
  constructor(root, config, runner = run) { Object.assign(this, { root, config, runner }); }
  async git(...args) {
    const result = await this.runner("git", ["-c", "core.hooksPath=" + path.join(this.root, ".ai", "automation", "empty-hooks"), ...args], { cwd: this.root });
    if (result.code !== 0) throw new Stop(`Git failed: ${args[0]}. No reset, rebase or force push attempted.`);
    return result.stdout.trim();
  }
  head() { return this.git("rev-parse", "HEAD"); }
  async clean() { if (await this.git("status", "--porcelain")) throw new Stop("Working tree is not clean; preserve work and inspect it."); }
  async remoteSha(branch) {
    const result = await this.git("ls-remote", "--heads", this.config.git.remote, `refs/heads/${branch}`);
    return result ? result.split(/\s+/)[0] : null;
  }
  async push(branch = this.config.git.workBranch) {
    await this.clean();
    if (await this.git("branch", "--show-current") !== branch) throw new Stop("Push branch mismatch.");
    const head = await this.head();
    await this.git("push", "-u", this.config.git.remote, `HEAD:refs/heads/${branch}`);
    if (await this.remoteSha(branch) !== head) throw new Stop("Remote SHA verification failed.");
    return head;
  }
  async sync() {
    await this.clean();
    if (await this.git("branch", "--show-current") !== this.config.git.workBranch) throw new Stop("Unexpected work branch.");
    await this.git("fetch", "--prune", this.config.git.remote);
    if (!await this.remoteSha(this.config.git.workBranch)) { await this.push(); return; }
    const counts = await this.git("rev-list", "--left-right", "--count", `HEAD...${this.config.git.remote}/${this.config.git.workBranch}`);
    const [ahead, behind] = counts.split(/\s+/).map(Number);
    if (!Number.isInteger(ahead) || !Number.isInteger(behind) || (ahead && behind)) throw new Stop("Git history diverged; Founder attention required.");
    if (behind) await this.git("pull", "--ff-only", this.config.git.remote, this.config.git.workBranch);
    if (ahead) await this.push();
    await this.clean();
  }
  async prepare() {
    await this.git("rev-parse", "--is-inside-work-tree");
    await this.git("remote", "get-url", this.config.git.remote);
    let initialized = true;
    try { await this.head(); } catch { initialized = false; }
    if (!initialized) {
      if (await this.git("ls-remote", "--heads", this.config.git.remote)) throw new Stop("Remote has history but local HEAD is unborn. No automatic overwrite.");
      await this.scanSecrets();
      await this.git("symbolic-ref", "HEAD", `refs/heads/${this.config.git.mainBranch}`);
      await this.git("add", "--all");
      await this.git("commit", "-m", "chore: initialize UASF canonical startup pack");
      await this.push(this.config.git.mainBranch);
    }
    await this.clean();
    await this.git("fetch", "--prune", this.config.git.remote);
    const branches = await this.git("branch", "--list", this.config.git.workBranch);
    if (branches) await this.git("checkout", this.config.git.workBranch);
    else if (await this.remoteSha(this.config.git.workBranch)) await this.git("checkout", "-b", this.config.git.workBranch, "--track", `${this.config.git.remote}/${this.config.git.workBranch}`);
    else await this.git("checkout", "-b", this.config.git.workBranch);
    await this.sync();
  }
  async tree() {
    return (await this.git("ls-files", "--cached", "--others", "--exclude-standard")).split(/\r?\n/).filter(Boolean);
  }
  async scanSecrets() {
    for (const name of await this.tree()) {
      if (forbidden.test(name) && !name.startsWith(".claude/")) throw new Stop("Sensitive path would enter Git/context.");
      const file = name.startsWith(".claude/") ? path.join(this.root, name) : await safeFile(this.root, name);
      if ((await lstat(file)).isSymbolicLink()) throw new Stop("Symlink in baseline.");
      const data = await readFile(file);
      if (hasSecret(data.toString("utf8"))) throw new Stop(`Potential secret in ${name}.`);
    }
  }
  async context(extraPaths = [], baseCommit = null) {
    const tree = (await this.tree()).filter(name => !forbidden.test(name));
    const changed = baseCommit ? (await this.git("diff", "--name-only", `${baseCommit}..HEAD`)).split(/\r?\n/).filter(Boolean) : [];
    const names = [...new Set([...canonical, ...checkpoints, ...changed, ...extraPaths])];
    const files = [];
    for (const name of names) {
      const file = await safeFile(this.root, name);
      try {
        const content = await readFile(file, "utf8");
        if (hasSecret(content)) throw new Stop("Context contains a potential secret.");
        files.push({ path: name, sha256: digest(content), content });
      } catch (error) { if (error.code !== "ENOENT") throw error; files.push({ path: name, sha256: null, content: null }); }
    }
    const context = { head: await this.head(), tree, files };
    if (JSON.stringify(context).length > this.config.execution.maxContextChars) throw new Stop("Context limit exceeded; no truncated independent review permitted.");
    return context;
  }
  async apply(proposal, role, expectedHead, runtimeState, save) {
    if (await this.head() !== expectedHead) throw new Stop("Proposal target HEAD changed.");
    await this.clean();
    if (proposal.baseCommit !== expectedHead || !Array.isArray(proposal.files) || !proposal.files.length || proposal.files.length > 40) throw new ProviderError("INVALID_RESPONSE");
    validateProposalRisk(proposal);
    const names = new Set(), prepared = [];
    for (const entry of proposal.files) {
      const name = safeName(entry.path);
      if (names.has(name.toLowerCase())) throw new ProviderError("INVALID_RESPONSE");
      names.add(name.toLowerCase());
      if (canonical.some(p => p.toLowerCase() === name.toLowerCase()) || protectedWrite.test(name) || (role === "planner" ? !checkpoints.includes(name) : name.toLowerCase() === ".ai/master_state.json")) throw new Stop(`Founder approval required for protected change: ${name}`);
      if (typeof entry.content !== "string" || entry.content.length > 200000 || hasSecret(entry.content)) throw new Stop("Unsafe or oversized proposal content.");
      if (/\b(?:terraform\s+apply|kubectl\s+apply|git\s+push|--force(?:-with-lease)?|reset\s+--hard|npm\s+publish|aws\s+.*(?:delete|deploy)|stripe.*(?:charge|payment))\b/i.test(entry.content)) throw new Stop("Proposed content requires Founder review for external/destructive actions.");
      const file = await safeFile(this.root, name);
      let old = null;
      try { old = await readFile(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (entry.baseSha256 !== (old === null ? null : digest(old))) throw new ProviderError("INVALID_RESPONSE");
      prepared.push({ file, content: entry.content, path: name, sha256: digest(entry.content) });
    }
    if (role === "planner") {
      const master = prepared.find(f => f.path === ".ai/MASTER_STATE.json");
      if (!master) throw new ProviderError("INVALID_RESPONSE");
      const before = JSON.parse(await readFile(path.join(this.root, ".ai/MASTER_STATE.json"), "utf8"));
      let after; try { after = JSON.parse(master.content); } catch { throw new ProviderError("INVALID_RESPONSE"); }
      const allowed = new Set(["currentPhase", "currentPhaseName", "currentMilestone", "currentMilestoneName", "lastCompletedMilestone", "nextAction"]);
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) if (!allowed.has(key) && JSON.stringify(before[key]) !== JSON.stringify(after[key])) throw new Stop("Planner attempted authority/evidence state mutation.");
      const oldMilestone = String(before.currentMilestone).split(".").map(Number);
      const newMilestone = String(after.currentMilestone).split(".").map(Number);
      const samePhase = after.currentPhase === before.currentPhase;
      if (!Number.isInteger(after.currentPhase) || after.currentPhase < before.currentPhase || after.currentPhase > before.currentPhase + 1 || newMilestone.length !== 2 || newMilestone.some(n => !Number.isInteger(n) || n < 0) || newMilestone[0] !== after.currentPhase || newMilestone[1] !== (samePhase ? oldMilestone[1] + 1 : 1) || after.lastCompletedMilestone !== before.currentMilestone) throw new Stop("Invalid canonical milestone transition.");
    }
    // Türkçe: Çok dosyalı yazma kesilirse SUCCESS üretilmez; journal sonraki açılışta durdurur.
    runtimeState.pendingApply = { head: expectedHead, files: prepared.map(({ path: name, sha256 }) => ({ path: name, sha256 })) };
    await save();
    for (const item of prepared) {
      await mkdir(path.dirname(item.file), { recursive: true });
      const temp = `${item.file}.${randomUUID()}.tmp`;
      await writeFile(temp, item.content, "utf8"); await rename(temp, item.file);
    }
    const changed = await this.git("status", "--porcelain");
    if (!changed) throw new Stop("Builder produced no change.");
    await this.git("add", "--", ...prepared.map(p => p.path));
    await this.git("commit", "-m", role === "planner" ? "chore(ai): advance canonical milestone" : "feat: implement current Factory milestone batch");
    runtimeState.pendingApply = null;
    await save();
    return this.head();
  }
  async validation() {
    const result = await this.runner(process.execPath, [path.join(this.root, "scripts", "validate-automation.mjs")], { cwd: this.root, timeoutMs: this.config.execution.validationTimeoutMs });
    if (result.code !== 0) return { passed: false, output: result.stdout + "\n" + result.stderr };
    // Phase 0 has no package yet; missing tooling is explicitly reported, never called PASS.
    let pkg;
    try { pkg = JSON.parse(await readFile(path.join(this.root, "package.json"), "utf8")); } catch (error) { if (error.code === "ENOENT") return { passed: true, output: "Bootstrap checks passed; package toolchain not present (not executed)." }; throw error; }
    let output = result.stdout;
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|API_KEY|PASSWORD|CREDENTIAL/i.test(key)));
    const dependencyState = path.join(this.root, ".ai/automation/dependencies.json");
    const packageHash = digest(JSON.stringify(pkg));
    const installed = await readJson(dependencyState, {});
    let modulesExist = false;
    try { modulesExist = (await lstat(path.join(this.root, "node_modules"))).isDirectory(); } catch { /* First install. */ }
    if ((pkg.dependencies || pkg.devDependencies || pkg.workspaces) && (installed.packageHash !== packageHash || !modulesExist)) {
      // Türkçe: Bağımlılık kurulumu lifecycle scriptlerini çalıştırmaz; lockfile review snapshot'ına girer.
      const install = await this.runner("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: this.root, env: cleanEnv, timeoutMs: this.config.execution.validationTimeoutMs });
      output += install.stdout + install.stderr;
      if (install.code !== 0) return { passed: false, output };
      const dirty = (await this.git("status", "--porcelain")).split(/\r?\n/).filter(Boolean);
      if (dirty.some(line => !line.endsWith("package-lock.json"))) throw new Stop("Dependency install changed files outside package-lock.json.");
      if (dirty.length) { await this.git("add", "--", "package-lock.json"); await this.git("commit", "-m", "chore: lock milestone dependencies"); }
      await atomicJson(dependencyState, { packageHash });
    }
    for (const name of ["lint", "typecheck", "test", "build"]) {
      if (!pkg.scripts?.[name]) return { passed: false, output: `Required package script missing: ${name}` };
      const check = await this.runner("npm", ["run", name, "--ignore-scripts"], { cwd: this.root, timeoutMs: this.config.execution.validationTimeoutMs,
        env: cleanEnv });
      output += check.stdout + check.stderr;
      if (check.code !== 0) return { passed: false, output };
    }
    await this.clean();
    return { passed: true, output };
  }
}
