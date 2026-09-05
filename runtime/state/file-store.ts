// Baseline section 275 (State Store): "Interface-first. Initial candidate:
// SQLite. Future: PostgreSQL." P0 aşamasında ek bir native bağımlılık
// (SQLite derleme gereksinimi vb.) eklemeden gerçek bir kalıcılık
// sağlamak için, bu arayüzün ilk somut uygulaması düz JSON dosyalarıdır.
// StateStore arayüzü sabit kaldığı sürece, ileride bu sınıf SQLite/
// PostgreSQL tabanlı bir uygulamayla DEĞİŞTİRİLEBİLİR — çağıran kodun
// (ör. runtime/project-lifecycle) hiçbir satırı değişmez.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

export interface StateStore {
  write(path: string, data: unknown): void;
  read<T>(path: string): T | undefined;
  exists(path: string): boolean;
}

/**
 * JSON dosyalarına yazan basit, senkron, bağımlılıksız bir StateStore
 * uygulaması. Sadece in-memory tutmanın aksine, süreç yeniden başlasa
 * bile veri kaybolmaz (bölüm 277, "Durable State / Resume").
 *
 * P2 fix (8th independent review round, "failed state writes destroy
 * previous recoverable state"): eskiden `write()` DOĞRUDAN hedef dosyaya
 * yazıyordu (`writeFileSync(path, ...)`). Codex, gerçek bir yazma
 * hatasıyla (ör. EFBIG/dosya-boyutu sınırı) şunu gösterdi: geçerli bir
 * durum dosyası ZATEN varken, yazma YARIDA kesilirse, önceki geçerli dosya
 * KISMİ/BOZUK bir JSON ile YER DEĞİŞTİRİR — bir sonraki süreç `read()`
 * çağırdığında `JSON.parse` bir SyntaxError fırlatır ve DURUM TAMAMEN
 * KURTARILAMAZ hale gelir. Bu, "kalıcı durum" (bölüm 277) sözleşmesinin
 * doğrudan ihlalidir: BAŞARISIZ bir yazma, bilinen-son-iyi durumu ASLA yok
 * etmemelidir. Fixed: klasik atomik-yazma deseni — (1) tam içerik önce
 * AYNI dizindeki GEÇİCİ bir kardeş (sibling) dosyaya yazılır (yeniden
 * adlandırmanın atomik olabilmesi için AYNI dosya sistemi/dizinde
 * olmalıdır — çapraz-dosya-sistemi rename varsayımından kaçınılır), (2)
 * yalnızca bu yazma TAMAMEN başarılı olursa `renameSync` ile hedefin
 * ÜZERİNE atomik olarak taşınır (POSIX rename() bir tek syscall'dır — okuyan
 * bir süreç ASLA yarı-yazılmış bir dosya GÖRMEZ, ya eski içeriği ya da
 * tamamen yeni içeriği görür), (3) geçici dosyaya yazma BAŞARISIZ olursa,
 * hedef dosyaya HİÇ DOKUNULMAZ (eski, geçerli içerik olduğu gibi kalır) ve
 * yarım kalan geçici dosya best-effort temizlenir (temizleme kendisi
 * başarısız olsa bile orijinal hata olduğu gibi fırlatılmaya devam eder —
 * temizleme hatası asıl yazma hatasını ASLA gizlemez).
 */
export class FileStateStore implements StateStore {
  write(path: string, data: unknown): void {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    const tempPath = join(dir, `.${basename(path)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
    try {
      writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      renameSync(tempPath, path);
    } catch (err) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup only — a leftover temp file is harmless
        // (never read as authoritative state), and its cleanup failing
        // must never mask the original write error below.
      }
      throw err;
    }
  }

  read<T>(path: string): T | undefined {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  }

  exists(path: string): boolean {
    return existsSync(path);
  }
}
