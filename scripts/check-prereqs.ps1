$ErrorActionPreference = 'Stop'
$taskMissing = @('git', 'node', 'npm') | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) }
if ($taskMissing.Count -gt 0) { Write-Host "Eksik zorunlu araçlar: $($taskMissing -join ', ')" -ForegroundColor Red; exit 1 }
$taskMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($taskMajor -lt 24) { Write-Host 'Node.js 24 veya üstü gerekiyor.' -ForegroundColor Red; exit 1 }
foreach ($taskCLI in @('claude', 'opencode', 'codex')) {
    $taskVariable = 'FACTORY_' + $taskCLI.ToUpper() + '_COMMAND'
    $taskCommand = [Environment]::GetEnvironmentVariable($taskVariable)
    if (-not $taskCommand) { $taskCommand = $taskCLI }
    if (-not (Get-Command $taskCommand -ErrorAction SilentlyContinue)) {
        Write-Host "$taskCLI bulunamadı; health-check ve uygun fallback kullanılacak." -ForegroundColor Yellow
    }
}
if (-not $env:FACTORY_OMNIROUTE_API_KEY) { Write-Host 'OmniRoute provider havuzu REGISTERED / INACTIVE / NO_CREDENTIAL. Diğer kaynaklar devam eder.' }
git rev-parse --is-inside-work-tree 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host 'Repository bulunamadı.'; exit 1 }
git remote get-url origin 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host 'origin remote eksik.'; exit 1 }
exit 0
