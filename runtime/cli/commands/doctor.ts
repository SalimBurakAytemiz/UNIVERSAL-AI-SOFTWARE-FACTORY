// Baseline section 80 (Factory Doctor): temel araç zincirinin hazır olup
// olmadığını kontrol eder. Eksik OPSİYONEL bir araç, çekirdeği asla
// bozmamalıdır (bölüm 79) — bu yüzden her kontrolün bir "blocking" alanı
// vardır ve yalnızca gerçekten kritik olanlar BLOCKING olarak işaretlenir.

import { execFileSync } from "node:child_process";

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

export function defaultDoctorChecks(): DoctorCheck[] {
  return [
    toolCheck("Node.js", "node", ["--version"], true),
    toolCheck("npm", "npm", ["--version"], true),
    toolCheck("Python", "python3", ["--version"], false),
    toolCheck("Git", "git", ["--version"], true),
    toolCheck("Docker", "docker", ["--version"], false)
  ];
}

export function runDoctor(checks: DoctorCheck[] = defaultDoctorChecks()): DoctorCheckResult[] {
  return checks.map((c) => c.check());
}
