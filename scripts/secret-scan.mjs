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
  { name: "AWS Access Key ID", regex: /AKIA[0-9A-Z]{16}/g },
  { name: "AWS Secret Access Key (assignment)", regex: /aws_secret_access_key\s*=\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi },
  { name: "Private key block", regex: /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  { name: "GitHub token", regex: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: "Slack token", regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: "Generic API key/secret assignment with a real-looking value", regex: /(api[_-]?key|secret|password|access[_-]?token)\s*[:=]\s*['"][A-Za-z0-9_\-/.+]{12,}['"]/gi },
  { name: "Anthropic API key", regex: /sk-ant-[A-Za-z0-9\-_]{20,}/g },
  { name: "OpenAI API key", regex: /sk-[A-Za-z0-9]{20,}/g }
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
  }
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
