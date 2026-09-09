#!/usr/bin/env node
// Baseline section 280 (Strict Schemas, fail closed) + 297 (Baseline Drift
// Detection). Validates every record in specification/requirements/*.yml
// against schemas/requirement.schema.json and checks for duplicate IDs.
// Invalid data fails the process (exit code 1) rather than being silently
// accepted — "fail closed", not "fail open".
//
// P1 fix (33rd independent review round, finding 3 / root class B,
// "authoritative validation parity" — "there must not be one validator for
// scripts/CI and a weaker validator at runtime"): this script used to
// reimplement its OWN, independent YAML-load / ajv-compile / duplicate-id
// loop — a second, hand-synchronized copy of exactly the logic
// `runtime/cli/commands/baseline-status.ts`'s `loadRequirementsFromDir()`
// already had to implement for `factory baseline status`, `factory trace
// requirement`, and `bootstrapProject()`'s own preflight check. Two
// independently-maintained implementations of "what makes a requirement
// registry valid" WILL drift apart over time (a rule added to one and
// forgotten in the other is invisible until it causes a real incident) —
// exactly the split baseline section 294 ("no unsupported upgrades") and
// 303 ("no claim without evidence") forbid. Fixed: this script no longer
// contains ANY of its own validation rules — it DELEGATES entirely to the
// compiled runtime's `loadRequirementsFromDir()`, so there is genuinely
// ONE authoritative implementation, not two. Because that function lives
// in TypeScript source compiled to `dist/`, and CI always runs `npm run
// build` before `npm run validate:requirements` (bkz. `.github/workflows/
// ci.yml`), this delegation is safe in CI; a local/pre-build invocation
// gets a clear, actionable error below rather than a cryptic
// MODULE_NOT_FOUND.

import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const requirementsDir = join(repoRoot, "specification", "requirements");
const compiledLoaderPath = join(repoRoot, "dist", "runtime", "cli", "commands", "baseline-status.js");

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

async function loadAuthoritativeLoader() {
  try {
    return await import(pathToFileURL(compiledLoaderPath).href);
  } catch (err) {
    if (err && (err.code === "ERR_MODULE_NOT_FOUND" || err.code === "MODULE_NOT_FOUND")) {
      console.error(
        `FAIL: '${compiledLoaderPath}' does not exist yet. This script delegates to the compiled runtime's ` +
          `own requirement loader (the SAME one 'factory baseline status'/'factory trace requirement'/bootstrap ` +
          `preflight use) rather than maintaining a second, independent validator — run 'npm run build' first, ` +
          `then re-run 'npm run validate:requirements'.`
      );
      process.exitCode = 1;
      return undefined;
    }
    throw err;
  }
}

async function main() {
  const loader = await loadAuthoritativeLoader();
  if (!loader) return;

  const { loadRequirementsFromDir, EmptyRequirementRegistryError, MalformedRequirementRegistryError, DuplicateRequirementIdError } =
    loader;

  let records;
  try {
    records = loadRequirementsFromDir(requirementsDir);
  } catch (err) {
    if (
      err instanceof EmptyRequirementRegistryError ||
      err instanceof MalformedRequirementRegistryError ||
      err instanceof DuplicateRequirementIdError
    ) {
      fail(err.message);
      return;
    }
    throw err;
  }

  // loadRequirementsFromDir() itself already enumerated the files; we only
  // need a count for the summary line, so re-derive it the same way it does.
  const fileCount = readdirSync(requirementsDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml")).length;

  console.log(`OK: ${records.length} requirement record(s) across ${fileCount} file(s) are schema-valid with unique IDs.`);
}

main();
