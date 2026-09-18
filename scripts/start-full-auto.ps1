param([switch]$Check, [switch]$ValidateOnly, [switch]$Status, [string]$RecoverReview, [switch]$FounderAuthorized)
$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location -LiteralPath $taskRoot
try {
    # Türkçe: Tüm girişler aynı root'u kullanır; çağıranın bulunduğu klasöre bağımlı değildir.
    $taskExtraPaths = @((Join-Path $env:USERPROFILE '.local\bin'), (Join-Path $env:APPDATA 'npm'), (Join-Path $env:ProgramFiles 'nodejs'))
    $env:PATH = ($taskExtraPaths -join ';') + ';' + $env:PATH
    if (-not (Get-Command codex -ErrorAction SilentlyContinue) -and -not $env:FACTORY_CODEX_COMMAND) {
        $taskCodexReleases = Join-Path $env:USERPROFILE '.codex\packages\standalone\releases'
        $taskCodex = Get-ChildItem -LiteralPath $taskCodexReleases -Filter codex.exe -Recurse -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($taskCodex) { $env:FACTORY_CODEX_COMMAND = $taskCodex.FullName }
    }
    if ($Status) { & (Join-Path $PSScriptRoot 'status.ps1'); exit 0 }
    if ($ValidateOnly) { node (Join-Path $PSScriptRoot 'validate-automation.mjs'); exit $LASTEXITCODE }
    & (Join-Path $PSScriptRoot 'check-prereqs.ps1')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Host 'Factory: Claude -> OpenCode Free -> credential-ready OmniRoute Free' -ForegroundColor Cyan
    Write-Host 'Codex independent review; paid/production/Risk-5 actions disabled.'
    if ($RecoverReview) {
        if (-not $FounderAuthorized -or $RecoverReview -notmatch '^[a-f0-9]{40}$') { throw 'Recovery requires a full SHA and -FounderAuthorized' }
        node (Join-Path $taskRoot 'automation\factory-supervisor.mjs') --recover-review $RecoverReview --founder-authorized
    }
    elseif ($Check) { node (Join-Path $taskRoot 'automation\factory-supervisor.mjs') --check }
    else { node (Join-Path $taskRoot 'automation\factory-supervisor.mjs') }
    exit $LASTEXITCODE
} finally { Pop-Location }
