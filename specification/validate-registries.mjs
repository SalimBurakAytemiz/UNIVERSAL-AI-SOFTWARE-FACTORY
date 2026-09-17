import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Bu betik AI'nin kendi kendine "gecti" dememesini onlemek icin degil,
// kayitlarin (registry) yapisal butunlugunu deterministik olarak dogrulamak icindir.
const repoRoot = path.dirname(fileURLToPath(import.meta.url));

function readJson(relativePath) {
  const fullPath = path.join(repoRoot, relativePath);
  return JSON.parse(readFileSync(fullPath, 'utf-8'));
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

function checkUniqueIds(items, pattern, label) {
  const seen = new Set();
  for (const item of items) {
    const id = item.id;
    if (!pattern.test(id)) {
      fail(`${label} id "${id}" does not match ${pattern}`);
    }
    if (seen.has(id)) {
      fail(`${label} id "${id}" is duplicated`);
    }
    seen.add(id);
  }
  return seen;
}

const requirementRegistry = readJson('requirements/registry.json');
const invariantRegistry = readJson('invariants/registry.json');
const policyRegistry = readJson('policies/registry.json');
const adrRegistry = readJson('ADR/registry.json');
const traceabilityMatrix = readJson('traceability/matrix.json');
const realityMatrix = readJson('implementation-reality/matrix.json');
const baseline = readJson('baseline/version.json');

const requirementIds = checkUniqueIds(requirementRegistry.requirements, /^UASF-REQ-\d{4}$/, 'requirement');
const invariantIds = checkUniqueIds(invariantRegistry.invariants, /^UASF-INV-\d{4}$/, 'invariant');
checkUniqueIds(policyRegistry.policies, /^UASF-POL-\d{4}$/, 'policy');
checkUniqueIds(adrRegistry.decisions, /^ADR-\d{4}$/, 'ADR decision');

const requirementStatuses = new Set([
  'DEFINED', 'PLANNED', 'IMPLEMENTATION_IN_PROGRESS', 'IMPLEMENTED',
  'UNIT_TESTED', 'INTEGRATION_TESTED', 'PROOF_VERIFIED',
  'PRODUCTION_VERIFIED', 'BLOCKED', 'DEPRECATED', 'SUPERSEDED'
]);
for (const requirement of requirementRegistry.requirements) {
  if (!requirementStatuses.has(requirement.status)) {
    fail(`requirement ${requirement.id} has unknown status "${requirement.status}"`);
  }
}

// Bağlantı alanları dizi olmalı ve yalnız mevcut kanonik kimliklere başvurmalıdır.
function checkReferences(items, field, ids, label) {
  for (const item of items) {
    if (!Array.isArray(item[field])) {
      fail(label + ' ' + item.id + ' requires array field ' + field);
      continue;
    }
    for (const id of item[field]) {
      if (typeof id !== 'string' || !ids.has(id)) fail(label + ' ' + item.id + ' references unknown id ' + JSON.stringify(id));
    }
  }
}
checkReferences(requirementRegistry.requirements, 'relatedInvariants', invariantIds, 'requirement');
checkReferences(policyRegistry.policies, 'relatedInvariants', invariantIds, 'policy');
checkReferences(adrRegistry.decisions, 'relatedRequirements', requirementIds, 'ADR');

// Traceability matrisindeki her girisin bilinen bir invariant'a atifta bulunmasi gerekir.
for (const entry of traceabilityMatrix.entries) {
  for (const invariantId of entry.invariantIds ?? []) {
    if (!invariantIds.has(invariantId)) {
      fail(`traceability matrix references unknown invariant id "${invariantId}"`);
    }
  }
}

// Her kanonik gereksinim, traceability ve reality matrislerinde tam olarak bir kez yer almalidir.
// Sadece Set boyutunu karsilastirmak yeterli degildir: fazladan eklenen bir yinelenen giris,
// mevcut girislerle ayni boyutta bir Set uretebilir ve kapsamin aslinda tekil olmadigini gizleyebilir.
// Bu yuzden her giris tek tek islenip zaten gorulmus bir requirementId acikca reddedilir (P1 duzeltme).
function checkExactRequirementCoverage(entries, label) {
  const seenRequirementIds = new Set();
  for (const entry of entries) {
    if (!requirementIds.has(entry.requirementId)) {
      fail(`${label} references unknown requirement id "${entry.requirementId}"`);
      continue;
    }
    if (seenRequirementIds.has(entry.requirementId)) {
      fail(`${label} has a duplicate entry for requirement "${entry.requirementId}"`);
      continue;
    }
    seenRequirementIds.add(entry.requirementId);
  }
  for (const reqId of requirementIds) {
    if (!seenRequirementIds.has(reqId)) {
      fail(`${label} is missing entry for requirement "${reqId}"`);
    }
  }
}

checkExactRequirementCoverage(traceabilityMatrix.entries, 'traceability matrix');
checkExactRequirementCoverage(realityMatrix.entries, 'implementation reality matrix');

if (!/^\d+\.\d+\.\d+$/.test(baseline.currentBaselineVersion)) {
  fail(`baseline currentBaselineVersion "${baseline.currentBaselineVersion}" is not a valid semantic version`);
}

if (process.exitCode === 1) {
  console.error('Specification registry validation FAILED.');
} else {
  console.log('Specification registry validation PASSED.');
}