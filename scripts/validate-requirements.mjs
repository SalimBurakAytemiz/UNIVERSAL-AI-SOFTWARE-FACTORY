#!/usr/bin/env node
// Baseline section 280 (Strict Schemas, fail closed) + 297 (Baseline Drift
// Detection). Validates every record in specification/requirements/*.yml
// against schemas/requirement.schema.json and checks for duplicate IDs.
// Invalid data fails the process (exit code 1) rather than being silently
// accepted — "fail closed", not "fail open".

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import Ajv from "ajv";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const requirementsDir = join(repoRoot, "specification", "requirements");
const schemaPath = join(repoRoot, "schemas", "requirement.schema.json");

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

function main() {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);

  const files = readdirSync(requirementsDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  if (files.length === 0) {
    fail(`No requirement YAML files found in ${requirementsDir}`);
    return;
  }

  const seenIds = new Map(); // id -> file it first appeared in
  let totalRecords = 0;
  let invalidRecords = 0;

  for (const file of files) {
    const fullPath = join(requirementsDir, file);
    const content = readFileSync(fullPath, "utf8");
    let records;
    try {
      records = yaml.load(content);
    } catch (err) {
      fail(`${file}: invalid YAML — ${err.message}`);
      continue;
    }

    if (!Array.isArray(records)) {
      fail(`${file}: expected a YAML array of requirement records at the top level`);
      continue;
    }

    for (const record of records) {
      totalRecords++;
      const valid = validate(record);
      if (!valid) {
        invalidRecords++;
        fail(`${file}: requirement ${record?.id ?? "<no id>"} failed schema validation:`);
        for (const err of validate.errors ?? []) {
          console.error(`  - ${err.instancePath || "(root)"} ${err.message}`);
        }
        continue;
      }

      if (seenIds.has(record.id)) {
        invalidRecords++;
        fail(`Duplicate requirement id '${record.id}' in ${file} (first seen in ${seenIds.get(record.id)})`);
      } else {
        seenIds.set(record.id, file);
      }
    }
  }

  if (invalidRecords === 0) {
    console.log(
      `OK: ${totalRecords} requirement record(s) across ${files.length} file(s) are schema-valid with unique IDs.`
    );
  } else {
    console.error(`\n${invalidRecords} of ${totalRecords} requirement record(s) failed validation.`);
  }
}

main();
