// Baseline section 80 (Factory Doctor): temel araç zincirinin hazır olup
// olmadığını kontrol eder. Eksik OPSİYONEL bir araç, çekirdeği asla
// bozmamalıdır (bölüm 79) — bu yüzden her kontrolün bir "blocking" alanı
// vardır ve yalnızca gerçekten kritik olanlar BLOCKING olarak işaretlenir.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type DoctorStatus = "READY" | "MISSING" | "OPTIONAL" | "BLOCKING" | "HUMAN_ACTION_REQUIRED";

export interface DoctorCheckResult {
  readonly name: string;
  readonly status: DoctorStatus;
  readonly detail: string;
}

function tryVersion(command: string, args: string[] = ["--version"]): string | null {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export interface DoctorCheck {
  readonly name: string;
  readonly blocking: boolean;
  check(): DoctorCheckResult;
}

function toolCheck(name: string, command: string, args: string[], blocking: boolean): DoctorCheck {
  return {
    name,
    blocking,
    check(): DoctorCheckResult {
      const version = tryVersion(command, args);
      if (version) {
        return { name, status: "READY", detail: version };
      }
      return {
        name,
        status: blocking ? "BLOCKING" : "OPTIONAL",
        detail: `'${command}' not found on PATH`
      };
    }
  };
}

/** Accepts partial versions ("20", "20.11") as well as full ones — a bare major is a common, valid `engines` style. */
function parseVersion(v: string): readonly [number, number, number] {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim());
  if (!m) throw new Error(`Cannot parse version string: '${v}'`);
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function compareVersions(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}

/**
 * P2 fix (9th independent review round, "declared Node support conflicts
 * with Vitest 5"): Codex found `package.json`'s `engines.node` (">=20")
 * silently contradicted the LOCKED `vitest@^5.0.0` dependency's own
 * `engines.node` requirement (`^22.12.0 || ^24.0.0 || >=26.0.0`) — the
 * Factory advertised support for a runtime its own required test
 * toolchain does not support, and nothing would ever catch a FUTURE
 * dependency upgrade silently widening that gap further. `engines.node`
 * itself is declarative (npm only warns, never fails a normal install by
 * default), so it cannot be trusted alone to catch this — the Factory's
 * OWN `factory doctor` command is the honest, machine-checked way to
 * confirm the running Node genuinely satisfies the CURRENTLY declared
 * range, not just that some `node` binary is on PATH.
 */
export function satisfiesEngineRange(actualVersion: string, range: string): boolean {
  const version = parseVersion(actualVersion);
  return range.split("||").some((clauseRaw) => {
    const clause = clauseRaw.trim();
    if (clause.startsWith("^")) {
      const base = parseVersion(clause.slice(1));
      return version[0] === base[0] && compareVersions(version, base) >= 0;
    }
    if (clause.startsWith(">=")) {
      return compareVersions(version, parseVersion(clause.slice(2))) >= 0;
    }
    return compareVersions(version, parseVersion(clause)) === 0;
  });
}

/**
 * Walks UP from `startDir` until a `package.json` is found. A fixed
 * relative-`..` count (e.g. "3 levels up from this source file") would be
 * WRONG for one of the two ways this module actually runs: from source via
 * `tsx runtime/cli/index.ts` (doctor.ts lives 3 directories under the repo
 * root) versus the COMPILED CLI via `node dist/runtime/cli/index.js` (the
 * same relative structure is preserved but nested one level deeper, under
 * `dist/`). Walking upward finds the real package.json in EITHER case
 * without hardcoding how deep this file happens to sit.
 */
function findNearestPackageJson(startDir: string): string {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not locate package.json walking up from '${startDir}'`);
    }
    dir = parent;
  }
}

function readDeclaredNodeEngineRange(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = findNearestPackageJson(here);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { engines?: { node?: string } };
  const range = pkg.engines?.node;
  if (!range) throw new Error(`package.json at '${pkgPath}' does not declare engines.node`);
  return range;
}

function nodeVersionCheck(): DoctorCheck {
  return {
    name: "Node.js",
    blocking: true,
    check(): DoctorCheckResult {
      const version = tryVersion("node", ["--version"]);
      if (!version) {
        return { name: "Node.js", status: "BLOCKING", detail: "'node' not found on PATH" };
      }
      const declaredRange = readDeclaredNodeEngineRange();
      if (!satisfiesEngineRange(version, declaredRange)) {
        return {
          name: "Node.js",
          status: "BLOCKING",
          detail: `${version} does not satisfy the Factory's declared engines.node range '${declaredRange}' ` +
            `(this range matches the locked Vitest 5 test toolchain requirement — see package.json).`
        };
      }
      return { name: "Node.js", status: "READY", detail: `${version} (satisfies '${declaredRange}')` };
    }
  };
}

export function defaultDoctorChecks(): DoctorCheck[] {
  return [
    nodeVersionCheck(),
    toolCheck("npm", "npm", ["--version"], true),
    toolCheck("Python", "python3", ["--version"], false),
    toolCheck("Git", "git", ["--version"], true),
    toolCheck("Docker", "docker", ["--version"], false)
  ];
}

export function runDoctor(checks: DoctorCheck[] = defaultDoctorChecks()): DoctorCheckResult[] {
  return checks.map((c) => c.check());
}
