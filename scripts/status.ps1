$taskRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$taskStateFile = Join-Path $taskRoot '.ai\automation\state.json'
if (-not (Test-Path -LiteralPath $taskStateFile)) { $taskStateFile = Join-Path $taskRoot '.ai\AUTOMATION_STATE.json' }
$taskState = Get-Content -LiteralPath $taskStateFile -Raw | ConvertFrom-Json
$taskMaster = Get-Content -LiteralPath (Join-Path $taskRoot '.ai\MASTER_STATE.json') -Raw | ConvertFrom-Json
Write-Host "Phase: $($taskMaster.currentPhase); milestone: $($taskMaster.currentMilestone)"
Write-Host "Status: $($taskState.status); step: $($taskState.step); review cycle: $($taskState.reviewCycle)"
Write-Host "Last remote SHA: $($taskState.git.lastVerifiedRemoteSha)"
if ($taskState.stopReason) { Write-Host $taskState.stopReason -ForegroundColor Yellow }
if ($taskState.providers) {
    $taskState.providers.PSObject.Properties | ForEach-Object {
        [PSCustomObject]@{ Model = $_.Name; Availability = $_.Value.availability; Quota = $_.Value.quota; Reason = $_.Value.lastFailure; RetryAt = $_.Value.retryAt }
    } | Format-Table -AutoSize
}
