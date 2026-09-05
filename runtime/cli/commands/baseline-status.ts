// Baseline section 296 (Baseline Coverage Engine): "factory baseline
// status" durumu DÜZYAZI iddialardan değil, specification/requirements/
// altındaki makine-okunur kayıtlardan hesaplar (bölüm 303, "no claim
// without evidence"). Bu dosya, o hesaplamayı yapan saf mantığı içerir;
// dosya sistemi okuma kısmı ayrıca test edilebilsin diye yalın tutulmuştur.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

export interface RequirementRecord {
  readonly id: string;
  readonly category: string;
  readonly status: string;
  readonly [key: string]: unknown;
}

export interface BaselineStatusSummary {
  readonly total: number;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly byCategory: Readonly<Record<string, number>>;
}

export function loadRequirementsFromDir(dir: string): RequirementRecord[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  const all: RequirementRecord[] = [];
  for (const file of files) {
    const content = readFileSync(join(dir, file), "utf8");
    const parsed = yaml.load(content);
    if (Array.isArray(parsed)) {
      all.push(...(parsed as RequirementRecord[]));
    }
  }
  return all;
}

export function summarizeRequirements(requirements: readonly RequirementRecord[]): BaselineStatusSummary {
  const byStatus: Record<string, number> = {};
  const byCategory: Record<string, number> = {};

  for (const req of requirements) {
    byStatus[req.status] = (byStatus[req.status] ?? 0) + 1;
    byCategory[req.category] = (byCategory[req.category] ?? 0) + 1;
  }

  return { total: requirements.length, byStatus, byCategory };
}

export function computeBaselineStatus(requirementsDir: string): BaselineStatusSummary {
  return summarizeRequirements(loadRequirementsFromDir(requirementsDir));
}
