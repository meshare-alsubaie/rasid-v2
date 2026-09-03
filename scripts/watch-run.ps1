# The watcher's entry point, as Task Scheduler starts it at logon.
#
# This file is kept to plain ASCII on purpose. Windows PowerShell 5.1 reads a
# .ps1 with no byte-order mark in the system codepage, so a single typographic
# dash in a comment turns into bytes that break the parser -- which is exactly
# what happened to the collection task twice, and nothing reached the log
# because the log is written from inside the script.

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

# The log is Arabic and the collector prints UTF-8, so both ends are pinned to
# it. Without this, PowerShell 5.1 decodes the child's output in the console
# codepage and an ellipsis arrives in the log as "AsCa", which is a small thing
# that makes a file nobody can read.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# Written without a byte-order mark. Add-Content -Encoding utf8 puts one at the
# head of the file on 5.1, and it shows up as stray characters in every reader
# that does not expect it.
$log = Join-Path $repo "watch.log"
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Write-Log($text) {
    [System.IO.File]::AppendAllText($log, $text + [Environment]::NewLine, $utf8)
}
function Say($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm"), $msg
    Write-Output $line
    Write-Log $line
}

# Task Scheduler starts with a bare environment, so the tools are named here.
#
# The node directory is a guess that happens to be right on this machine, and is
# wrong on every other one. Anybody who clones this repository gets a watcher
# that cannot find node and a task that fails at logon with nothing in the log.
# So the guess is now the fallback, and an installed node on PATH wins; set
# RASID_NODE_DIR to point somewhere else without editing this file.
$nodeDir = $env:RASID_NODE_DIR
if (-not $nodeDir) {
    $onPath = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($onPath) { $nodeDir = Split-Path -Parent $onPath.Source }
}
if (-not $nodeDir) { $nodeDir = "D:\tools\node" }
$env:Path = "$nodeDir;C:\Program Files\GitHub CLI;C:\Program Files\Git\cmd;$env:Path"

# Where the headless browser lives, said out loud rather than inferred.
#
# Playwright finds its browsers under LOCALAPPDATA. A task started by the
# scheduler does not always inherit the same LOCALAPPDATA as a shell, and when
# it does not, every browser-rendered source in the round fails with
# "Executable doesn't exist" -- 41 of them at once, including SDAIA's own co-op
# page, while the identical command from a terminal worked perfectly. The cause
# is invisible from the error, which blames a missing install.
#
# Reproduced deliberately: overriding LOCALAPPDATA produces exactly that error
# and nothing else changes. So the location is pinned here, and the watcher no
# longer depends on which environment the scheduler happened to hand it.
# Resolved from the user token, not from the environment block.
#
# The first attempt at this read $env:LOCALAPPDATA and fell back to
# $env:USERNAME, and the watcher's own warning then fired on every start: the
# scheduler hands the task an environment in which neither is usable, so both
# candidates missed and 41 sources went on failing. GetFolderPath asks Windows
# where the folder is rather than asking the environment what it was told, which
# is the difference between a value that is right and a value that was inherited.
if (-not $env:PLAYWRIGHT_BROWSERS_PATH) {
    # The last candidate is derived from this script's own location and asks the
    # environment for nothing at all. The three before it were each tried in
    # turn and each failed under the scheduler, which hands the task an
    # environment where LOCALAPPDATA, USERNAME and even the token lookup all
    # miss. The repository sits inside the profile that owns the browsers, so
    # its path is the one fact available here that is certainly true.
    # First: the copy installed inside the repository itself.
    $inRepo = Join-Path $repo ".playwright"

    $fromRepo = $null
    if ($repo -match '^(?<root>[A-Za-z]:\\Users\\[^\\]+)\\') {
        $fromRepo = Join-Path $Matches['root'] "AppData\Local"
    }
    $candidates = @(
        $inRepo,
        [Environment]::GetFolderPath("LocalApplicationData"),
        $env:LOCALAPPDATA,
        (Join-Path $HOME "AppData\Local"),
        $fromRepo
    )
    foreach ($root in $candidates) {
        if (-not $root) { continue }
        # The in-repo copy is already the browsers root; the profile ones need
        # the ms-playwright folder appended.
        $browsers = if ($root -eq $inRepo) { $root } else { Join-Path $root "ms-playwright" }
        # [IO.Directory]::Exists rather than Test-Path: the provider-based cmdlet
        # reported False for this exact path under the scheduler while a direct
        # filesystem call reports True, and the log above proved the string was
        # correct all along.
        if ([System.IO.Directory]::Exists($browsers)) {
            $env:PLAYWRIGHT_BROWSERS_PATH = $browsers
            break
        }
    }
    if ($env:PLAYWRIGHT_BROWSERS_PATH) {
        Say ("browsers: " + $env:PLAYWRIGHT_BROWSERS_PATH)
    } else {
        # Naming what was tried, because the first two attempts at this failed
        # silently and the only way to tell why was to guess. A diagnostic that
        # prints the candidates costs one line and ends the guessing.
        Say "WARNING: no Playwright browsers found. Pages needing a real browser will not be read."
        Say ("  repo=" + $repo)
        $i = 0
        foreach ($root in $candidates) {
            $i++
            if (-not $root) { Say ("  candidate " + $i + ": (empty)"); continue }
            $try = if ($root -eq $inRepo) { $root } else { Join-Path $root "ms-playwright" }
            Say ("  candidate " + $i + ": " + $try + " exists=" + [System.IO.Directory]::Exists($try))
        }
    }
}

# Spec 5.1 asks the User-Agent to carry a contact address, so a site owner who
# sees this traffic can reach a person. The value is a personal email, so it is
# read from a gitignored file and never committed.
$contactFile = Join-Path $repo ".contact.local"
if (Test-Path $contactFile) {
    $env:RASID_CONTACT = (Get-Content $contactFile -Raw -Encoding utf8).Trim()
}

# Without the profile the relevance score cannot be computed, and the pipeline
# stores null with needs_manual_review rather than guessing. That is the right
# behaviour and a bad state to sit in for weeks, so it is said out loud.
$profileFile = Join-Path $repo ".profile.local"
if ((Test-Path $profileFile) -and -not $env:RASID_STUDENT_PROFILE) {
    $env:RASID_STUDENT_PROFILE = (Get-Content $profileFile -Raw -Encoding utf8)
}
if (-not $env:RASID_STUDENT_PROFILE) {
    Say "WARNING: no student profile. Pages will be read and judged, but nothing scored."
}

# Ollama is the classifier now. It does not stop the run: the pages are still
# fetched and hashed, so when it comes back only what actually moved is judged.
# What must never happen is a run that looks healthy while nothing is judged.
$ollama = $env:OLLAMA_HOST
if (-not $ollama) { $ollama = "http://127.0.0.1:11434" }
if ($ollama -notmatch '^https?://') { $ollama = "http://$ollama" }
$ollama = $ollama -replace '//0\.0\.0\.0', '//127.0.0.1'
try {
    $tags = Invoke-RestMethod -Uri "$ollama/api/tags" -TimeoutSec 5 -ErrorAction Stop
    $wanted = $env:RASID_LOCAL_MODEL
    if (-not $wanted) { $wanted = "qwen3:8b" }
    if (($tags.models | ForEach-Object { $_.name }) -notcontains $wanted) {
        Say "WARNING: model $wanted is not installed. Pages will be fetched but nothing judged."
    }
} catch {
    Say "WARNING: Ollama is not reachable at $ollama. Pages will be fetched but nothing judged."
}

Say "watcher starting"

# Run in the foreground and let the task hold it. The watcher loops until it is
# stopped; every cycle it runs is its own child process, so a wedged collection
# cannot take the watcher with it.
# One line on stderr must not end the watcher.
#
# Windows PowerShell 5.1 wraps every stderr line of a native program in an
# ErrorRecord (NativeCommandError). With $ErrorActionPreference = "Stop" set at
# the top of this file, that record is a *terminating* error, so the catch below
# fired and the process exited -- on a single warning line from node, while the
# collector itself was healthy. The one component whose entire job is to outlive
# a bad round was being killed by a log line, and it has already happened once
# in scheduled-run.log.
#
# Stop stays in force for everything above; it is lifted only around the child,
# where stderr is output to be logged rather than a fault to abort on. The lines
# still reach the log exactly as before.
$outerPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    & node.exe --import tsx (Join-Path $repo "scripts\watch.ts") 2>&1 | ForEach-Object {
        Write-Log ([string]$_)
        Write-Output $_
    }
    $childExit = $LASTEXITCODE
    Say ("watcher exited with code " + $childExit)
    exit $childExit
} catch {
    Say ("watcher crashed: " + $_.Exception.Message)
    exit 1
} finally {
    $ErrorActionPreference = $outerPreference
}
