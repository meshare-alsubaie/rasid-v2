# Show one Windows toast, from a payload file written by Node.
#
# Two constraints shape this file and neither is cosmetic.
#
# It is pure ASCII. Windows PowerShell 5.1 reads a .ps1 with no byte-order mark
# in the system codepage, so a single character outside ASCII stops the parser
# before the first line runs. That has already happened here once: two
# typographic dashes in a comment killed the scheduled collection twice, and
# nothing reached the log because the log is written from inside the script.
# The notification text is Arabic, so it cannot live in this file. It is read
# from a UTF-8 file whose path is the only argument.
#
# And it needs no module. BurntToast would do this in one line, but a
# notification channel that depends on an install is a channel that silently
# stops working on a machine where the install was never done. This uses the
# WinRT API that ships with Windows.
#
# Exit codes: 0 shown, 2 bad arguments, 3 the API refused.

param([Parameter(Mandatory = $true)][string]$PayloadPath)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $PayloadPath)) {
    Write-Output "payload file not found: $PayloadPath"
    exit 2
}

# -Encoding utf8 is the whole point: the file holds Arabic, and Get-Content
# without it would decode as the system codepage and show mojibake.
$xml = Get-Content -LiteralPath $PayloadPath -Raw -Encoding utf8

try {
    [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]

    $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
    $doc.LoadXml($xml)
    $toast = New-Object Windows.UI.Notifications.ToastNotification $doc

    # Toasts are shown under a registered application identity. Registering one
    # would mean an installer, so the PowerShell shortcut that Windows already
    # ships with is borrowed. The notification is attributed to it in the Action
    # Center, which is honest: this is a script on his machine, not an app.
    $appId = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
    exit 0
} catch {
    Write-Output ("toast failed: " + $_.Exception.Message)
    exit 3
}
