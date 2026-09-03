# Register the local collection as a Windows scheduled task.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-schedule.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-schedule.ps1 -Remove
#
# Runs as the current user, not as SYSTEM, because it needs that user's
# ANTHROPIC_API_KEY, the gitignored .profile.local, and the git credentials
# that let it push. It does not need administrator rights.

param([switch]$Remove)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$name = "RASID collection"
$script = Join-Path $repo "scripts\scheduled-run.ps1"

if ($Remove) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output "removed: $name"
    return
}

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""

# Every six hours, matching the cloud schedule, plus once shortly after logon
# so a machine that was off overnight catches up instead of waiting.
$daily = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddHours(6) `
    -RepetitionInterval (New-TimeSpan -Hours 6)
$logon = New-ScheduledTaskTrigger -AtLogOn
$logon.Delay = "PT5M"

# The three battery settings and the time limit are the four that fix-schedule.ps1
# exists to correct, and this file re-registered with -Force and put the defaults
# straight back: unplugged at 18:00 meant no run at all, unplugged mid-run meant
# a run killed halfway, and thirty minutes was short enough that the scheduler
# killed a round after the sitemaps and before the collection. It was measured:
# LastTaskResult 267014, and not one word written.
#
# So the corrected settings are here, at the point of creation, rather than in a
# second script somebody has to remember to run afterwards. Anything changed
# here has to change in fix-schedule.ps1 too.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopOnIdleEnd `
    -RunOnlyIfNetworkAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 40) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $name -Action $action -Trigger @($daily, $logon) `
    -Settings $settings -Description "Reads Saudi training pages from this machine, which many .gov.sa sites accept and a US cloud runner does not, then pushes the result." `
    -Force | Out-Null

Write-Output "registered: $name"
Get-ScheduledTask -TaskName $name | Select-Object TaskName, State
