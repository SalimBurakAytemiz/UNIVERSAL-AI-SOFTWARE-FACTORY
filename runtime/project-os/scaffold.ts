// Baseline section 26 (Project OS): her proje izole bir dizin yapısı
// alır. Bu fonksiyon var olan hiçbir dosyayı SİLMEZ veya ÜZERİNE
// YAZMAZ — yalnızca eksik alt klasörleri oluşturur (idempotent), böylece
// aynı proje için tekrar tekrar çağrılması güvenlidir.

import { mkdirSync } from "node:fs";
import { assertFilesystemConfinement, assertValidProjectId } from "../sandbox/sandbox.js";

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
 * biçiminde olduğunu doğrular, (2) nihai hedefi doğrular — HİÇBİR dosya
 * sistemi mutasyonundan (mkdirSync) ÖNCE.
 *
 * P1 fix (4th independent review round): (2)'deki doğrulama artık salt
 * sözdizimsel (assertWithinRoot) DEĞİL — assertFilesystemConfinement()
 * kullanılır, bu da `baseDir` içine yerleştirilmiş, `baseDir` dışına işaret
 * eden bir symlink/junction ile yapılan bir kaçışı da yakalar (bölüm 87).
 * Bu, yalnızca üst katmanın (bootstrapProject) doğru doğrulama yapmasına
 * güvenmek yerine, bu fonksiyonu doğrudan çağıran herhangi bir kod için de
 * aynı garantiyi verir (fail closed).
 */
export function scaffoldProjectOs(baseDir: string, projectId: string): ScaffoldResult {
  assertValidProjectId(projectId);
  const projectRoot = assertFilesystemConfinement(baseDir, projectId);
  const createdDirectories = PROJECT_OS_SUBDIRECTORIES.map((sub) => {
    const dir = assertFilesystemConfinement(projectRoot, sub);
    mkdirSync(dir, { recursive: true });
    return dir;
  });
  return { projectRoot, createdDirectories };
}
