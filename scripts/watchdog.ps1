# Keep the watcher alive for the whole session.
#
# The watcher task has a logon trigger and nothing else, so it starts once when
# he signs in and never again. On 2026-09-05 it was killed at 05:35 with
# 0xC000013A - a termination, not a crash, which Task Scheduler's RestartCount
# does not cover - and stayed dead for six hours while the machine was in use.
# Eleven real announcements sat in the queue for 25 to 52 hours against a
# promise of six. Nothing anywhere would have said a word.
#
# Modifying the watcher task, or registering a second one, both need elevation
# on this machine. This does not: it is an ordinary script started from the
# Startup folder at logon, and it loops for the life of the session. Every ten
# minutes it asks whether the watcher is Running and starts it if not.
# MultipleInstances=IgnoreNew on the watcher means starting one that is already
# running costs nothing.
#
# This is a desktop with no battery, so the machine does not sleep or hibernate
# on its own: it is either on with a session logged in, or it is off and there is
# nothing to watch. That makes a session-length loop the right shape here.
#
# ASCII only. PowerShell 5.1 reads an unmarked .ps1 in the system codepage and a
# single non-ASCII byte breaks the parser, which would silently stop collection.

$name = "RASID v2 watcher"
$log = Join-Path $PSScriptRoot "..\watchdog.log"
$intervalSeconds = 600

# A way to stop the watcher and have it stay stopped, for as long as it takes to
# edit data/ by hand.
#
# CLAUDE.md says to stop the watcher before touching data/, because a round in
# flight reads those files at its start and writes them at its end, silently
# erasing anything written in between. That instruction was true and impossible
# to follow: this loop started the task again within ten minutes, so any edit
# taking longer than that was overwritten anyway.
#
# So: touch the pause file, work, delete it. The pause EXPIRES on its own after
# an hour, because the failure this whole file exists to prevent is a watcher
# that is dead and nobody notices - and a pause file forgotten in a directory
# nobody looks at is exactly that failure wearing a different hat.
$pause = Join-Path $PSScriptRoot "..\.rasid\watchdog.paused"
$pauseMinutes = 60

function Say($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm"), $msg
    try { Add-Content -Path $log -Value $line -Encoding utf8 } catch { }
}

# One watchdog is enough. A second would do no harm, but it would double the log.
$mutex = New-Object System.Threading.Mutex($false, "Global\RASID-watchdog")
if (-not $mutex.WaitOne(0)) { exit 0 }

Say "watchdog started"

while ($true) {
    $held = $false
    if (Test-Path $pause) {
        $age = (New-TimeSpan -Start (Get-Item $pause).LastWriteTime -End (Get-Date)).TotalMinutes
        if ($age -lt $pauseMinutes) {
            $held = $true
            Say ("paused by hand for {0:N0} more minute(s)" -f ($pauseMinutes - $age))
        } else {
            Say ("the pause file is {0:N0} minutes old; ignoring it and removing it" -f $age)
            try { Remove-Item $pause -Force -ErrorAction Stop } catch { }
        }
    }

    try {
        $task = Get-ScheduledTask -TaskName $name -ErrorAction Stop
        if (-not $held -and $task.State -ne "Running") {
            Say ("watcher was {0}; starting it" -f $task.State)
            try {
                Start-ScheduledTask -TaskName $name -ErrorAction Stop
                Say "watcher started"
            } catch {
                Say ("could not start it: {0}" -f $_.Exception.Message)
            }
        }
    } catch {
        # The task is gone entirely. Say so every round rather than exit: a
        # missing watcher is the loudest problem there is, and this is the only
        # thing looking at it.
        Say ("task '{0}' does not exist" -f $name)
    }

    # Keep the log from growing without end. One line every ten minutes is small,
    # but this runs for months.
    try {
        if ((Test-Path $log) -and ((Get-Item $log).Length -gt 1MB)) {
            $keep = Get-Content $log -Tail 200 -Encoding utf8
            Set-Content -Path $log -Value $keep -Encoding utf8
        }
    } catch { }

    Start-Sleep -Seconds $intervalSeconds
}
