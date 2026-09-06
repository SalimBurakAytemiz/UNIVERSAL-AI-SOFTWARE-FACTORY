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
    // P2 fix (10th independent review round, "declared Node support still
    // conflicts with the complete required toolchain"): scanning the FULL
    // locked dependency tree (findToolchainEngineViolations, below) surfaces
    // packages whose `engines.node` is the bare wildcard `"*"` (e.g. some
    // nested `minimatch` copies) — standard semver/npm semantics treat `*`
    // (and an empty range) as "any version accepted," and it is NOT a
    // parseable version number itself. Without this case,
    // `parseVersion("*")` throws, which would make the toolchain-wide scan
    // crash on a package that imposes NO real constraint at all.
    if (clause === "*" || clause === "") {
      return true;
    }
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

/** Same upward-walk strategy as `findNearestPackageJson` — correct from source or from `dist/`. */
function findNearestPackageLock(startDir: string): string {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, "package-lock.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not locate package-lock.json walking up from '${startDir}'`);
    }
    dir = parent;
  }
}

export interface ToolchainEngineViolation {
  readonly packagePath: string;
  readonly requiredRange: string;
}

interface LockedPackageMeta {
  readonly engines?: { readonly node?: string };
  readonly os?: readonly string[];
  readonly cpu?: readonly string[];
}

/**
 * P2 fix (10th independent review round, "declared Node support still
 * conflicts with the complete required toolchain"): the PREVIOUS round's
 * fix (see the note above on `satisfiesEngineRange`) only checked the
 * running Node version against Vitest's OWN `engines.node` — Codex then
 * reproduced a DIFFERENT, narrower locked dependency (a nested
 * `eslint-visitor-keys@5.0.1`, pulled in transitively by
 * `@typescript-eslint/visitor-keys`, itself required by
 * `@typescript-eslint/eslint-plugin`/`parser` — i.e. the LINT half of the
 * toolchain `npm run lint` genuinely needs) declaring
 * `^20.19.0 || ^22.13.0 || >=24`, which REJECTS Node 22.12.x even though
 * package.json's `engines.node` (at the time) still claimed `^22.12.0`
 * support. Checking one single dependency (Vitest) can never catch a
 * DIFFERENT dependency tightening its own requirement — the Factory
 * advertised support for a Node line its own required LINT toolchain
 * would refuse to run under, exactly the same class of "declared vs.
 * actually required" gap as the 9th round's Vitest-only version of this
 * bug, just one dependency over. Fixed: this function walks the ENTIRE
 * locked dependency tree (`package-lock.json`'s `packages` map — not
 * just one hand-picked package) and returns every locked package whose
 * OWN `engines.node` rejects the given Node version. A package pinned to
 * a DIFFERENT platform than the one currently running (`os`/`cpu` fields
 * that exclude `process.platform`/`process.arch`) is skipped — it will
 * never actually be installed/loaded here, so its `engines.node` cannot
 * genuinely constrain THIS machine's required Node version (ör.
 * `@rolldown/binding-android-arm-eabi` never applies on Linux x64).
 */
export function findToolchainEngineViolations(
  nodeVersion: string,
  lockPathOverride?: string
): readonly ToolchainEngineViolation[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const lockPath = lockPathOverride ?? findNearestPackageLock(here);
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
    readonly packages?: Readonly<Record<string, LockedPackageMeta>>;
  };

  const violations: ToolchainEngineViolation[] = [];
  for (const [packagePath, meta] of Object.entries(lock.packages ?? {})) {
    // "" is the Factory's OWN root package entry (package.json itself,
    // mirrored into the lockfile) — that is the DECLARATION being
    // verified, not one of the "locked dependencies" it must satisfy.
    if (packagePath === "") continue;
    const range = meta.engines?.node;
    if (!range) continue;
    if (meta.os && !meta.os.includes(process.platform)) continue;
    if (meta.cpu && !meta.cpu.includes(process.arch)) continue;
    if (!satisfiesEngineRange(nodeVersion, range)) {
      violations.push({ packagePath, requiredRange: range });
    }
  }
  return violations;
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
            `(this range matches the locked test/lint toolchain requirement — see package.json).`
        };
      }

      // Satisfying the Factory's OWN declared range is necessary but not
      // sufficient — see findToolchainEngineViolations()'s note above.
      const violations = findToolchainEngineViolations(version);
      if (violations.length > 0) {
        const [first] = violations;
        return {
          name: "Node.js",
          status: "BLOCKING",
          detail:
            `${version} satisfies the Factory's declared engines.node range ('${declaredRange}') but NOT the ` +
            `locked dependency '${first!.packagePath}' (requires '${first!.requiredRange}')` +
            (violations.length > 1 ? ` and ${violations.length - 1} other locked package(s)` : "") +
            ` — the declared range and the actually-required toolchain have silently diverged.`
        };
      }

      return {
        name: "Node.js",
        status: "READY",
        detail: `${version} (satisfies '${declaredRange}' and the complete locked toolchain)`
      };
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
