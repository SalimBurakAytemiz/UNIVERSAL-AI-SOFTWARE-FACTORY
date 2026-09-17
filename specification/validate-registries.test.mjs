import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const source = path.dirname(fileURLToPath(import.meta.url));
function validate(file, mutate) {
  const temp = mkdtempSync(path.join(tmpdir(), 'uasf-registry-'));
  try {
    const target = path.join(temp, 'specification');
    cpSync(source, target, { recursive: true });
    if (file) {
      const location = path.join(target, file);
      const data = JSON.parse(readFileSync(location, 'utf8'));
      mutate(data);
      writeFileSync(location, JSON.stringify(data));
    }
    return spawnSync(process.execPath, [path.join(target, 'validate-registries.mjs')], { encoding: 'utf8' });
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
test('canonical registries pass', () => assert.equal(validate().status, 0));
for (const [file, collection, field, bad] of [
  ['requirements/registry.json', 'requirements', 'relatedInvariants', 'UASF-INV-9999'],
  ['policies/registry.json', 'policies', 'relatedInvariants', 'UASF-INV-9999'],
  ['ADR/registry.json', 'decisions', 'relatedRequirements', 'UASF-REQ-9999']
]) {
  for (const value of [[bad], bad, null]) test(file + ' rejects invalid references ' + JSON.stringify(value), () => {
    const result = validate(file, data => { data[collection][0][field] = value; });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FAIL:/);
  });
}
for (const file of ['traceability/matrix.json', 'implementation-reality/matrix.json']) {
  test(file + ' rejects missing coverage', () => assert.equal(validate(file, data => data.entries.pop()).status, 1));
  test(file + ' rejects duplicate coverage', () => assert.equal(validate(file, data => data.entries.push(data.entries[0])).status, 1));
}
