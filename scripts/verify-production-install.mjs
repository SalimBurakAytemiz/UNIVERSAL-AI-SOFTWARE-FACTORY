#!/usr/bin/env node
// P1 fix (26th independent review round, finding 1, "move runtime libraries
// out of devDependencies"): `npm ci --omit=dev` used to strip `ajv` and
// `js-yaml` even though `runtime/project-genome/genome.ts` and
// `runtime/cli/commands/baseline-status.ts` import them directly — the
// COMPILED CLI would crash on `MODULE_NOT_FOUND` the moment anyone
// installed this package the way a real production deployment does
// (`npm ci --omit=dev`, never `npm ci`). Moving the two packages to
// `dependencies` in package.json (bkz. commit) fixes the manifest; THIS
// script is the "do not merely make the test environment green" proof
// Codex asked for — it performs a GENUINE `npm ci --omit=dev` into an
// isolated directory (no dev toolchain available at all, exactly like a
// production host) and then actually RUNS the compiled CLI and the
// ajv-backed genome validator against that install, rather than just
// statically re-reading package.json.
//
// Bu betik gerçek bir üretim kurulumunu taklit eder: devDependencies HİÇ
// kurulmadan, derlenmiş CLI'nin ve AJV/js-yaml'a bağımlı çalışma zamanı
// kodunun GERÇEKTEN çalıştığını doğrular (yalnızca statik bir dosya
// kontrolü değil).

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, cpSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

async function main() {
  const distDir = join(repoRoot, "dist");
  if (!existsSync(distDir)) {
    fail("dist/ does not exist — run `npm run build` before this script (it verifies the COMPILED output).");
  }

  const workDir = mkdtempSync(join(tmpdir(), "uasf-prod-install-"));
  try {
    cpSync(distDir, join(workDir, "dist"), { recursive: true });
    cpSync(join(repoRoot, "package.json"), join(workDir, "package.json"));
    cpSync(join(repoRoot, "package-lock.json"), join(workDir, "package-lock.json"));
    cpSync(join(repoRoot, "specification"), join(workDir, "specification"), { recursive: true });
    cpSync(join(repoRoot, "project-state"), join(workDir, "project-state"), { recursive: true });

    console.log(`[1/5] Running \`npm ci --omit=dev\` in isolated directory: ${workDir}`);
    execFileSync("npm", ["ci", "--omit=dev"], { cwd: workDir, stdio: "inherit" });

    console.log("[2/5] Verifying dev-only tooling is genuinely ABSENT from the production install...");
    const nodeModules = join(workDir, "node_modules");
    for (const devOnly of ["typescript", "vitest", "eslint"]) {
      if (existsSync(join(nodeModules, devOnly))) {
        fail(`devDependency '${devOnly}' was installed by --omit=dev — the dependency split is not actually working.`);
      }
    }

    console.log("[3/5] Verifying runtime dependencies are genuinely PRESENT...");
    for (const runtimeDep of ["ajv", "js-yaml"]) {
      if (!existsSync(join(nodeModules, runtimeDep))) {
        fail(`runtime dependency '${runtimeDep}' is MISSING from the --omit=dev install — it is still misplaced as devDependency-only.`);
      }
    }

    console.log("[4/5] Running the COMPILED CLI's `factory baseline status` against this production install...");
    const baselineOutput = execFileSync("node", [join(workDir, "dist", "runtime", "cli", "index.js"), "baseline", "status"], {
      cwd: workDir,
      encoding: "utf8"
    });
    if (!baselineOutput.includes("Total requirements tracked")) {
      fail("`factory baseline status` did not produce the expected output under the production install (js-yaml path).");
    }

    console.log("[5/5] Exercising the ajv-backed project-genome validator against this production install...");
    const genomeModuleUrl = new URL(`file://${join(workDir, "dist", "runtime", "project-genome", "genome.js")}`);
    const { validateProjectGenome } = await import(genomeModuleUrl);
    const validResult = validateProjectGenome({
      project: { id: "prod-install-proof", name: "Prod Install Proof", family: "web-app" }
    });
    if (!validResult.valid) {
      fail(`ajv rejected a well-formed genome under the production install: ${JSON.stringify(validResult.errors)}`);
    }
    const invalidResult = validateProjectGenome({ project: { id: "" } });
    if (invalidResult.valid || invalidResult.errors.length === 0) {
      fail("ajv accepted a malformed genome under the production install — validation is not actually running.");
    }

    console.log(
      "\nPASS: `npm ci --omit=dev` install is genuinely runnable — the compiled CLI loads, `factory baseline status` " +
        "works (js-yaml), and the ajv-backed genome validator accepts/rejects correctly (ajv) — all with zero " +
        `devDependencies present. Verified packages present in node_modules/: ${readdirSync(nodeModules).sort().join(", ")}`
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

await main();
