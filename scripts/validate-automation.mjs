import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateConfig } from '../automation/model-router.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(path.join(root, 'automation/config.json'), 'utf8'));
const registry = JSON.parse(await readFile(path.join(root, 'automation/providers.json'), 'utf8'));
validateConfig(config, registry);
for (const name of await readdir(path.join(root, 'automation'))) {
  if (!name.endsWith('.mjs')) continue;
  const result = spawnSync(process.execPath, ['--check', path.join(root, 'automation', name)], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) { console.error(result.error || result.stderr); process.exit(1); }
}
for (const file of ['.ai/MASTER_STATE.json', '.ai/AUTOMATION_STATE.json']) JSON.parse(await readFile(path.join(root, file), 'utf8'));
const result = spawnSync(process.execPath, ['--test', path.join(root, 'automation', 'automation.test.mjs')], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.status !== 0) process.exit(1);
console.log('PASS: JavaScript syntax, config/policy, canonical JSON, deterministic automation tests.');
