#!/usr/bin/env node
// Baseline section 286: Factory CLI entry point. Only a subset of the full
// command list is implemented at P0 (see specification/requirements
// UASF-REQ-0006 for the honestly-scoped status of this command surface).

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { runDoctor } from "./commands/doctor.js";
import { computeBaselineStatus } from "./commands/baseline-status.js";
import { createDefaultModelRegistry } from "../models/registry.js";
import { CheapestCapableModelRouter } from "../models/router.js";

// __dirname here is <repoRoot>/runtime/cli (dev) or <repoRoot>/dist/runtime/cli
// (built). Both are exactly two levels below the repo root plus one extra
// level when running from dist/, so we walk up until we find package.json
// rather than hardcoding a fixed number of ".." segments.
const __dirname = dirname(fileURLToPath(import.meta.url));
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error(`Could not locate repository root from ${startDir}`);
}
const repoRoot = findRepoRoot(__dirname);

function printDoctor(): void {
  const results = runDoctor();
  console.log("factory doctor");
  console.log("================");
  for (const r of results) {
    console.log(`${r.status.padEnd(20)} ${r.name.padEnd(12)} ${r.detail}`);
  }
  const blocking = results.filter((r) => r.status === "BLOCKING");
  if (blocking.length > 0) {
    console.log(`\n${blocking.length} BLOCKING issue(s) found.`);
    process.exitCode = 1;
  }
}

function printBaselineStatus(): void {
  const requirementsDir = join(repoRoot, "specification", "requirements");
  const summary = computeBaselineStatus(requirementsDir);
  console.log("factory baseline status");
  console.log("========================");
  console.log(`Total requirements tracked: ${summary.total}`);
  console.log("\nBy status:");
  for (const [status, count] of Object.entries(summary.byStatus).sort()) {
    console.log(`  ${status.padEnd(28)} ${count}`);
  }
  console.log("\nBy phase:");
  for (const [category, count] of Object.entries(summary.byCategory).sort()) {
    console.log(`  ${category.padEnd(28)} ${count}`);
  }
  console.log(
    "\nNote: this counts the P0-scope requirement batch only. See " +
      "specification/requirements/README.md — the full 323-section baseline " +
      "decomposition is not yet complete."
  );
}

function printRoutingExplain(): void {
  const registry = createDefaultModelRegistry();
  const router = new CheapestCapableModelRouter(registry);
  console.log("factory routing explain");
  console.log("========================");
  const scenarios: Array<{ label: string; risk: 0 | 1 | 2 | 3 | 4 | 5; caps: string[] }> = [
    { label: "trivial tagging", risk: 0, caps: ["tagging"] },
    { label: "standard implementation", risk: 3, caps: ["implementation"] },
    { label: "critical architecture", risk: 4, caps: ["critical-architecture"] }
  ];
  for (const s of scenarios) {
    try {
      const decision = router.selectModel({ taskId: s.label, risk: s.risk, requiredCapabilities: s.caps });
      console.log(
        `${s.label.padEnd(26)} -> ${decision.model.modelId} (tier=${decision.model.tier}, ` +
          `cost/call=$${decision.model.costPerCall})`
      );
    } catch (err) {
      console.log(`${s.label.padEnd(26)} -> NO CAPABLE MODEL (${(err as Error).message})`);
    }
  }
}

function main(): void {
  const [command, subcommand] = process.argv.slice(2);

  if (command === "doctor") return printDoctor();
  if (command === "baseline" && subcommand === "status") return printBaselineStatus();
  if (command === "routing" && subcommand === "explain") return printRoutingExplain();

  console.log("Universal AI Technology Factory CLI (P0 kernel)");
  console.log("Usage:");
  console.log("  factory doctor");
  console.log("  factory baseline status");
  console.log("  factory routing explain");
  console.log("\nSee specification/requirements/README.md for what is and isn't implemented yet.");
  process.exitCode = command ? 1 : 0;
}

main();
