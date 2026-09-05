// Baseline section 26 (Project OS): her proje izole bir dizin yapısı
// alır. Bu fonksiyon var olan hiçbir dosyayı SİLMEZ veya ÜZERİNE
// YAZMAZ — yalnızca eksik alt klasörleri oluşturur (idempotent), böylece
// aynı proje için tekrar tekrar çağrılması güvenlidir.

import { mkdirSync } from "node:fs";
import { assertValidProjectId, assertWithinRoot } from "../sandbox/sandbox.js";

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
 * `baseDir/projectId/<alt klasörler>` yapısını oluşturur.
 *
 * P1 fix (2nd independent review round): eskiden bu fonksiyon `projectId`'yi
 * doğrudan `join(baseDir, projectId)` ile birleştiriyordu — bir çağıran
 * (veya üst katmandaki doğrulamayı atlayan bir yol) `projectId = "../outside"`
 * verirse, sonuç `baseDir` dışına çıkabiliyordu. Artık bu fonksiyon KENDİSİ
 * de savunma katmanı olarak: (1) projectId'nin güvenli bir tanımlayıcı
 * biçiminde olduğunu doğrular, (2) nihai hedefi GÜVENİLİR bir yol API'siyle
 * (`assertWithinRoot`) çözüp `baseDir` içinde kaldığını doğrular — HİÇBİR
 * dosya sistemi mutasyonundan (mkdirSync) ÖNCE. Bu, yalnızca üst katmanın
 * (bootstrapProject) doğru doğrulama yapmasına güvenmek yerine, bu
 * fonksiyonu doğrudan çağıran herhangi bir kod için de aynı garantiyi verir
 * (fail closed, bölüm 87).
 */
export function scaffoldProjectOs(baseDir: string, projectId: string): ScaffoldResult {
  assertValidProjectId(projectId);
  const projectRoot = assertWithinRoot(baseDir, projectId);
  const createdDirectories = PROJECT_OS_SUBDIRECTORIES.map((sub) => {
    const dir = assertWithinRoot(projectRoot, sub);
    mkdirSync(dir, { recursive: true });
    return dir;
  });
  return { projectRoot, createdDirectories };
}
