# Register the resident watcher to start when the owner logs in.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-watch.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-watch.ps1 -Remove
#
# Runs as the current user, not as SYSTEM: it needs that user's gitignored
# .profile.local, the git credentials that let it push, and the Ollama server
# running in that user's session. It does not need administrator rights.
#
# This is a SECOND task, deliberately named apart from "RASID collection",
# which belongs to the live project in Desktop\rasid and is not touched. The
# two run side by side until v2 has proved itself; turning the first one off is
# the owner's decision and nobody else's.
#
# Plain ASCII, because PowerShell 5.1 reads an unmarked .ps1 in the system
# codepage and one character outside ASCII stops the parser before the first
# line runs.

param([switch]$Remove)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$name = "RASID v2 watcher"
$script = Join-Path $repo "scripts\watch-run.ps1"

if ($Remove) {
    # Both places, because either could hold it.
    Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
    $link = Join-Path ([Environment]::GetFolderPath("Startup")) "RASID v2 watcher.lnk"
    if (Test-Path $link) { Remove-Item $link -Force }
    Write-Output "removed: $name (scheduled task and Startup shortcut)"
    Write-Output "A watcher already running is not stopped by this. To stop it:"
    Write-Output "    Get-Process node | Where-Object { `$_.Path -like '*tools\node*' } | Stop-Process"
    return
}

if (-not (Test-Path $script)) {
    Write-Output "cannot find $script"
    exit 1
}

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""

# At logon, which is what "starts when I turn the PC on" means for a process
# that needs this user's session. A short delay lets the desktop, the network
# and Ollama settle first; the watcher would survive starting before them, but
# it would spend its first cycle reporting failures that were only earliness.
$logon = New-ScheduledTaskTrigger -AtLogOn
$logon.Delay = "PT2M"

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopOnIdleEnd `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 5) `
    -MultipleInstances IgnoreNew

# No execution time limit. Every other task in this repository is a round that
# should finish; this one is a process that should not. The default of three
# days would kill it silently on the fourth, and a watcher that stops watching
# without saying so is the exact failure this project exists to refuse.
$settings.ExecutionTimeLimit = "PT0S"

# The network is deliberately NOT required to start. RunOnlyIfNetworkAvailable
# would keep the watcher from starting at all on a machine that logs in before
# wifi associates, and it would then never start, because the trigger has
# already passed. It handles its own network failures: each cycle records them
# in health.json where the app shows them.

# Two ways to start at logon, and the second one is not a lesser version.
#
# Task Scheduler is preferred: it can restart the watcher if it dies mid-session
# and it survives a user who never opens Explorer. But creating a task on this
# machine needs elevation, and asking for an administrator prompt every time
# would be a worse answer than not having the restart.
#
# So it tries, and falls back to the Startup folder, which needs no rights at
# all and is where the owner can see it and remove it. The watcher already
# contains every cycle in its own child process and catches its own errors, so
# what the fallback gives up is recovery from the whole process dying, which
# the next logon fixes anyway.
$viaTask = $false
try {
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $logon `
        -Settings $settings `
        -Description "Watches Saudi cooperative-training pages continuously from this machine, which .gov.sa hosts accept and a cloud runner does not. Judges them with a local model, notifies, and pushes." `
        -Force -ErrorAction Stop | Out-Null
    $viaTask = $true
    Write-Output "registered as a scheduled task: $name"
    Get-ScheduledTask -TaskName $name | Select-Object TaskName, State
} catch {
    Write-Output "Task Scheduler refused (needs administrator): $($_.Exception.Message)"
    Write-Output "Falling back to the Startup folder, which needs no rights."
}

if (-not $viaTask) {
    $startup = [Environment]::GetFolderPath("Startup")
    $link = Join-Path $startup "RASID v2 watcher.lnk"
    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut($link)
    $sc.TargetPath = "powershell.exe"
    $sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
    $sc.WorkingDirectory = $repo
    $sc.Description = "Watches Saudi cooperative-training pages from this machine."
    # 7 is minimised. The hidden window style above means nothing appears at
    # all; this only stops a taskbar button flashing on the way there.
    $sc.WindowStyle = 7
    $sc.Save()

    if (Test-Path $link) {
        Write-Output "registered in the Startup folder:"
        Write-Output "    $link"
    } else {
        Write-Output "could not create the Startup shortcut"
        exit 1
    }
}

Write-Output ""
Write-Output "It starts at the next logon. To start it now without waiting:"
Write-Output ("    powershell -ExecutionPolicy Bypass -File `"" + $script + "`"")
Write-Output "To watch what it is doing:"
Write-Output ("    Get-Content '" + (Join-Path $repo "watch.log") + "' -Tail 20 -Wait")
Write-Output "To remove it:"
Write-Output "    powershell -ExecutionPolicy Bypass -File scripts\install-watch.ps1 -Remove"
