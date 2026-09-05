// Baseline section 275 (State Store): "Interface-first. Initial candidate:
// SQLite. Future: PostgreSQL." P0 aşamasında ek bir native bağımlılık
// (SQLite derleme gereksinimi vb.) eklemeden gerçek bir kalıcılık
// sağlamak için, bu arayüzün ilk somut uygulaması düz JSON dosyalarıdır.
// StateStore arayüzü sabit kaldığı sürece, ileride bu sınıf SQLite/
// PostgreSQL tabanlı bir uygulamayla DEĞİŞTİRİLEBİLİR — çağıran kodun
// (ör. runtime/project-lifecycle) hiçbir satırı değişmez.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface StateStore {
  write(path: string, data: unknown): void;
  read<T>(path: string): T | undefined;
  exists(path: string): boolean;
}

/**
 * JSON dosyalarına yazan basit, senkron, bağımlılıksız bir StateStore
 * uygulaması. Sadece in-memory tutmanın aksine, süreç yeniden başlasa
 * bile veri kaybolmaz (bölüm 277, "Durable State / Resume").
 */
export class FileStateStore implements StateStore {
  write(path: string, data: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  read<T>(path: string): T | undefined {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  }

  exists(path: string): boolean {
    return existsSync(path);
  }
}
