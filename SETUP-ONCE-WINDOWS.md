# Windows — Bir Kez Kurulum

## Gerekli araçlar

- Git
- Node.js 18+
- npm
- Claude Code CLI
- Codex CLI

Claude Code resmi CLI non-interactive çalışmayı `claude -p` ile destekler.
Codex non-interactive shell akışı `codex exec` ile çalışır.

## Kurulu değilse

Claude Code:

```powershell
npm install -g @anthropic-ai/claude-code
```

Codex:

```powershell
npm install -g @openai/codex
```

## Authentication

Claude Code:

```powershell
claude
```

İlk çalıştırmada hesabınla giriş akışını tamamla ve çık.

Codex:

```powershell
codex --login
```

Giriş akışını tamamla.

## Kontrol

```powershell
claude --version
codex --version
git --version
node --version
npm --version
```

## GitHub

GitHub'da boş repository oluştur ve clone et.

Örnek:

```powershell
git clone <YENI_REPO_URL>
cd <REPO_KLASORU>
```

ZIP içeriğini bu klasöre çıkar.

Sonra yalnız:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-full-auto.ps1
```
