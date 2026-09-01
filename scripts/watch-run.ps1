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
$env:Path = "D:\tools\node;C:\Program Files\GitHub CLI;C:\Program Files\Git\cmd;$env:Path"

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
    if (-not $wanted) { $wanted = "llama3.1:8b" }
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
try {
    & node.exe --import tsx (Join-Path $repo "scripts\watch.ts") 2>&1 | ForEach-Object {
        Write-Log ([string]$_)
        Write-Output $_
    }
    Say ("watcher exited with code " + $LASTEXITCODE)
    exit $LASTEXITCODE
} catch {
    Say ("watcher crashed: " + $_.Exception.Message)
    exit 1
}
