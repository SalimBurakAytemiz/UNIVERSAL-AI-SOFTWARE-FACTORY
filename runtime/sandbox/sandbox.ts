// Baseline section 87 (Sandbox): yol sınırlama (path confinement) ve
// zaman aşımı (timeout) kontrolleri. Bu, bir ajanın "proje kökü dışına"
// (örn. `../../etc/passwd`) çıkarak dosya okuyup yazmasını veya bir işlemi
// sonsuza kadar çalışır bırakmasını engelleyen minimum korumadır.

import { resolve, sep } from "node:path";

export class PathEscapeError extends Error {
  constructor(root: string, target: string) {
    super(`Path '${target}' resolves outside sandbox root '${root}'`);
    this.name = "PathEscapeError";
  }
}

/**
 * `target` (root'a göre veya mutlak) yolunun `root` dizini dışına
 * çıkmadığını doğrular ve çözümlenmiş mutlak yolu döndürür. `../` ile
 * kaçış girişimlerini engeller (path traversal koruması).
 */
export function assertWithinRoot(root: string, target: string): string {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(root, target);

  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + sep)) {
    throw new PathEscapeError(resolvedRoot, target);
  }
  return resolvedTarget;
}

export class SandboxTimeoutError extends Error {
  constructor(ms: number) {
    super(`Operation exceeded sandbox timeout of ${ms}ms`);
    this.name = "SandboxTimeoutError";
  }
}

/**
 * Verilen promise, `ms` milisaniye içinde tamamlanmazsa
 * SandboxTimeoutError ile reddedilir. Sonsuz döngüye giren veya asılı
 * kalan bir işlemi kalıcı olarak kaynak tüketmekten alıkoyar (bölüm 87).
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SandboxTimeoutError(ms)), ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
