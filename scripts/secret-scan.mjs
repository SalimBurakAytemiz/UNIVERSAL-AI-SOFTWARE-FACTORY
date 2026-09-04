#!/usr/bin/env node
// Baseline section 2 (Public Repository Security Rule) + 307 (Public
// Repository Security Proofs). Deterministic, dependency-free secret
// scanner for tracked files. Per section 2's flow, a real finding is never
// printed with its value — only its location and pattern classification.
//
// This is intentionally a "custom deterministic pattern check" (section 2
// explicitly allows this as an alternative to Gitleaks/TruffleHog, which
// are not installed in this environment). It is not a substitute for a
// dedicated secret-scanning tool in a production CI pipeline — see
// specification/requirements UASF-REQ-0002 notes.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

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

// Files that legitimately contain placeholder-shaped text resembling these
// patterns (documentation, examples, this scanner's own source) are allowed
// to mention pattern *names* but must not contain real-looking values.
const ALLOWLIST_SUBSTRINGS = ["scripts/secret-scan.mjs", "tests/secret-scan.test.mjs"];

function gitTrackedFiles() {
  const output = execFileSync("git", ["ls-files"], { encoding: "utf8" });
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
    // tests (e.g. asserting that a logger redacts an "apiKey" field). Real
    // secret scanners support the same idea (gitleaks allowlist comments,
    // etc.) — use sparingly and only for values that are provably fake.
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

function scanFile(path) {
  let buffer;
  try {
    buffer = readFileSync(path);
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

export function checkEnvExamplePlaceholdersOnly(trackedFiles) {
  const envExample = trackedFiles.find((f) => f === ".env.example");
  if (!envExample) return { ok: true, findings: [] };

  const content = readFileSync(envExample, "utf8");
  const findings = findNonPlaceholderEnvLines(content);
  return { ok: findings.length === 0, findings };
}

function main() {
  const trackedFiles = gitTrackedFiles();
  const findings = trackedFiles.flatMap(scanFile);

  const envCheck = checkEnvExamplePlaceholdersOnly(trackedFiles);
  const envIsTracked = trackedFiles.includes(".env");

  console.log("Public Repository Secret Scan");
  console.log("==============================");
  console.log(`Files scanned: ${trackedFiles.length}`);
  console.log(`.env tracked in git: ${envIsTracked ? "YES (FAIL)" : "no"}`);
  console.log(`.env.example placeholders only: ${envCheck.ok ? "PASS" : "FAIL"}`);

  const allFindings = [...findings, ...envCheck.findings];

  if (allFindings.length === 0 && !envIsTracked) {
    console.log("\nResult: PASS — no likely secrets found in tracked files.");
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
