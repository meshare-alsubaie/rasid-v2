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

function Say($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm"), $msg
    try { Add-Content -Path $log -Value $line -Encoding utf8 } catch { }
}

# One watchdog is enough. A second would do no harm, but it would double the log.
$mutex = New-Object System.Threading.Mutex($false, "Global\RASID-watchdog")
if (-not $mutex.WaitOne(0)) { exit 0 }

Say "watchdog started"

while ($true) {
    try {
        $task = Get-ScheduledTask -TaskName $name -ErrorAction Stop
        if ($task.State -ne "Running") {
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
