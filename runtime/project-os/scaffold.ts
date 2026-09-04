// Baseline section 26 (Project OS): her proje izole bir dizin yapısı
// alır. Bu fonksiyon var olan hiçbir dosyayı SİLMEZ veya ÜZERİNE
// YAZMAZ — yalnızca eksik alt klasörleri oluşturur (idempotent), böylece
// aynı proje için tekrar tekrar çağrılması güvenlidir.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const PROJECT_OS_SUBDIRECTORIES = [
  "project-definition",
  "project-genome",
  "business",
  "requirements",
  "decisions",
  "assumptions",
  "architecture",
  "organization",
  "teams",
  "services",
  "databases",
  "integrations",
  "data",
  "security",
  "qa",
  "operations",
  "observability",
  "runbooks",
  "incidents",
  "backlog",
  "technical-debt",
  "cost",
  "artifacts",
  "state"
] as const;

export interface ScaffoldResult {
  readonly projectRoot: string;
  readonly createdDirectories: readonly string[];
}

/**
 * `baseDir/projectId/<alt klasörler>` yapısını oluşturur. `baseDir`
 * sandbox kökü olarak ele alınmalıdır — çağıran taraf, projectId'nin
 * `baseDir` dışına çıkmadığını garanti etmek için
 * `runtime/sandbox/assertWithinRoot`'u kullanmalıdır (bu fonksiyon kendi
 * başına path-traversal kontrolü yapmaz; bu ayrım, tek sorumluluk
 * ilkesini korur — bkz. runtime/sandbox/sandbox.ts).
 */
export function scaffoldProjectOs(baseDir: string, projectId: string): ScaffoldResult {
  const projectRoot = join(baseDir, projectId);
  const createdDirectories = PROJECT_OS_SUBDIRECTORIES.map((sub) => {
    const dir = join(projectRoot, sub);
    mkdirSync(dir, { recursive: true });
    return dir;
  });
  return { projectRoot, createdDirectories };
}
