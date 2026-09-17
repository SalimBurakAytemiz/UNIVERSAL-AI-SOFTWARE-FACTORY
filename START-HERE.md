# START HERE — Tek Kullanılacak Paket

Bu paket `v4-FULL-AUTO-GIT` sürümüdür ve önceki startup ZIP'lerinin yerine geçer.

## Hedef

İlk günden itibaren rutin akış:

Claude
→ test/lint/typecheck/build
→ commit
→ GitHub'a otomatik push + SHA doğrulama
→ Codex review
→ blocker varsa Claude fix
→ yeni commit
→ GitHub push
→ Codex review
→ CLEAN
→ sonraki milestone

Sen arada çıktı taşımayacaksın ve rutin `git fetch / pull / push` yapmayacaksın.

## Bir kez yapacağın hazırlık

1. GitHub'da tamamen boş bir repository oluştur.
2. Repository'yi bilgisayarına clone et.
3. Bu ZIP'in **içeriğini doğrudan clone edilmiş repository köküne** çıkar.
4. Node.js, Git, Claude Code CLI ve Codex CLI'nin kurulu olduğundan emin ol.
5. Claude Code ve Codex CLI'da bir kez giriş yap.
6. Repository kökünde PowerShell aç.
7. Tek komut çalıştır:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-full-auto.ps1
```

## Script ilk çalışmada ne yapar?

Yeni boş repo ise:

- canonical startup dosyalarını `main` üzerinde ilk commit yapar
- `origin/main`'e push eder
- `factory/development` branch'ini oluşturur
- GitHub'a push eder
- development branch'ine geçer
- Phase 0 / Milestone 0.1'i Claude'a başlatır

Sonra otomatik döngü devam eder.

## Otomasyon hangi durumda seni çağırır?

- Founder approval gerekiyorsa
- 3 review turunda blocker kapanmadıysa
- local/remote Git diverged ise
- GitHub push doğrulanamıyorsa
- CLI authentication yoksa
- deterministik validation düzelmiyorsa
- kritik güvenlik/authority kararı gerekiyorsa

Durum:

`.ai/AUTOMATION_STATE.json`

Review kayıtları:

`.ai/reviews/`

Git kayıtları:

`.ai/git/`

## Çok önemli

Normal development commitleri `factory/development` branch'ine otomatik gider.

`main` stabil canonical baseline olarak tutulur.
Güvenilir phase-closure/main-promotion sistemi daha sonraki governance fazlarında eklenir.

Rutin development için senden GitHub'a elle push beklenmez.
