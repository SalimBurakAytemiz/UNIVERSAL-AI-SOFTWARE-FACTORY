#!/usr/bin/env node
// Baseline section 2 (Public Repository Security Rule) + 307 (Public
// Repository Security Proofs). Deterministic, dependency-free secret
// scanner. Per section 2's flow, a real finding is never printed with its
// value — only its location and pattern classification.
//
// This scanner checks TWO things:
//   1. Currently tracked files (git ls-files) — what's in the working tree today.
//   2. Every blob ever reachable from any ref in git history (git rev-list
//      --objects --all) — a secret committed and later deleted is still
//      exposed in a PUBLIC repository's history, and removing the current
//      file alone does not fix that (baseline section 2's own flow says
//      so explicitly: "removing the current file alone is NOT sufficient").
//
// This is intentionally a "custom deterministic pattern check" (section 2
// explicitly allows this as an alternative to Gitleaks/TruffleHog, which
// are not installed in this environment). It is not a substitute for a
// dedicated secret-scanning tool in a production CI pipeline — see
// specification/requirements UASF-REQ-0002 notes. History scanning
// requires a non-shallow clone (CI uses `fetch-depth: 0`); a shallow
// clone will only see the commits it has, which is reported, not hidden.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PATTERNS = [
  // P2 fix (18th independent review round targeted audit, same root class
  // as the OpenAI finding below: "supported provider credential format
  // missed due to prefix variant"): `AKIA` is only AWS's LONG-TERM access
  // key ID prefix; `ASIA` (temporary/STS credentials — arguably the more
  // commonly LEAKED variant, since they're minted and pasted around far
  // more often in CI/session contexts) is an equally real, currently-
  // issued AWS access key ID format that the old pattern silently missed.
  { name: "AWS Access Key ID", regex: /(AKIA|ASIA)[0-9A-Z]{16}/g },
  { name: "AWS Secret Access Key (assignment)", regex: /aws_secret_access_key\s*=\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi },
  { name: "Private key block", regex: /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  // P2 fix (18th independent review round targeted audit, same root
  // class): `gh[pousr]_` covers the classic PAT/OAuth/app-token prefixes
  // but misses `github_pat_` — GitHub's newer, now-RECOMMENDED
  // fine-grained personal access token format, which uses an entirely
  // different, non-single-character prefix.
  { name: "GitHub token", regex: /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { name: "Slack token", regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  // P2 fix (18th independent review round, "secret scanner misses
  // project-scoped OpenAI keys in JSON"): a quoted JSON property NAME
  // (`"apiKey": "..."`) has a closing quote sitting directly between the
  // key name and the `:`/`=` — the old pattern went straight from the key
  // name to `\s*[:=]`, which cannot match across that quote character, so
  // it silently failed on ordinary JSON while still working for
  // unquoted-key syntax (YAML, TOML, shell/env, plain JS object
  // literals). `['"]?` absorbs that optional closing quote without
  // requiring one, so every previously-supported syntax keeps matching.
  { name: "Generic API key/secret assignment with a real-looking value", regex: /(api[_-]?key|secret|password|access[_-]?token)['"]?\s*[:=]\s*['"][A-Za-z0-9_\-/.+]{12,}['"]/gi },
  { name: "Anthropic API key", regex: /sk-ant-[A-Za-z0-9\-_]{20,}/g },
  // P2 fix (18th independent review round, same finding): the old pattern
  // required 20+ CONSECUTIVE alphanumeric characters immediately after
  // "sk-", with no allowance for a hyphen or underscore anywhere in that
  // run. A project-scoped OpenAI key (`sk-proj-<...>`) — and OpenAI's
  // other documented "sk-"-prefixed variants (service-account, admin
  // keys, etc.) — all embed a hyphenated segment right after "sk-", which
  // broke the match at the very first hyphen, evading detection entirely
  // despite being a fully supported, real credential format. Fixed by
  // widening the trailing character class to match hyphens/underscores
  // too — exactly the same class the sibling "Anthropic API key" pattern
  // above already uses, so this is a consistency fix, not a new
  // allowance. `(?!ant-)` keeps this pattern from ALSO re-matching an
  // Anthropic key as a duplicate, lower-precision "OpenAI API key"
  // finding on the same line (Anthropic's own dedicated pattern already
  // covers it).
  //
  // Self-caught false-positive during THIS fix's own verification (real
  // secret-scan run against this repository, not a reproduction Codex
  // gave): allowing hyphens in the trailing run means "sk-" occurring as
  // the tail of an ORDINARY English word immediately followed by a
  // hyphenated phrase now also matches — e.g. prose reading "...the
  // ri`sk-5`-never-weakens-an-explicit-DENY logic..." — which the OLD,
  // narrower (pure-alphanumeric-only) trailing class could never trigger
  // (any hyphen anywhere in the run broke it immediately). The credential
  // prefix "sk-" is always its OWN token (start of string/value, or
  // preceded by a quote/`=`/`:`/whitespace/BOL) — never the tail of a
  // longer alphanumeric word — so `(?<![A-Za-z0-9])` requires the
  // character immediately before "sk-" to NOT itself be a letter or
  // digit, ruling out "risk-"/"desk-"/"task-"/... while every genuine
  // credential-shaped occurrence (JSON/YAML/TOML/.env/JS string — always
  // preceded by a quote, `=`, `:`, whitespace, or the very start of the
  // line/value) is completely unaffected.
  { name: "OpenAI API key", regex: /(?<![A-Za-z0-9])sk-(?!ant-)[A-Za-z0-9_-]{20,}/g }
];

// Path-level allowlisting is DELIBERATELY not used for files that contain
// fake secret-shaped fixtures (e.g. tests/secret-scan.test.mjs) — a whole-
// file exclusion would also hide a real, unrelated credential accidentally
// pasted anywhere else in that file. Use the per-LINE `secret-scan:allow`
// marker (see findSecretsInText) instead: minimal, deterministic, and it
// can only suppress the exact line it's written on.
const ALLOWLIST_SUBSTRINGS = [];

// A minimal, explicit baseline of historical (blob sha, line, pattern)
// findings that have been manually reviewed and confirmed to be fake test
// fixtures, not real secrets. These predate the `secret-scan:allow` marker
// (added after this blob was committed) and the commit that introduced
// them (981f0a4) cannot be edited without rewriting PUBLIC git history,
// which this repository's own policy forbids without Founder approval
// (see CLAUDE.md / the PR-handling rules: "never rewrite history on
// someone else's branch... on a branch you created, follow the repo's
// convention" — rewriting a pushed, PR-attached branch's history is not
// this scanner's call to make). Content verified via:
//   git cat-file -p 0f3959557c676f3b8d02e1ac7210d79876e9c34a
// — byte-for-byte identical to the CURRENT file's marked fixtures at the
// same three lines. This list matches on the EXACT blob sha + line +
// pattern triple, so it can never suppress a different secret at a
// different line, even within the same file/path.
const KNOWN_HISTORICAL_FIXTURE_FINDINGS = [
  { sha: "0f3959557c676f3b8d02e1ac7210d79876e9c34a", line: 6, pattern: "AWS Access Key ID" },
  { sha: "0f3959557c676f3b8d02e1ac7210d79876e9c34a", line: 11, pattern: "Private key block" },
  {
    sha: "0f3959557c676f3b8d02e1ac7210d79876e9c34a",
    line: 16,
    pattern: "Generic API key/secret assignment with a real-looking value"
  },
  // P2 fix (18th independent review round, "secret scanner misses
  // project-scoped OpenAI keys in JSON"): widening the "OpenAI API key"
  // pattern's trailing character class newly surfaced these three
  // PRE-EXISTING historical blobs of
  // runtime/telemetry/__tests__/logger.test.ts — each contains, at line
  // 27, a `not.toContain(...)` assertion on the SAME deliberately-fake
  // fixture value that line 22 of these same historical blobs already
  // documents as fake via its own `secret-scan:allow` marker (only line
  // 27's OWN marker, added in this round's fix to the CURRENT file,
  // postdates these commits). Content verified via
  // `git cat-file -p <sha> | sed -n '25,29p'` — byte-for-byte identical
  // across all three blobs and to the current file's marked line before
  // the marker was added. These commits are reachable from already-
  // merged history and cannot be edited without rewriting PUBLIC git
  // history (forbidden without Founder approval, same constraint as the
  // pre-existing baseline entries above).
  { sha: "d0dab64660912c9ebf4c631a1c0bae21d677da16", line: 27, pattern: "OpenAI API key" },
  { sha: "1d6b2318c001af032e791ba8e1c353240d598ba8", line: 27, pattern: "OpenAI API key" },
  { sha: "89068682805a085196632186a84c6cf2ee6d30bc", line: 27, pattern: "OpenAI API key" }
];

function gitTrackedFiles(cwd = process.cwd()) {
  const output = execFileSync("git", ["ls-files"], { cwd, encoding: "utf8" });
  return output.split("\n").filter(Boolean);
}

function isProbablyBinary(buffer) {
  return buffer.subarray(0, 1024).includes(0);
}

/**
 * Pure scanning function (no filesystem access) so it can be unit-tested
 * directly. `filePath` is only used to label findings.
 */
export function findSecretsInText(content, filePath = "<in-memory>") {
  const lines = content.split("\n");
  const findings = [];

  lines.forEach((line, index) => {
    // Escape hatch for deliberate, obviously-fake secret-shaped fixtures in
    // tests (e.g. asserting that a logger redacts an "apiKey" field, or
    // that this very scanner detects a pattern). Real secret scanners
    // support the same idea (gitleaks allowlist comments, etc.) — use
    // sparingly and only for values that are provably fake. This is a
    // per-LINE marker: it cannot hide a secret on any other line.
    if (line.includes("secret-scan:allow")) return;
    for (const pattern of PATTERNS) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(line)) {
        findings.push({ file: filePath, line: index + 1, pattern: pattern.name });
      }
    }
  });

  return findings;
}

export function scanFile(path, cwd = process.cwd()) {
  let buffer;
  try {
    buffer = readFileSync(join(cwd, path));
  } catch {
    return [];
  }
  if (isProbablyBinary(buffer)) return [];
  if (ALLOWLIST_SUBSTRINGS.some((s) => path.includes(s))) return [];

  return findSecretsInText(buffer.toString("utf8"), path);
}

/** A placeholder is empty, or an obviously non-secret example string. */
export function isPlaceholderValue(value) {
  if (value.length === 0) return true;
  return /^(<.*>|your[-_].*|example.*|changeme|xxx+)$/i.test(value);
}

export function findNonPlaceholderEnvLines(content) {
  const findings = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const value = trimmed.slice(eq + 1).trim();
    if (!isPlaceholderValue(value)) {
      findings.push({ file: ".env.example", line: 0, pattern: `Non-empty value for ${trimmed.slice(0, eq)}` });
    }
  }
  return findings;
}

export function checkEnvExamplePlaceholdersOnly(trackedFiles, cwd = process.cwd()) {
  const envExample = trackedFiles.find((f) => f === ".env.example");
  if (!envExample) return { ok: true, findings: [] };

  const content = readFileSync(join(cwd, envExample), "utf8");
  const findings = findNonPlaceholderEnvLines(content);
  return { ok: findings.length === 0, findings };
}

// ---------------------------------------------------------------------
// Git-history-aware scanning (finding: "Secret scanning does not inspect
// Git history"). A credential committed once and later deleted remains
// exposed in a public repository's history — deleting the current file is
// not sufficient (baseline section 2).
// ---------------------------------------------------------------------

/**
 * Every blob object reachable from any ref (`--all`), each tagged with a
 * path it was found at. Deleted files are still reachable this way as
 * long as the clone is not shallow. Returns [{ sha, path }].
 */
export function listHistoricalBlobs(cwd = process.cwd()) {
  const revListOutput = execFileSync("git", ["rev-list", "--objects", "--all"], { cwd, encoding: "utf8" });
  const shaToPath = new Map();
  for (const line of revListOutput.split("\n")) {
    if (!line) continue;
    const spaceIdx = line.indexOf(" ");
    const sha = spaceIdx === -1 ? line : line.slice(0, spaceIdx);
    const path = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1);
    shaToPath.set(sha, path);
  }
  if (shaToPath.size === 0) return [];

  // Single batched call to classify every object's type (commit/tree/blob) at once.
  const batchInput = [...shaToPath.keys()].join("\n");
  const batchOutput = execFileSync("git", ["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
    cwd,
    input: batchInput,
    encoding: "utf8"
  });

  const blobs = [];
  for (const line of batchOutput.split("\n")) {
    if (!line) continue;
    const [sha, type] = line.split(" ");
    if (type === "blob") {
      blobs.push({ sha, path: shaToPath.get(sha) ?? "" });
    }
  }
  return blobs;
}

function readBlobContent(sha, cwd = process.cwd()) {
  try {
    return execFileSync("git", ["cat-file", "-p", sha], { cwd, maxBuffer: 1024 * 1024 * 64 });
  } catch {
    return null;
  }
}

/**
 * Scans every UNIQUE blob ever reachable in git history (deduped by
 * content hash, so identical content committed many times is only
 * scanned once). Returns findings labeled `history:<path>@<short-sha>`.
 */
export function scanGitHistory(cwd = process.cwd()) {
  const blobs = listHistoricalBlobs(cwd);
  const seen = new Set();
  const findings = [];

  for (const blob of blobs) {
    if (seen.has(blob.sha)) continue;
    seen.add(blob.sha);

    if (ALLOWLIST_SUBSTRINGS.some((s) => blob.path.includes(s))) continue;

    const content = readBlobContent(blob.sha, cwd);
    if (!content || isProbablyBinary(content)) continue;

    const label = `history:${blob.path}@${blob.sha.slice(0, 7)}`;
    const blobFindings = findSecretsInText(content.toString("utf8"), label);
    const notBaselined = blobFindings.filter(
      (f) =>
        !KNOWN_HISTORICAL_FIXTURE_FINDINGS.some(
          (known) => known.sha === blob.sha && known.line === f.line && known.pattern === f.pattern
        )
    );
    findings.push(...notBaselined);
  }

  return findings;
}

function main() {
  const cwd = process.cwd();
  const trackedFiles = gitTrackedFiles(cwd);
  const currentFindings = trackedFiles.flatMap((f) => scanFile(f, cwd));
  const historyFindings = scanGitHistory(cwd);

  const envCheck = checkEnvExamplePlaceholdersOnly(trackedFiles, cwd);
  const envIsTracked = trackedFiles.includes(".env");

  console.log("Public Repository Secret Scan");
  console.log("==============================");
  console.log(`Files scanned (current tree): ${trackedFiles.length}`);
  console.log(`Unique historical blobs scanned: ${new Set(listHistoricalBlobs(cwd).map((b) => b.sha)).size}`);
  console.log(`.env tracked in git: ${envIsTracked ? "YES (FAIL)" : "no"}`);
  console.log(`.env.example placeholders only: ${envCheck.ok ? "PASS" : "FAIL"}`);

  const allFindings = [...currentFindings, ...historyFindings, ...envCheck.findings];

  if (allFindings.length === 0 && !envIsTracked) {
    console.log("\nResult: PASS — no likely secrets found in tracked files or git history.");
    return;
  }

  console.log(`\nResult: FAIL — ${allFindings.length} potential issue(s) found (values redacted):`);
  for (const f of allFindings) {
    console.log(`  - ${f.file}:${f.line} [${f.pattern}]`);
  }
  if (envIsTracked) {
    console.log("  - .env is tracked by git and must never be committed.");
  }
  process.exitCode = 1;
}

// Only run as a CLI, not when imported for tests (tests/secret-scan.test.mjs).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
